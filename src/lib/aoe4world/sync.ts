import "server-only";

import { db } from "@/lib/db";
import { mergeAbandonedAudit, readPlayerSyncState, writePlayerSyncState } from "@/lib/settings";
import { recomputeScores, type RecomputeScoresResult } from "@/lib/scoring";
import { createAoe4WorldClient, type Aoe4WorldClient } from "./client";
import { getAoe4WorldConfig } from "./env";
import { Aoe4WorldError, Aoe4WorldNotFoundError } from "./http";
import { syncLadderSnapshot, type LadderSyncResult } from "./ladder";
import { normalizeGame, type NormalizedMatch } from "./normalize";
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
 * Al final se recalcula la clasificación. Es lo que cumple el requisito de
 * "siempre actualizada" sin que nadie tenga que recargar: cada pasada del worker
 * deja la tabla de puntos al día.
 */

/**
 * Margen que se le resta al cursor para volver a pedir una franja ya vista.
 * Sin él, una partida que la API publica con retraso (una partida en curso que
 * se procesa minutos después) podría quedarse sin resultado para siempre.
 */
export const SYNC_OVERLAP_MINUTES = 60;

const SYNC_OVERLAP_MS = SYNC_OVERLAP_MINUTES * 60_000;

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
  matchesUpdated: number;
  matchesSkipped: number;
  /** Partidas en curso que el listado ya no alcanzaba y el refetch sí resolvió. */
  matchesResolvedByRefetch: number;
  /** Partidas borradas por abandono (regla "nunca cuenta"). */
  matchesAbandoned: number;
  liveMatches: number;
  historyTruncated: boolean;
  sinceUsed: string | null;
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
   * Recálculo de la clasificación al final de la pasada. `null` solo si la
   * versión de reglas leída no existe, lo que no debería ocurrir.
   */
  scoring: RecomputeScoresResult | null;
  /** Por qué no se pudo recalcular la clasificación, si no se pudo. */
  scoringError: string | null;
  players: SyncPlayerResult[];
};

export type SyncOptions = {
  /** Limita la pasada a estos `profileId`. Por defecto, todos los aprobados. */
  profileIds?: number[];
  /** Inyecta un cliente alternativo (verificaciones con datos de ejemplo). */
  client?: Aoe4WorldClient;
  /** Cancela la pasada; los jugadores pendientes se marcan como cancelados. */
  signal?: AbortSignal;
};

type SyncConfig = {
  pageSize: number;
  maxPages: number;
  concurrency: number;
  deadlineMs: number;
};

type SyncPlayerRow = {
  id: string;
  profileId: number;
  name: string;
  aoe4WorldName: string | null;
  avatarUrl: string | null;
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
    select: { id: true, profileId: true, name: true, aoe4WorldName: true, avatarUrl: true },
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
    matchesUpdated: 0,
    matchesSkipped: 0,
    matchesResolvedByRefetch: 0,
    matchesAbandoned: 0,
    liveMatches: 0,
    historyTruncated: false,
    sinceUsed: null,
    sinceStored: null,
    ...overrides,
  };
}

/**
 * Refresca una fila ya guardada. `points` no se toca a propósito: lo calcula el
 * motor de F3 y aquí no hay nada que decidir.
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
 * Dedup por `(playerId, gameId)`: las partidas terminadas son inmutables, así que
 * basta con insertar las que falten (`skipDuplicates`). Las que ya estaban
 * guardadas en curso sí hay que refrescarlas, porque al terminar les llega el
 * resultado y `finishedAt`.
 */
async function persistMatches(
  playerId: string,
  matches: NormalizedMatch[],
): Promise<{ inserted: number; updated: number }> {
  if (matches.length === 0) {
    return { inserted: 0, updated: 0 };
  }

  const existing = await db.match.findMany({
    where: { playerId, gameId: { in: matches.map((match) => match.gameId) } },
    select: { gameId: true, finishedAt: true },
  });

  // Solo se refresca lo que estaba en curso; el resto ya es definitivo.
  const unfinished = new Set(
    existing.filter((row) => row.finishedAt === null).map((row) => row.gameId),
  );

  const toCreate = matches.filter((match) => !unfinished.has(match.gameId));
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

  return { inserted, updated: toRefresh.length };
}

