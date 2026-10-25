import { describe, expect, it } from "vitest";

import {
  createAoe4WorldClient,
  GAMES_BULK_MAX_PAGE,
  GAMES_BULK_MAX_PROFILE_IDS,
  type Aoe4WorldBulkGamesQuery,
} from "@/lib/aoe4world/client";
import { Aoe4WorldError, type Aoe4WorldHttpClient } from "@/lib/aoe4world/http";

/**
 * La construcción de la petición masiva, no la red.
 *
 * El cliente real se prueba con un `Aoe4WorldHttpClient` falso que solo captura
 * path y query: así se comprueba el contrato del endpoint (ids separados por
 * comas, `updated_since` ISO, `order`, `page`) y que los parámetros del listado
 * por jugador (`per_page`, `limit`, `leaderboard`) no se cuelan. Las guardas se
 * prueban antes de que el falso llegue a ver una llamada.
 */

type Call = {
  path: string;
  params: URLSearchParams | undefined;
};

const PAGE = {
  page: 1,
  per_page: 50,
  count: 0,
  next_page: null,
  filters: {},
  games: [],
};

function withFakeHttp(payload: unknown = PAGE) {
  const calls: Call[] = [];
  const http: Aoe4WorldHttpClient = {
    async fetchJson(path, params) {
      calls.push({ path, params });
      return payload;
    },
    stats: { requests: 0, retries: 0, rateLimitResponses: 0, rateLimitPausesMs: 0 },
    async drain() {},
  };

  return { client: createAoe4WorldClient(http), calls };
}

const BASE: Aoe4WorldBulkGamesQuery = {
  profileIds: [12_345, 67_890],
  updatedSince: new Date("2026-09-20T00:00:00.000Z"),
  order: "updated_at",
  page: 2,
};

describe("getGamesBulk", () => {
  it("construye la query del masivo sin los parámetros del listado por jugador", async () => {
    const { client, calls } = withFakeHttp();

    await client.getGamesBulk(BASE);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe("/games");

    const params = calls[0]?.params;

    expect(params?.get("profile_ids")).toBe("12345,67890");
    expect(params?.get("updated_since")).toBe("2026-09-20T00:00:00.000Z");
    expect(params?.get("order")).toBe("updated_at");
    expect(params?.get("page")).toBe("2");

    for (const ausente of ["per_page", "limit", "leaderboard"]) {
      expect(params?.get(ausente), ausente).toBeNull();
    }
  });

  it("acepta 50 ids y devuelve la página parseada", async () => {
    const ids = Array.from({ length: GAMES_BULK_MAX_PROFILE_IDS }, (_, index) => index + 1);
    const { client, calls } = withFakeHttp();

    const page = await client.getGamesBulk({ ...BASE, profileIds: ids });

    expect(page.games).toEqual([]);
    expect(page.notice).toBeNull();
    expect(calls[0]?.params?.get("profile_ids")?.split(",")).toHaveLength(50);
  });

  it("rechaza ids y páginas fuera del contrato antes de llamar", async () => {
    const { client, calls } = withFakeHttp();

    const invalidas: Aoe4WorldBulkGamesQuery[] = [
      { ...BASE, profileIds: [] },
      {
        ...BASE,
        profileIds: Array.from(
          { length: GAMES_BULK_MAX_PROFILE_IDS + 1 },
          (_, index) => index + 1,
        ),
      },
      { ...BASE, profileIds: [1, 0] },
      { ...BASE, profileIds: [1.5] },
      { ...BASE, page: 0 },
      { ...BASE, page: GAMES_BULK_MAX_PAGE + 1 },
      { ...BASE, order: "nope" as unknown as Aoe4WorldBulkGamesQuery["order"] },
      { ...BASE, updatedSince: new Date("no-es-fecha") },
    ];

    for (const query of invalidas) {
      await expect(client.getGamesBulk(query)).rejects.toBeInstanceOf(Aoe4WorldError);
    }

    expect(calls).toHaveLength(0);
  });
});
