/**
 * Endpoints de AoE4World, tipados.
 *
 * Cada función devuelve el tipo de `types.ts` y falla con un
 * `Aoe4WorldError` si la respuesta no tiene la forma esperada. Nada aquí hace
 * `fetch`: todo pasa por el cliente HTTP, que es quien aplica la política de
 * rate limit.
 */

import {
  createAoe4WorldHttpClient,
  Aoe4WorldError,
  type Aoe4WorldHttpClient,
  type Aoe4WorldRequestOptions,
} from "./http";
import {
  parseAutocomplete,
  parseGame,
  parseGamesPage,
  parseLeaderboard,
  parsePlayer,
} from "./parse";
import {
  DEFAULT_LEADERBOARD,
  type Aoe4WorldAutocompleteResult,
  type Aoe4WorldGame,
  type Aoe4WorldGamesPage,
  type Aoe4WorldLeaderboard,
  type Aoe4WorldPlayer,
} from "./types";

/** La API acepta un máximo de 50 ids por llamada a `leaderboards`. */
export const LEADERBOARD_MAX_PROFILE_IDS = 50;

/**
 * Máximo real de partidas por página. Pedir más no da error: la API devuelve
 * `per_page: 50` y una página más corta, así que acotamos aquí para no perder
 * tiempo ni contar páginas de más.
 */
export const GAMES_MAX_PAGE_SIZE = 50;

export type Aoe4WorldGamesQuery = {
  page?: number;
  limit?: number;
  /** Epoch en segundos o fecha ISO. Acota por `started_at`. */
  since?: Date | string;
  leaderboard?: string;
  opponentProfileId?: number;
  includeAlts?: boolean;
};

export type Aoe4WorldClient = {
  /** `GET /api/v0/players/:profile_id` */
  getPlayer(profileId: number, options?: Aoe4WorldRequestOptions): Promise<Aoe4WorldPlayer>;
  /** `GET /api/v0/players/:profile_id/games` */
  getPlayerGames(
    profileId: number,
    query?: Aoe4WorldGamesQuery,
    options?: Aoe4WorldRequestOptions,
  ): Promise<Aoe4WorldGamesPage>;
  /** `GET /api/v0/players/:profile_id/games/:game_id` */
  getPlayerGame(
    profileId: number,
    gameId: number,
    options?: Aoe4WorldRequestOptions,
  ): Promise<Aoe4WorldGame>;
  /** `GET /api/v0/leaderboards/:leaderboard` (hasta 50 ids) */
  getLeaderboard(
    leaderboard: string,
    profileIds: number[],
    options?: Aoe4WorldRequestOptions,
  ): Promise<Aoe4WorldLeaderboard>;
  /** `GET /api/v0/players/autocomplete` */
  autocompletePlayers(
    leaderboard: string,
    query: string,
    limit?: number,
    options?: Aoe4WorldRequestOptions,
  ): Promise<Aoe4WorldAutocompleteResult>;
  readonly stats: Aoe4WorldHttpClient["stats"];
};

function requireProfileId(profileId: number): void {
  if (!Number.isInteger(profileId) || profileId <= 0) {
    throw new Aoe4WorldError(`profile_id inválido: ${profileId}`);
  }
}

function requireGameId(gameId: number): void {
  if (!Number.isInteger(gameId) || gameId <= 0) {
    throw new Aoe4WorldError(`game_id inválido: ${gameId}`);
  }
}

/** `since` acepta epoch en segundos o fecha; normalizamos a ISO. */
function formatSince(since: Date | string): string {
  return since instanceof Date ? since.toISOString() : since;
}

function buildGamesQuery(query: Aoe4WorldGamesQuery | undefined): URLSearchParams {
  const params = new URLSearchParams();

  if (query === undefined) {
    return params;
  }

  if (query.page !== undefined) {
    params.set("page", String(query.page));
  }

  if (query.limit !== undefined) {
    params.set("limit", String(Math.min(query.limit, GAMES_MAX_PAGE_SIZE)));
  }

  if (query.since !== undefined) {
    params.set("since", formatSince(query.since));
  }

  if (query.leaderboard !== undefined) {
    params.set("leaderboard", query.leaderboard);
  }

  if (query.opponentProfileId !== undefined) {
    params.set("opponent_profile_id", String(query.opponentProfileId));
  }

  if (query.includeAlts !== undefined) {
    params.set("include_alts", String(query.includeAlts));
  }

  return params;
}

export function createAoe4WorldClient(
  http: Aoe4WorldHttpClient = createAoe4WorldHttpClient(),
): Aoe4WorldClient {
  return {
    async getPlayer(profileId, options) {
      requireProfileId(profileId);

      const payload = await http.fetchJson(`/players/${profileId}`, undefined, options);
      const player = parsePlayer(payload);

      if (player === null) {
        throw new Aoe4WorldError(
          `La respuesta de /players/${profileId} no tiene un perfil legible.`,
        );
      }

      return player;
    },

    async getPlayerGames(profileId, query, options) {
      requireProfileId(profileId);

      const payload = await http.fetchJson(
        `/players/${profileId}/games`,
        buildGamesQuery(query),
        options,
      );
      const page = parseGamesPage(payload);

      if (page === null) {
        throw new Aoe4WorldError(
          `La respuesta de /players/${profileId}/games no tiene la forma esperada.`,
        );
      }

      return page;
    },

    async getPlayerGame(profileId, gameId, options) {
      requireProfileId(profileId);
      requireGameId(gameId);

      const payload = await http.fetchJson(
        `/players/${profileId}/games/${gameId}`,
        undefined,
        options,
      );
      const game = parseGame(payload);

      if (game === null) {
        throw new Aoe4WorldError(`La partida ${gameId} no tiene la forma esperada.`);
      }

      return game;
    },

    async getLeaderboard(leaderboard, profileIds, options) {
      if (profileIds.length > LEADERBOARD_MAX_PROFILE_IDS) {
        throw new Aoe4WorldError(
          `/leaderboards acepta como máximo ${LEADERBOARD_MAX_PROFILE_IDS} profile_id por llamada (recibidos: ${profileIds.length}).`,
        );
      }

      // Comprobado contra la API: los ids van separados por comas. Mandar el
      // parámetro repetido no da error, pero solo devuelve el último, así que
      // se perderían jugadores en silencio.
      const params = new URLSearchParams();

      if (profileIds.length > 0) {
        params.set("profile_id", profileIds.join(","));
      }

      const payload = await http.fetchJson(
        `/leaderboards/${encodeURIComponent(leaderboard)}`,
        params,
        options,
      );
      const result = parseLeaderboard(payload);

      if (result === null) {
        throw new Aoe4WorldError(
          `La respuesta de /leaderboards/${leaderboard} no tiene la forma esperada.`,
        );
      }

      return result;
    },

    async autocompletePlayers(leaderboard, query, limit, options) {
      if (leaderboard.trim() === "") {
        throw new Aoe4WorldError("El autocomplete necesita una ladder.");
      }

      if (query.trim().length < 3) {
        throw new Aoe4WorldError("El autocomplete necesita al menos 3 caracteres.");
      }

      const params = new URLSearchParams({
        leaderboard,
        query,
      });

      if (limit !== undefined) {
        params.set("limit", String(limit));
      }

      const payload = await http.fetchJson("/players/autocomplete", params, options);
      const result = parseAutocomplete(payload);

      if (result === null) {
        throw new Aoe4WorldError("La respuesta de /players/autocomplete no tiene la forma esperada.");
      }

      return result;
    },

    get stats() {
      return http.stats;
    },
  };
}

export { DEFAULT_LEADERBOARD };
