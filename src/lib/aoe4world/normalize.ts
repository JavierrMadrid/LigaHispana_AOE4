import { MatchResult } from "@/generated/prisma/enums";
import { isProcessedState } from "./parse";
import type { Aoe4WorldGame, JsonInput } from "./types";

/**
 * Ventana de "partida en directo".
 *
 * La API solo publica partidas terminadas: una partida en curso aparece con
 * `ongoing: true` y/o `state` distinto de `processed` mientras la API todavía
 * no ha obtenido el resultado definitivo (su FAQ dice que puede tardar unos
 * minutos). Ese estado se queda así para siempre si alguien abandona la
 * partida, así que no basta con mirar `ongoing`: exigimos además que la
 * partida haya empezado hace poco.
 *
 * 60 minutos es el umbral porque la partida *más larga* que hemos observado en
 * las respuestas reales de la API ronda los 50 minutos (ranked 1v1 y 4v4
 * custom). Con 60 cubrimos esas partidas con margen y, a la vez, una partida
 * olvidada deja de figurar como "en directo" a la hora.
 */
export const LIVE_GAME_WINDOW_MINUTES = 60;

export const LIVE_GAME_WINDOW_MS = LIVE_GAME_WINDOW_MINUTES * 60_000;

export type NormalizedMatch = {
  gameId: string;
  leaderboard: string;
  opponentProfileId: number | null;
  opponentName: string | null;
  civ: string | null;
  opponentCiv: string | null;
  map: string | null;
  /** `null` mientras la partida sigue en curso. */
  result: MatchResult | null;
  startedAt: Date;
  /** `null` mientras la partida sigue en curso: así la lista F4 la encuentra. */
  finishedAt: Date | null;
  durationSeconds: number | null;
  rawJson: JsonInput;
};

export type NormalizedGame =
  | { status: "ok"; match: NormalizedMatch }
  | { status: "skipped"; gameId: number; reason: string };

/**
 * La API no da `finished_at`: se deduce sumando la duración a `started_at`. Para
 * las partidas en curso no hay duración, y por eso `finishedAt` queda a `null`.
 */
export function isLiveGame(game: Aoe4WorldGame, now: Date = new Date()): boolean {
  const notFinishedYet = game.ongoing || !isProcessedState(game.state);
  const elapsedMs = now.getTime() - game.startedAt.getTime();

  return notFinishedYet && elapsedMs <= LIVE_GAME_WINDOW_MS;
}

function toMatchResult(result: "win" | "loss" | null): MatchResult | null {
  if (result === "win") {
    return MatchResult.WIN;
  }

  if (result === "loss") {
    return MatchResult.LOSS;
  }

  return null;
}

/**
 * Localiza al jugador dentro de la partida y su equipo contrario.
 *
 * La API agrupa en `teams` según el modo de juego: en 1v1 hay un jugador por
 * equipo, en 2v2 o 3v3 hay varios. Guardamos un solo rival (el primero del
 * equipo contrario) porque el schema tiene un único par de campos de rival; en
 * `rawJson` queda el equipo completo por si F3/F4 necesitan más.
 */
function findSides(game: Aoe4WorldGame, profileId: number) {
  const ownTeam = game.teams.find((team) => team.some((player) => player.profileId === profileId));
  const own = ownTeam?.find((player) => player.profileId === profileId) ?? null;
  const opponentTeam = game.teams.find((team) => !team.some((p) => p.profileId === profileId));
  const opponent = opponentTeam?.[0] ?? null;

  return { own, opponent };
}

export function normalizeGame(
  game: Aoe4WorldGame,
  profileId: number,
  now: Date = new Date(),
): NormalizedGame {
  const leaderboard = game.leaderboard ?? game.kind;

  if (leaderboard === null) {
    return {
      status: "skipped",
      gameId: game.gameId,
      reason: "la partida no indica ni leaderboard ni kind",
    };
  }

  const live = isLiveGame(game, now);
  const { own, opponent } = findSides(game, profileId);
  const result = toMatchResult(own?.result ?? null);

  if (!live && result === null) {
    // Fuera de la ventana de "en directo" y sin resultado: la API no tiene (o
    // ya nunca tendrá) el desenlace. No inventamos nada y la descartamos.
    return {
      status: "skipped",
      gameId: game.gameId,
      reason: "partida cerrada sin resultado (la API no la tiene procesada)",
    };
  }

  const finishedAt =
    live || game.durationSeconds === null
      ? null
      : new Date(game.startedAt.getTime() + game.durationSeconds * 1000);

  return {
    status: "ok",
    match: {
      gameId: String(game.gameId),
      leaderboard,
      opponentProfileId: opponent?.profileId ?? null,
      opponentName: opponent?.name ?? null,
      civ: own?.civilization ?? null,
      opponentCiv: opponent?.civilization ?? null,
      map: game.map,
      result,
      startedAt: game.startedAt,
      finishedAt,
      durationSeconds: live ? null : game.durationSeconds,
      rawJson: game.raw,
    },
  };
}
