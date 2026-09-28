import {
  GAMES_MAX_PAGE_SIZE,
  LADDER_MAX_PAGE_SIZE,
  type Aoe4WorldClient,
} from "@/lib/aoe4world/client";
import { Aoe4WorldNotFoundError } from "@/lib/aoe4world/http";
import { normalizeGame } from "@/lib/aoe4world/normalize";
import {
  DEFAULT_LEADERBOARD,
  type Aoe4WorldLeaderboardEntry,
  type Aoe4WorldLadderPage,
} from "@/lib/aoe4world/types";
import { DIVISIONS, divisionFromRankLevel, type DivisionId } from "@/lib/divisions";
import { normalizeTwitchChannel } from "@/lib/twitch";

/**
 * ElecciÃ³n de un participante real por divisiÃ³n, para la simulaciÃ³n del torneo.
 *
 * ## Por quÃ© hay que buscar en la ladder entera
 *
 * La API de AoE4World **ignora en silencio** los filtros de la ladder:
 * `rating_min`/`rating_max` y `rank_level` devuelven siempre la pÃ¡gina 1, asÃ­ que
 * no hay forma de pedir "los bronces". Lo Ãºnico que funciona es paginar
 * (`?page=N`) y quedarse con los rangos que interesan: son unas 461 pÃ¡ginas para
 * `rm_solo`, y recorrerlas todas serÃ­an 461 llamadas por ejecuciÃ³n.
 *
 * ## Por quÃ© bÃºsqueda binaria
 *
 * La clasificaciÃ³n viene ordenada por puesto, y el `rank_level` sale del rating,
 * asÃ­ que **las divisiones son bloques contiguos**: la pÃ¡gina 1 es de
 * conquistadores y la Ãºltima de bronces, sin entrelazado (salvo en el borde
 * entre dos divisiones, donde una pÃ¡gina puede acabar en una y empezar en otra).
 * Con esa monotonÃ­a, encontrar la primera pÃ¡gina de cada divisiÃ³n son
 * `log2(461) â‰ˆ 9` llamadas en vez de 461: cinco bÃºsquedas (una por divisiÃ³n
 * menos la primera, que es la pÃ¡gina 1) son ~45 llamadas.
 *
 * ## Por quÃ© despuÃ©s hay que validar candidatos
 *
 * Estar en la ladder no dice nada sobre actividad: buena parte de los bronces y
 * de las platas no ha jugado nada en dos semanas. Por eso, despuÃ©s de localizar
 * el bloque, se leen **unas pocas pÃ¡ginas** del principio del bloque (los puestos
 * mÃ¡s altos de la divisiÃ³n, que son los mÃ¡s activos) y se cuentan las partidas
 * reales de cada candidato. Los que no llegan al mÃ­nimo se descartan con el
 * nÃºmero que los dejÃ³ fuera, y quedan escritos en el informe para que la
 * elecciÃ³n sea auditable.
 *
 * El recuento **no es un filtro propio**: reutiliza `normalizeGame` con el mismo
 * criterio que el import, de modo que "+20 partidas" significa exactamente
 * "+20 filas que van a acabar en la base de datos".
 */

/** MÃ­nimo de partidas de ladder en la ventana reciente que hay que superar. */
export const MIN_RECENT_RANKED_GAMES = 20;

/** Ventana de actividad para validar a un candidato, en dÃ­as. */
export const RECENT_WINDOW_DAYS = 14;

export const SELECTION_DEFAULTS = {
  /** Páginas de ladder leídas por división al buscar candidatos. */
  maxPagesPerDivision: 3,
  /**
   * Candidatos validados por división antes de abandonar el resto.
   *
   * Tres páginas son ~150 jugadores y este presupuesto se agota dentro de la
   * primera, así que el tope está en los candidatos, no en las páginas. El valor
   * sale de la medición: en septiembre de 2026 el primer jugador de bronce con
   * más de 20 partidas de ladder en 14 días era el número 13 del bloque, y en las
   * otras cinco divisiones bastaban entre 1 y 4. Con 16 hay margen sin
   *inguishable de un recorrido completo de la ladder.
   */
  maxCandidatesPerDivision: 16,
  /** Paseo de corrección tras la búsqueda binaria (ver `correctBoundary`). */
  maxBoundaryProbePages: 8,
};

