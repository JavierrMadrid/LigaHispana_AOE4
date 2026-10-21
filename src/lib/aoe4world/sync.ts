import "server-only";

import type { LadderCutoffsTable } from "@/lib/alerts/division-cutoffs";
import { evaluateAlerts, type EvaluateAlertsResult } from "@/lib/alerts/evaluate";
import { readDivisionCutoffs } from "@/lib/alerts/settings";
import { checkDiscordMembership, describeDiscordChecks, type DiscordChecksResult } from "@/lib/discord/check";
import {
  describeEditionEventEligibility,
  syncEditionEventEligibility,
} from "@/lib/discord/event-eligibility";
import { describeParticipantRoleSync } from "@/lib/discord/participant-role";
import { syncParticipantRole } from "@/lib/discord/role-sync";
import { db } from "@/lib/db";
import { announceEditionWindow } from "@/lib/edition-announcements";
import { announceEditionEvents } from "@/lib/edition-event-announcements";
import {
  checkPlayerHistory,
  describeHistoryChecks,
  type HistoryChecksResult,
} from "@/lib/history-checks";
import {
  GAMES_BATCH_ERRORS_LIMIT,
  mergeAbandonedAudit,
  readGamesCursor,
  readPlayerSyncState,
  readSyncRunTrace,
  writeGamesCursor,
  writePlayerSyncState,
  writeSyncRunTrace,
  type GamesBatchError,
  type GamesCursorSeedSource,
  type GamesCursorState,
  type SyncRunTrace,
} from "@/lib/settings";
import { countsAsRanked, type TeamTierContext } from "@/lib/ranked-match";
import {
  recomputeScores,
  readRuleset,
  type RecomputeScoresResult,
  type ScoringRuleset,
} from "@/lib/scoring";
import {
  describeStreamRefresh,
  refreshStreamLiveStatus,
  type StreamRefreshResult,
} from "@/lib/streams/refresh";
import { announceDailyStandings } from "@/lib/standings-report";
import {
  backfillMatchSummaries,
  describeSummaryBackfill,
  type SummaryBackfillResult,
} from "@/lib/sync-summaries";
import { createAoe4WorldClient, GAMES_BULK_MAX_PAGE, type Aoe4WorldClient } from "./client";
import { getAoe4WorldConfig } from "./env";
import { Aoe4WorldError, Aoe4WorldNotFoundError } from "./http";
import { syncLadderSnapshot, type LadderSyncResult } from "./ladder";
import { refreshMapPool, type MapPoolRefreshResult } from "./map-pool";
import { normalizeGame, reconciliationCutoff, type NormalizedMatch } from "./normalize";
import type { Aoe4WorldGame } from "./types";

/**
 * Sincronización de partidas de los participantes aprobados.
 *
 * Por jugador: se pide el perfil (para guardar el nombre oficial de AoE4World y
 * refrescar el avatar), se paginan las partidas de **todas** las ladders, se
 * normalizan y se guardan las nuevas con deduplicación por
 * `(playerId, gameId)`. Un jugador que falle no tumba el lote: su error queda
 * registrado y el resto sigue.
 *
 * Además, una vez por pasada y antes del bucle, se toma una instantánea de la
 * ladder (`ladder.ts`): elo, división, racha y directo de Twitch de todos los
 * aprobados en una sola llamada.
 *
 * Al final se recalcula la clasificación y, si algo ha cambiado para alguien, se
 * evaluan las alertas de comportamiento **de ese jugador y solo de ese**. Es lo
 * que cumple el requisito de "siempre actualizada" sin que nadie tenga que
 * recargar: cada pasada del worker deja la tabla de puntos al día y el historial
 * de alertas al día.
 *
 * Y justo **antes del recálculo** —que es quien lo lee— se refresca el pool de mapas
 * del objetivo `por-tierra-y-agua` (`src/lib/aoe4world/map-pool.ts`), como mucho una
 * vez al día y desde el homepage de AoE4World, porque la API no lo expone. Un fallo
 * de ese parseo deja `Setting` como estaba y no rompe nada.
 *
 * Y **en el mismo sitio**, también antes del recálculo porque el motor de objetivos
 * es quien lee lo que escribe, se rellena el **summary de las partidas que aún no lo
 * tienen** (`src/lib/sync-summaries.ts`): los APM, la edad a la que se llegó y los
 * aldeanos perdidos, que son lo que cobran `ansioso`, los tres
 * `avance-relampago-*` y `defensor-del-pueblo`. Son peticiones al **sitio** de
 * AoE4World (su ruta de summary no es la API) con su propio presupuesto por pasada y
 * su cola de más nueva a más vieja, y un fallo suyo no tumba la pasada: deja esos
 * objetivos sin datos hasta la siguiente y el motivo en el rastro.
 *
 * Después, y antes de los directos, se comprueba **el historial de partidas en el
 * juego** de los participantes (`src/lib/history-checks.ts`): si alguien tiene el
 * toggle "Share History" cerrado, lo sabemos, y si la ladder registra una partida
 * que no nos ha llegado, también. Es el único paso de la pasada que sale a una ruta
 * **del sitio** de AoE4World y no a su API, y lleva su propio presupuesto: un `HEAD`
 * de 0 bytes por partida, tres partidas como mucho y solo para quien tiene vencida la
 * caché de 12 horas.
 *
 * Y en el mismo sitio, con el mismo trato, la **pertenencia al servidor de Discord**
 * (`src/lib/discord/check.ts`, F12): para saber si la organización sigue teniendo por
 * dónde hablar con esa persona. Sale con la **lista de miembros del servidor** cuando
 * esa lista se puede leer —una lectura por cada mil miembros, cacheada doce horas, que
 * además resuelve la cuenta de quien solo tiene `@usuario`—, y si no se puede leer cae
 * a una petición por cuenta vinculada. A quien no tenga Discord no se le comprueba ni
 * se le avisa, y lo que no se ha podido comprobar no se escribe.
 *
 * Y en el último sitio, y con la misma tolerancia, se comprueba el estado de
 * directo de **YouTube y Kick** (`src/lib/streams/`): al final porque no depende de
 * nada de lo anterior y porque, si falla, lo único que se pierde es un icono. Vive
 * aquí y no en el DAL porque son peticiones salientes a dos APIs externas y en el
 * plan Free de Cloudflare eso solo cabe una vez por pasada.
 *
 * Y **lo último de todo** es el aviso del comienzo y el final del torneo en Discord
 * (`src/lib/edition-announcements.ts`): mira la ventana del ruleset y manda un mensaje
 * al canal de avisos cuando cruza cada extremo, una sola vez por edición. Sin nada que
 * anunciar no lee el nombre de la edición ni crea ningún cliente HTTP, y un fallo suyo
 * va al rastro (`announceError`) sin mover `lastSuccessAt`.
 */

/**
 * Margen que se le resta al cursor para volver a pedir una franja ya vista.
 *
 * El invariante es `SYNC_OVERLAP_MINUTES >= LADDER_PUBLICATION_LAG_MINUTES`: lo
 * que el incremental no puede ver por quedar por debajo del cursor tiene que
 * caer dentro de la franja que la regla de la ladder declara no poder juzgar.
 * Con el margen de 75 min, 90 deja 15 de holgura.
 */
export const SYNC_OVERLAP_MINUTES = 90;

const SYNC_OVERLAP_MS = SYNC_OVERLAP_MINUTES * 60_000;

/**
 * Edad a la que el `updated_since` de un cursor vivo deja de ser fiable.
 *
 * F0 midió que la API empieza a devolver `_important_notice_` con ventanas de 30
 * días o más. No tiene nada que ver con `AOE4WORLD_SYNC_SEED_MAX_AGE_MINUTES`:
 * esa cota solo se aplica a la **siembra inicial**, no a un cursor que ya existe.
 */
const GAMES_CURSOR_NOTICE_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Caché de perfil: a partir de una hora se vuelve a pedir `GET /players/:id`. */
export const PROFILE_CACHE_TTL_HOURS = 1;

export const PROFILE_CACHE_TTL_MS = PROFILE_CACHE_TTL_HOURS * 60 * 60_000;

/**
 * ¿Toca pedir el perfil de este jugador?
 *
 * `null` es "nunca comprobado" y siempre toca. Una fecha futura se considera
 * fresca (no se puede haber comprobado en el futuro; si el reloj se movió, no
 * hay que pedir nada). `ttlMs = 0` desactiva la caché y toca siempre.
 */
export function shouldRefreshProfile(
  checkedAt: Date | null,
  now: Date,
  ttlMs: number,
): boolean {
  if (checkedAt === null) {
    return true;
  }

  if (ttlMs <= 0) {
    return true;
  }

  const elapsed = now.getTime() - checkedAt.getTime();

  if (elapsed < 0) {
    return false;
  }

  return elapsed >= ttlMs;
}

/* -------------------------------------------------------------------------- */
/* Piezas puras del cursor global y del relleno                                */
/* -------------------------------------------------------------------------- */

/** Un lote del masivo, con el estado que decide si hay que encolarlo. */
export type GamesBatch = {
  profileIds: number[];
  incomplete: boolean;
};

/** Lo que el relleno necesita saber de cada jugador del lote. */
export type BackfillPlayerState = {
  profileId: number;
  windowComplete: boolean;
  backfillPage: number;
};

export type BackfillQueueAction = "rewind" | "keepPage";

export type BackfillQueueEntry = {
  profileId: number;
  action: BackfillQueueAction;
};

export type BackfillPlan = {
  since: Date;
  startPage: number;
  pages: number;
};

/** Las tres guardas de avance del cursor global. */
export type GamesCursorAdvanceInput = {
  directed: boolean;
  batchesFailed: number;
  aborted: boolean;
  maxUpdatedAt: Date | null;
};

export type BackfillWatchdogState = Pick<
  GamesCursorState,
  "bulkIncompleteStreak" | "pendingBestCount" | "pendingBestAt"
>;

export type BackfillThresholds = {
  maxIncompleteStreak?: number;
  pendingStaleMs?: number;
};

/** Trocea ids en lotes de `size`; con una lista vacía devuelve cero lotes. */
export function groupProfileIds(ids: readonly number[], size: number): number[][] {
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error(`El tamaño de lote tiene que ser un entero positivo (recibido: ${size}).`);
  }

  const batches: number[][] = [];

  for (let start = 0; start < ids.length; start += size) {
    batches.push(ids.slice(start, start + size));
  }

  return batches;
}

/**
 * Reparte las partidas de un lote entre sus jugadores.
 *
 * Solo se queda con los ids que se le pasan: una partida entre un jugador del
 * lote y otro de fuera no se le asigna al de fuera. Si dos jugadores del lote
 * comparten una partida (2v2, 3v3…), la partida aparece en los dos arrays una
 * vez por jugador, que es justo lo que `persistMatches()` necesita.
 */
export function splitGamesByPlayer(
  games: readonly Aoe4WorldGame[],
  profileIds: readonly number[],
): Map<number, Aoe4WorldGame[]> {
  const ids = [...new Set(profileIds)];
  const byProfile = new Map<number, Aoe4WorldGame[]>(ids.map((id) => [id, []]));
  const inBatch = new Set(ids);

  for (const game of games) {
    const assigned = new Set<number>();

    for (const team of game.teams) {
      for (const side of team) {
        const profileId = side.profileId;

        if (profileId === null || !inBatch.has(profileId) || assigned.has(profileId)) {
          continue;
        }

        assigned.add(profileId);
        byProfile.get(profileId)?.push(game);
      }
    }
  }

  return byProfile;
}

/**
 * Siembra acotada del cursor global.
 *
 * `floor = max(window.from, now − capMs)` y `ceiling = now`; si el último acierto
 * del rastro cae dentro se usa tal cual. El `capMs = 0` desactiva la cota. La
 * diferencia con `now` se resta después como solape.
 */
