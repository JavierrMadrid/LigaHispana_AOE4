import "server-only";

import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { isRecord } from "@/lib/json";

/**
 * Lectura y escritura de la tabla `Setting`.
 *
 * `Setting` es la configuración del torneo y también la memoria del worker: hasta
 * qué fecha se le pidió a la API por cada jugador. Se centraliza aquí porque F3
 * (ventana de clasificatorias, reglas) va a usar las mismas claves.
 *
 * Claves que introduce F2:
 * - `aoe4world.sync.player.<profileId>`: cursor de sincronización de un jugador.
 *
 * Clave que introduce F3:
 * - `scoring.lastRun`: rastro de la última pasada del motor de puntuación.
 */

/** Cuántos `gameId` de partidas abandonadas se guardan como rastro. */
export const ABANDONED_AUDIT_LIMIT = 20;

export const PLAYER_SYNC_KEY_PREFIX = "aoe4world.sync.player.";

/**
 * Rastro de la última pasada del motor (`docs/MODELO-DATOS.md` §3.4).
 *
 * Es una fila que se sobrescribe, no un histórico: `ScoreSnapshot` sigue diferido
 * porque con una sola versión de reglas activa no hay delta que conservar, y lo que
 * hace falta para responder "¿cuándo se calculó esto y sobre cuántas partidas?" es
 * una línea. La hora la da la propia columna `Setting.updatedAt`, que se escribe en
 * la misma transacción que el recálculo.
 */
export const SCORING_LAST_RUN_KEY = "scoring.lastRun";

export function playerSyncKey(profileId: number): string {
  return `${PLAYER_SYNC_KEY_PREFIX}${profileId}`;
}

export type PlayerSyncState = {
  /** Último `started_at` visto menos el solape de seguridad; es lo que se manda como `since`. */
  since: string;
  /** Último `started_at` visto tal cual, sin restar el solape. */
  maxStartedAt: string;
  /** Cuándo se hizo esta sincronización. */
  lastSyncedAt: string;
  /** `true` si el tope de páginas cortó el histórico y quedan partidas por traer. */
  historyTruncated: boolean;
  /**
   * Rastro de la regla "una partida abandonada nunca cuenta": cuántas se han
   * descartado y cuáles, para que el borrado no sea silencioso. No puntúa
   * nada; solo deja constancia de lo que el worker eliminó y por qué.
   */
  abandonedCount: number;
  abandonedGameIds: string[];
  lastAbandonedAt: string | null;
};

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string");
}

function readPlayerSyncStateValue(value: unknown): PlayerSyncState | null {
  if (!isRecord(value)) {
    return null;
  }

  const { since, maxStartedAt, lastSyncedAt, historyTruncated } = value;

  if (typeof since !== "string" || typeof maxStartedAt !== "string") {
    return null;
  }

  const abandonedCount =
    typeof value.abandonedCount === "number" && Number.isInteger(value.abandonedCount)
      ? value.abandonedCount
      : 0;

  return {
    since,
    maxStartedAt,
    lastSyncedAt: typeof lastSyncedAt === "string" ? lastSyncedAt : since,
    historyTruncated: historyTruncated === true,
    abandonedCount: Math.max(abandonedCount, 0),
    abandonedGameIds: readStringArray(value.abandonedGameIds).slice(0, ABANDONED_AUDIT_LIMIT),
    lastAbandonedAt: typeof value.lastAbandonedAt === "string" ? value.lastAbandonedAt : null,
  };
}

export async function readPlayerSyncState(profileId: number): Promise<PlayerSyncState | null> {
  const setting = await db.setting.findUnique({ where: { key: playerSyncKey(profileId) } });

  return setting === null ? null : readPlayerSyncStateValue(setting.value);
}

/** Rastro de abandonos, del más reciente al más antiguo y acotado. */
export function mergeAbandonedAudit(
  previous: PlayerSyncState | null,
  addedGameIds: string[],
  nowIso: string,
): Pick<PlayerSyncState, "abandonedCount" | "abandonedGameIds" | "lastAbandonedAt"> {
  if (addedGameIds.length === 0) {
    return {
      abandonedCount: previous?.abandonedCount ?? 0,
      abandonedGameIds: previous?.abandonedGameIds ?? [],
      lastAbandonedAt: previous?.lastAbandonedAt ?? null,
    };
  }

  return {
    abandonedCount: (previous?.abandonedCount ?? 0) + addedGameIds.length,
    abandonedGameIds: [...addedGameIds, ...(previous?.abandonedGameIds ?? [])].slice(
      0,
      ABANDONED_AUDIT_LIMIT,
    ),
    lastAbandonedAt: nowIso,
  };
}

export async function writePlayerSyncState(
  profileId: number,
  state: PlayerSyncState,
): Promise<void> {
  const key = playerSyncKey(profileId);

  await db.setting.upsert({
    where: { key },
    create: { key, value: state },
    update: { value: state },
  });
}

/** Cliente con la única tabla que necesita escribir (`db` o una `tx`). */
export type SettingWriter = Pick<Prisma.TransactionClient, "setting">;

/**
 * Escribe el rastro de la última pasada del motor.
 *
 * Acepta el cliente porque el motor lo llama **dentro** de su transacción: así el
 * rastro se confirma a la vez que la clasificación, y nunca queda describiendo un
 * recálculo que se ha escrito a medias o que ha abortado.
 */
export async function writeScoringLastRun(
  value: Prisma.InputJsonObject,
  client: SettingWriter = db,
): Promise<void> {
  await client.setting.upsert({
    where: { key: SCORING_LAST_RUN_KEY },
    create: { key: SCORING_LAST_RUN_KEY, value },
    update: { value },
  });
}