/** Jugador elegido para una divisiÃ³n, con lo que la decisiÃ³n necesita para ser auditable. */
export type SelectionPick = {
  profileId: number;
  name: string;
  division: DivisionId;
  rankLevel: string | null;
  rating: number | null;
  ladderRank: number | null;
  twitchChannel: string | null;
  avatarUrl: string | null;
  /**
   * Partidas `rm_solo` de la ventana reciente. **Contado hasta el objetivo**: en
   * cuanto se llega a `minRecentRankedGames + 1` se para, así que el número
   * exacto solo es ese si vale 21; cualquier valor mayor significa "al menos
   * eso". No hace falta más precisión para decidir y sale más barato para todos.
   */
  recentRankedGames: number;
};

/** Un candidato que no cumple el mÃ­nimo de actividad, y por quÃ© se cayÃ³. */
export type SelectionRejection = {
  profileId: number;
  name: string;
  division: DivisionId;
  rankLevel: string | null;
  rating: number | null;
  ladderRank: number | null;
  recentRankedGames: number;
  reason: string;
};

/** CÃ³mo se localizÃ³ y se llenÃ³ una divisiÃ³n. */
export type DivisionSelection = {
  division: DivisionId;
  /** PÃ¡ginas de la ladder que ocupan a esta divisiÃ³n. */
  firstPage: number;
  lastPage: number;
  /** PÃ¡ginas leÃ­das de verdad para buscar candidatos. */
  pagesScanned: number[];
  candidatesTried: number;
  pick: SelectionPick | null;
  rejections: SelectionRejection[];
  /** Avisos no fatales: por ejemplo, un lÃ­mite que hubo que corregir a ojo. */
  notes: string[];
};

export type SelectionResult = {
  leaderboard: string;
  totalLadderPlayers: number;
  lastPage: number;
  minRecentRankedGames: number;
  recentWindowDays: number;
  divisions: DivisionSelection[];
  picks: SelectionPick[];
  /** Divisiones sin candidato vÃ¡lido: la simulaciÃ³n queda incompleta. */
  missingDivisions: DivisionId[];
  /** Peticiones a la ladder, para poder comparar con la estimaciÃ³n. */
  ladderRequests: number;
  /** Peticiones a las partidas de los candidatos. */
  gameRequests: number;
};

export type SelectionOptions = {
  client: Aoe4WorldClient;
  leaderboard?: string;
  minRecentRankedGames?: number;
  recentWindowDays?: number;
  maxPagesPerDivision?: number;
  maxCandidatesPerDivision?: number;
  maxBoundaryProbePages?: number;
  signal?: AbortSignal;
  /** "Ahora" de la simulaciÃ³n; se pasa para que la ventana sea reproducible. */
  now?: Date;
  onProgress?: (message: string) => void;
};

type LadderReader = {
  /** PÃ¡gina pedida, o `null` si estÃ¡ mÃ¡s allÃ¡ del final de la ladder. */
  at(page: number): Promise<Aoe4WorldLadderPage | null>;
  requests(): number;
  lastPage(): number | null;
};

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : `Error desconocido: ${String(error)}`;
}

/**
 * Lector de pÃ¡ginas de la ladder con cachÃ©.
 *
 * La cachÃ© no es una optimizaciÃ³n menor: la bÃºsqueda binaria visita pÃ¡ginas que
 * ya se han leÃ­do (al corregir un lÃ­mite, al derivar el final de una divisiÃ³n del
 * principio de la siguiente) y sin ella el mismo tramo se pedirÃ­a dos veces.
 *
 * Una pÃ¡gina vacÃ­a (mÃ¡s allÃ¡ del final) se cachea como `null` y no se reintenta:
 * la API contesta `200` con `players: []` en lugar de un 404.
 */