export function seedGamesCursor(
  trace: Pick<SyncRunTrace, "finishedAt"> | null,
  windowFrom: Date,
  now: Date,
  overlapMs: number,
  capMs: number,
): { updatedAt: Date; seededFrom: GamesCursorSeedSource } {
  const floor =
    capMs > 0
      ? new Date(Math.max(windowFrom.getTime(), now.getTime() - capMs))
      : windowFrom;
  const finishedMs = trace === null ? Number.NaN : Date.parse(trace.finishedAt);

  if (Number.isNaN(finishedMs)) {
    return {
      updatedAt: new Date(now.getTime() - overlapMs),
      seededFrom: "catch-up",
    };
  }

  const base = new Date(
    Math.min(Math.max(finishedMs, floor.getTime()), now.getTime()),
  );

  return {
    updatedAt: new Date(base.getTime() - overlapMs),
    seededFrom: "sync.lastRun.finishedAt",
  };
}

/**
 * Cursor siguiente a partir de lo leído: el mayor `updatedAt` menos el solape.
 *
 * Nunca retrocede: si el candidato queda por debajo del anterior, se conserva el
 * anterior. Sin partidas con `updatedAt` devuelve `null` y el llamador no escribe.
 */
export function nextGamesCursor(
  previous: Date | null,
  games: readonly Aoe4WorldGame[],
  overlapMs: number,
): Date | null {
  let maxUpdatedAtMs: number | null = null;

  for (const game of games) {
    const updatedAtMs = game.updatedAt?.getTime();

    if (
      updatedAtMs !== undefined &&
      !Number.isNaN(updatedAtMs) &&
      (maxUpdatedAtMs === null || updatedAtMs > maxUpdatedAtMs)
    ) {
      maxUpdatedAtMs = updatedAtMs;
    }
  }

  if (maxUpdatedAtMs === null) {
    return null;
  }

  const candidate = maxUpdatedAtMs - overlapMs;

  if (previous !== null && previous.getTime() > candidate) {
    return previous;
  }

  return new Date(candidate);
}

/** Las tres guardas: ni dirigida, ni lote fallido, ni plazo, ni cero partidas. */
export function shouldAdvanceGamesCursor(input: GamesCursorAdvanceInput): boolean {
  return (
    !input.directed &&
    input.batchesFailed === 0 &&
    !input.aborted &&
    input.maxUpdatedAt !== null
  );
}

function isBackfillStateArray(
  value: ReadonlyMap<number, BackfillPlayerState> | readonly BackfillPlayerState[],
): value is readonly BackfillPlayerState[] {
  return Array.isArray(value);
}

/**
 * Jugadores de los lotes truncados, con la acción que les toca.
 *
 * `keepPage` solo para quien ya iba a mitad de recorrido: rebobinarlo gastaría
 * las páginas que ya había leído. Sin fila o con la ventana completa, `rewind`.
 * Los ids repetidos se quedan con la primera acción vista.
 */
export function playersToQueueForBackfill(
  batches: readonly GamesBatch[],
  states: ReadonlyMap<number, BackfillPlayerState> | readonly BackfillPlayerState[],
): BackfillQueueEntry[] {
  const byProfile = new Map<number, BackfillPlayerState>();

  if (isBackfillStateArray(states)) {
    for (const state of states) {
      byProfile.set(state.profileId, state);
    }
  } else {
    for (const [profileId, state] of states) {
      byProfile.set(profileId, state);
    }
  }

  const queued = new Map<number, BackfillQueueAction>();

  for (const batch of batches) {
    if (!batch.incomplete) {
      continue;
    }

    for (const profileId of batch.profileIds) {
      if (queued.has(profileId)) {
        continue;
      }

      const state = byProfile.get(profileId);
      const action: BackfillQueueAction =
        state !== undefined && !state.windowComplete && state.backfillPage > 1
          ? "keepPage"
          : "rewind";

      queued.set(profileId, action);
    }
  }

  return [...queued].map(([profileId, action]) => ({ profileId, action }));
}

/** Plan de una pasada de relleno, o `null` si la ventana ya está completa. */
export function backfillPlan(
  player: Pick<BackfillPlayerState, "windowComplete" | "backfillPage"> & {
    registeredAt: Date | null;
  },
  windowFrom: Date,
  pagesPerPlayer: number,
): BackfillPlan | null {
  if (player.windowComplete) {
    return null;
  }

  const since =
    player.registeredAt !== null && player.registeredAt.getTime() > windowFrom.getTime()
      ? player.registeredAt
      : windowFrom;

  return {
    since,
    startPage: Math.max(1, player.backfillPage),
    pages: pagesPerPlayer,
  };
}

/**
 * Actualiza la racha de truncación y el mejor `backfillPending` visto.
 *
 * La racha sube una unidad por pasada con truncación y se resetea a cero en la
 * primera limpia. El mínimo solo se mueve cuando aparece uno nuevo (o el primero):
 * si no baja, `count` y `at` se quedan intactos.
 */
export function nextBackfillWatchdog(
  state: BackfillWatchdogState,
  pending: number | null,
  incompleteThisPass: number,
  now: Date,
): BackfillWatchdogState {
  const bulkIncompleteStreak =
    incompleteThisPass > 0 ? state.bulkIncompleteStreak + 1 : 0;
  let pendingBestCount = state.pendingBestCount;
  let pendingBestAt = state.pendingBestAt;

  if (pending !== null && (pendingBestAt === null || pending < pendingBestCount)) {
    pendingBestCount = pending;
    pendingBestAt = now.toISOString();
  }

  return { bulkIncompleteStreak, pendingBestCount, pendingBestAt };
}

/**
 * ¿Lleva el relleno demasiado tiempo sin avanzar?
 *
 * Con `pending` a `null` o `0` no hay atasco por construcción. Si no, la alarma
 * salta con siete pasadas seguidas truncando o con un mínimo de 24 h sin bajar.
 */
export function backfillProgressStalled(
  state: Pick<BackfillWatchdogState, "bulkIncompleteStreak" | "pendingBestAt">,
  pending: number | null,
  now: Date,
  thresholds: BackfillThresholds = {},
): boolean {
  if (pending === null || pending === 0) {
    return false;
  }

  const maxIncompleteStreak = thresholds.maxIncompleteStreak ?? 7;
  const pendingStaleMs = thresholds.pendingStaleMs ?? 24 * 60 * 60 * 1000;

  if (state.bulkIncompleteStreak >= maxIncompleteStreak) {
    return true;
  }

  if (state.pendingBestAt === null) {
    return false;
  }

  const pendingBestAtMs = Date.parse(state.pendingBestAt);

  return (
    !Number.isNaN(pendingBestAtMs) &&
    now.getTime() - pendingBestAtMs >= pendingStaleMs
  );
}

/**
 * Regla del torneo: si la API nunca publica el desenlace de una partida, esa
 * partida no cuenta nunca. Se materializa borrando la fila, y no dejando la
 * partida a medias: `finishedAt = null` significa "en curso" para F4, así que
 * una fila sin resolver sería indistinguible de una partida viva y F3 podría
 * colarla por error al contar todo lo que no tenga `finishedAt`.
 *
 * La fila se borra y su `gameId` queda en el rastro de `Setting`, para que la
 * decisión sea auditable sin guardar datos que no cuentan.
 */
const ABANDONED_REASON = "abandonada: la API no ha publicado el desenlace";

export type SyncPlayerStatus = "ok" | "failed" | "cancelled";

export type SyncPlayerResult = {
  profileId: number;
  /**
   * Nombre de display del jugador (`Player.name`), el que escribió en la
   * inscripción. Es lo que identifica al jugador en los logs y en la salida de
   * los scripts, así que **no** se sustituye por el oficial de AoE4World: si la
   * API no llegara a devolver el perfil, el nombre de referencia sigue siendo el
   * que la web muestra.
   */
  name: string;
  status: SyncPlayerStatus;
  error: string | null;
  pages: number;
  gamesSeen: number;
  matchesInserted: number;
  /**
   * Partidas que **entran a contar para el torneo** en esta pasada: las que se
   * insertan ya resueltas y cumplen la regla, más las que estaban **en curso**
   * (`finishedAt = null`) y esta pasada quedan resueltas cumpliéndola —da igual
   * la vía, el listado o el refetch de pendientes—. No es "filas tocadas": una
   * partida en curso que sigue en curso, una anterior al corte de inscripción o
   * al inicio de la ventana, de un modo que no puntúa o de un equipo
   * desequilibrado se guarda (o se refresca) pero **no** cuenta aquí. Es lo que
   * suma `SyncSummary.newMatches`.
   */
  matchesCounted: number;
  matchesUpdated: number;
  matchesSkipped: number;
  /** Partidas sin resolver que el refetch confirmó y resolvió (ya fuera de la ventana). */
  matchesResolvedByRefetch: number;
  /** Partidas borradas por abandono (regla "nunca cuenta"). */
  matchesAbandoned: number;
  liveMatches: number;
  /** ¿Está completa la ventana del torneo de este jugador? */
  windowComplete: boolean;
  /** Página por la que sigue el relleno de su ventana. */
  backfillPage: number;
  /** `since` que usó el relleno, o `null` si el jugador no pasó por él. */
  sinceUsed: string | null;
  /** `since` que quedó en la auditoría del relleno; `null` si no se escribió. */
  sinceStored: string | null;
};

