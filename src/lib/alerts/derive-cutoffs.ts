import "server-only";

import { LADDER_MAX_PAGE_SIZE, type Aoe4WorldClient } from "@/lib/aoe4world/client";
import { Aoe4WorldNotFoundError } from "@/lib/aoe4world/http";
import type { Aoe4WorldLadderPage } from "@/lib/aoe4world/types";
import { SUBDIVISION_RANK_LEVELS, subdivisionIndex } from "@/lib/divisions";
import type { LadderCutoff, LadderCutoffs, LadderCutoffsTable } from "./division-cutoffs";
import { readDivisionCutoffs, writeDivisionCutoffs } from "./settings";

/**
 * Derivar los cortes rating → subdivisión recorriendo la ladder.
 *
 * ## Por qué hay que recorrerla
 *
 * La API **ignora en silencio** los filtros de la ladder: `rating_min`,
 * `rating_max` y `rank_level` devuelven siempre la página 1 (comprobado contra la
 * API real). La única vía es `?page=N`, y las ladders son grandes: `rm_solo` son
 * unas 23 000 personas (~461 páginas) y `rm_team` unas 50 000 (~1 017). Recorrer
 * eso entero en cada derivación serían 1 500 llamadas.
 *
 * ## Por qué búsqueda binaria
 *
 * La clasificación viene ordenada por puesto y el `rank_level` sale del rating,
 * así que **las subdivisiones son bloques contiguos**: la página 1 es de
 * conquistadores y la última de bronces, sin entrelazado salvo en el borde entre
 * dos bloques, donde una página puede acabar en una y empezar en otra. Con esa
 * monotonía, encontrar el primer jugador de cada subdivisión son
 * `log2(n_páginas)` llamadas, y como los cortes van en orden cada búsqueda
 * **arranca donde acabó la anterior**: es lo que hace
 * `selectTournamentPlayers` con las divisiones, y es lo que convierte 17
 * búsquedas independientes (17 × log2) en un recorrido que se estrecha paso a
 * paso.
 *
 * ## Por qué después hay que corregir el límite
 *
 * La búsqueda binaria exige que el bloque no se entrelace. En la práctica es
 * cierto de bloque en bloque, pero el rating de cada jugador fluctúa y en un
 * bloque largo puede haber algún desajuste; sin la corrección, un límite
 * equivocado descartaría divisiones enteras sin avisar. La corrección lee la
 * página vecina, que casi siempre ya está en la caché, así que no cuesta una
 * llamada.
 *
 * ## El precio
 *
 * Una derivación por ladder son del orden de 120 a 150 llamadas, con la
 * separación mínima entre peticiones que impone `http.ts`. Es un trabajo de una
 * sola vez, cacheado en `Setting["alerts.divisionCutoffs"]` y refrescable a mano
 * con `npm run alerts:cutoffs`: el motor **no** lo deriva nunca, porque el
 * sincronizador corre cada 5 minutos y eso no cabe ni de lejos.
 */

/** Cuántas páginas vecinas como mucho se recorren corrigiendo un límite. */
const MAX_BOUNDARY_PROBE_PAGES = 8;

type LadderReader = {
  /** Página pedida, o `null` si está más allá del final de la ladder. */
  at(page: number): Promise<Aoe4WorldLadderPage | null>;
  requests(): number;
  lastPage(): number | null;
  /** Última página con filas, buscando hacia atrás desde `from` (acotado). */
  lastNonEmptyFrom(from: number): Promise<{ page: Aoe4WorldLadderPage; pageNumber: number } | null>;
};

export type DeriveCutoffsOptions = {
  client: Aoe4WorldClient;
  ladder: string;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
};

/**
 * Lector de páginas de la ladder con caché.
 *
 * La caché no es una optimización menor: la búsqueda binaria visita páginas que
 * ya se han leído (al corregir un límite, al derivar el corte siguiente desde el
 * final del anterior) y sin ella el mismo tramo se pediría dos veces.
 *
 * Una página vacía (más allá del final) se cachea como `null` y no se reintenta:
 * la API contesta `200` con la lista vacía en lugar de un 404.
 */
function createLadderReader(
  client: Aoe4WorldClient,
  ladder: string,
  signal: AbortSignal | undefined,
): LadderReader {
  const cache = new Map<number, Aoe4WorldLadderPage | null>();
  let requests = 0;
  let lastPage: number | null = null;

  async function at(page: number): Promise<Aoe4WorldLadderPage | null> {
    const cached = cache.get(page);

    if (cached !== undefined) {
      return cached;
    }

    requests += 1;

    let loaded: Aoe4WorldLadderPage | null;

    try {
      const response = await client.getLadderPage(
        ladder,
        { page, perPage: LADDER_MAX_PAGE_SIZE },
        signal === undefined ? undefined : { signal },
      );

      loaded = response.players.length === 0 ? null : response;
    } catch (error) {
      if (!(error instanceof Aoe4WorldNotFoundError)) {
        throw error;
      }

      loaded = null;
    }

    cache.set(page, loaded);

    if (loaded !== null) {
      // El tamaño de página efectivo lo dice la respuesta, no el pedido: si se
      // pidieran 100 y la API devolviera 50, el final de la ladder está al doble.
      const perPage = Math.max(1, loaded.perPage);
      lastPage = Math.max(lastPage ?? 0, Math.ceil(loaded.totalCount / perPage));
    }

    return loaded;
  }

  return {
    at,
    requests: () => requests,
    lastPage: () => lastPage,
    async lastNonEmptyFrom(from) {
      for (let page = from; page >= 1 && page > from - 4; page -= 1) {
        const loaded = await at(page);

        if (loaded !== null) {
          return { page: loaded, pageNumber: page };
        }
      }

      return null;
    },
  };
}

