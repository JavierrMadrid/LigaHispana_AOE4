import "server-only";

import { db } from "@/lib/db";
import { LEADERBOARD_MAX_PROFILE_IDS, type Aoe4WorldClient } from "./client";
import { DEFAULT_LEADERBOARD } from "./types";

/**
 * Instantánea de la ladder de los participantes, una vez por pasada del worker.
 *
 * Un único `GET /leaderboards/rm_solo?profile_id=…` (ids separados por comas,
 * hasta 50 por llamada) trae de golpe elo, `rank_level`, racha, número de partidas,
 * fecha de la última, canal y estado de directo de Twitch de todos los aprobados.
 * Pedirlo jugador a jugador multiplicaría el consumo de la API por el número de
 * participantes para traer exactamente los mismos datos.
 *
 * Reglas:
 *
 * - Un jugador que **no aparece** en la respuesta se queda como estaba: no se
 *   borra su elo ni su racha. Ocurre con perfiles sin partidas en la ladder y
 *   con la API devolviendo una página incompleta.
 * - Un jugador que aparece **con los campos vacíos** sí se guarda así (`null`
 *   en `elo`/`rankLevel`/`streak`, `twitchIsLive = false`): eso significa "no
 *   está clasificado ahora mismo", que es información y no un hueco.
 * - **Excepción `avatarUrl`**: un `avatars.full` vacío no dice nada (el retrato
 *   sigue existiendo en AoE4World), así que no pisa el último guardado; solo se
 *   actualiza cuando llega URL nueva. Borrar un avatar bueno degradaría la
 *   tabla a un monograma sin ganar información.
 * - Un fallo de este paso **no tumba la pasada**: se devuelve en `error`, quien
 *   llama lo registra y la sincronización de partidas sigue igual. La web
 *   serviría el último snapshot guardado hasta la próxima pasada.
 */

export type LadderPlayerRow = {
  id: string;
  profileId: number;
};

export type LadderSyncResult = {
  /** Llamadas hechas a `/leaderboards` (1 por cada 50 jugadores). */
  batches: number;
  playersRequested: number;
  /** Jugadores que la ladder sí ha devuelto. */
  playersSeen: number;
  playersUpdated: number;
  /** Pedidos que no aparecen en la respuesta: se conserva lo que ya tenían. */
  playersMissing: number;
  /** Por qué no se pudo completar el snapshot, si no se pudo. */
  error: string | null;
};

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return `Error desconocido: ${String(error)}`;
}

export async function syncLadderSnapshot(
  players: LadderPlayerRow[],
  client: Aoe4WorldClient,
  signal: AbortSignal,
): Promise<LadderSyncResult> {
  const result: LadderSyncResult = {
    batches: 0,
    playersRequested: players.length,
    playersSeen: 0,
    playersUpdated: 0,
    playersMissing: 0,
    error: null,
  };

  if (players.length === 0) {
    return result;
  }

  const byProfileId = new Map(players.map((player) => [player.profileId, player]));
  const fetchedAt = new Date();

  // Un solo `try`: si un lote falla (rate limit agotado, red caída) no se
  // siguen lanzando llamadas justo después, que es cuando más duele un 429.
  try {
    for (let start = 0; start < players.length; start += LEADERBOARD_MAX_PROFILE_IDS) {
      const profileIds = players
        .slice(start, start + LEADERBOARD_MAX_PROFILE_IDS)
        .map((player) => player.profileId);

      const board = await client.getLeaderboard(DEFAULT_LEADERBOARD, profileIds, { signal });
      result.batches += 1;

      const entries = new Map(board.players.map((entry) => [entry.profileId, entry]));

      for (const profileId of profileIds) {
        const player = byProfileId.get(profileId);

        if (player === undefined) {
          // No puede pasar (salen de la misma lista) y, si pasara, lo seguro
          // es no tocar ninguna fila.
          continue;
        }

        const entry = entries.get(profileId);

        if (entry === undefined) {
          result.playersMissing += 1;
          continue;
        }

        await db.player.update({
          where: { id: player.id },
          data: {
            elo: entry.rating,
            rankLevel: entry.rankLevel,
            streak: entry.streak,
            // Los dos que se estaban descartando y que no costaban nada: vienen en
            // la misma entrada de la misma llamada por lotes. Con
            // `ladderLastGameAt` se puede saber que la ladder registra una partida
            // que todavía no aparece en nuestro histórico (ver
            // `LADDER_PUBLICATION_LAG_MINUTES`); con `ladderGamesCount`, cuántos
            // juegos lleva en la temporada.
            ladderGamesCount: entry.gamesCount,
            ladderLastGameAt: entry.lastGameAt,
            twitchIsLive: entry.twitchIsLive,
            twitchUrl: entry.twitchUrl,
            // Sin la clave en el `update`, Prisma no toca el campo: un avatar
            // nulo de la respuesta no borra el que ya había (ver cabecera).
            ...(entry.avatars.full === null ? {} : { avatarUrl: entry.avatars.full }),
            ladderUpdatedAt: fetchedAt,
          },
        });

        result.playersSeen += 1;
        result.playersUpdated += 1;
      }
    }
  } catch (error) {
    result.error = toErrorMessage(error);
  }

  return result;
}
