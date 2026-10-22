import { afterEach, describe, expect, it, vi } from "vitest";

import {
  OLD_UPDATED_SINCE_NOTICE,
  resolveMockAoe4WorldRequest,
} from "@/lib/aoe4world/mock";
import { MOCK_FINISHED_GAMES, mockGamesForPlayers } from "@/lib/aoe4world/mock/games";
import { MOCK_TOURNAMENT_PLAYERS } from "@/lib/aoe4world/mock/players";

/**
 * El mock de AoE4World, y en particular el endpoint masivo `GET /games`.
 *
 * Aquí se fijan las trampas que F0 midió contra la API real y que F2 va a
 * consumir: envelope sin `total_count`, `per_page` ignorado, recorte a 50 ids,
 * tope de 20 páginas y aviso de `updated_since` antiguo. Los tests usan las
 * fixtures deterministas del histórico; solo el de `since`/`updated_since`
 * fija el reloj, porque el histórico está anclado a septiembre y el aviso de
 * 30 días depende de la fecha de ejecución.
 */

type MockResponse = ReturnType<typeof resolveMockAoe4WorldRequest>;

function resolve(
  path: string,
  params: Record<string, string> = {},
): MockResponse {
  return resolveMockAoe4WorldRequest(path, new URLSearchParams(params));
}

function payloadOf(response: MockResponse): Record<string, unknown> {
  if (response.kind !== "ok") {
    throw new Error(`Se esperaba una respuesta ok y llegó ${response.kind}.`);
  }

  return response.payload as Record<string, unknown>;
}

function gamesOf(payload: Record<string, unknown>): Record<string, unknown>[] {
  return payload["games"] as Record<string, unknown>[];
}

function filtersOf(payload: Record<string, unknown>): Record<string, unknown> {
  return payload["filters"] as Record<string, unknown>;
}

function sharedFinishedGame(firstId: number, secondId: number) {
  const game = MOCK_FINISHED_GAMES.find((candidate) => {
    const sides = candidate.teams.flat();

    return (
      sides.some((side) => side.profileId === firstId) &&
      sides.some((side) => side.profileId === secondId)
    );
  });

  if (game === undefined) {
    throw new Error("Las fixtures no tienen una partida compartida por los dos ids.");
  }

  return game;
}

const [FIRST, SECOND] = MOCK_TOURNAMENT_PLAYERS;

afterEach(() => {
  vi.useRealTimers();
});

describe("mock de AoE4World: /players/:id/games", () => {
  it("sigue trayendo total_count", () => {
    const payload = payloadOf(resolve(`/players/${FIRST.profileId}/games`));

    expect(payload["total_count"]).toBeTypeOf("number");
    expect(gamesOf(payload).length).toBeGreaterThan(0);
  });
});