/** Índice de subdivisión de un jugador de la ladder, o `null` si no se reconoce. */
function entryIndex(rankLevel: string | null): number | null {
  return subdivisionIndex(rankLevel);
}

/** Índice de la última fila de una página no vacía. */
function lastIndex(page: Aoe4WorldLadderPage): number | null {
  return entryIndex(page.players.at(-1)?.rankLevel ?? null);
}

/** Índice de la primera fila de una página no vacía. */
function firstIndex(page: Aoe4WorldLadderPage): number | null {
  return entryIndex(page.players.at(0)?.rankLevel ?? null);
}

/**
 * Primera página cuya última fila ya es de la subdivisión `target` o de una más
 * débil.
 *
 * Es un `lower_bound` sobre el predicado `últimaFila >= target`: como la ladder
 * baja de rating con el número de página, el predicado pasa de falso a verdadero
 * una sola vez y la búsqueda binaria es válida.
 */
async function firstPageAtOrBelow(
  reader: LadderReader,
  low: number,
  high: number,
  target: number,
): Promise<number | null> {
  let lo = low;
  let hi = high;
  let answer: number | null = null;

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const page = await reader.at(mid);

    if (page === null) {
      hi = mid - 1;
      continue;
    }

    const last = lastIndex(page);

    if (last !== null && last >= target) {
      answer = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }

  return answer;
}

/**
 * Corrige el límite devuelto por la búsqueda con un paseo corto de páginas
 * vecinas, como hace `select.ts` con las divisiones.
 *
 * Solo se mueve el límite mientras la página vecina diga que está corrido, y como
 * mucho `MAX_BOUNDARY_PROBE_PAGES` páginas: es una corrección acotada, no un
 * recorrido. Si no converge, se queda con lo que hay y lo avisa, porque los cortes
 * se guardan y se pueden volver a derivar.
 */
async function correctBoundary(
  reader: LadderReader,
  guess: number,
  target: number,
  minPage: number,
): Promise<{ page: number; corrected: boolean; exhausted: boolean }> {
  let page = guess;

  for (let probe = 0; probe < MAX_BOUNDARY_PROBE_PAGES; probe += 1) {
    const current = await reader.at(page);

    if (current === null) {
      return { page, corrected: false, exhausted: false };
    }

    const first = firstIndex(current);

    // La página entera es anterior al objetivo: el límite real está más abajo.
    if (first !== null && first < target) {
      page += 1;
      continue;
    }

    if (page > minPage) {
      const anterior = await reader.at(page - 1);
      const last = anterior === null ? null : lastIndex(anterior);

      // La página anterior aún no había llegado al objetivo: el límite real está
      // una página antes de la que dijo la búsqueda.
      if (last !== null && last < target) {
        page -= 1;
        continue;
      }
    }

    return { page, corrected: page !== guess, exhausted: false };
  }

  return { page, corrected: page !== guess, exhausted: true };
}

/**
 * Rating más bajo de la subdivisión `target` dentro de la ladder.
 *
 * La búsqueda devuelve la primera página cuya última fila ya es de `target` o
 * más débil. El corte es el rating más bajo de `target` que se puede leer: si esa
 * página trae ya filas de la siguiente subdivisión, se toman las suyas; si no, se
 * lee la página anterior y se toma la de allí. Los dos casos son el mismo y
 * necesario: al principio de una temporada las divisiones caben enteras en la
 * página 1, así que el corte casi siempre acaba vINIENDO de la página anterior a
 * la que marca la búsqueda.
 */
async function minRatingOf(
  reader: LadderReader,
  boundaryPage: number,
  target: number,
): Promise<number | null> {
  const ratings: number[] = [];

  const collect = (page: Aoe4WorldLadderPage): void => {
    for (const entry of page.players) {
      if (entryIndex(entry.rankLevel) === target && typeof entry.rating === "number") {
        ratings.push(entry.rating);
      }
    }
  };

  const boundary = await reader.at(boundaryPage);

  if (boundary !== null) {
    collect(boundary);
  }

  if (ratings.length === 0 && boundaryPage - 1 >= 1) {
    const anterior = await reader.at(boundaryPage - 1);

    if (anterior !== null) {
      collect(anterior);
    }
  }

  return ratings.length === 0 ? null : Math.min(...ratings);
}

