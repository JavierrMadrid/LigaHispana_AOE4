import { isRecord } from "@/lib/json";
import {
  DEFAULT_LEADERBOARD,
  type Aoe4WorldAutocompleteResult,
  type Aoe4WorldGame,
  type Aoe4WorldGamePlayer,
  type Aoe4WorldGamesPage,
  type Aoe4WorldGameResult,
  type Aoe4WorldLadderPage,
  type Aoe4WorldLeaderboard,
  type Aoe4WorldLeaderboardEntry,
  type Aoe4WorldPlayer,
  type JsonInput,
} from "./types";

/**
 * Frontera de confianza con la API de AoE4World.
 *
 * Todo lo que llega de la red entra como `unknown` y sale de aquí ya tipado y
 * contrastado. Nunca hacemos `as` sobre la respuesta: si un campo no tiene la
 * forma esperada se devuelve `null` y quien llama decide (descartar la partida,
 * marcar al jugador como no encontrado, etc.). Es preferible perder una fila
 * rara que guardar datos falsos en la base de datos.
 */

const PROCESSED_STATE = "processed";

function readString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();

  return trimmed === "" ? null : trimmed;
}

/**
 * Acepta números y cadenas numéricas. La API es inconsistente en algunos
 * campos (depende de la serialización de origen), así que toleramos ambas
 * formas en lugar de perder el registro entero.
 */
function readNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function readInteger(value: unknown): number | null {
  const parsed = readNumber(value);

  if (parsed === null) {
    return null;
  }

  return Number.isInteger(parsed) ? parsed : null;
}

function readBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  return fallback;
}

/**
 * Acepta ISO 8601, fechas legibles tipo `2022/04/19` y epoch en segundos.
 * Devuelve `null` si no hay fecha utilizable, porque sin `started_at` la
 * partida no se puede colocar en el tiempo ni ordenar.
 */
function readDate(value: unknown): Date | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    // La API usa segundos epoch en unos campos y milisegundos en otros; los
    // valores en segundos son los que llegan hoy, así que se normaliza así.
    const milliseconds = value > 1e11 ? value : value * 1000;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }

  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : new Date(timestamp);
}

/**
 * El payload viene de `response.json()`, es decir de `JSON.parse`: por
 * construcción es JSON puro (sin `undefined`, funciones ni `BigInt`). La única
 * conversión necesaria es darle el nombre de tipo que ya tiene, para poder
 * guardarlo tal cual en la columna `rawJson`.
 */
export function asJsonValue(value: unknown): JsonInput {
  return value as JsonInput;
}

function readAvatars(value: unknown): Aoe4WorldPlayer["avatars"] {
  if (!isRecord(value)) {
    return { small: null, medium: null, full: null };
  }

  return {
    small: readString(value.small),
    medium: readString(value.medium),
    full: readString(value.full),
  };
}

export function parsePlayer(value: unknown): Aoe4WorldPlayer | null {
  if (!isRecord(value)) {
    return null;
  }

  const profileId = readInteger(value.profile_id);
  const name = readString(value.name);

  if (profileId === null || name === null) {
    return null;
  }

  return {
    profileId,
    name,
    steamId: readString(value.steam_id),
    siteUrl: readString(value.site_url),
    country: readString(value.country),
    avatars: readAvatars(value.avatars),
  };
}

function readGameResult(value: unknown): Aoe4WorldGameResult | null {
  const text = readString(value)?.toLowerCase();

  return text === "win" || text === "loss" ? text : null;
}

/**
 * En `/players/:id/games` cada entrada va envuelta en `{ player: {...} }` y en
 * `/players/:id/games/:game_id` viene plana. Aceptamos las dos formas para no
 * atar la normalización a un endpoint concreto.
 */
export function parseGamePlayer(entry: unknown): Aoe4WorldGamePlayer | null {
  const source = isRecord(entry) && isRecord(entry.player) ? entry.player : entry;

  if (!isRecord(source)) {
    return null;
  }

  return {
    profileId: readInteger(source.profile_id),
    name: readString(source.name),
    country: readString(source.country),
    result: readGameResult(source.result),
    civilization: readString(source.civilization),
    civilizationRandomized: readBoolean(source.civilization_randomized),
    rating: readNumber(source.rating),
    mmr: readNumber(source.mmr),
  };
}

function parseTeams(value: unknown): Aoe4WorldGamePlayer[][] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((team) => {
    if (!Array.isArray(team)) {
      return [];
    }

    const players = team.flatMap((entry) => {
      const player = parseGamePlayer(entry);
      return player === null ? [] : [player];
    });

    return players.length === 0 ? [] : [players];
  });
}