type ReconcileResult = {
  resolved: number;
  abandonedGameIds: string[];
};

function toGameIdNumber(gameId: string): number | null {
  const parsed = Number(gameId);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Segunda pasada sobre las partidas que el listado ya no puede alcanzar.
 *
 * El cursor `since` es `maxStartedAt - 60 min`, así que una partida en curso que
 * haya empezado más de 60 min antes de la partida más nueva del jugador queda
 * fuera del paginado para siempre. Sin esto se quedaría con `finishedAt = null`
 *indefinidamente: ni F3 la puntuaría ni F4 la listaría.
 *
 * Aquí se resuelven con el endpoint de detalle (una llamada por partida, y el
 * conjunto suele ser de 0 a 2). `normalizeGame` sigue siendo el único que juzga
 * si una partida está en curso, con el mismo criterio de 60 minutos: el refetch
 * no se salta ninguna regla, solo rescata lo que el listado no ve.
 */
async function reconcileUnfinishedMatches(
  player: SyncPlayerRow,
  client: Aoe4WorldClient,
  listingSince: Date | null,
  signal: AbortSignal,
): Promise<ReconcileResult> {
  // Sin cursor todavía no hay partidas guardadas, pero por si acaso el corte es
  // la epoch y así ninguna se queda sin resolver.
  const cutoff = listingSince ?? new Date(0);

  const pending = await db.match.findMany({
    where: { playerId: player.id, finishedAt: null, startedAt: { lt: cutoff } },
    select: { gameId: true },
    orderBy: { startedAt: "asc" },
  });

  const result: ReconcileResult = { resolved: 0, abandonedGameIds: [] };

  const abandon = async (gameId: string) => {
    await db.match.delete({
      where: { playerId_gameId: { playerId: player.id, gameId } },
    });
    result.abandonedGameIds.push(gameId);
    console.warn(`[sync] Jugador ${player.profileId}: partida ${gameId} borrada (${ABANDONED_REASON}).`);
  };

  for (const match of pending) {
    signal.throwIfAborted();

    const gameId = toGameIdNumber(match.gameId);

    if (gameId === null) {
      // Una fila que ni siquiera se puede pedir no puede contar para nadie.
      await abandon(match.gameId);
      continue;
    }

    let finished: Aoe4WorldGame;

    try {
      finished = await client.getPlayerGame(player.profileId, gameId, { signal });
    } catch (error) {
      if (error instanceof Aoe4WorldNotFoundError) {
        // La API ya no conoce la partida: no hay desenlace que esperar.
        await abandon(match.gameId);
        continue;
      }

      throw error;
    }

    const normalized = normalizeGame(finished, player.profileId);

    if (normalized.status === "skipped") {
      // Pasada la ventana de 60 min y sin resultado: abandono definitivo.
      await abandon(match.gameId);
      continue;
    }

    if (normalized.match.finishedAt === null) {
      // La API la sigue dando viva y dentro de ventana: aún no se decide nada.
      continue;
    }

    await applyMatchUpdate(player.id, normalized.match);
    result.resolved += 1;
  }

  return result;
}

type FetchedGames = {
  games: Aoe4WorldGame[];
  pages: number;
  maxStartedAt: Date | null;
  truncated: boolean;
};

async function fetchPlayerGames(
  client: Aoe4WorldClient,
  profileId: number,
  since: Date | null,
  config: SyncConfig,
  signal: AbortSignal,
): Promise<FetchedGames> {
  const games: Aoe4WorldGame[] = [];
  let maxStartedAt: Date | null = null;
  let pages = 0;
  let nextPage: number | null = 1;

  // La API pagina de la más reciente a la más antigua, así que el tope de
  // páginas recorta el pasado y nunca lo nuevo: no se pierden partidas nuevas.
  while (nextPage !== null && pages < config.maxPages) {
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
      break;
    }

    for (const game of page.games) {
      if (maxStartedAt === null || game.startedAt > maxStartedAt) {
        maxStartedAt = game.startedAt;
      }
    }
  }

  return { games, pages, maxStartedAt, truncated: nextPage !== null };
}