/**
 * Deriva los dieciocho cortes de una ladder.
 *
 * **Se niega a devolver cortes incompletos**: si alguna subdivisión no aparece en
 * la ladder, lanza. Es la única forma de que un hueco no se convierta en una
 * cuenta de escalones falseada, y una ladder de decenas de miles de jugadores
 * tiene las dieciocho subdivisiones de sobra.
 */
export async function deriveLadderCutoffs(options: DeriveCutoffsOptions): Promise<LadderCutoffs> {
  const { client, ladder, signal, onProgress } = options;
  const report = onProgress ?? (() => undefined);
  const reader = createLadderReader(client, ladder, signal);

  const primera = await reader.at(1);

  if (primera === null) {
    throw new Error(`La ladder ${ladder} no devuelve jugadores en la primera página.`);
  }

  const lastPage = reader.lastPage() ?? 1;
  const totalCount = primera.totalCount;
  const weakest = SUBDIVISION_RANK_LEVELS.length - 1;

  report(
    `Ladder ${ladder}: ${totalCount} jugadores en ${lastPage} páginas de ${primera.perPage}.`,
  );

  const cutoffs: LadderCutoff[] = [];
  // Cada búsqueda arranca donde acabó la anterior: los bloques son contiguos y
  // esto es lo que hace que el recorrido se estreche paso a paso.
  let low = 1;

  for (let target = 0; target <= weakest; target += 1) {
    const rankLevel = SUBDIVISION_RANK_LEVELS[target];

    // La subdivisión más fuerte empieza en la página 1 y la más débil termina en
    // la última: no hay nada que buscar en ellas, y eso ahorra dos búsquedas.
    if (target === 0) {
      const minRating = await minRatingOf(reader, 2, target);

      if (minRating === null) {
        throw new Error(`La ladder ${ladder} no tiene jugadores en ${rankLevel}.`);
      }

      cutoffs.push({ rankLevel, minRating });
      report(`  ${rankLevel}: corte en ${minRating} de elo — ${reader.requests()} peticiones`);
      continue;
    }

    if (target === weakest) {
      const final = await reader.lastNonEmptyFrom(lastPage);
      const ultimaFila = final?.page.players.at(-1);

      if (final === null || ultimaFila === undefined || typeof ultimaFila.rating !== "number") {
        throw new Error(`La ladder ${ladder} no termina en ${rankLevel}.`);
      }

      if (entryIndex(ultimaFila.rankLevel) !== target) {
        throw new Error(
          `La ladder ${ladder} termina en ${ultimaFila.rankLevel ?? "una subdivisión desconocida"} ` +
            `y no en ${rankLevel}: no se puede derivar una tabla completa.`,
        );
      }

      cutoffs.push({ rankLevel, minRating: ultimaFila.rating });
      report(`  ${rankLevel}: corte en ${ultimaFila.rating} de elo — ${reader.requests()} peticiones`);
      break;
    }

    const guess = await firstPageAtOrBelow(reader, low, lastPage, target);

    if (guess === null) {
      throw new Error(`No se ha podido localizar ${rankLevel} en la ladder ${ladder}.`);
    }

    const corregido = await correctBoundary(reader, guess, target, low);

    if (corregido.exhausted) {
      console.warn(
        `[alerts/cutoffs] ${ladder}: el límite de ${rankLevel} se corrigió ` +
          `${MAX_BOUNDARY_PROBE_PAGES} páginas sin converger; se queda en la ${corregido.page}.`,
      );
    }

    const minRating = await minRatingOf(reader, corregido.page, target);

    if (minRating === null) {
      throw new Error(`La ladder ${ladder} no tiene jugadores en ${rankLevel}.`);
    }

    cutoffs.push({ rankLevel, minRating });
    low = corregido.page;

    report(
      `  ${rankLevel}: página ${corregido.page}${corregido.corrected ? " (corregida)" : ""}, ` +
        `corte en ${minRating} de elo — ${reader.requests()} peticiones`,
    );
  }

  return {
    ladder,
    derivedAt: new Date().toISOString(),
    totalCount,
    cutoffs,
    requests: reader.requests(),
  };
}

/**
 * Deriva (o refresca) los cortes de una o varias ladders y los deja cacheados en
 * `Setting["alerts.divisionCutoffs"]`.
 *
 * Se **acumula**: las ladders que no se piden en esta llamada conservan sus
 * cortes. Refrescar `rm_team` no puede borrar los de `rm_solo`, y quien se
 * equivoca de eso se queda sin R5 en los partidos de su propio grupo.
 */
export async function refreshDivisionCutoffs(
  ladders: string[],
  options: { client: Aoe4WorldClient; signal?: AbortSignal; onProgress?: (message: string) => void },
): Promise<LadderCutoffsTable> {
  const existing = (await readDivisionCutoffs()) ?? {};
  const table: LadderCutoffsTable = { ...existing };

  for (const ladder of ladders) {
    table[ladder] = await deriveLadderCutoffs({
      client: options.client,
      ladder,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
    });
  }

  await writeDivisionCutoffs(table);

  return table;
}
