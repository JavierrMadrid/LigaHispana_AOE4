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
  /** Familia de ladder resuelta; `null` solo si la API no dio ninguna referencia. */
  mode: string | null;
  opponentProfileId: number | null;
  opponentName: string | null;
  civ: string | null;
  opponentCiv: string | null;
  civRandomized: boolean;
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

/**
 * Corte por el que una partida **guardada** sin resolver deja de poder estar viva.
 *
 * `finishedAt = null` significa "en curso" para F4, así que una fila así solo es
 * legítima mientras la partida pueda seguir jugándose. Pasada la ventana de
 * directo ya no: hay que ir a por su desenlace (resolverla o abandonarla). El
 * sincronizador usa este corte para elegir qué pendientes reconciliar, y por eso
 * la condición **no** depende del cursor `since`: una partida abandonada que fuera
 * la más nueva del jugador tiene `startedAt >= since` (el cursor es
 * `maxStartedAt − 60 min`) y con el criterio del cursor se quedaría sin
 * reconciliar para siempre.
 */
export function reconciliationCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - LIVE_GAME_WINDOW_MS);
}

/**
 * Correspondencia mecánica entre el `kind` de la API y la familia de ladder.
 *
 * La API usa el mismo nombre para cosas distintas según el endpoint: un ranked
 * 2v2 puede venir como `leaderboard: "rm_team"` o como `kind: "rm_2v2"`. Como
 * `leaderboard` es el registro literal de lo que publicó la API, no se reescribe;
 * esta función produce la familia canónica en `Match.mode`, que es la columna por
 * la que el motor filtra.
 *
 * La lista de qué familias **puntúan** no va aquí: eso es dato de las reglas, y
 * por eso el mapeo es "cómo se llaman las cosas en la API" y no "qué cuenta en
 * este torneo". Así, añadir un modo al ruleset no obliga a reescribir datos.
 */
const LADDER_FAMILY: Readonly<Record<string, string>> = {
  rm_1v1: "rm_solo",
  rm_2v2: "rm_team",
  rm_3v3: "rm_team",
  rm_4v4: "rm_team",
};

/** `rm_1v1` -> `rm_solo`, `rm_2v2` -> `rm_team`, cualquier otro valor pasa tal cual. */
export function resolveGameMode(leaderboard: string | null): string | null {
  if (leaderboard === null) {
    return null;
  }

  const trimmed = leaderboard.trim();

  if (trimmed === "") {
    return null;
  }

  return LADDER_FAMILY[trimmed] ?? trimmed;
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

/**
 * Si la civilización de **este** jugador fue aleatoria.
 *
 * La API marca la civilización de cada jugador dentro de su equipo, así que hay
 * que buscar a nuestro `profileId` y no leer el primer `true` que aparezca: en un
 * 2v2 puede ser el compañero el que jugó con civ aleatoria. `teams` ya viene
 * normalizado desde `parse.ts`, que acepta las dos formas en que la API envía la
 * entrada (`{ player: {...} }` en el listado y plana en el detalle), así que aquí
 * no hay que volver a parsear `rawJson`.
 *
 * `false` cuando no aparece: la API no siempre manda el campo, y quedarse sin
 * dato se interpreta como "no aleatoria", que es el mismo valor por defecto de la
 * columna.
 */
export function readOwnCivRandomized(game: Aoe4WorldGame, profileId: number): boolean {
  return findSides(game, profileId).own?.civilizationRandomized ?? false;
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
      mode: resolveGameMode(leaderboard),
      opponentProfileId: opponent?.profileId ?? null,
      opponentName: opponent?.name ?? null,
      civ: own?.civilization ?? null,
      opponentCiv: opponent?.civilization ?? null,
      civRandomized: readOwnCivRandomized(game, profileId),
      map: game.map,
      result,
      startedAt: game.startedAt,
      finishedAt,
      durationSeconds: live ? null : game.durationSeconds,
      rawJson: game.raw,
    },
  };
}