describe("mock de AoE4World: /games masivo", () => {
  it("no trae total_count y publica solo las claves del envelope medido", () => {
    const payload = payloadOf(resolve("/games", { profile_ids: String(FIRST.profileId) }));

    expect(Object.keys(payload).sort()).toEqual([
      "count",
      "filters",
      "games",
      "next_page",
      "offset",
      "page",
      "per_page",
    ]);
    expect(payload["total_count"]).toBeUndefined();
    expect(payload["page"]).toBe(1);
    expect(payload["per_page"]).toBe(50);
    expect(filtersOf(payload)["profile_ids"]).toEqual([FIRST.profileId]);
  });

  it("ignora per_page y declara siempre páginas de 50", () => {
    const payload = payloadOf(
      resolve("/games", { profile_ids: String(FIRST.profileId), per_page: "5" }),
    );

    expect(payload["per_page"]).toBe(50);
    expect(gamesOf(payload).length).toBeLessThanOrEqual(50);
  });

  it("recorta a 50 ids y no devuelve partidas de los descartados", () => {
    const filler = Array.from({ length: 50 }, (_, index) => 93_000_001 + index);
    const payload = payloadOf(
      resolve("/games", {
        profile_ids: [...filler, FIRST.profileId].join(","),
      }),
    );

    expect(filtersOf(payload)["profile_ids"]).toEqual(filler);
    expect(gamesOf(payload)).toEqual([]);
  });

  it("deduplica por gameId una partida compartida por dos ids", () => {
    const shared = sharedFinishedGame(FIRST.profileId, SECOND.profileId);
    const payload = payloadOf(
      resolve("/games", {
        profile_ids: `${FIRST.profileId},${SECOND.profileId}`,
        order: "started_at",
      }),
    );

    const matches = gamesOf(payload).filter((game) => game["game_id"] === shared.gameId);

    expect(matches).toHaveLength(1);
  });

  it("filtra since por started_at y updated_since por updated_at", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-25T12:00:00.000Z"));

    const game = MOCK_FINISHED_GAMES[0];
    const cutoff = new Date(game.startedAtMs + 60_000).toISOString();

    const byStart = payloadOf(
      resolve("/games", {
        profile_ids: String(FIRST.profileId),
        since: cutoff,
        order: "started_at",
      }),
    );
    const byUpdate = payloadOf(
      resolve("/games", {
        profile_ids: String(FIRST.profileId),
        updated_since: cutoff,
        order: "updated_at",
      }),
    );

    expect(gamesOf(byStart).some((entry) => entry["game_id"] === game.gameId)).toBe(false);
    expect(gamesOf(byUpdate).some((entry) => entry["game_id"] === game.gameId)).toBe(true);
  });

  it("ordena descendente por started_at y por updated_at, con updated_at por defecto", () => {
    const started = payloadOf(
      resolve("/games", { profile_ids: String(FIRST.profileId), order: "started_at" }),
    );
    const updated = payloadOf(
      resolve("/games", { profile_ids: String(FIRST.profileId), order: "updated_at" }),
    );
    const byDefault = payloadOf(resolve("/games", { profile_ids: String(FIRST.profileId) }));

    const startedTimes = gamesOf(started).map((game) => Date.parse(String(game["started_at"])));
    const updatedTimes = gamesOf(updated).map((game) => Date.parse(String(game["updated_at"])));

    expect(startedTimes).toEqual([...startedTimes].sort((a, b) => b - a));
    expect(updatedTimes).toEqual([...updatedTimes].sort((a, b) => b - a));
    expect(filtersOf(started)["order"]).toBe("started_at");
    expect(filtersOf(byDefault)["order"]).toBe("updated_at");
  });

  it("devuelve página 20 vacía y error 400 en la 21", () => {
    const page20 = payloadOf(
      resolve("/games", { profile_ids: String(FIRST.profileId), page: "20" }),
    );
    const page21 = resolve("/games", { profile_ids: String(FIRST.profileId), page: "21" });

    expect(gamesOf(page20)).toEqual([]);
    expect(page20["next_page"]).toBeNull();
    expect(page21).toEqual({
      kind: "error",
      status: 400,
      message: "Page greater than 20 is not supported",
    });
  });

  it("un updated_since de 60 días devuelve vacío con el aviso medido", () => {
    const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    const payload = payloadOf(
      resolve("/games", { profile_ids: String(FIRST.profileId), updated_since: old }),
    );

    expect(gamesOf(payload)).toEqual([]);
    expect(payload["next_page"]).toBeNull();
    expect(filtersOf(payload)["updated_since"]).toBe(old);
    expect(filtersOf(payload)["_important_notice_"]).toBe(OLD_UPDATED_SINCE_NOTICE);
  });
});

describe("mockGamesForPlayers", () => {
  it("incluye una entrada por id pedido aunque no tenga partidas", () => {
    const byProfile = mockGamesForPlayers([FIRST.profileId, 99_999_999]);

    expect(byProfile.get(FIRST.profileId)?.length).toBeGreaterThan(0);
    expect(byProfile.get(99_999_999)).toEqual([]);
  });

  it("mantiene la partida compartida en los dos mapas sin deduplicar", () => {
    const shared = sharedFinishedGame(FIRST.profileId, SECOND.profileId);
    const byProfile = mockGamesForPlayers([FIRST.profileId, SECOND.profileId]);

    expect(byProfile.get(FIRST.profileId)?.some((game) => game.gameId === shared.gameId)).toBe(
      true,
    );
    expect(byProfile.get(SECOND.profileId)?.some((game) => game.gameId === shared.gameId)).toBe(
      true,
    );
  });
});
