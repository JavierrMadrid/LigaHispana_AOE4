import "server-only";

import { LADDER_MAX_PAGE_SIZE, type Aoe4WorldClient } from "@/lib/aoe4world/client";
import { Aoe4WorldNotFoundError } from "@/lib/aoe4world/http";
import type { Aoe4WorldLadderPage } from "@/lib/aoe4world/types";
import { SUBDIVISION_RANK_LEVELS } from "@/lib/divisions";
import {
  lowestRatingInSubdivision,
  majoritySubdivisionIndex,
  pruneCutoffsTable,
  type LadderCutoff,
  type LadderCutoffs,
  type LadderCutoffsTable,
} from "./division-cutoffs";
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
 * monotonía, encontrar la primera página de cada subdivisión son
 * `log2(n_páginas)` llamadas, y como las fronteras van en orden cada búsqueda
 * **arranca donde acabó la anterior**: es lo que hace
 * `selectTournamentPlayers` con las divisiones, y es lo que convierte 17
 * búsquedas independientes (17 × log2) en un recorrido que se estrecha paso a
 * paso.
 *
 * ## Qué página de la frontera se lee
 *
 * La búsqueda da la **primera** página de cada bloque, pero el corte de una
 * subdivisión es su rating **más bajo**, y ese está al **final** del bloque, no al
 * principio: la primera página del bloque trae sus ratings más altos. Por eso,
 * con la primera página del bloque siguiente localizada, el corte se lee en la
 * página **anterior** (la última del bloque). Leer el principio fue el error que
 * desplazaba la tabla ~80 puntos hacia arriba y corría las etiquetas un escalón.
 *
 * ## Por qué el predicado es la subdivisión **mayoritaria**
 *
 * El `rank_level` de una fila suelta no es monótono: Glicko deja etiquetas
 * incoherentes (una fila `gold_3` con rating 745 en medio de un bloque de
 * `gold_1`). La subdivisión **mayoritaria** de la página sí avanza de la más
 * fuerte a la más débil con el número de página, así que el predicado de la
 * búsqueda es la moda (`majoritySubdivisionIndex()`) y el corte se filtra por
 * subdivisión (`lowestRatingInSubdivision()`), de modo que una fila suelta no
 * decide ni la frontera ni el corte.
 *
 * ## Por qué después hay que corregir la frontera
 *
 * La búsqueda binaria exige que el predicado sea monótono. La mayoría de página
 * lo es casi siempre, pero puede haber una página entera con la mayoría corrida;
 * sin la corrección, una frontera equivocada descartaría divisiones enteras sin
 * avisar. La corrección comprueba la página vecina, que casi siempre ya está en la
 * caché, así que no cuesta una llamada.
 *
 * ## El precio
 *
 * Una derivación por familia son del orden de 120 a 150 llamadas, con la
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

/** Índice de la subdivisión mayoritaria de una página, o `null` si no se reconoce. */
function majorityIndex(page: Aoe4WorldLadderPage): number | null {
  return majoritySubdivisionIndex(page.players);
}

/**
 * Primera página cuya subdivisión mayoritaria es `target` o una más débil.
 *
 * Es un `lower_bound` sobre el predicado `mayoria(pagina) >= target`: la ladder
 * baja de subdivisión con el número de página y la mayoría de cada página es
 * estable (ver `majoritySubdivisionIndex()`), así que el predicado pasa de falso a
 * verdadero una sola vez y la búsqueda binaria es válida.
 *
 * Devuelve la **primera página del bloque `target`**. La frontera con la
 * subdivisión anterior está en `answer - 1`, que es donde el recorrido de
 * `deriveLadderCutoffs()` lee el corte de la subdivisión anterior.
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

    const majority = majorityIndex(page);

    if (majority !== null && majority >= target) {
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
 * Con la mayoría de página el predicado casi siempre es monótono y la búsqueda ya
 * acierta, pero Glicko puede colar una página entera con la mayoría corrida. La
 * corrección comprueba que la página sea la **primera** con mayoría `>= target` y,
 * si no, se mueve una vecina; como mucho `MAX_BOUNDARY_PROBE_PAGES` páginas. Si no
 * converge, se queda con lo que hay y lo avisa, porque los cortes se guardan y se
 * pueden volver a derivar.
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

    const majority = majorityIndex(current);

    // La página entera es anterior al objetivo: el límite real está más abajo.
    if (majority === null || majority < target) {
      page += 1;
      continue;
    }

    if (page > minPage) {
      const anterior = await reader.at(page - 1);
      const majorityAnterior = anterior === null ? null : majorityIndex(anterior);

      // La página anterior ya había llegado al objetivo: el límite real está una
      // página antes de la que dijo la búsqueda.
      if (majorityAnterior !== null && majorityAnterior >= target) {
        page -= 1;
        continue;
      }
    }

    return { page, corrected: page !== guess, exhausted: false };
  }

  return { page, corrected: page !== guess, exhausted: true };
}

/**
 * Rating más bajo de la subdivisión `target`, leído en la **última** página de su
 * bloque.
 *
 * El corte de una subdivisión es su rating más bajo, y ese rating está donde la
 * ladder deja de ser de esa subdivisión, no donde empieza: en la primera página
 * del bloque el rating más bajo todavía es el más alto del bloque. Por eso se lee
 * `blockEndPage` (la página anterior a la primera de la subdivisión siguiente) y
 * solo si allí no hubiera filas de `target` —no debería, porque es su página
 * mayoritaria— se prueba la siguiente.
 */