export type SyncSummary = {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  playersTotal: number;
  playersOk: number;
  playersFailed: number;
  playersCancelled: number;
  /**
   * Partidas que **entran a contar para el torneo** en esta pasada, no filas
   * insertadas: la suma de `SyncPlayerResult.matchesCounted`. Cuenta las que se
   * insertan ya resueltas y cumplen la regla, más las que estaban en curso y han
   * quedado resueltas cumpliéndola. Una partida que se guarda pero no puntúa
   * (en curso, fuera de la ventana o del corte de inscripción, de un modo que no
   * puntúa o de un equipo desequilibrado) **no** suma aquí, aunque sí en
   * `updatedMatches` o en el detalle del jugador. Ver `docs/OPERACION.md`.
   */
  newMatches: number;
  updatedMatches: number;
  resolvedByRefetch: number;
  abandonedMatches: number;
  skippedGames: number;
  liveMatches: number;
  apiRequests: number;
  apiRetries: number;
  rateLimitResponses: number;
  rateLimitPausesMs: number;
  /**
   * Instantánea de la ladder (elo, división, racha, directo de Twitch) tomada
   * al principio de la pasada. Su fallo no afecta al resto del resumen.
   */
  ladder: LadderSyncResult;
  /**
   * Refresco del pool de mapas del objetivo `por-tierra-y-agua` desde el homepage
   * de AoE4World. `null` solo si ni siquiera se pudo intentar por un fallo de la
   * base leyendo la contabilidad; el motivo va en `mapPoolError`.
   */
  mapPool: MapPoolRefreshResult | null;
  /**
   * Por qué no se pudo refrescar el pool de mapas, si no se pudo. Un fallo **no**
   * mueve `lastSuccessAt`: el motor sigue con el último pool bueno.
   */
  mapPoolError: string | null;
  /**
   * Relleno de las métricas del summary de las partidas que aún no lo tienen
   * (`src/lib/sync-summaries.ts`): los APM, la edad a la que se llegó y los aldeanos
   * perdidos de los cinco objetivos que los necesitan.
   *
   * **No** es parte de la salud del sincronizador: que no se haya podido leer el
   * summary de unas partidas solo deja esos objetivos sin datos. El motivo va en
   * `summariesError` y **no** mueve `lastSuccessAt`.
   */
  summaries: SummaryBackfillResult | null;
  /**
   * Lo que hay que saber del paso del summary y no es un éxito limpio: summaries
   * que no se han podido leer, partidas que el sitio no tiene, o partidas que
   * quedaron para la siguiente pasada por el presupuesto. `null` cuando todo fue
   * bien o no había nada que pedir.
   */
  summariesError: string | null;
  /** Páginas leídas del endpoint masivo en la pasada. */
  gamesPagesRead: number;
  /** Lotes que agotaron su presupuesto de páginas con la ventana abierta. */
  gamesBatchesIncomplete: number;
  /** Lotes que fallaron enteros. */
  gamesBatchesFailed: number;
  /** Jugadores encolados para el relleno. */
  gamesPlayersQueuedForBackfill: number;
  /** Errores de lote, con su número y su rango de ids. */
  gamesBatchErrors: GamesBatchError[];
  /** `updated_since` que deja la pasada, o `null` si no hay cursor. */
  gamesCursor: string | null;
  /** `true` si el cursor global avanzó. */
  gamesCursorAdvanced: boolean;
  /** `true` si esta pasada sembró el cursor. */
  gamesCursorSeeded: boolean;
  /** Jugadores a los que tocó el relleno. */
  backfillPlayers: number;
  /** Páginas leídas por el relleno. */
  backfillPagesRead: number;
  /** Aprobados con la ventana todavía incompleta al terminar. */
  backfillPending: number;
  /** Aviso de la API (`filters._important_notice_`), si lo mandó. */
  apiNotice: string | null;
  /**
   * Recálculo de la clasificación al final de la pasada. `null` solo si la
   * versión de reglas leída no existe, lo que no debería ocurrir.
   */
  scoring: RecomputeScoresResult | null;
  /** Por qué no se pudo recalcular la clasificación, si no se pudo. */
  scoringError: string | null;
  /**
   * Alertas de comportamiento de **los jugadores tocados** en esta pasada, más
   * la evaluación completa del cierre de torneo si esta pasada ha sido la que lo
   * detectó. `null` si no se pudo evaluar; el motivo va en `alertsError`.
   */
  alerts: EvaluateAlertsResult | null;
  /** Por qué no se pudieron evaluar las alertas, si no se pudieron. */
  alertsError: string | null;
  /**
   * Comprobación del historial de partidas en el juego y de la regla de la ladder
   * (`src/lib/history-checks.ts`). `null` solo si el paso se apagó con
   * `history: false`, que es lo que hace el mock del torneo para no tocar el sitio de
   * AoE4World.
   *
   * **No** es parte de la salud del sincronizador: que no se haya podido comprobar si
   * alguien tiene el historial abierto no ha parado ni una partida de las que sí se han
   * sincronizado. El motivo va en `historyError` y **no** mueve `lastSuccessAt`.
   */
  history: HistoryChecksResult | null;
  /**
   * Lo que hay que saber del paso del historial y no es un éxito limpio: comprobaciones
   * que no se han podido hacer, players que quedaron para la siguiente pasada por el
   * tope, o el mock activo. `null` cuando todo fue bien.
   */
  historyError: string | null;
  /**
   * Comprobación de la pertenencia al servidor de Discord de los participantes que
   * tienen la cuenta vinculada o el `@usuario` (`src/lib/discord/check.ts`).
   *
   * **No** es parte de la salud del sincronizador, por lo mismo que `historyError`:
   * que no se sepa si alguien se ha salido del servidor no ha parado ni una partida.
   * El motivo va en `discordError` y **no** mueve `lastSuccessAt`.
   */
  discord: DiscordChecksResult | null;
  /**
   * Lo que hay que saber del paso de Discord y no es un éxito limpio: cuentas que no
   * se han podido comprobar, participantes que quedaron para la siguiente pasada por el
   * tope, una lista de miembros que no se ha podido leer (típicamente el intent
   * privilegiado `GUILD_MEMBERS` sin activar), o la comprobación apagada por falta de
   * `DISCORD_BOT_TOKEN` o `DISCORD_GUILD_ID`. `null` cuando todo fue bien.
   *
   * **No** mueve `lastSuccessAt` del rastro, igual que `historyError` y
   * `streamsError`: es información sobre si la organización puede hablar con sus
   * participantes, no salud del sincronizador.
   */
  discordError: string | null;
  /**
   * Estado de directo de YouTube y Kick para los participantes con canal. `null`
   * cuando la detección estaba apagada en esta pasada (`streams: false`) o no había
   * nadie con canal, que es lo que hace que una pasada sin nada que hacer no salga a
   * la red.
   */
  streams: StreamRefreshResult | null;
  /**
   * Lo que hay que saber del paso de directos y no es un éxito limpio: fallos,
   * comprobaciones que no se han hecho, o la detección de YouTube apagada por falta
   * de clave. `null` cuando todo fue bien.
   *
   * **No** mueve `lastSuccessAt` del rastro, igual que `alertsError`: es información
   * sobre un icono, no salud del sincronizador.
   */
  streamsError: string | null;
  /**
   * Lo que hay que saber de los **mensajes del bot al canal de avisos**: los hitos de la
   * edición (`src/lib/edition-announcements.ts`) y el informe diario de clasificación
   * (`src/lib/standings-report.ts`). Un envío que ha fallado, o la falta de
   * `DISCORD_BOT_TOKEN` o `DISCORD_ANNOUNCE_CHANNEL_ID`. `null` cuando no tocaba ningún
   * mensaje o los que tocaban salieron.
   *
   * **No** mueve `lastSuccessAt` del rastro, por el mismo motivo que `discordError`: no
   * poder avisar del torneo no ha parado ni una partida.
   */
  announceError: string | null;
  players: SyncPlayerResult[];
};

export type SyncOptions = {
  /** Limita la pasada a estos `profileId`. Por defecto, todos los aprobados. */
  profileIds?: number[];
  /** Inyecta un cliente alternativo (verificaciones con datos de ejemplo). */
  client?: Aoe4WorldClient;
  /** Cancela la pasada; los jugadores pendientes se marcan como cancelados. */
  signal?: AbortSignal;
  /**
   * Comprueba el estado de directo de YouTube y Kick. Por defecto `true`.
   *
   * Existe para `npm run mock:tournament`, que **no debe tocar ninguna API
   * externa** (ni AoE4World, con `AOE4WORLD_MOCK`, ni estas dos): el script planta
   * los canales y el estado de directo del torneo simulado por su cuenta, así que
   * aquí no se pregunta a nadie. Apagado, `streams` sale a `null` en el resumen y no
   * se lee ni se escribe nada.
   */
  streams?: boolean;
  /**
   * Comprueba el historial de partidas en el juego y la regla de la ladder. Por
   * defecto `true`.
   *
   * Existe por el mismo motivo que `streams`: `npm run mock:tournament` **no debe
   * tocar ninguna API externa**, y aquí la ruta que se toca (`HEAD` al sitio de
   * AoE4World) no tiene fixtures. Con el mock activo el propio módulo no sale a la red y
   * devuelve `unknown`, así que apagar esto solo evita el ruido del aviso; apagado,
   * `history` sale a `null` y no se lee ni se escribe nada.
   */
  history?: boolean;
};

type SyncConfig = {
  pageSize: number;
  /** Tope duro de páginas por jugador del relleno. */
  maxPages: number;
  /** Páginas por lote del endpoint masivo (ya recortadas al tope del cliente). */
  bulkMaxPages: number;
  /** Jugadores con la ventana pendiente que se atienden por pasada. */
  backfillMaxPlayers: number;
  /** Páginas por jugador en cada pasada de relleno (sin recortar). */
  backfillPagesPerPlayer: number;
  /** Cota de antigüedad de la semilla del cursor global, en ms. 0 = sin cota. */
  seedMaxAgeMs: number;
  concurrency: number;
  deadlineMs: number;
};

type SyncPlayerRow = {
  id: string;
  profileId: number;
  name: string;
  aoe4WorldName: string | null;
  avatarUrl: string | null;
  /** Sello de la caché de perfil; `null` = sin comprobar. */
  profileCheckedAt: Date | null;
  /**
   * Cuándo se inscribió la persona (`Player.registeredAt`). Es el corte por el que
   * cuenta `countsAsRanked()`: una partida anterior a esta fecha no puntúa. `null`
   * significa "desde el inicio de la ventana".
   */
  registeredAt: Date | null;
  /** ¿Ya se recorrió su ventana del torneo? */
  windowComplete: boolean;
  /** Página por la que sigue el relleno. */
  backfillPage: number;
};

function nowIso(): string {
  return new Date().toISOString();
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return `Error desconocido: ${String(error)}`;
}

function readApprovedPlayers(profileIds: number[] | undefined): Promise<SyncPlayerRow[]> {
  return db.player.findMany({
    where: {
      status: "APPROVED",
      ...(profileIds === undefined ? {} : { profileId: { in: profileIds } }),
    },
    select: {
      id: true,
      profileId: true,
      name: true,
      aoe4WorldName: true,
      avatarUrl: true,
      profileCheckedAt: true,
      registeredAt: true,
      windowComplete: true,
      backfillPage: true,
    },
    orderBy: { profileId: "asc" },
  });
}

function emptyPlayerResult(
  player: SyncPlayerRow,
  overrides: Partial<SyncPlayerResult> = {},
): SyncPlayerResult {
  return {
    profileId: player.profileId,
    name: player.name,
    status: "ok",
    error: null,
    pages: 0,
    gamesSeen: 0,
    matchesInserted: 0,
    matchesCounted: 0,
    matchesUpdated: 0,
    matchesSkipped: 0,
    matchesResolvedByRefetch: 0,
    matchesAbandoned: 0,
    liveMatches: 0,
    windowComplete: player.windowComplete,
    backfillPage: player.backfillPage,
    sinceUsed: null,
    sinceStored: null,
    ...overrides,
  };
}

/**
 * Refresca una fila ya guardada. `points` no se toca a propósito: lo calcula el
 * motor de F3 y aquí no hay nada que decidir. `revertedAt` tampoco, y por el
 * mismo motivo con más fuerza: la marca que pone el panel de admin para que una
 * partida deje de puntuar tiene que sobrevivir a la reimportación, o el revert
 * duraría hasta cinco minutos.
 */
async function applyMatchUpdate(playerId: string, match: NormalizedMatch): Promise<void> {
  await db.match.update({
    where: { playerId_gameId: { playerId, gameId: match.gameId } },
    data: {
      opponentProfileId: match.opponentProfileId,
      opponentName: match.opponentName,
      civ: match.civ,
      opponentCiv: match.opponentCiv,
      civRandomized: match.civRandomized,
      map: match.map,
      leaderboard: match.leaderboard,
      mode: match.mode,
      result: match.result,
      startedAt: match.startedAt,
      finishedAt: match.finishedAt,
      durationSeconds: match.durationSeconds,
      rawJson: match.rawJson,
    },
  });
}

/**
 * ¿Cuenta esta partida recién vista para el torneo, con el ruleset y el
 * `registeredAt` del jugador?
 *
 * Es la costura por la que el contador `matchesCounted` aplica la **regla única**
 * (`countsAsRanked()` de `ranked-match.ts`) a una partida normalizada por el
 * worker. `NormalizedMatch` no lleva `revertedAt`: una fila que el worker acaba
 * de ver nunca está revertida —la marca la pone el panel sobre la fila guardada—,
 * así que se le pasa `null`. El filtro de familia de ladder es el de la regla
 * (las `RANKED_MODES`), el mismo que aplica el motor al puntuar, y `rawJson` va
 * dentro del objeto de la partida porque es lo que necesita la condición de
 * equipos.
 */
function countsForTournament(
  match: NormalizedMatch,
  ruleset: Pick<ScoringRuleset, "window">,
  registeredAt: Date | null,
  context: TeamTierContext,
): boolean {
  return countsAsRanked({ ...match, revertedAt: null }, ruleset.window, registeredAt, context);
}

