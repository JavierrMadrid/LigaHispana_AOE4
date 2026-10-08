import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { Aoe4WorldConfig } from "@/lib/aoe4world/env";
import {
  fetchMapPoolFromHomepage,
  parseMapPoolHomepage,
} from "@/lib/aoe4world/map-pool";

/**
 * El pool de mapas del homepage de AoE4World.
 *
 * Lo que se comprueba aquí es **el parseo del HTML**, que es la parte frágil: que
 * saque los nueve nombres del atributo escapado, que ignore items sin nombre y que
 * devuelva `null` —sin lanzar— ante cualquier HTML que no cuadre. Quien llama
 * (`refreshMapPool()`) interpreta el `null` como "no toques `Setting`".
 *
 * Sin red: el fixture es una muestra recortada del homepage real y, para la petición,
 * se inyecta un `fetch` falso.
 */

const FIXTURE = readFileSync(
  fileURLToPath(new URL("../../../fixtures/aoe4world-home.html", import.meta.url)),
  "utf-8",
);

const CONFIG: Aoe4WorldConfig = {
  apiBase: "https://aoe4world.com",
  timeoutMs: 15_000,
  userAgent: "LigaHispanaAOE4/0.1 (sync AoE4World)",
  apiKey: null,
  maxRetries: 3,
  retryBaseMs: 500,
  retryMaxMs: 15_000,
  minRequestIntervalMs: 300,
  syncConcurrency: 3,
  syncPageSize: 50,
  syncMaxPages: 10,
  syncDeadlineMs: 240_000,
  mock: false,
};

/** Un `home-leaderboard` con el JSON ya escapado, para los casos de borde. */
function homeConEstado(estado: unknown): string {
  const escaped = JSON.stringify(estado)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  return `<html><body><home-leaderboard :initial-state="${escaped}"></home-leaderboard></body></html>`;
}

function fetchQueResponde(status: number, body: string): typeof globalThis.fetch {
  return (async () => new Response(body, { status })) as typeof globalThis.fetch;
}

/* -------------------------------------------------------------------------- */

describe("parseMapPoolHomepage", () => {
  it("saca los nueve mapas de rm_solo, en orden, con sus fechas", () => {
    const pool = parseMapPoolHomepage(FIXTURE);

    expect(pool).not.toBeNull();
    expect(pool?.maps).toEqual([
      "Atacama",
      "Baltic",
      "Dry Arabia",
      "Flankwoods",
      "Golden Heights",
      "Himeyama",
      "King of the Hill",
      "Lipany",
      "The Pit",
    ]);
    expect(pool?.startedAt).toBe("2026-10-01T00:00:00Z");
    expect(pool?.nextRefresh).toBe("2026-11-01T00:00:00Z");
  });

  it("desescapa las entidades HTML del nombre", () => {
    const html = homeConEstado({
      rm_solo: { mappool: { maps: [{ name: "Tom & Jerry" }, { name: "A < B" }] } },
    });

    expect(parseMapPoolHomepage(html)?.maps).toEqual(["Tom & Jerry", "A < B"]);
  });

  it("ignora los items sin nombre y devuelve solo los válidos", () => {
    const html = homeConEstado({
      rm_solo: {
        mappool: {
          maps: [{ id: 1 }, { name: "  Atacama  " }, { name: 42 }, { name: "" }],
        },
      },
    });

    expect(parseMapPoolHomepage(html)?.maps).toEqual(["Atacama"]);
  });

  it("sin el elemento devuelve null", () => {
    expect(parseMapPoolHomepage("<html><body>nada</body></html>")).toBeNull();
  });

  it("sin el atributo devuelve null", () => {
    expect(parseMapPoolHomepage("<home-leaderboard></home-leaderboard>")).toBeNull();
  });

  it("con el JSON mutilado devuelve null y no lanza", () => {
    const html = '<home-leaderboard :initial-state="{&quot;rm_solo&quot;:"></home-leaderboard>';

    expect(parseMapPoolHomepage(html)).toBeNull();
  });

  it("sin rm_solo devuelve null", () => {
    expect(parseMapPoolHomepage(homeConEstado({ rm_team: {} }))).toBeNull();
  });

  it("sin mappool o sin maps devuelve null", () => {
    expect(parseMapPoolHomepage(homeConEstado({ rm_solo: {} }))).toBeNull();
    expect(parseMapPoolHomepage(homeConEstado({ rm_solo: { mappool: {} } }))).toBeNull();
  });

  it("con la lista de mapas entera sin nombres válidos devuelve null", () => {
    expect(
      parseMapPoolHomepage(homeConEstado({ rm_solo: { mappool: { maps: [{ id: 1 }] } } })),
    ).toBeNull();
  });
});

describe("fetchMapPoolFromHomepage", () => {
  it("devuelve el pool cuando el homepage responde 200", async () => {
    const result = await fetchMapPoolFromHomepage({
      config: CONFIG,
      fetch: fetchQueResponde(200, FIXTURE),
    });

    expect(result.kind).toBe("ok");
    expect(result.kind === "ok" ? result.pool.maps.length : 0).toBe(9);
  });

  it("con un 5xx devuelve failed sin lanzar", async () => {
    const result = await fetchMapPoolFromHomepage({
      config: CONFIG,
      fetch: fetchQueResponde(503, "boom"),
    });

    expect(result.kind).toBe("failed");
  });

  it("con un 200 que no trae el elemento devuelve failed", async () => {
    const result = await fetchMapPoolFromHomepage({
      config: CONFIG,
      fetch: fetchQueResponde(200, "<html><body>otra portada</body></html>"),
    });

    expect(result.kind).toBe("failed");
  });

  it("con el mock activo no sale a la red y no es un fallo", async () => {
    let llamadas = 0;
    const fake = (async () => {
      llamadas += 1;

      return new Response(FIXTURE, { status: 200 });
    }) as typeof globalThis.fetch;

    const result = await fetchMapPoolFromHomepage({
      config: { ...CONFIG, mock: true },
      fetch: fake,
    });

    expect(result.kind).toBe("skipped");
    expect(llamadas).toBe(0);
  });
});