export function parseGame(value: unknown): Aoe4WorldGame | null {
  if (!isRecord(value)) {
    return null;
  }

  const gameId = readInteger(value.game_id);
  const startedAt = readDate(value.started_at);

  if (gameId === null || gameId <= 0 || startedAt === null) {
    return null;
  }

  const durationSeconds = readNumber(value.duration);
  const state = readString(value.state);

  return {
    gameId,
    startedAt,
    durationSeconds: durationSeconds === null ? null : Math.round(durationSeconds),
    map: readString(value.map),
    mapId: readInteger(value.map_id),
    leaderboard: readString(value.leaderboard),
    kind: readString(value.kind),
    state,
    ongoing: readBoolean(value.ongoing),
    justFinished: readBoolean(value.just_finished),
    averageMmr: readNumber(value.average_mmr),
    averageRating: readNumber(value.average_rating),
    teams: parseTeams(value.teams),
    raw: asJsonValue(value),
  };
}

export function parseGamesPage(value: unknown): Aoe4WorldGamesPage | null {
  if (!isRecord(value)) {
    return null;
  }

  const games = Array.isArray(value.games)
    ? value.games.flatMap((game) => {
        const parsed = parseGame(game);
        return parsed === null ? [] : [parsed];
      })
    : [];

  const perPage = readInteger(value.per_page) ?? games.length;
  const nextPage = readInteger(value.next_page);

  return {
    page: readInteger(value.page) ?? 1,
    perPage,
    totalCount: readInteger(value.total_count) ?? games.length,
    count: readInteger(value.count) ?? games.length,
    nextPage: nextPage !== null && nextPage > 0 ? nextPage : null,
    games,
  };
}

function parseLeaderboardEntry(value: unknown): Aoe4WorldLeaderboardEntry | null {
  if (!isRecord(value)) {
    return null;
  }

  const profileId = readInteger(value.profile_id);

  if (profileId === null) {
    return null;
  }

  return {
    profileId,
    name: readString(value.name) ?? "",
    country: readString(value.country),
    rating: readNumber(value.rating),
    rank: readInteger(value.rank),
    rankLevel: readString(value.rank_level),
    // Firmado: `readInteger` no descarta negativos, que es justo lo que hay que
    // conservar de una racha de derrotas.
    streak: readInteger(value.streak),
    gamesCount: readInteger(value.games_count),
    winsCount: readInteger(value.wins_count),
    lossesCount: readInteger(value.losses_count),
    twitchUrl: readString(value.twitch_url),
    twitchIsLive: readBoolean(value.twitch_is_live),
    avatars: readAvatars(value.avatars),
    lastGameAt: readDate(value.last_game_at),
  };
}

export function parseLeaderboard(value: unknown): Aoe4WorldLeaderboard | null {
  if (!isRecord(value)) {
    return null;
  }

  const key = readString(value.key);

  if (key === null) {
    return null;
  }

  const players = Array.isArray(value.players)
    ? value.players.flatMap((entry) => {
        const parsed = parseLeaderboardEntry(entry);
        return parsed === null ? [] : [parsed];
      })
    : [];

  return {
    key,
    name: readString(value.name) ?? key,
    season: readInteger(value.season),
    players,
    totalCount: readInteger(value.total_count) ?? players.length,
  };
}

/**
 * Una página de la ladder completa (`GET /leaderboards/:ladder` sin `profile_id`).
 *
 * Delega en `parseLeaderboard` para no duplicar la lectura de cada jugador y solo
 * añade lo que ese tipo no necesita: la paginación. Los campos salen de la misma
 * respuesta, así que una entrada se interpreta exactamente igual en los dos
 * endpoints.
 */
export function parseLadderPage(value: unknown): Aoe4WorldLadderPage | null {
  const board = parseLeaderboard(value);

  if (board === null || !isRecord(value)) {
    return null;
  }

  const perPage = readInteger(value.per_page) ?? board.players.length;
  const nextPage = readInteger(value.next_page);

  return {
    key: board.key,
    name: board.name,
    season: board.season,
    page: readInteger(value.page) ?? 1,
    perPage,
    totalCount: board.totalCount,
    count: readInteger(value.count) ?? board.players.length,
    nextPage: nextPage !== null && nextPage > 0 ? nextPage : null,
    players: board.players,
  };
}

export function parseAutocomplete(value: unknown): Aoe4WorldAutocompleteResult | null {
  if (!isRecord(value)) {
    return null;
  }

  const players = Array.isArray(value.players)
    ? value.players.flatMap((entry) => {
        const parsed = parsePlayer(entry);
        return parsed === null ? [] : [parsed];
      })
    : [];

  return {
    query: readString(value.query) ?? "",
    leaderboard: readString(value.leaderboard) ?? DEFAULT_LEADERBOARD,
    players,
  };
}

/** `processed` es el único estado con resultado definitivo. */
export function isProcessedState(state: string | null): boolean {
  return state !== null && state.toLowerCase() === PROCESSED_STATE;
}