/**
 * Cuántas de una lista de partidas **entran a contar para el torneo**.
 *
 * Es `countsForTournament()` fila a fila, y es pura: recibe las partidas
 * normalizadas, la ventana del ruleset, el `registeredAt` del jugador y el
 * contexto de equipos (`profileId` y cortes), y no toca ni la base ni la red. Se
 * prueba en `tests/unit/lib/aoe4world/sync.test.ts`.
 *
 * Una partida cuenta solo si está **resuelta**, es de una familia rankeada,
 * empezó dentro del corte del jugador (`max(window.from, registeredAt)`), antes
 * del fin de la ventana y —en equipos— con los compañeros a un escalón o menos.
 * Una fila en curso (`finishedAt === null`) no cuenta todavía: contará en la
 * pasada que la resuelva.
 *
 * Los cortes los lee el worker **una vez por pasada** y los pasa aquí: derivarlos
 * es un trabajo de un solo día de 130 llamadas por familia, y sin ellos la partida
 * cuenta (no se puede demostrar que el equipo esté desequilibrado).
 */
export function countTournamentMatches(
  matches: readonly NormalizedMatch[],
  ruleset: Pick<ScoringRuleset, "window">,
  registeredAt: Date | null,
  context: TeamTierContext,
): number {
  let counted = 0;

  for (const match of matches) {
    if (countsForTournament(match, ruleset, registeredAt, context)) {
      counted += 1;
    }
  }

  return counted;
}

/**
 * Dedup por `(playerId, gameId)`: las partidas terminadas son inmutables, así que
 * basta con insertar las que falten (`skipDuplicates`). Las que ya estaban
 * guardadas en curso sí hay que refrescarlas, porque al terminar les llega el
 * resultado y `finishedAt`.
 *
 * El `counted` que devuelve es la parte de `matchesCounted`: de las que se
 * insertan de verdad (una fila que ya existía por `gameId` queda fuera del alta
 * y del contador) y de las refrescadas que pasan de en curso a resuelta, cuántas
 * cumplen la regla del torneo.
 */
async function persistMatches(
  playerId: string,
  matches: NormalizedMatch[],
  ruleset: Pick<ScoringRuleset, "window">,
  registeredAt: Date | null,
  context: TeamTierContext,
): Promise<{ inserted: number; updated: number; counted: number }> {
  if (matches.length === 0) {
    return { inserted: 0, updated: 0, counted: 0 };
  }

  const existing = await db.match.findMany({
    where: { playerId, gameId: { in: matches.map((match) => match.gameId) } },
    select: { gameId: true, finishedAt: true },
  });

  // Una fila que ya existe por `gameId` no se vuelve a insertar, así que queda
  // fuera del alta y del contador. Solo se refresca la que estaba en curso; el
  // resto ya es definitivo.
  const existingGameIds = new Set(existing.map((row) => row.gameId));
  const unfinished = new Set(
    existing.filter((row) => row.finishedAt === null).map((row) => row.gameId),
  );

  const toCreate = matches.filter((match) => !existingGameIds.has(match.gameId));
  const toRefresh = matches.filter((match) => unfinished.has(match.gameId));

  let inserted = 0;

  if (toCreate.length > 0) {
    // `points` se escribe solo en el alta y a 0: aquí no hay nada que decidir,
    // los puntos los calcula el motor de scoring al final de la pasada. En la
    // actualización no se toca, para no pisar lo que ese motor haya escrito.
    const created = await db.match.createMany({
      data: toCreate.map((match) => ({
        gameId: match.gameId,
        playerId,
        opponentProfileId: match.opponentProfileId,
        opponentName: match.opponentName,
        civ: match.civ,
        opponentCiv: match.opponentCiv,
        civRandomized: match.civRandomized,
        map: match.map,
        leaderboard: match.leaderboard,
        mode: match.mode,
        result: match.result,
        startedAt: match.startedAt,
        finishedAt: match.finishedAt,
        durationSeconds: match.durationSeconds,
        points: 0,
        rawJson: match.rawJson,
      })),
      skipDuplicates: true,
    });

    inserted = created.count;
  }

  for (const match of toRefresh) {
    await applyMatchUpdate(playerId, match);
  }

  // Las de alta y las refrescadas se cuentan igual: una refrescada que cumple la
  // regla estaba en curso (`finishedAt = null`) y ahora está resuelta, así que es
  // una transición a clasificatoria. Las que siguen en curso no cuentan.
  const counted =
    countTournamentMatches(toCreate, ruleset, registeredAt, context) +
    countTournamentMatches(toRefresh, ruleset, registeredAt, context);

  return { inserted, updated: toRefresh.length, counted };
}

type ReconcilePlayerResult = {
  resolved: number;
  /** De las resueltas, las que entran a contar para el torneo (regla única). */
  counted: number;
  abandonedGameIds: string[];
  firstAbandonedStartedAt: Date | null;
};

type ReconcileResult = {
  byProfile: Map<number, ReconcilePlayerResult>;
  /** Jugadores con un error no-404; el primero que apareció. */
  failed: Map<number, string>;
};