async function syncPlayer(
  player: SyncPlayerRow,
  client: Aoe4WorldClient,
  config: SyncConfig,
  signal: AbortSignal,
): Promise<SyncPlayerResult> {
  const state = await readPlayerSyncState(player.profileId);
  const storedSince = state === null ? null : new Date(state.since);
  const since =
    storedSince !== null && !Number.isNaN(storedSince.getTime()) ? storedSince : null;
  const sinceUsed = since === null ? null : since.toISOString();

  // `Player.name` es el nombre de display y no se toca aquí: lo escribió quien
  // se inscribió y no depende de que AoE4World renombre el perfil. Del perfil
  // solo se toma lo que es de AoE4World y va en su propia columna.
  try {
    const profile = await client.getPlayer(player.profileId, { signal });

    // El perfil se pide en cada pasada, así que aprovecha para refrescar también
    // el retrato: es la única vía para los jugadores que la ladder de `rm_solo`
    // no devuelve (sin partidas en la temporada), que no llegarían a tener
    // avatar nunca. Un `avatars.full` vacío no pisa el que ya había, igual que
    // en `ladder.ts`.
    const officialNameChanged = profile.name !== player.aoe4WorldName;
    const avatarUrl = profile.avatars.full;
    const avatarChanged = avatarUrl !== null && avatarUrl !== player.avatarUrl;

    if (officialNameChanged || avatarChanged) {
      await db.player.update({
        where: { id: player.id },
        data: {
          ...(officialNameChanged ? { aoe4WorldName: profile.name } : {}),
          ...(avatarChanged ? { avatarUrl } : {}),
        },
      });
    }
  } catch (error) {
    if (error instanceof Aoe4WorldError && error.status === 404) {
      // Perfil borrado o inexistente en AoE4World: es un fallo de este jugador,
      // no del lote, pero no se sigue gastando API en intentarlo cada pasada.
      return emptyPlayerResult(player, {
        status: "failed",
        error: `AoE4World no conoce el perfil ${player.profileId}.`,
        sinceUsed,
      });
    }

    throw error;
  }

  // Antes de paginar: rescata lo que el listado no va a alcanzar.
  const reconcile = await reconcileUnfinishedMatches(player, client, since, signal);

  const fetched = await fetchPlayerGames(client, player.profileId, since, config, signal);
  const now = new Date();

  const matches: NormalizedMatch[] = [];
  let matchesSkipped = 0;
  let liveMatches = 0;

  for (const game of fetched.games) {
    const normalized = normalizeGame(game, player.profileId, now);

    if (normalized.status === "skipped") {
      matchesSkipped += 1;
      continue;
    }

    if (normalized.match.finishedAt === null) {
      liveMatches += 1;
    }

    matches.push(normalized.match);
  }

  const { inserted, updated } = await persistMatches(player.id, matches);

  // El cursor solo avanza si hemos visto alguna partida, y nunca retrocede.
  const nextSince =
    fetched.maxStartedAt === null ? null : new Date(fetched.maxStartedAt.getTime() - SYNC_OVERLAP_MS);
  const cursorAdvances = nextSince !== null && (since === null || nextSince > since);
  const effectiveSince = cursorAdvances ? nextSince : since;
  const effectiveMaxStartedAt = fetched.maxStartedAt ?? (state === null ? null : new Date(state.maxStartedAt));

  let sinceStored = sinceUsed;

  // Se escribe el cursor si avanza o si hay abandonos que dejar anotados.
  if (
    effectiveSince !== null &&
    effectiveMaxStartedAt !== null &&
    !Number.isNaN(effectiveMaxStartedAt.getTime()) &&
    (cursorAdvances || reconcile.abandonedGameIds.length > 0)
  ) {
    await writePlayerSyncState(player.profileId, {
      since: effectiveSince.toISOString(),
      maxStartedAt: effectiveMaxStartedAt.toISOString(),
      lastSyncedAt: nowIso(),
      historyTruncated: cursorAdvances ? fetched.truncated : (state?.historyTruncated ?? false),
      ...mergeAbandonedAudit(state, reconcile.abandonedGameIds, nowIso()),
    });

    sinceStored = effectiveSince.toISOString();
  }

  return emptyPlayerResult(player, {
    pages: fetched.pages,
    gamesSeen: fetched.games.length,
    matchesInserted: inserted,
    matchesUpdated: updated,
    matchesSkipped,
    matchesResolvedByRefetch: reconcile.resolved,
    matchesAbandoned: reconcile.abandonedGameIds.length,
    liveMatches,
    historyTruncated: fetched.truncated,
    sinceUsed,
    sinceStored,
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
    concurrency: envConfig.syncConcurrency,
    deadlineMs: envConfig.syncDeadlineMs,
  };

  const client = options.client ?? createAoe4WorldClient();
  const startedAtMs = Date.now();

  // Plazo global: mejor un lote incompleto y legible que un cron que no acaba.
  const deadline = AbortSignal.timeout(config.deadlineMs);
  const signal = options.signal === undefined ? deadline : AbortSignal.any([options.signal, deadline]);

  const players = await readApprovedPlayers(options.profileIds);

  // Una sola llamada a la ladder para todos los aprobados, y antes del bucle:
  // así se ejecuta siempre, aunque el bucle se pase del plazo o algún jugador
  // falle. Si falla, se registra y la pasada continúa con lo que ya había.
  const ladder = await syncLadderSnapshot(players, client, signal);

  if (ladder.error !== null) {
    console.error(`[sync] No se ha podido refrescar la ladder: ${ladder.error}`);
  }

  const settled = await runPool(players, config.concurrency, async (player) => {
    if (signal.aborted) {
      return emptyPlayerResult(player, { status: "cancelled", error: "Plazo agotado." });
    }

    try {
      return await syncPlayer(player, client, config, signal);
    } catch (error) {
      return emptyPlayerResult(player, { status: "failed", error: toErrorMessage(error) });
    }
  });

  for (const result of settled) {
    if (result.status === "failed") {
      console.error(`[sync] Jugador ${result.profileId} (${result.name}): ${result.error}`);
    } else if (result.status === "cancelled") {
      console.warn(`[sync] Jugador ${result.profileId} (${result.name}): sincronización cancelada.`);
    }
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

  const finishedAtMs = Date.now();

  return {
    startedAt: new Date(startedAtMs).toISOString(),
    finishedAt: new Date(finishedAtMs).toISOString(),
    durationMs: finishedAtMs - startedAtMs,
    playersTotal: settled.length,
    playersOk: settled.filter((result) => result.status === "ok").length,
    playersFailed: settled.filter((result) => result.status === "failed").length,
    playersCancelled: settled.filter((result) => result.status === "cancelled").length,
    newMatches: settled.reduce((total, result) => total + result.matchesInserted, 0),
    updatedMatches: settled.reduce((total, result) => total + result.matchesUpdated, 0),
    resolvedByRefetch: settled.reduce((total, result) => total + result.matchesResolvedByRefetch, 0),
    abandonedMatches: settled.reduce((total, result) => total + result.matchesAbandoned, 0),
    skippedGames: settled.reduce((total, result) => total + result.matchesSkipped, 0),
    liveMatches: settled.reduce((total, result) => total + result.liveMatches, 0),
    apiRequests: client.stats.requests,
    apiRetries: client.stats.retries,
    rateLimitResponses: client.stats.rateLimitResponses,
    rateLimitPausesMs: client.stats.rateLimitPausesMs,
    ladder,
    scoring,
    scoringError,
    players: settled,
  };
}
