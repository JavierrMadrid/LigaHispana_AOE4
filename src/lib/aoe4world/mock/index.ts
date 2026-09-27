/**
 * Resolvedor de rutas del mock de AoE4World.
 *
 * Recibe lo mismo que `fetch` recibiría en `http.ts` (path + query) y devuelve
 * la respuesta ya serializada, o `not-found` para que quien llama traduzca el
 * fallo al `Aoe4WorldNotFoundError` del que ya sabe el worker. No lanza errores
 * propios: así el mock no se cuela en la política de reintentos de `http.ts`.
 *
 * Solo se mockean los tres endpoints que usa el worker (`getPlayer`,
 * `getPlayerGames` y `getPlayerGame`); `leaderboards` y `autocomplete` llevan
 * además una versión básica para que ninguna llamada de futuro se rompa. El
 * directorio de jugadores incluye también a los rivales externos: preguntar por
 * alguien de la ladder que no juega la liga devuelve su perfil, no un 404.
 */

import { DEFAULT_LEADERBOARD } from "../types";
import {
  MOCK_ALL_GAMES,
  mockCareerStats,
  mockGamesForPlayer,
  serializeMockGame,
  type MockCareerStats,
  type MockGame,
} from "./games";
import {
  MOCK_DIRECTORY_PLAYERS,
  MOCK_TOURNAMENT_PLAYERS,
  findMockPlayer,
  type MockTournamentPlayer,
} from "./players";

export type MockAoe4WorldResponse =
  | { kind: "ok"; payload: unknown }
  | { kind: "not-found" };

/** Máximo real de partidas por página; la API devuelve como mucho 50. */
const MAX_PAGE_SIZE = 50;

const DEFAULT_PAGE_SIZE = 50;

const DEFAULT_AUTOCOMPLETE_LIMIT = 10;

const OK = (payload: unknown): MockAoe4WorldResponse => ({ kind: "ok", payload });

const NOT_FOUND: MockAoe4WorldResponse = { kind: "not-found" };

