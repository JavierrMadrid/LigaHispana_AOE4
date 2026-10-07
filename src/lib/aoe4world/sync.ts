import "server-only";

import { evaluateAlerts, type EvaluateAlertsResult } from "@/lib/alerts/evaluate";
import { checkDiscordMembership, describeDiscordChecks, type DiscordChecksResult } from "@/lib/discord/check";
import { db } from "@/lib/db";
import {
  checkPlayerHistory,
  describeHistoryChecks,
  type HistoryChecksResult,
} from "@/lib/history-checks";
import {
  mergeAbandonedAudit,
  readPlayerSyncState,
  readSyncRunTrace,
  writePlayerSyncState,
  writeSyncRunTrace,
  type SyncRunTrace,
} from "@/lib/settings";
import { recomputeScores, type RecomputeScoresResult } from "@/lib/scoring";
import {
  describeStreamRefresh,
  refreshStreamLiveStatus,
  type StreamRefreshResult,
} from "@/lib/streams/refresh";
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
 * Al final se recalcula la clasificación y, si algo ha cambiado para alguien, se
 * evaluan las alertas de comportamiento **de ese jugador y solo de ese**. Es lo
 * que cumple el requisito de "siempre actualizada" sin que nadie tenga que
 * recargar: cada pasada del worker deja la tabla de puntos al día y el historial
 * de alertas al día.
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
    console.warn(
      `[sync] Jugador ${player.profileId}: partida ${gameId} borrada (${ABANDONED_REASON}).`,
    );
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
  const since = storedSince !== null && !Number.isNaN(storedSince.getTime()) ? storedSince : null;
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
    fetched.maxStartedAt === null
      ? null
      : new Date(fetched.maxStartedAt.getTime() - SYNC_OVERLAP_MS);
  const cursorAdvances = nextSince !== null && (since === null || nextSince > since);
  const effectiveSince = cursorAdvances ? nextSince : since;
  const effectiveMaxStartedAt =
    fetched.maxStartedAt ?? (state === null ? null : new Date(state.maxStartedAt));

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
  const signal =
    options.signal === undefined ? deadline : AbortSignal.any([options.signal, deadline]);

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
      console.warn(
        `[sync] Jugador ${result.profileId} (${result.name}): sincronización cancelada.`,
      );
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

  // Las alertas van **después** del recálculo y solo para quien ha cambiado, porque
  // una alerta de comportamiento solo puede moverse si el conjunto de
  // clasificatorias del jugador ha cambiado: y eso es exactamente lo que cuenta
  // cualquiera de los cuatro contadores. En una pasada sin novedades (lo normal,
  // 288 veces al día) no se evalúa a nadie y no se lee ni una fila de `Match`.
  const tocados = settled
    .filter(
      (result) =>
        result.matchesInserted > 0 ||
        result.matchesUpdated > 0 ||
        result.matchesResolvedByRefetch > 0 ||
        result.matchesAbandoned > 0,
    )
    .map((result) => result.profileId);

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
  // lectura por cada mil miembros, cacheada doce horas, que además resuelve el
  // `discordUserId` de quien solo tiene `@usuario`— y solo si esa lista no está
  // disponible cae a una petición por cuenta (`GET /guilds/{id}/members/{user}`).
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

  // El estado de directo de YouTube y Kick va **el último de los tres que salen a la
  // red**, con el mismo tratamiento que las alertas: tolerante a fallos, con el motivo
  // en el rastro, y sin que un fallo suyo pueda parar la pasada. Y por el mismo motivo
  // que las alertas, se ejecuta aquí y no en el DAL: son peticiones salientes a dos
  // APIs externas, y en el plan Free de Cloudflare eso solo cabe una vez por pasada
  // (README, "El límite de CPU del plan Free"), no en cada visita a la web.
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

  const finishedAtMs = Date.now();

  const summary: SyncSummary = {
    startedAt: new Date(startedAtMs).toISOString(),
    finishedAt: new Date(finishedAtMs).toISOString(),
    durationMs: finishedAtMs - startedAtMs,
    playersTotal: settled.length,
    playersOk: settled.filter((result) => result.status === "ok").length,
    playersFailed: settled.filter((result) => result.status === "failed").length,
    playersCancelled: settled.filter((result) => result.status === "cancelled").length,
    newMatches: settled.reduce((total, result) => total + result.matchesInserted, 0),
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