function toGameIdNumber(gameId: string): number | null {
  const parsed = Number(gameId);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Reconciliación global de partidas guardadas que ya no pueden estar vivas.
 *
 * Una fila con `finishedAt = null` solo es legítima mientras la partida pueda
 * seguir jugándose. Pasada la ventana de directo, el listado ya no la resuelve:
 * la devuelve, pero `normalizeGame` la clasifica como "cerrada sin resultado" y
 * entonces no se refresca (ni se borra) la fila que ya estaba guardada. Sin esta
 * pasada se quedaría con `finishedAt = null` indefinidamente.
 *
 * Es una sola consulta para toda la pasada, no una por jugador: el conjunto de
 * pendientes suele ser de 0 a 2 y se agrupa en memoria. El corte es la ventana de
 * directo (`reconciliationCutoff()`), no el cursor: una partida abandonada que
 * fuera la más nueva del jugador tiene `startedAt` dentro de la ventana y con el
 * criterio del cursor no se reconciliaría nunca.
 */
async function reconcileUnfinishedMatches(
  players: readonly SyncPlayerRow[],
  profileIds: number[] | undefined,
  client: Aoe4WorldClient,
  signal: AbortSignal,
  ruleset: Pick<ScoringRuleset, "window">,
  cutoffs: LadderCutoffsTable | null,
  now: Date,
): Promise<ReconcileResult> {
  const byId = new Map(players.map((player) => [player.id, player]));
  const pending = await db.match.findMany({
    where: {
      finishedAt: null,
      startedAt: { lt: reconciliationCutoff(now) },
      player: {
        status: "APPROVED",
        ...(profileIds === undefined ? {} : { profileId: { in: profileIds } }),
      },
    },
    select: {
      gameId: true,
      playerId: true,
      startedAt: true,
      player: { select: { profileId: true, registeredAt: true } },
    },
    orderBy: { startedAt: "asc" },
  });

  const groups = new Map<
    string,
    { profileId: number; registeredAt: Date | null; rows: typeof pending }
  >();

  for (const row of pending) {
    const group = groups.get(row.playerId);

    if (group === undefined) {
      groups.set(row.playerId, {
        profileId: row.player.profileId,
        registeredAt: row.player.registeredAt,
        rows: [row],
      });
    } else {
      group.rows.push(row);
    }
  }

  const byProfile = new Map<number, ReconcilePlayerResult>();
  const failed = new Map<number, string>();

  for (const [playerId, group] of groups) {
    const player = byId.get(playerId);

    if (player === undefined) {
      continue;
    }

    const result: ReconcilePlayerResult = {
      resolved: 0,
      counted: 0,
      abandonedGameIds: [],
      firstAbandonedStartedAt: null,
    };
    const context: TeamTierContext = { profileId: player.profileId, cutoffs };
    let playerError: string | null = null;

    try {
      for (const row of group.rows) {
        if (signal.aborted) {
          break;
        }

        const abandon = async (gameId: string, startedAt: Date) => {
          await db.match.delete({
            where: { playerId_gameId: { playerId, gameId } },
          });
          result.abandonedGameIds.push(gameId);

          if (result.firstAbandonedStartedAt === null) {
            result.firstAbandonedStartedAt = startedAt;
          }

          console.warn(
            `[sync] Jugador ${player.profileId}: partida ${gameId} borrada (${ABANDONED_REASON}).`,
          );
        };

        const gameId = toGameIdNumber(row.gameId);

        if (gameId === null) {
          // Una fila que ni siquiera se puede pedir no puede contar para nadie.
          await abandon(row.gameId, row.startedAt);
          continue;
        }

        let finished: Aoe4WorldGame;

        try {
          finished = await client.getPlayerGame(player.profileId, gameId, { signal });
        } catch (error) {
          if (error instanceof Aoe4WorldNotFoundError) {
            // La API ya no conoce la partida: no hay desenlace que esperar.
            await abandon(row.gameId, row.startedAt);
            continue;
          }

          playerError = toErrorMessage(error);
          break;
        }

        const normalized = normalizeGame(finished, player.profileId, now);

        if (normalized.status === "skipped") {
          // Pasada la ventana de 60 min y sin resultado: abandono definitivo.
          await abandon(row.gameId, row.startedAt);
          continue;
        }

        if (normalized.match.finishedAt === null) {
          // La API la sigue dando viva y dentro de ventana: aún no se decide nada.
          continue;
        }

        await applyMatchUpdate(player.id, normalized.match);
        result.resolved += 1;

        // La fila estaba en curso y ahora está resuelta: si cumple la regla,
        // entra a contar en esta pasada.
        if (
          countTournamentMatches([normalized.match], ruleset, player.registeredAt, context) > 0
        ) {
          result.counted += 1;
        }
      }
    } catch (error) {
      playerError = playerError ?? toErrorMessage(error);
    }

    if (result.abandonedGameIds.length > 0) {
      try {
        const previous = await readPlayerSyncState(player.profileId);
        const fallbackStartedAt = result.firstAbandonedStartedAt ?? now;
        const since = previous?.since ?? fallbackStartedAt.toISOString();
        const maxStartedAt = previous?.maxStartedAt ?? fallbackStartedAt.toISOString();

        await writePlayerSyncState(player.profileId, {
          since,
          maxStartedAt,
          lastSyncedAt: nowIso(),
          ...mergeAbandonedAudit(previous, result.abandonedGameIds, nowIso()),
        });
      } catch (error) {
        playerError = playerError ?? toErrorMessage(error);
      }
    }

    byProfile.set(player.profileId, result);

    if (playerError !== null) {
      failed.set(player.profileId, playerError);
    }
  }

  return { byProfile, failed };
}

type FetchedGames = {
  games: Aoe4WorldGame[];
  pages: number;
  maxStartedAt: Date | null;
  /** Página siguiente a la última leída, o `null` si el recorrido terminó. */
  nextPage: number | null;
};

async function fetchPlayerGames(
  client: Aoe4WorldClient,
  profileId: number,
  since: Date | null,
  config: SyncConfig,
  signal: AbortSignal,
  startPage = 1,
  maxPages = config.maxPages,
): Promise<FetchedGames> {
  const games: Aoe4WorldGame[] = [];
  let maxStartedAt: Date | null = null;
  let pages = 0;
  let nextPage: number | null = startPage;

  // La API pagina de la más reciente a la más antigua, así que el tope de
  // páginas recorta el pasado y nunca lo nuevo: no se pierden partidas nuevas.
  while (nextPage !== null && pages < maxPages) {
    signal.throwIfAborted();

    const page = await client.getPlayerGames(
      profileId,
      { page: nextPage, limit: config.pageSize, ...(since === null ? {} : { since }) },
      { signal },
    );

    pages += 1;
    games.push(...page.games);
    nextPage = page.nextPage;

    if (page.games.length === 0) {
      nextPage = null;
      break;
    }

    for (const game of page.games) {
      if (maxStartedAt === null || game.startedAt > maxStartedAt) {
        maxStartedAt = game.startedAt;
      }
    }
  }

  return { games, pages, maxStartedAt, nextPage };
}

function markPlayerFailed(result: SyncPlayerResult, error: string): void {
  if (result.status !== "failed") {
    result.status = "failed";
    result.error = error;
  }
}

function markPlayerCancelled(result: SyncPlayerResult): void {
  if (result.status === "ok") {
    result.status = "cancelled";
    result.error = "Plazo agotado.";
  }
}

/**
 * Siembra (o recupera) el cursor global y encola al roster entero.
 *
 * Las dos escrituras van en la **misma transacción**: si se escribiera el cursor
 * sin encolar, el masivo avanzaría y el relleno no sabría qué tramo cubrir. El
 * `updateMany` no se filtra por `profileIds` a propósito: la siembra es la única
 * vez que el sistema admite que no sabe dónde está, y filtrarla dejaría al resto
 * del roster sin dueño para su tramo perdido.
 */
async function seedCursorAndQueue(
  players: readonly SyncPlayerRow[],
  trace: Pick<SyncRunTrace, "finishedAt"> | null,
  windowFrom: Date,
  now: Date,
  config: SyncConfig,
  forceCatchUp: boolean,
): Promise<GamesCursorState> {
  const seed = seedGamesCursor(
    forceCatchUp ? null : trace,
    windowFrom,
    now,
    SYNC_OVERLAP_MS,
    config.seedMaxAgeMs,
  );
  const state: GamesCursorState = {
    updatedAt: seed.updatedAt.toISOString(),
    seededAt: now.toISOString(),
    seededFrom: seed.seededFrom,
    bulkIncompleteStreak: 0,
    pendingBestCount: 0,
    pendingBestAt: null,
  };

  await db.$transaction(async (tx) => {
    await tx.player.updateMany({
      where: { status: "APPROVED" },
      data: { windowComplete: false, backfillPage: 1 },
    });
    await writeGamesCursor(state, tx);
  });

  for (const player of players) {
    player.windowComplete = false;
    player.backfillPage = 1;
  }

  return state;
}

/** Aplica la cola del relleno a la base y a las filas/resultados en memoria. */
async function applyBackfillQueue(
  players: readonly SyncPlayerRow[],
  results: ReadonlyMap<number, SyncPlayerResult>,
  entries: readonly BackfillQueueEntry[],
): Promise<void> {
  const byProfile = new Map(players.map((player) => [player.profileId, player]));
  const rewindIds: string[] = [];
  const keepIds: string[] = [];

  for (const entry of entries) {
    const player = byProfile.get(entry.profileId);

    if (player === undefined) {
      continue;
    }

    if (entry.action === "rewind") {
      rewindIds.push(player.id);
    } else {
      keepIds.push(player.id);
    }
  }

  if (keepIds.length > 0) {
    await db.player.updateMany({
      where: { id: { in: keepIds } },
      data: { windowComplete: false },
    });
  }

  if (rewindIds.length > 0) {
    await db.player.updateMany({
      where: { id: { in: rewindIds } },
      data: { windowComplete: false, backfillPage: 1 },
    });
  }

  for (const entry of entries) {
    const player = byProfile.get(entry.profileId);

    if (player === undefined) {
      continue;
    }

    player.windowComplete = false;

    if (entry.action === "rewind") {
      player.backfillPage = 1;
    }

    const result = results.get(entry.profileId);

    if (result !== undefined) {
      result.windowComplete = false;

      if (entry.action === "rewind") {
        result.backfillPage = 1;
      }
    }
  }
}

type BulkStepResult = {
  pagesRead: number;
  batchesIncomplete: number;
  batchesFailed: number;
  batchErrors: GamesBatchError[];
  queuedEntries: BackfillQueueEntry[];
  games: Aoe4WorldGame[];
  maxUpdatedAt: Date | null;
  apiNotice: string | null;
};

async function runBulkStep(
  batches: readonly (readonly number[])[],
  players: readonly SyncPlayerRow[],
  results: ReadonlyMap<number, SyncPlayerResult>,
  client: Aoe4WorldClient,
  config: SyncConfig,
  signal: AbortSignal,
  cursorDate: Date,
  ruleset: Pick<ScoringRuleset, "window">,
  cutoffs: LadderCutoffsTable | null,
  now: Date,
): Promise<BulkStepResult> {
  const byProfile = new Map(players.map((player) => [player.profileId, player]));
  const incompleteBatches: GamesBatch[] = [];
  const saveFailureBatches: GamesBatch[] = [];
  const batchErrors: GamesBatchError[] = [];
  const games: Aoe4WorldGame[] = [];
  let pagesRead = 0;
  let batchesIncomplete = 0;
  let batchesFailed = 0;
  let maxUpdatedAt: Date | null = null;
  let apiNotice: string | null = null;

  const cancelFrom = (startIndex: number): void => {
    for (let index = startIndex; index < batches.length; index += 1) {
      for (const profileId of batches[index] ?? []) {
        const result = results.get(profileId);

        if (result !== undefined) {
          markPlayerCancelled(result);
        }
      }
    }
  };

  for (let index = 0; index < batches.length; index += 1) {
    const batchProfileIds = batches[index];

    if (batchProfileIds === undefined) {
      continue;
    }

    if (signal.aborted) {
      cancelFrom(index);
      break;
    }

    const batchNumber = index + 1;
    const batchGames: Aoe4WorldGame[] = [];
    let page: number | null = 1;
    let pagesThisBatch = 0;

    try {
      while (page !== null && pagesThisBatch < config.bulkMaxPages) {
        const response = await client.getGamesBulk(
          {
            profileIds: [...batchProfileIds],
            updatedSince: cursorDate,
            order: "updated_at",
            page,
          },
          { signal },
        );

        pagesRead += 1;
        pagesThisBatch += 1;

        if (response.notice !== null && apiNotice === null) {
          apiNotice = response.notice;
        }

        batchGames.push(...response.games);

        for (const game of response.games) {
          const updatedAt = game.updatedAt;

          if (updatedAt !== null && (maxUpdatedAt === null || updatedAt > maxUpdatedAt)) {
            maxUpdatedAt = updatedAt;
          }
        }

        page = response.nextPage;

        if (response.games.length === 0) {
          page = null;
        }
      }
    } catch (error) {
      if (signal.aborted) {
        cancelFrom(index);
        break;
      }

      batchesFailed += 1;
      const batchError = toErrorMessage(error);

      if (batchErrors.length < GAMES_BATCH_ERRORS_LIMIT) {
        batchErrors.push({
          batch: batchNumber,
          firstProfileId: batchProfileIds[0] ?? 0,
          lastProfileId: batchProfileIds[batchProfileIds.length - 1] ?? 0,
          error: batchError,
        });
      }

      for (const profileId of batchProfileIds) {
        const result = results.get(profileId);

        if (result !== undefined) {
          markPlayerFailed(result, batchError);
        }
      }

      continue;
    }

    games.push(...batchGames);

    if (page !== null) {
      batchesIncomplete += 1;
      incompleteBatches.push({ profileIds: [...batchProfileIds], incomplete: true });
    }

    const split = splitGamesByPlayer(batchGames, batchProfileIds);

    for (const profileId of batchProfileIds) {
      const player = byProfile.get(profileId);
      const result = results.get(profileId);

      if (player === undefined || result === undefined) {
        continue;
      }

      if (signal.aborted) {
        markPlayerCancelled(result);
        cancelFrom(index);
        break;
      }

      const playerGames = split.get(profileId) ?? [];
      result.gamesSeen += playerGames.length;

      const matches: NormalizedMatch[] = [];

      for (const game of playerGames) {
        const normalized = normalizeGame(game, profileId, now);

        if (normalized.status === "skipped") {
          result.matchesSkipped += 1;
          continue;
        }

        if (normalized.match.finishedAt === null) {
          result.liveMatches += 1;
        }

        matches.push(normalized.match);
      }

      try {
        const context: TeamTierContext = { profileId, cutoffs };
        const persisted = await persistMatches(
          player.id,
          matches,
          ruleset,
          player.registeredAt,
          context,
        );

        result.matchesInserted += persisted.inserted;
        result.matchesCounted += persisted.counted;
        result.matchesUpdated += persisted.updated;
      } catch (error) {
        if (signal.aborted) {
          markPlayerCancelled(result);
          cancelFrom(index);
          break;
        }

        markPlayerFailed(result, toErrorMessage(error));
        saveFailureBatches.push({ profileIds: [profileId], incomplete: true });
      }
    }
  }

  const queuedEntries =
    incompleteBatches.length === 0 && saveFailureBatches.length === 0
      ? []
      : playersToQueueForBackfill(
          [...incompleteBatches, ...saveFailureBatches],
          players.map((player) => ({
            profileId: player.profileId,
            windowComplete: player.windowComplete,
            backfillPage: player.backfillPage,
          })),
        );

  return {
    pagesRead,
    batchesIncomplete,
    batchesFailed,
    batchErrors,
    queuedEntries,
    games,
    maxUpdatedAt,
    apiNotice,
  };
}

type BackfillStepResult = {
  players: number;
  pagesRead: number;
  pending: number;
};

async function runBackfillStep(
  candidates: readonly {
    id: string;
    profileId: number;
    registeredAt: Date | null;
    backfillPage: number;
    windowComplete: boolean;
  }[],
  players: readonly SyncPlayerRow[],
  results: ReadonlyMap<number, SyncPlayerResult>,
  client: Aoe4WorldClient,
  config: SyncConfig,
  signal: AbortSignal,
  windowFrom: Date,
  ruleset: Pick<ScoringRuleset, "window">,
  cutoffs: LadderCutoffsTable | null,
  profileIds: number[] | undefined,
  now: Date,
): Promise<BackfillStepResult> {
  const byProfile = new Map(players.map((player) => [player.profileId, player]));
  const pagesPerPlayer = Math.min(config.backfillPagesPerPlayer, config.maxPages);
  let served = 0;
  let pagesRead = 0;

  for (const candidate of candidates) {
    if (signal.aborted) {
      break;
    }

    const player = byProfile.get(candidate.profileId);
    const result = results.get(candidate.profileId);

    if (player === undefined || result === undefined) {
      continue;
    }

    const plan = backfillPlan(candidate, windowFrom, pagesPerPlayer);

    if (plan === null) {
      continue;
    }

    served += 1;
    const sinceUsed = plan.since.toISOString();
    result.sinceUsed = sinceUsed;

    try {
      const fetched = await fetchPlayerGames(
        client,
        candidate.profileId,
        plan.since,
        config,
        signal,
        plan.startPage,
        plan.pages,
      );

      pagesRead += fetched.pages;
      result.pages += fetched.pages;
      result.gamesSeen += fetched.games.length;

      const matches: NormalizedMatch[] = [];

      for (const game of fetched.games) {
        const normalized = normalizeGame(game, candidate.profileId, now);

        if (normalized.status === "skipped") {
          result.matchesSkipped += 1;
          continue;
        }

        if (normalized.match.finishedAt === null) {
          result.liveMatches += 1;
        }

        matches.push(normalized.match);
      }

      const context: TeamTierContext = { profileId: candidate.profileId, cutoffs };
      const persisted = await persistMatches(
        candidate.id,
        matches,
        ruleset,
        candidate.registeredAt,
        context,
      );

      result.matchesInserted += persisted.inserted;
      result.matchesCounted += persisted.counted;
      result.matchesUpdated += persisted.updated;

      if (fetched.nextPage === null) {
        await db.player.update({
          where: { id: candidate.id },
          data: { windowComplete: true, windowCheckedAt: now },
        });

        player.windowComplete = true;
        result.windowComplete = true;

        const previous = await readPlayerSyncState(candidate.profileId);
        const maxStartedAt = fetched.maxStartedAt ?? plan.since;

        await writePlayerSyncState(candidate.profileId, {
          since: sinceUsed,
          maxStartedAt: maxStartedAt.toISOString(),
          lastSyncedAt: nowIso(),
          ...mergeAbandonedAudit(previous, [], nowIso()),
        });

        result.sinceStored = sinceUsed;
      } else {
        await db.player.update({
          where: { id: candidate.id },
          data: { windowComplete: false, backfillPage: fetched.nextPage },
        });

        player.windowComplete = false;
        player.backfillPage = fetched.nextPage;
        result.windowComplete = false;
        result.backfillPage = fetched.nextPage;
      }
    } catch (error) {
      markPlayerFailed(result, toErrorMessage(error));
    }
  }

  const pending = await db.player.count({
    where: {
      status: "APPROVED",
      windowComplete: false,
      ...(profileIds === undefined ? {} : { profileId: { in: profileIds } }),
    },
  });

  return { players: served, pagesRead, pending };
}

async function refreshProfiles(
  players: readonly SyncPlayerRow[],
  results: ReadonlyMap<number, SyncPlayerResult>,
  client: Aoe4WorldClient,
  config: SyncConfig,
  signal: AbortSignal,
  now: Date,
): Promise<void> {
  // La ladder se ejecuta antes que este paso y sella `profileCheckedAt` y el
  // nombre en la base. La lista de jugadores se leyó antes, así que hay que
  // releer esas tres columnas para no pedir un perfil que la ladder acaba de
  // dejar fresco.
  if (players.length > 0) {
    const frescos = await db.player.findMany({
      where: { profileId: { in: players.map((player) => player.profileId) } },
      select: {
        profileId: true,
        profileCheckedAt: true,
        aoe4WorldName: true,
        avatarUrl: true,
      },
    });
    const byProfile = new Map(frescos.map((row) => [row.profileId, row]));

    for (const player of players) {
      const row = byProfile.get(player.profileId);

      if (row !== undefined) {
        player.profileCheckedAt = row.profileCheckedAt;
        player.aoe4WorldName = row.aoe4WorldName;
        player.avatarUrl = row.avatarUrl;
      }
    }
  }

  await runPool([...players], config.concurrency, async (player) => {
    const result = results.get(player.profileId);

    if (result === undefined) {
      return;
    }

    if (signal.aborted) {
      markPlayerCancelled(result);
      return;
    }

    if (!shouldRefreshProfile(player.profileCheckedAt, now, PROFILE_CACHE_TTL_MS)) {
      return;
    }

    try {
      const profile = await client.getPlayer(player.profileId, { signal });
      const officialNameChanged = profile.name !== player.aoe4WorldName;
      const avatarUrl = profile.avatars.full;
      const avatarChanged = avatarUrl !== null && avatarUrl !== player.avatarUrl;

      await db.player.update({
        where: { id: player.id },
        data: {
          ...(officialNameChanged ? { aoe4WorldName: profile.name } : {}),
          ...(avatarChanged ? { avatarUrl } : {}),
          // Se sella siempre que la llamada va bien, haya cambiado algo o no.
          profileCheckedAt: now,
        },
      });

      if (officialNameChanged) {
        player.aoe4WorldName = profile.name;
      }

      if (avatarChanged) {
        player.avatarUrl = avatarUrl;
      }

      player.profileCheckedAt = now;
    } catch (error) {
      if (error instanceof Aoe4WorldError && error.status === 404) {
        markPlayerFailed(result, `AoE4World no conoce el perfil ${player.profileId}.`);
      } else {
        markPlayerFailed(result, toErrorMessage(error));
      }
    }
  });
}

/** Reparte los jugadores en `concurrency` carriles para no saturar la API. */
async function runPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  async function lane(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, lane));

  return results;
}