async function minRatingOf(
  reader: LadderReader,
  blockEndPage: number,
  target: number,
): Promise<number | null> {
  if (blockEndPage >= 1) {
    const end = await reader.at(blockEndPage);

    if (end !== null) {
      const min = lowestRatingInSubdivision(end.players, target);

      if (min !== null) {
        return min;
      }
    }
  }

  const siguiente = await reader.at(blockEndPage + 1);

  return siguiente === null ? null : lowestRatingInSubdivision(siguiente.players, target);
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

    // La subdivisión más débil termina en la última página: no hay frontera que
    // buscar y su corte es el rating más bajo de `bronze_1` que se pueda leer.
    if (target === weakest) {
      const final = await reader.lastNonEmptyFrom(lastPage);

      if (final === null) {
        throw new Error(`La ladder ${ladder} no termina en ${rankLevel}.`);
      }

      const minRating = lowestRatingInSubdivision(final.page.players, target);

      if (minRating === null) {
        throw new Error(`La ladder ${ladder} no termina en ${rankLevel}.`);
      }

      cutoffs.push({ rankLevel, minRating });
      report(`  ${rankLevel}: corte en ${minRating} de elo — ${reader.requests()} peticiones`);
      break;
    }

    // La primera página del bloque siguiente marca dónde acaba el bloque `target`:
    // el corte se lee en la página anterior, que es la **última** del bloque. Leer
    // el principio del bloque daría el rating más alto del bloque, no el más bajo.
    const nextStart = await firstPageAtOrBelow(reader, low, lastPage, target + 1);

    if (nextStart === null) {
      throw new Error(`No se ha podido localizar ${rankLevel} en la ladder ${ladder}.`);
    }

    const corregido = await correctBoundary(reader, nextStart, target + 1, low);

    if (corregido.exhausted) {
      console.warn(
        `[alerts/cutoffs] ${ladder}: la frontera de ${rankLevel} se corrigió ` +
          `${MAX_BOUNDARY_PROBE_PAGES} páginas sin converger; se queda en la ${corregido.page}.`,
      );
    }

    const minRating = await minRatingOf(reader, corregido.page - 1, target);

    if (minRating === null) {
      throw new Error(`La ladder ${ladder} no tiene jugadores en ${rankLevel}.`);
    }

    cutoffs.push({ rankLevel, minRating });
    low = corregido.page;

    report(
      `  ${rankLevel}: fin del bloque en la página ${corregido.page - 1}` +
        `${corregido.corrected ? " (corregida)" : ""}, corte en ${minRating} de elo — ` +
        `${reader.requests()} peticiones`,
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
 * Deriva (o refresca) los cortes de una o varias familias de ladder y los deja
 * cacheados en `Setting["alerts.divisionCutoffs"]`.
 *
 * La caché se reescribe como un **retrato** de esta llamada: se parte de lo que
 * había, se poda a las familias que se van a derivar y se refrescan esas. Así,
 * una entrada de una familia que ya no se deriva —el `rm_solo` que R5 consultaba
 * antes— no sobrevive a la reescritura, en vez de quedarse inerte para siempre.
 */
export async function refreshDivisionCutoffs(
  ladders: string[],
  options: { client: Aoe4WorldClient; signal?: AbortSignal; onProgress?: (message: string) => void },
): Promise<LadderCutoffsTable> {
  const existing = (await readDivisionCutoffs()) ?? {};
  const table = pruneCutoffsTable(existing, ladders);

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
