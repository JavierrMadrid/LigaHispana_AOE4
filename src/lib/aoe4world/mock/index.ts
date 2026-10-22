/**
 * Resolvedor de rutas del mock de AoE4World.
 *
 * Recibe lo mismo que `fetch` recibiría en `http.ts` (path + query) y devuelve
 * la respuesta ya serializada, o `not-found` para que quien llama traduzca el
 * fallo al `Aoe4WorldNotFoundError` del que ya sabe el worker. Tampoco lanza los
 * errores de validación: devuelve la variante `error` y es `http.ts` quien la
 * convierte en un `Aoe4WorldError` con el status y el criterio de reintento que
 * tendría una respuesta real.
 *
 * Solo se mockean los cuatro endpoints que usa el worker (`getPlayer`,
 * `getPlayerGames`, `getPlayerGame` y el masivo `GET /games`); `leaderboards` y
 * `autocomplete` llevan además una versión básica para que ninguna llamada de
 * futuro se rompa. El directorio de jugadores incluye también a los rivales
 * externos: preguntar por alguien de la ladder que no juega la liga devuelve su
 * perfil, no un 404.
 */

import { DEFAULT_LEADERBOARD } from "../types";
import {
  MOCK_ALL_GAMES,
  mockCareerStats,
  mockGameStartedAtMs,
  mockGameUpdatedAtMs,
  mockGamesForPlayer,
  mockGamesForPlayers,
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
  | { kind: "not-found" }
  | { kind: "error"; status: number; message: string };

/** Máximo real de partidas por página; la API devuelve como mucho 50. */
const MAX_PAGE_SIZE = 50;

const DEFAULT_PAGE_SIZE = 50;

const DEFAULT_AUTOCOMPLETE_LIMIT = 10;

/** Ids que el endpoint masivo acepta por llamada (el cliente valida 1–50). */
const MAX_BULK_PROFILE_IDS = 50;

/** Tope real de páginas del endpoint masivo: la 21 devuelve 400. */
const MAX_BULK_PAGE = 20;

/**
 * Antigüedad a partir de la cual `updated_since` deja de servir. Medido en F0:
 * con 30, 60 y 90 días la API responde 200 con una página vacía y este aviso.
 */
const UPDATED_SINCE_NOTICE_MS = 30 * 24 * 60 * 60 * 1000;

export const OLD_UPDATED_SINCE_NOTICE =
  "updated_since=.. is too long ago, are you keeping it up to date?... and msg us on discord ~ aoe4world devs";

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

/** `since` y `updated_since` llegan como ISO desde `client.ts`; se tolera epoch. */
function readDateMs(raw: string | null): number | null {
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

function readSinceMs(params: URLSearchParams): number | null {
  return readDateMs(params.get("since"));
}

function readUpdatedSinceMs(params: URLSearchParams): number | null {
  return readDateMs(params.get("updated_since"));
}

/**
 * Los `profile_ids` del endpoint masivo, separados por comas.
 *
 * Se conserva el orden y se quitan repetidos: el límite de 50 se aplica después
 * sobre la lista ya limpia, que es lo que hace que `filters.profile_ids` diga
 * exactamente qué ids se quedó la API.
 */
function readProfileIds(params: URLSearchParams): number[] {
  const ids = new Set<number>();

  for (const raw of (params.get("profile_ids") ?? "").split(",")) {
    const text = raw.trim();

    if (!/^\d+$/.test(text)) {
      continue;
    }

    const value = Number(text);

    if (Number.isSafeInteger(value) && value > 0) {
      ids.add(value);
    }
  }

  return [...ids];
}

/** Común a participantes y externos: lo mínimo para poblar `GET /players/:id`. */
type DirectoryPlayer = {
  profileId: number;
  name: string;
  country: string;
  /** `avatars.full`; los rivales externos no lo traen y se responde `null`. */
  avatarUrl?: string | null;
};

function playerPayload(player: DirectoryPlayer): unknown {
  const avatar = player.avatarUrl ?? null;

  return {
    profile_id: player.profileId,
    name: player.name,
    steam_id: null,
    site_url: `https://aoe4world.com/players/${player.profileId}`,
    country: player.country,
    // La API real devuelve aquí el retrato (contrastado en septiembre de 2026):
    // el worker lo guarda, así que el mock tiene que servirlo también.
    avatars: { small: avatar, medium: avatar, full: avatar },
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

/**
 * `GET /games?profile_ids=…&since=…&updated_since=…&order=…&page=…`.
 *
 * Es el endpoint masivo que F2 usará para traer las partidas nuevas de varios
 * jugadores en una sola llamada. Reproduce lo que se midió contra la API real en
 * F0: sin `total_count`, `per_page` fijo en 50, `_important_notice_` cuando
 * `updated_since` es demasiado antiguo, tope de 20 páginas y página vacía más
 * allá del final.
 *
 * La unión de las partidas se deduplica aquí por `gameId`: `mockGamesForPlayers()`
 * devuelve la partida compartida en el array de cada uno de sus jugadores, y la
 * API masiva la publica una sola vez por página.
 */
function bulkGamesPayload(params: URLSearchParams): MockAoe4WorldResponse {
  const page = readPositiveIntParam(params, "page", 1);

  if (page > MAX_BULK_PAGE) {
    return {
      kind: "error",
      status: 400,
      message: `Page greater than ${MAX_BULK_PAGE} is not supported`,
    };
  }

  const now = new Date();
  const nowMs = now.getTime();
  const keptIds = readProfileIds(params).slice(0, MAX_BULK_PROFILE_IDS);
  const sinceMs = readSinceMs(params);
  const updatedSinceMs = readUpdatedSinceMs(params);
  const order = params.get("order") === "started_at" ? "started_at" : "updated_at";
  const notice =
    updatedSinceMs !== null && nowMs - updatedSinceMs >= UPDATED_SINCE_NOTICE_MS
      ? OLD_UPDATED_SINCE_NOTICE
      : null;
  const filters = {
    profile_ids: keptIds,
    since: params.get("since"),
    updated_since: params.get("updated_since"),
    order,
    ...(notice === null ? {} : { _important_notice_: notice }),
  };
  const offset = (page - 1) * DEFAULT_PAGE_SIZE;

  if (notice !== null) {
    return OK({
      page,
      per_page: DEFAULT_PAGE_SIZE,
      count: 0,
      offset,
      next_page: null,
      filters,
      games: [],
    });
  }

  const union = new Map<number, MockGame>();

  for (const games of mockGamesForPlayers(keptIds).values()) {
    for (const game of games) {
      union.set(game.gameId, game);
    }
  }

  const timestamp =
    order === "started_at"
      ? (game: MockGame): number => mockGameStartedAtMs(game, now)
      : (game: MockGame): number => mockGameUpdatedAtMs(game, now);

  const games = [...union.values()]
    .filter((game) => sinceMs === null || mockGameStartedAtMs(game, now) >= sinceMs)
    .filter((game) => updatedSinceMs === null || mockGameUpdatedAtMs(game, now) >= updatedSinceMs)
    .sort((a, b) => timestamp(b) - timestamp(a) || b.gameId - a.gameId);

  const slice = games.slice(offset, offset + DEFAULT_PAGE_SIZE);

  return OK({
    page,
    per_page: DEFAULT_PAGE_SIZE,
    count: slice.length,
    offset,
    next_page:
      page < MAX_BULK_PAGE && offset + DEFAULT_PAGE_SIZE < games.length ? page + 1 : null,
    filters,
    games: slice.map((game) => serializeMockGame(game, now, "listing")),
  });
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

  // El endpoint masivo va antes que `players` porque no cuelga de un perfil.
  if (segments[0] === "games") {
    return segments.length === 1 ? bulkGamesPayload(params) : NOT_FOUND;
  }

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