export async function syncApprovedPlayers(options: SyncOptions = {}): Promise<SyncSummary> {
  const envConfig = getAoe4WorldConfig();
  const config: SyncConfig = {
    pageSize: envConfig.syncPageSize,
    maxPages: envConfig.syncMaxPages,
    bulkMaxPages: Math.min(envConfig.syncBulkMaxPages, GAMES_BULK_MAX_PAGE),
    backfillMaxPlayers: envConfig.syncBackfillMaxPlayers,
    backfillPagesPerPlayer: envConfig.syncBackfillPagesPerPlayer,
    seedMaxAgeMs: envConfig.syncSeedMaxAgeMinutes * 60_000,
    concurrency: envConfig.syncConcurrency,
    deadlineMs: envConfig.syncDeadlineMs,
  };

  const client = options.client ?? createAoe4WorldClient();
  const startedAtMs = Date.now();

  // Plazo global: mejor un lote incompleto y legible que un cron que no acaba.
  const deadline = AbortSignal.timeout(config.deadlineMs);
  const signal =
    options.signal === undefined ? deadline : AbortSignal.any([options.signal, deadline]);

  const players = await readApprovedPlayers(options.profileIds);
  const results = new Map(
    players.map((player) => [player.profileId, emptyPlayerResult(player)]),
  );
  const directed = options.profileIds !== undefined;

  const ruleset = await readRuleset();
  const cutoffs = await readDivisionCutoffs();
  const previousTrace = players.length === 0 ? null : await readSyncRunTrace();
  const windowFrom = new Date(ruleset.window.from);

  // --- Cursor global: siembra perezosa y recuperación por edad -----------------
  let cursorState: GamesCursorState | null = null;
  let cursorDate: Date | null = null;
  let gamesCursorSeeded = false;

  const resetBackfillInMemory = (): void => {
    for (const player of players) {
      player.windowComplete = false;
      player.backfillPage = 1;
    }

    for (const result of results.values()) {
      result.windowComplete = false;
      result.backfillPage = 1;
    }
  };

  if (players.length > 0) {
    cursorState = await readGamesCursor();
    const seedNow = new Date();

    if (cursorState === null) {
      cursorState = await seedCursorAndQueue(
        players,
        previousTrace,
        windowFrom,
        seedNow,
        config,
        false,
      );
      resetBackfillInMemory();
      cursorDate = new Date(cursorState.updatedAt);
      gamesCursorSeeded = true;
    } else {
      const cursorMs = Date.parse(cursorState.updatedAt);

      // La cota de `seedMaxAgeMs` es de la **siembra inicial**: un cursor vivo
      // puede quedarse quieto horas o días sin partidas nuevas y eso no lo
      // invalida. Solo se recupera cuando la propia API empezaría a rechazar la
      // ventana por antigüedad (30 días) o cuando llega el aviso del masivo.
      if (
        !Number.isNaN(cursorMs) &&
        seedNow.getTime() - cursorMs > GAMES_CURSOR_NOTICE_AGE_MS
      ) {
        // La recuperación usa `catch-up` a propósito: la fila guardada ya no es
        // una base fiable y el tramo que se salte lo cubre el relleno del roster.
        cursorState = await seedCursorAndQueue(
          players,
          previousTrace,
          windowFrom,
          seedNow,
          config,
          true,
        );
        resetBackfillInMemory();
        cursorDate = new Date(cursorState.updatedAt);
        gamesCursorSeeded = true;
      } else {
        cursorDate = new Date(cursorState.updatedAt);
      }
    }
  }

  // Una sola llamada a la ladder para todos los aprobados, y antes del resto:
  // así se ejecuta siempre, aunque el bucle se pase del plazo o algún jugador
  // falle. Si falla, se registra y la pasada continúa con lo que ya había.
  const ladder = await syncLadderSnapshot(players, client, signal);

  if (ladder.error !== null) {
    console.error(`[sync] No se ha podido refrescar la ladder: ${ladder.error}`);
  }

  // --- Paso 1: reconciliación global -----------------------------------------
  if (players.length > 0) {
    const reconcileNow = new Date();
    const reconciled = await reconcileUnfinishedMatches(
      players,
      options.profileIds,
      client,
      signal,
      ruleset,
      cutoffs,
      reconcileNow,
    );

    for (const [profileId, result] of reconciled.byProfile) {
      const playerResult = results.get(profileId);

      if (playerResult === undefined) {
        continue;
      }

      playerResult.matchesResolvedByRefetch += result.resolved;
      playerResult.matchesCounted += result.counted;
      playerResult.matchesAbandoned += result.abandonedGameIds.length;
    }

    for (const [profileId, error] of reconciled.failed) {
      const playerResult = results.get(profileId);

      if (playerResult !== undefined) {
        markPlayerFailed(playerResult, error);
      }
    }
  }

  // --- Paso 2: incremental masivo --------------------------------------------
  let bulkResult: BulkStepResult = {
    pagesRead: 0,
    batchesIncomplete: 0,
    batchesFailed: 0,
    batchErrors: [],
    queuedEntries: [],
    games: [],
    maxUpdatedAt: null,
    apiNotice: null,
  };

  if (players.length > 0 && cursorDate !== null) {
    bulkResult = await runBulkStep(
      groupProfileIds(
        players.map((player) => player.profileId),
        50,
      ),
      players,
      results,
      client,
      config,
      signal,
      cursorDate,
      ruleset,
      cutoffs,
      new Date(),
    );

    if (bulkResult.queuedEntries.length > 0) {
      await applyBackfillQueue(players, results, bulkResult.queuedEntries);
    }
  }

  // Red de seguridad para la API: si el `updated_since` era demasiado antiguo,
  // vuelve a sembrar y encola al roster. La recuperación por edad de 30 días ya
  // cubre el caso normal; esto también funciona si el aviso llega antes.
  if (!directed && players.length > 0 && cursorState !== null && cursorDate !== null) {
    const noticeMentionsOldWindow =
      bulkResult.apiNotice !== null &&
      bulkResult.apiNotice.toLowerCase().includes("updated_since");
    const nextCursorPreview =
      bulkResult.maxUpdatedAt === null
        ? null
        : nextGamesCursor(cursorDate, bulkResult.games, SYNC_OVERLAP_MS);
    const wouldAdvance =
      shouldAdvanceGamesCursor({
        directed: false,
        batchesFailed: bulkResult.batchesFailed,
        aborted: signal.aborted,
        maxUpdatedAt: bulkResult.maxUpdatedAt,
      }) &&
      nextCursorPreview !== null &&
      nextCursorPreview.getTime() > cursorDate.getTime();

    if (bulkResult.apiNotice !== null && (noticeMentionsOldWindow || !wouldAdvance)) {
      const recoveryNow = new Date();
      cursorState = await seedCursorAndQueue(
        players,
        previousTrace,
        windowFrom,
        recoveryNow,
        config,
        true,
      );
      resetBackfillInMemory();
      cursorDate = new Date(cursorState.updatedAt);
      gamesCursorSeeded = true;
    }
  }

  // --- Paso 3: relleno de la ventana -----------------------------------------
  let backfillResult: BackfillStepResult = { players: 0, pagesRead: 0, pending: 0 };

  if (players.length > 0) {
    const candidates = await db.player.findMany({
      where: {
        status: "APPROVED",
        windowComplete: false,
        ...(options.profileIds === undefined
          ? {}
          : { profileId: { in: options.profileIds } }),
      },
      select: {
        id: true,
        profileId: true,
        registeredAt: true,
        backfillPage: true,
        windowComplete: true,
      },
      orderBy: [{ backfillPage: "asc" }, { profileId: "asc" }],
      take: config.backfillMaxPlayers,
    });

    backfillResult = await runBackfillStep(
      candidates,
      players,
      results,
      client,
      config,
      signal,
      windowFrom,
      ruleset,
      cutoffs,
      options.profileIds,
      new Date(),
    );
  }

  // --- Paso 4: perfil con caché de una hora --------------------------------
  if (players.length > 0) {
    await refreshProfiles(players, results, client, config, signal, new Date());
  }

  // --- Paso 6a/6b: avance del cursor y watchdog -------------------------------
  let gamesCursorAdvanced = false;

  if (!directed && cursorState !== null) {
    const nowCursor = new Date();
    let nextState = cursorState;

    if (cursorDate !== null) {
      const advance = shouldAdvanceGamesCursor({
        directed: false,
        batchesFailed: bulkResult.batchesFailed,
        aborted: signal.aborted,
        maxUpdatedAt: bulkResult.maxUpdatedAt,
      });

      if (advance) {
        const next = nextGamesCursor(cursorDate, bulkResult.games, SYNC_OVERLAP_MS);

        if (next !== null && next.getTime() > cursorDate.getTime()) {
          nextState = { ...cursorState, updatedAt: next.toISOString() };
          gamesCursorAdvanced = true;
        }
      }
    }

    const watchdog = nextBackfillWatchdog(
      nextState,
      backfillResult.pending,
      bulkResult.batchesIncomplete,
      nowCursor,
    );
    const candidate = { ...nextState, ...watchdog };

    try {
      await writeGamesCursor(candidate);
      cursorState = candidate;
      cursorDate = new Date(candidate.updatedAt);
    } catch (error) {
      // El cursor anterior sigue siendo válido; se reintenta en la próxima pasada.
      gamesCursorAdvanced = false;
      console.error(`[sync] No se ha podido guardar el cursor global: ${toErrorMessage(error)}`);
    }
  }

  const settled = [...results.values()];

  for (const result of settled) {
    if (result.status === "failed") {
      console.error(`[sync] Jugador ${result.profileId} (${result.name}): ${result.error}`);
    } else if (result.status === "cancelled") {
      console.warn(
        `[sync] Jugador ${result.profileId} (${result.name}): sincronización cancelada.`,
      );
    }
  }

  // El pool de mapas del objetivo `por-tierra-y-agua` se refresca **antes** del
  // recálculo, que es quien lo lee, y como mucho una vez al día: el pool rota una vez
  // al mes y el homepage no es la API (ver `map-pool.ts`). Un fallo no toca `Setting`
  // —el motor sigue con el último pool bueno—, así que se trata como los demás pasos
  // tolerantes: el motivo va al rastro y **no** mueve `lastSuccessAt`.
  let mapPool: MapPoolRefreshResult | null = null;
  let mapPoolError: string | null = null;

  try {
    mapPool = await refreshMapPool({ signal });

    if (mapPool.status === "failed") {
      mapPoolError = mapPool.warning;
      console.warn(`[sync] No se ha podido refrescar el pool de mapas: ${mapPoolError}`);
    } else if (mapPool.status === "updated") {
      console.info(`[sync] Pool de mapas refrescado desde AoE4World: ${mapPool.mapCount} mapas.`);
    }
  } catch (error) {
    mapPoolError = toErrorMessage(error);
    console.error(`[sync] No se ha podido refrescar el pool de mapas: ${mapPoolError}`);
  }

  // El summary de las partidas que aún no lo tienen se rellena **también antes del
  // recálculo**, que es quien lee lo que escribe (los cinco objetivos de APM, edad y
  // aldeanos perdidos). Es un paso que sale a una ruta **del sitio** de AoE4World, no
  // de su API, así que lleva su propio presupuesto por pasada y su cola; un fallo
  // suyo solo deja esos objetivos sin datos hasta la siguiente pasada y el motivo va
  // al rastro sin mover `lastSuccessAt`.
  let summaries: SummaryBackfillResult | null = null;
  let summariesError: string | null = null;

  try {
    summaries = await backfillMatchSummaries({ signal });
    summariesError = describeSummaryBackfill(summaries);

    if (summariesError !== null) {
      console.warn(`[sync] ${summariesError}`);
    }

    if (summaries.fetched > 0 || summaries.throttled) {
      console.info(
        `[sync] Summaries de partida: ${summaries.fetched} guardado(s), ` +
          `${summaries.missing} sin summary, ${summaries.unreviewed} sin revisar, ` +
          `${summaries.candidates} candidata(s) pendiente(s).` +
          (summaries.throttled
            ? " AoE4World pidió bajar el ritmo (429): la pasada se ha cortado."
            : ""),
      );
    }
  } catch (error) {
    summariesError = toErrorMessage(error);
    console.error(`[sync] No se han podido rellenar los summaries de partida: ${summariesError}`);
  }

  // La **elegibilidad de los eventos puntuales** que exigen Discord se congela
  // **antes** del recálculo, que es quien la lee para repartir el bono
  // (`computeEventBonuses()`). Si se escribiera después, el bono de la primera pasada
  // del evento llegaría un ciclo tarde. Es un paso tolerante: sin snapshot el motor no
  // reparte bono, y un fallo no impide sincronizar ni recalcular lo demás.
  let eventEligibilityError: string | null = null;

  try {
    const eventEligibility = await syncEditionEventEligibility({ signal });
    eventEligibilityError = describeEditionEventEligibility(eventEligibility);

    if (eventEligibilityError !== null) {
      console.warn(`[sync] ${eventEligibilityError}`);
    }

    if (eventEligibility.checked > 0) {
      console.info(
        `[sync] Elegibilidad de eventos en Discord: ${eventEligibility.checked} comprobado(s), ` +
          `${eventEligibility.eligible} elegible(s) nuevo(s), ` +
          `${eventEligibility.pending} para la siguiente pasada.`,
      );
    }
  } catch (error) {
    eventEligibilityError = toErrorMessage(error);
    console.error(
      `[sync] No se ha podido comprobar la elegibilidad de los eventos en Discord: ${eventEligibilityError}`,
    );
  }

  // La clasificación se recalcula al final y en su propia transacción. Si falla,
  // las partidas ya están guardadas: la web serviría la clasificación anterior
  // hasta la próxima pasada, que es preferible a tumbar la sincronización entera.
  let scoring: RecomputeScoresResult | null = null;
  let scoringError: string | null = null;

  try {
    scoring = await recomputeScores();
  } catch (error) {
    scoringError = toErrorMessage(error);
    console.error(`[sync] No se ha podido recalcular la clasificación: ${scoringError}`);
  }

  // Las alertas van **después** del recálculo y solo para quien ha cambiado, porque
  // una alerta de comportamiento solo puede moverse si el conjunto de
  // clasificatorias del jugador ha cambiado: y eso es exactamente lo que cuenta
  // cualquiera de los cuatro contadores. En una pasada sin novedades (lo normal,
  // 288 veces al día) no se evalúa a nadie y no se lee ni una fila de `Match`.
  //
  // **Y los del summary, aunque no hayan jugado nada nuevo**: un resumen rellenado
  // para una partida vieja cambia lo que el motor de alertas tiene que mirar
  // (las tres reglas por partida y el estado de "sin revisar"), y esa partida pudo
  // entrar en la base hace días. Sin sumarlos, el hallazgo no se vería hasta que el
  // jugador volviera a jugar.
  const tocados = [
    ...new Set([
      ...settled
        .filter(
          (result) =>
            result.matchesInserted > 0 ||
            result.matchesUpdated > 0 ||
            result.matchesResolvedByRefetch > 0 ||
            result.matchesAbandoned > 0,
        )
        .map((result) => result.profileId),
      ...(summaries?.reviewedProfileIds ?? []),
      ...(summaries?.unreviewedProfileIds ?? []),
    ]),
  ].sort((a, b) => a - b);

  let alerts: EvaluateAlertsResult | null = null;
  let alertsError: string | null = null;

  try {
    // `evaluateAlerts` también hace, por su cuenta, la evaluación completa del
    // cierre de torneo si la ventana ya terminó y no estaba hecha. Por eso se
    // llama siempre, también con `tocados` vacío: el cierre no depende de que
    // alguien haya jugado nada en esta pasada.
    alerts = await evaluateAlerts(tocados.length === 0 ? {} : { profileIds: tocados });

    if (alerts.alertsCreated > 0 || alerts.tournamentClose) {
      console.info(
        `[sync] Alertas: ${alerts.alertsCreated} nuevas de ${alerts.alertsTriggered} disparadas, ` +
          `evaluados ${alerts.playersEvaluated} jugadores, ${alerts.openStreaks.length} rachas abiertas` +
          (alerts.tournamentClose ? " (evaluación completa de cierre de torneo)" : "") +
          ".",
      );
    }
  } catch (error) {
    alertsError = toErrorMessage(error);
    console.error(`[sync] No se han podido evaluar las alertas: ${alertsError}`);
  }

  // El historial de partidas en el juego va **después** de las alertas y **antes** de
  // los directos, con el mismo tratamiento tolerante que ellos: un fallo no para la
  // pasada y el motivo va al rastro sin mover `lastSuccessAt`.
  //
  // Y aquí, no en el DAL ni en el motor de alertas, por lo que dice el docblock de
  // `history-checks.ts`: el sondeo es una petición de red a una ruta del sitio de
  // AoE4World, y el motor de alertas es puro. Lo que hace falta cada 12 horas por
  // jugador no justifica una comprobación por visita a la web.
  let history: HistoryChecksResult | null = null;
  let historyError: string | null = null;

  try {
    if (options.history !== false) {
      history = await checkPlayerHistory({ signal });

      // `describeHistoryChecks()` escribe también los_counts sin fallos, porque es donde
      // se ve que el sondeo está funcionando; lo que no puede es mover el marcador de
      // "cuándo funcionó por última vez", y no lo mueve.
      historyError = describeHistoryChecks(history);

      if (historyError !== null) {
        console.warn(`[sync] ${historyError}`);
      }

      if (history.alertsCreated > 0) {
        console.info(
          `[sync] Historial: ${history.alertsCreated} alerta(s) nueva(s), ` +
            `${history.checked} comprobación(es), ${history.verdicts.closed} con el historial cerrado, ` +
            `${history.ladder.ahead} con la ladder por delante.`,
        );
      }
    }
  } catch (error) {
    historyError = toErrorMessage(error);
    console.error(`[sync] No se ha podido comprobar el historial de partidas: ${historyError}`);
  }

  // La pertenencia al servidor de Discord va **después** del historial y **antes** de
  // los directos, con el mismo tratamiento tolerante: un fallo no para la pasada, el
  // motivo va al rastro sin mover `lastSuccessAt`, y lo que no se ha podido comprobar no
  // se escribe.
  //
  // Y en el worker y no en el motor de alertas, igual que las dos reglas de F11: son
  // datos de `Player` y de una API externa, no de `Match`, y el motor es puro. La
  // comprobación usa la **lista de miembros del servidor** cuando puede leerla —una
  // lectura por cada mil miembros, cacheada doce horas, que resuelve el `discordUserId`
  // de quien solo tiene `@usuario` y afirma las presencias—, y cae a una petición por
  // cuenta (`GET /guilds/{id}/members/{user}`) cuando no hay lista y para **confirmar
  // cualquier ausencia** que la lista no puede afirmar (una foto puede ser anterior a
  // la entrada de alguien).
  let discord: DiscordChecksResult | null = null;
  let discordError: string | null = null;

  try {
    discord = await checkDiscordMembership({ signal });

    // `describeDiscordChecks()` escribe también los recuentos sin fallos, porque es
    // donde se ve que la comprobación está corriendo (con cuántos miembros sale la
    // lista, cuántos participantes quedaron para la siguiente pasada por el tope y si
    // hace falta activarle el intent privilegiado al bot); lo que no puede es mover el
    // marcador de "cuándo funcionó por última vez", y no lo mueve.
    discordError = describeDiscordChecks(discord);

    if (discordError !== null) {
      console.warn(`[sync] ${discordError}`);
    }

    if (discord.alertsCreated > 0) {
      console.info(
        `[sync] Discord: ${discord.alertsCreated} alerta(s) nueva(s), ` +
          `${discord.checked} comprobación(es), ${discord.verdicts.notMember} fuera del servidor, ` +
          `${discord.resolvedByUsername} enlazada(s) por @usuario.`,
      );
    }
  } catch (error) {
    discordError = toErrorMessage(error);
    console.error(`[sync] No se ha podido comprobar la pertenencia a Discord: ${discordError}`);
  }

  // El snapshot de elegibilidad de los eventos comparte el rastro de Discord: es el
  // mismo servicio y el mismo sitio donde ya se mira que Discord esté funcionando. Se
  // **suma** al aviso de la pertenencia, no lo sustituye.
  if (eventEligibilityError !== null) {
    discordError =
      discordError === null ? eventEligibilityError : `${discordError} ${eventEligibilityError}`;
  }

  // El **rol de participante** (issue 56) va justo después, en el mismo tratamiento
  // tolerante y con el mismo destino en el rastro: es el adorno del torneo que acompaña
  // a la pertenencia, y comparte su resolución de cuentas (el roster resuelve los
  // `@usuario`). Sin `DISCORD_PARTICIPANT_ROLE_ID` el paso no existe y solo deja el
  // motivo; un 403 o un timeout no tumban la pasada y se reintentan en la siguiente.
  // El motivo se acumula en `discordError` —es el sitio donde ya se dejan los de
  // Discord— y **no** mueve `lastSuccessAt`.
  try {
    const role = await syncParticipantRole({ signal });
    const roleError = describeParticipantRoleSync(role);

    if (roleError !== null) {
      discordError = discordError === null ? roleError : `${discordError} ${roleError}`;
      console.warn(`[sync] ${roleError}`);
    }

    if (role.added > 0 || role.removed > 0) {
      console.info(
        `[sync] Rol de participante en Discord: ${role.added} puesto(s), ${role.removed} quitado(s).`,
      );
    }
  } catch (error) {
    const roleError = toErrorMessage(error);
    discordError = discordError === null ? roleError : `${discordError} ${roleError}`;
    console.error(
      `[sync] No se ha podido sincronizar el rol de participante en Discord: ${roleError}`,
    );
  }

  // El estado de directo de YouTube y Kick va **el último de los tres que salen a la
  // red**, con el mismo tratamiento que las alertas: tolerante a fallos, con el motivo
  // en el rastro, y sin que un fallo suyo pueda parar la pasada. Y por el mismo motivo
  // que las alertas, se ejecuta aquí y no en el DAL: son peticiones salientes a dos
  // APIs externas, y en el plan Free de Cloudflare eso solo cabe una vez por pasada
  // (docs/OPERACION.md, "El límite de CPU del plan Free"), no en cada visita a la web.
  //
  // La llamada se hace siempre, salvo que quien la llama la apague (el mock del
  // torneo, que no toca APIs externas), y `refreshStreamLiveStatus()` sale antes de
  // crear el cliente HTTP si no hay ningún participante aprobado con canal: así una
  // pasada sin nada que hacer no gasta ni una petición.
  let streams: StreamRefreshResult | null = null;
  let streamsError: string | null = null;

  try {
    if (options.streams !== false) {
      streams = await refreshStreamLiveStatus({ signal });

      // Lo que devuelve `describeStreamRefresh()` va al rastro tal cual, avisos
      // incluidos: es el sitio donde se ve que la detección está apagada por falta de
      // `YOUTUBE_API_KEY` o que una plataforma lleva fallando. Va también al log, con
      // `warn` y no con `error`, porque no es un fallo del sincronizador.
      streamsError = describeStreamRefresh(streams);

      if (streamsError !== null) {
        console.warn(`[sync] ${streamsError}`);
      }
    }
  } catch (error) {
    streamsError = toErrorMessage(error);
    console.error(`[sync] No se ha podido comprobar el estado de directo: ${streamsError}`);
  }

  // Los avisos al canal de Discord —los hitos de la edición y el informe diario de
  // clasificación— van **los últimos**, con el mismo tratamiento tolerante que los tres
  // pasos anteriores: no dependen de nada de lo de antes y un fallo suyo no para la pasada
  // ni mueve `lastSuccessAt`. Los dos comparten `announceError`, que es el rastro de los
  // mensajes al canal. `announceEditionWindow()` sale antes de leer el nombre de la
  // edición cuando no toca ningún aviso, así que en las pasadas normales es una
  // comparación de fechas; el informe diario, fuera de su hora, también.
  let announceError: string | null = null;

  try {
    const announced = await announceEditionWindow();

    announceError = announced.error;

    if (announced.sent.length > 0) {
      console.info(`[sync] Avisos del torneo enviados a Discord: ${announced.sent.join(", ")}.`);
    }

    if (announceError !== null) {
      console.warn(`[sync] ${announceError}`);
    }
  } catch (error) {
    announceError = toErrorMessage(error);
    console.error(`[sync] No se han podido enviar los avisos del torneo: ${announceError}`);
  }

  // Los recordatorios de los **eventos puntuales** (24/12/1 h antes) van junto a los
  // hitos de la edición, con el mismo tratamiento: un fallo no para la pasada, el
  // motivo se suma a `announceError` y el aviso que no salió queda pendiente. Sin
  // eventos, o sin ninguno en su tramo, no se lee la configuración de Discord.
  try {
    const eventos = await announceEditionEvents();

    if (eventos.sent.length > 0) {
      console.info(
        `[sync] Avisos de eventos enviados a Discord: ${eventos.sent.join(", ")}.`,
      );
    }

    if (eventos.error !== null) {
      announceError = announceError === null ? eventos.error : `${announceError} ${eventos.error}`;
      console.warn(`[sync] ${eventos.error}`);
    }
  } catch (error) {
    const eventosError = toErrorMessage(error);
    announceError = announceError === null ? eventosError : `${announceError} ${eventosError}`;
    console.error(`[sync] No se han podido enviar los avisos de los eventos: ${eventosError}`);
  }

  try {
    const report = await announceDailyStandings();

    if (report.error !== null) {
      announceError = announceError === null ? report.error : `${announceError} ${report.error}`;
      console.warn(`[sync] ${report.error}`);
    }

    if (report.sent > 0) {
      console.info(`[sync] Informe diario de clasificación enviado a Discord: ${report.sent} mensaje(s).`);
    }
  } catch (error) {
    const reportError = toErrorMessage(error);
    announceError = announceError === null ? reportError : `${announceError} ${reportError}`;
    console.error(
      `[sync] No se ha podido enviar el informe diario de clasificación: ${reportError}`,
    );
  }

  const finishedAtMs = Date.now();

  const summary: SyncSummary = {
    startedAt: new Date(startedAtMs).toISOString(),
    finishedAt: new Date(finishedAtMs).toISOString(),
    durationMs: finishedAtMs - startedAtMs,
    playersTotal: settled.length,
    playersOk: settled.filter((result) => result.status === "ok").length,
    playersFailed: settled.filter((result) => result.status === "failed").length,
    playersCancelled: settled.filter((result) => result.status === "cancelled").length,
    newMatches: settled.reduce((total, result) => total + result.matchesCounted, 0),
    updatedMatches: settled.reduce((total, result) => total + result.matchesUpdated, 0),
    resolvedByRefetch: settled.reduce(
      (total, result) => total + result.matchesResolvedByRefetch,
      0,
    ),
    abandonedMatches: settled.reduce((total, result) => total + result.matchesAbandoned, 0),
    skippedGames: settled.reduce((total, result) => total + result.matchesSkipped, 0),
    liveMatches: settled.reduce((total, result) => total + result.liveMatches, 0),
    apiRequests: client.stats.requests,
    apiRetries: client.stats.retries,
    rateLimitResponses: client.stats.rateLimitResponses,
    rateLimitPausesMs: client.stats.rateLimitPausesMs,
    ladder,
    mapPool,
    mapPoolError,
    summaries,
    summariesError,
    gamesPagesRead: bulkResult.pagesRead,
    gamesBatchesIncomplete: bulkResult.batchesIncomplete,
    gamesBatchesFailed: bulkResult.batchesFailed,
    gamesPlayersQueuedForBackfill: bulkResult.queuedEntries.length,
    gamesBatchErrors: bulkResult.batchErrors,
    gamesCursor: cursorState?.updatedAt ?? null,
    gamesCursorAdvanced,
    gamesCursorSeeded,
    backfillPlayers: backfillResult.players,
    backfillPagesRead: backfillResult.pagesRead,
    backfillPending: backfillResult.pending,
    apiNotice: bulkResult.apiNotice,
    scoring,
    scoringError,
    alerts,
    alertsError,
    history,
    historyError,
    discord,
    discordError,
    streams,
    streamsError,
    announceError,
    players: settled,
  };

  await recordRunTrace(summary);

  return summary;
}