function readPositiveIntText(text: string | undefined): number | null {
  if (text === undefined || !/^\d+$/.test(text)) {
    return null;
  }

  const value = Number(text);

  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function readPositiveIntParam(params: URLSearchParams, name: string, fallback: number): number {
  const raw = params.get(name);

  if (raw === null) {
    return fallback;
  }

  const value = Number(raw);

  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/** `since` llega como ISO desde `client.ts`; se tolera también epoch. */
function readSinceMs(params: URLSearchParams): number | null {
  const raw = params.get("since");

  if (raw === null || raw.trim() === "") {
    return null;
  }

  const parsed = Date.parse(raw);

  if (!Number.isNaN(parsed)) {
    return parsed;
  }

  const epoch = Number(raw);

  if (!Number.isFinite(epoch) || epoch <= 0) {
    return null;
  }

  return epoch < 1e11 ? epoch * 1000 : epoch;
}

/** Común a participantes y externos: lo mínimo para poblar `GET /players/:id`. */
type DirectoryPlayer = {
  profileId: number;
  name: string;
  country: string;
};

function playerPayload(player: DirectoryPlayer): unknown {
  return {
    profile_id: player.profileId,
    name: player.name,
    steam_id: null,
    site_url: `https://aoe4world.com/players/${player.profileId}`,
    country: player.country,
    avatars: { small: null, medium: null, full: null },
  };
}

/**
 * `GET /players/:profile_id/games`.
 *
 * Páginas de más reciente a más antigua igual que la API, con `since` acotando
 * por `started_at` y página vacía (no error) al pasar del final. Las partidas
 * en vivo serializan aquí su `started_at`, así que cada petición las ve dentro
 * de la ventana de 60 minutos.
 */
function gamesPagePayload(profileId: number, params: URLSearchParams): unknown {
  const now = new Date();
  const nowMs = now.getTime();
  const sinceMs = readSinceMs(params);
  const page = readPositiveIntParam(params, "page", 1);
  const limit = Math.min(
    readPositiveIntParam(params, "limit", DEFAULT_PAGE_SIZE),
    MAX_PAGE_SIZE,
  );

  const startedAtMs = (game: MockGame): number =>
    game.live ? nowMs - game.startedAtOffsetMs : game.startedAtMs;

  const games = mockGamesForPlayer(profileId)
    .sort((a, b) => startedAtMs(b) - startedAtMs(a))
    .filter((game) => sinceMs === null || startedAtMs(game) >= sinceMs);

  const offset = (page - 1) * limit;
  const slice = games.slice(offset, offset + limit);

  return {
    total_count: games.length,
    page,
    per_page: limit,
    count: slice.length,
    offset,
    next_page: offset + limit < games.length ? page + 1 : null,
    filters: {
      leaderboard: params.get("leaderboard"),
      since: params.get("since"),
      profile_ids: [profileId],
    },
    games: slice.map((game) => serializeMockGame(game, now, "listing")),
  };
}

function gameDetailPayload(profileId: number, gameId: number): MockAoe4WorldResponse {
  const game = MOCK_ALL_GAMES.find(
    (candidate) =>
      candidate.gameId === gameId &&
      candidate.teams.some((team) => team.some((side) => side.profileId === profileId)),
  );

  if (game === undefined) {
    return NOT_FOUND;
  }

  return OK(serializeMockGame(game, new Date(), "detail"));
}

function autocompletePayload(params: URLSearchParams): unknown {
  const query = params.get("query")?.trim() ?? "";
  const leaderboard = params.get("leaderboard") ?? DEFAULT_LEADERBOARD;
  const limit = readPositiveIntParam(params, "limit", DEFAULT_AUTOCOMPLETE_LIMIT);
  const needle = query.toLowerCase();

  const matches =
    needle === ""
      ? []
      : MOCK_DIRECTORY_PLAYERS.filter((player) =>
          player.name.toLowerCase().includes(needle),
        ).slice(0, limit);

  return {
    query,
    leaderboard,
    players: matches.map(playerPayload),
  };
}

/**
 * Entrada de la ladder simulada, con la misma forma que la real: de aquí sale
 * el elo, la división, la racha, el avatar y el directo de Twitch que el worker
 * guarda en `Player`, así que las fixtures de `mock/players.ts` tienen que
 * poblarlos todos si la tabla quiere verlos.
 */
function leaderboardEntry(
  player: MockTournamentPlayer,
  stats: MockCareerStats,
  rank: number,
): unknown {
  return {
    profile_id: player.profileId,
    name: player.name,
    country: player.country,
    rating: player.rating,
    rank,
    rank_level: player.rankLevel,
    streak: player.streak,
    games_count: stats.gamesCount,
    wins_count: stats.winsCount,
    losses_count: stats.lossesCount,
    twitch_url: player.twitchUrl,
    twitch_is_live: player.twitchIsLive,
    avatars: {
      small: player.avatarUrl,
      medium: player.avatarUrl,
      full: player.avatarUrl,
    },
    last_game_at:
      stats.lastGameAtMs === null ? null : new Date(stats.lastGameAtMs).toISOString(),
  };
}

/** `GET /leaderboards/:leaderboard?profile_id=1,2,3` (ids separados por comas). */
function leaderboardPayload(key: string, params: URLSearchParams): unknown {
  const requested = (params.get("profile_id") ?? "")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0);

  const entries = requested
    .flatMap((profileId) => {
      const player = MOCK_TOURNAMENT_PLAYERS.find((candidate) => candidate.profileId === profileId);
      return player === undefined ? [] : [{ player, stats: mockCareerStats(profileId) }];
    })
    .sort((a, b) => b.player.rating - a.player.rating)
    .map((entry, index) => leaderboardEntry(entry.player, entry.stats, index + 1));

  return {
    key,
    name: key,
    season: 14,
    players: entries,
    total_count: entries.length,
  };
}

/**
 * Única puerta del mock: `path` y `searchParams` son los mismos que viajarían
 * en la URL real (sin `api_key`, que se añade después en `http.ts`).
 */
export function resolveMockAoe4WorldRequest(
  path: string,
  searchParams: URLSearchParams | undefined,
): MockAoe4WorldResponse {
  const segments = path.split("/").filter((segment) => segment !== "");
  const params = searchParams ?? new URLSearchParams();

  if (segments[0] === "players") {
    if (segments[1] === "autocomplete" && segments.length === 2) {
      return OK(autocompletePayload(params));
    }

    const profileId = readPositiveIntText(segments[1]);

    if (profileId === null) {
      return NOT_FOUND;
    }

    // Participante o rival externo: los dos viven en el mismo directorio.
    const player = findMockPlayer(profileId);

    if (player === undefined) {
      return NOT_FOUND;
    }

    if (segments.length === 2) {
      return OK(playerPayload(player));
    }

    if (segments[2] === "games" && segments.length === 3) {
      return OK(gamesPagePayload(profileId, params));
    }

    if (segments[2] === "games" && segments.length === 4) {
      const gameId = readPositiveIntText(segments[3]);
      return gameId === null ? NOT_FOUND : gameDetailPayload(profileId, gameId);
    }

    return NOT_FOUND;
  }

  if (segments[0] === "leaderboards" && segments.length === 2) {
    const key = segments[1].trim();
    return key === "" ? NOT_FOUND : OK(leaderboardPayload(key, params));
  }

  return NOT_FOUND;
}