function createLadderReader(
  client: Aoe4WorldClient,
  leaderboard: string,
  signal: AbortSignal | undefined,
): LadderReader {
  const cache = new Map<number, Aoe4WorldLadderPage | null>();
  let requests = 0;
  let lastPage: number | null = null;

  return {
    async at(page) {
      const cached = cache.get(page);

      if (cached !== undefined) {
        return cached;
      }

      requests += 1;

      let loaded: Aoe4WorldLadderPage | null;

      try {
        const response = await client.getLadderPage(
          leaderboard,
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
        // El tamaÃ±o de pÃ¡gina efectivo lo dice la respuesta, no el pedido: si se
        // pidieran 100 y la API devuelva 50, el final de la ladder estÃ¡ al doble.
        const perPage = Math.max(1, loaded.perPage);
        lastPage = Math.max(lastPage ?? 0, Math.ceil(loaded.totalCount / perPage));
      }

      return loaded;
    },

    requests() {
      return requests;
    },

    lastPage() {
      return lastPage;
    },
  };
}

/**
 * PosiciÃ³n de una divisiÃ³n en el orden de `DIVISIONS` (0 = la mÃ¡s dÃ©bil).
 *
 * Reutiliza el orden del catÃ¡logo en lugar de declarar otro: `DIVISIONS` va de
 * bronce a conquistador, que es justo el eje por el que la ladder desciende.
 */
function ordinal(division: DivisionId): number {
  return DIVISIONS.findIndex((candidate) => candidate.id === division);
}

function entryDivision(entry: Aoe4WorldLeaderboardEntry): DivisionId | null {
  return divisionFromRankLevel(entry.rankLevel);
}

/** DivisiÃ³n del primer jugador de la pÃ¡gina (`null` si la pÃ¡gina estÃ¡ vacÃ­a). */
function firstOrdinal(page: Aoe4WorldLadderPage): number | null {
  const division = entryDivision(page.players[0]);

  return division === null ? null : ordinal(division);
}

/** DivisiÃ³n del Ãºltimo jugador de la pÃ¡gina (`null` si la pÃ¡gina estÃ¡ vacÃ­a). */
function lastOrdinal(page: Aoe4WorldLadderPage): number | null {
  const division = entryDivision(page.players[page.players.length - 1]);

  return division === null ? null : ordinal(division);
}

/**
 * Primera pÃ¡gina cuyo **primer** jugador es de la divisiÃ³n o de una mÃ¡s dÃ©bil.
 *
 * Es un `lower_bound` sobre el predicado `primerJugador <= divisiÃ³n`: como la
 * ladder baja de rating con el nÃºmero de pÃ¡gina, el predicado pasa de falso a
 * verdadero una sola vez y la bÃºsqueda binaria es vÃ¡lida.
 */
async function firstPageOf(
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

    const first = firstOrdinal(page);

    if (first !== null && first <= target) {
      answer = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }

  return answer;
}

/**
 * Corrige un lÃ­mite devuelto por la bÃºsqueda binaria con un paseo corto.
 *
 * La bÃºsqueda binaria exige que la divisiÃ³n **no** se entrelace. En la prÃ¡ctica es
 * cierto de bloque en bloque, pero el rating de cada jugador fluctÃºa y en un
 * bloque largo puede haber algÃºn desajuste; sin esta comprobaciÃ³n, un lÃ­mite
 * equivocado descartarÃ­a divisiones enteras sin avisar.
 *
 * Solo se mueve el lÃ­mite mientras la pÃ¡gina vecina diga que estÃ¡ corrido, y como
 * mucho `maxProbe` pÃ¡ginas: es una correcciÃ³n acotada, no un recorrido.
 */
async function correctBoundary(
  reader: LadderReader,
  guess: number,
  target: number,
  minPage: number,
  maxProbe: number,
): Promise<{ page: number; corrected: boolean; exhausted: boolean }> {
  let page = guess;

  for (let probe = 0; probe < maxProbe; probe += 1) {
    const current = await reader.at(page);

    if (current === null) {
      return { page, corrected: false, exhausted: false };
    }

    const first = firstOrdinal(current);

    if (first !== null && first < target) {
      page += 1;
      continue;
    }

    if (page > minPage) {
      const above = await reader.at(page - 1);
      const last = above === null ? null : lastOrdinal(above);

      if (last !== null && last === target) {
        page -= 1;
        continue;
      }
    }

    return { page, corrected: page !== guess, exhausted: false };
  }

  return { page, corrected: page !== guess, exhausted: true };
}

type DivisionProbe = {
  recentRankedGames: number;
  /** `true` en cuanto se alcanza el objetivo; el resto de la pÃ¡gina no se cuenta. */
  enough: boolean;
  /** Partidas de la ventana de otras ladders: no cuentan para el mÃ­nimo. */
  otherLadderGames: number;
  /** Partidas que el worker descartarÃ­a al importar (sin desempate o sin este jugador). */
  skippedGames: number;
  error: string | null;
};

/**
 * Cuenta las partidas de ladder del candidato en la ventana reciente.
 *
 * **Una sola pÃ¡gina basta**: se piden 50 (el mÃ¡ximo real de la API) y el objetivo
 * son 21, asÃ­ que nadie que supere el mÃ­nimo puede quedarse corto por falta de
 * pÃ¡ginas. Y se cuenta con `normalizeGame`, el mismo criterio del import, para
 * que el nÃºmero del informe sea el nÃºmero de filas que acabarÃ­an en la tabla
 * `Match`: una partida en la que el jugador no aparece (la jugada con un alt) o
 * que la API no ha resuelto no son una fila de este jugador.
 *
 * `includeAlts` se manda a `false` por lo mismo: el worker sincroniza el perfil
 * principal, y lo que se juega con un alt pertenece a otro `profile_id` y no se
 * puede atribuir a esta fila.
 *
 * `leaderboard=rm_solo` acota en la API (comprobado: `total_count` baja a 28 de
 * 114 en un jugador de ejemplo) y el filtro por `leaderboard` del resultado es la
 * red de seguridad por si el parÃ¡metro dejara de aplicarse.
 */
async function probeRecentRankedGames(
  client: Aoe4WorldClient,
  profileId: number,
  since: Date,
  target: number,
  now: Date,
  signal: AbortSignal | undefined,
): Promise<DivisionProbe> {
  const probe: DivisionProbe = {
    recentRankedGames: 0,
    enough: false,
    otherLadderGames: 0,
    skippedGames: 0,
    error: null,
  };

  let page;

  try {
    page = await client.getPlayerGames(
      profileId,
      {
        since,
        leaderboard: DEFAULT_LEADERBOARD,
        limit: GAMES_MAX_PAGE_SIZE,
        includeAlts: false,
      },
      signal === undefined ? undefined : { signal },
    );
  } catch (error) {
    return { ...probe, error: toErrorMessage(error) };
  }

  for (const game of page.games) {
    const normalized = normalizeGame(game, profileId, now);

    if (normalized.status !== "ok") {
      probe.skippedGames += 1;
      continue;
    }

    if (normalized.match.leaderboard !== DEFAULT_LEADERBOARD) {
      probe.otherLadderGames += 1;
      continue;
    }

    probe.recentRankedGames += 1;

    if (probe.recentRankedGames >= target) {
      probe.enough = true;
      break;
    }
  }

  return probe;
}

function toPick(
  entry: Aoe4WorldLeaderboardEntry,
  division: DivisionId,
  recentRankedGames: number,
): SelectionPick {
  return {
    profileId: entry.profileId,
    name: entry.name,
    division,
    rankLevel: entry.rankLevel,
    rating: entry.rating,
    ladderRank: entry.rank,
    twitchChannel: normalizeTwitchChannel(entry.twitchUrl),
    avatarUrl: entry.avatars.full,
    recentRankedGames,
  };
}

export async function selectTournamentPlayers(
  options: SelectionOptions,
): Promise<SelectionResult> {
  const leaderboard = options.leaderboard ?? DEFAULT_LEADERBOARD;
  const minRecentRankedGames = options.minRecentRankedGames ?? MIN_RECENT_RANKED_GAMES;
  const recentWindowDays = options.recentWindowDays ?? RECENT_WINDOW_DAYS;
  const maxPagesPerDivision = options.maxPagesPerDivision ?? SELECTION_DEFAULTS.maxPagesPerDivision;
  const maxCandidatesPerDivision =
    options.maxCandidatesPerDivision ?? SELECTION_DEFAULTS.maxCandidatesPerDivision;
  const maxBoundaryProbePages =
    options.maxBoundaryProbePages ?? SELECTION_DEFAULTS.maxBoundaryProbePages;
  const now = options.now ?? new Date();
  const signal = options.signal;
  const onProgress = options.onProgress ?? (() => undefined);

  const reader = createLadderReader(options.client, leaderboard, signal);
  const since = new Date(now.getTime() - recentWindowDays * 86_400_000);
  // Se pide un objetivo de `mÃ­nimo + 1` porque el requisito es "mÃ¡s de N": con N
  // partidas no se entra, asÃ­ que la comprobaciÃ³n que decide es `>= objetivo`.
  const target = minRecentRankedGames + 1;

  // 1. La primera pÃ¡gina da el tamaÃ±o total y, con Ã©l, la Ãºltima.
  const first = await reader.at(1);

  if (first === null) {
    throw new Error(`La ladder ${leaderboard} no devuelve jugadores en la primera pÃ¡gina.`);
  }

  const lastPage = reader.lastPage() ?? 1;
  const totalLadderPlayers = first.totalCount;

  onProgress(
    `Ladder ${leaderboard}: ${totalLadderPlayers} jugadores en ${lastPage} pÃ¡ginas de ${first.perPage}.`,
  );

  // 2. Primera pÃ¡gina de cada divisiÃ³n, de la mÃ¡s fuerte a la mÃ¡s dÃ©bil. La
  //    primera no cuesta nada (es la pÃ¡gina 1) y cada bÃºsqueda arranca donde
  //    acabÃ³ la anterior, asÃ­ que el rango se estrecha en cada paso.
  const strongestFirst = [...DIVISIONS].reverse();
  const starts = new Map<DivisionId, number>();
  const notesByDivision = new Map<DivisionId, string[]>();
  let searchLow = 1;

  for (const division of strongestFirst) {
    const divisionOrdinal = ordinal(division.id);
    let start: number;

    if (starts.size === 0) {
      start = searchLow;
    } else {
      start = (await firstPageOf(reader, searchLow, lastPage, divisionOrdinal)) ?? lastPage + 1;
    }

    const notes = notesByDivision.get(division.id) ?? [];
    const corrected = await correctBoundary(
      reader,
      start,
      divisionOrdinal,
      searchLow,
      maxBoundaryProbePages,
    );

    if (corrected.exhausted) {
      notes.push(
        `el lÃ­mite de ${division.label} se corrigiÃ³ ${maxBoundaryProbePages} pÃ¡ginas sin converger; se queda en la pÃ¡gina ${corrected.page}`,
      );
    }

    starts.set(division.id, corrected.page);
    notesByDivision.set(division.id, notes);
    searchLow = corrected.page;
  }

  // 3. El final de cada divisiÃ³n es el principio de la siguiente menos uno: los
  //    bloques son contiguos, asÃ­ que no hace falta una segunda bÃºsqueda por
  //    divisiÃ³n (y asÃ­ son ~45 llamadas en vez de ~90).
  const divisions: DivisionSelection[] = [];

  for (let index = 0; index < strongestFirst.length; index += 1) {
    const division = strongestFirst[index];
    const next = strongestFirst[index + 1];
    const firstPage = starts.get(division.id) ?? 1;
    const lastPageOfDivision =
      next === undefined ? lastPage : Math.min(lastPage, (starts.get(next.id) ?? lastPage + 1) - 1);

    divisions.push({
      division: division.id,
      firstPage,
      lastPage: lastPageOfDivision,
      pagesScanned: [],
      candidatesTried: 0,
      pick: null,
      rejections: [],
      notes: notesByDivision.get(division.id) ?? [],
    });
  }

  // El recorrido va de la divisiÃ³n mÃ¡s fuerte a la mÃ¡s dÃ©bil para que el informe
  // se lea en el mismo orden que la clasificaciÃ³n.
  const ordered = [...divisions].reverse();

  let gameRequests = 0;

  // 4. Candidatos: primeras pÃ¡ginas del bloque (los puestos mÃ¡s altos de cada
  //    divisiÃ³n) y, de cada una, los jugadores cuya divisiÃ³n resuelta es la suya.
  for (const selection of ordered) {
    if (selection.firstPage > selection.lastPage) {
      selection.notes.push("la divisiÃ³n no tiene jugadores en la ladder");
      continue;
    }

    const scanEnd = Math.min(selection.lastPage, selection.firstPage + maxPagesPerDivision - 1);
    const candidates: Aoe4WorldLeaderboardEntry[] = [];

    for (let page = selection.firstPage; page <= scanEnd; page += 1) {
      const loaded = await reader.at(page);

      selection.pagesScanned.push(page);

      if (loaded === null) {
        continue;
      }

      for (const entry of loaded.players) {
        if (entryDivision(entry) === selection.division) {
          candidates.push(entry);
        }
      }
    }

    onProgress(
      `  ${selection.division}: pÃ¡ginas ${selection.firstPage}-${selection.lastPage} de la ladder, ` +
        `${candidates.length} candidatos en las ${selection.pagesScanned.length} leÃ­das.`,
    );

    for (const entry of candidates) {
      if (selection.pick !== null || selection.candidatesTried >= maxCandidatesPerDivision) {
        break;
      }

      selection.candidatesTried += 1;
      gameRequests += 1;

      const probe = await probeRecentRankedGames(
        options.client,
        entry.profileId,
        since,
        target,
        now,
        signal,
      );

      if (probe.error !== null) {
        selection.rejections.push({
          profileId: entry.profileId,
          name: entry.name,
          division: selection.division,
          rankLevel: entry.rankLevel,
          rating: entry.rating,
          ladderRank: entry.rank,
          recentRankedGames: 0,
          reason: `no se han podido pedir sus partidas: ${probe.error}`,
        });
        continue;
      }

      if (probe.recentRankedGames < target) {
        selection.rejections.push({
          profileId: entry.profileId,
          name: entry.name,
          division: selection.division,
          rankLevel: entry.rankLevel,
          rating: entry.rating,
          ladderRank: entry.rank,
          recentRankedGames: probe.recentRankedGames,
          reason: `solo ${probe.recentRankedGames} partidas de ladder en ${recentWindowDays} dÃ­as ` +
            `(se piden ${target}; otras ladders: ${probe.otherLadderGames}, descartadas: ${probe.skippedGames})`,
        });
        continue;
      }

      selection.pick = toPick(entry, selection.division, probe.recentRankedGames);
    }

    if (selection.pick === null && selection.candidatesTried >= maxCandidatesPerDivision) {
      selection.notes.push(
        `se agotaron los ${maxCandidatesPerDivision} candidatos permitidos sin llegar al mÃ­nimo`,
      );
    }
  }

  const picks = ordered
    .map((selection) => selection.pick)
    .filter((pick): pick is SelectionPick => pick !== null);
  const missingDivisions = ordered
    .filter((selection) => selection.pick === null)
    .map((selection) => selection.division);

  return {
    leaderboard,
    totalLadderPlayers,
    lastPage,
    minRecentRankedGames,
    recentWindowDays,
    divisions,
    picks,
    missingDivisions,
    ladderRequests: reader.requests(),
    gameRequests,
  };
}