/**
 * Deja constancia de la pasada en `Setting` para que un fallo se pueda ver.
 *
 * Sin esto, un jugador que no se pudo sincronizar solo aparecía en los logs del
 * Worker: el cron dispara por HTTP y tira la respuesta, así que nadie se enteraba y
 * la web seguía sirviendo la clasificación vieja con toda naturalidad. Es
 * exactamente lo que pasó en septiembre de 2026, con el torneo congelado dos horas
 * sin que nada lo dijera.
 *
 * Se lee el rastro anterior **antes** de escribir, porque `writeSyncRunTrace()`
 * arrastra de ahí el `lastSuccessAt`: si esta pasada sale mal, el marcador de
 * "cuándo funcionó por última vez" tiene que quedarse en la anterior buena, no
 * avanzar a una pasada rota.
 *
 * No propaga: guardar el diagnóstico no puede ser motivo para que el torneo deje
 * de sincronizarse.
 */
async function recordRunTrace(summary: SyncSummary): Promise<void> {
  try {
    const previous = await readSyncRunTrace();

    const trace: Omit<SyncRunTrace, "lastSuccessAt"> = {
      startedAt: summary.startedAt,
      finishedAt: summary.finishedAt,
      durationMs: summary.durationMs,
      playersTotal: summary.playersTotal,
      playersOk: summary.playersOk,
      playersFailed: summary.playersFailed,
      playersCancelled: summary.playersCancelled,
      newMatches: summary.newMatches,
      updatedMatches: summary.updatedMatches,
      resolvedByRefetch: summary.resolvedByRefetch,
      abandonedMatches: summary.abandonedMatches,
      skippedGames: summary.skippedGames,
      liveMatches: summary.liveMatches,
      apiRequests: summary.apiRequests,
      apiRetries: summary.apiRetries,
      rateLimitResponses: summary.rateLimitResponses,
      rateLimitPausesMs: summary.rateLimitPausesMs,
      ladderError: summary.ladder.error,
      scoringError: summary.scoringError,
      alertsError: summary.alertsError,
      historyError: summary.historyError,
      discordError: summary.discordError,
      streamsError: summary.streamsError,
      announceError: summary.announceError,
      mapPoolError: summary.mapPoolError,
      summariesError: summary.summariesError,
      gamesPagesRead: summary.gamesPagesRead,
      gamesBatchesIncomplete: summary.gamesBatchesIncomplete,
      gamesBatchesFailed: summary.gamesBatchesFailed,
      gamesPlayersQueuedForBackfill: summary.gamesPlayersQueuedForBackfill,
      gamesBatchErrors: summary.gamesBatchErrors,
      gamesCursor: summary.gamesCursor,
      gamesCursorAdvanced: summary.gamesCursorAdvanced,
      gamesCursorSeeded: summary.gamesCursorSeeded,
      backfillPlayers: summary.backfillPlayers,
      backfillPagesRead: summary.backfillPagesRead,
      backfillPending: summary.backfillPending,
      apiNotice: summary.apiNotice,
      failures: summary.players
        .filter((result) => result.status !== "ok")
        .map((result) => ({
          profileId: result.profileId,
          name: result.name,
          status: result.status,
          error: result.error ?? "Sin motivo informado.",
        })),
    };

    await writeSyncRunTrace(trace, previous);
  } catch (error) {
    console.error(
      "[sync] No se ha podido guardar el rastro de la pasada:",
      error instanceof Error ? error.message : String(error),
    );
  }
}
