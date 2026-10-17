import { describe, expect, it } from "vitest";

import {
  GILDED_VILLAGER_PBGID,
  MOUNTED_VILLAGER_PBGID,
  SUMMARY_MAX_PER_RUN,
  SUMMARY_RETRY_DELAY_MS,
  VILLAGER_PBGIDS,
  fetchGameSummary,
  gameSummaryUrl,
  parseGameSummary,
  planSummaryBackfill,
  type SummaryBackfillCandidate,
} from "@/lib/aoe4world/summary";
import { mockGameSummaryPayload } from "@/lib/aoe4world/mock/summary";

/**
 * El *summary* de partida en lo que se puede comprobar sin red ni base de datos: el
 * lector del payload, la URL, los tres desenlaces de la llamada (con un `fetch`
 * falso) y el planificador de la cola.
 *
 * El payload de referencia imita la respuesta real con `camelize=true` (contrastada
 * contra producción el 2026-10-17), que es lo que decide qué claves se leen.
 */

const VILLAGER_PBGID = 129272;

/** Un payload con la forma real, con el jugador `profileId` dentro. */
function payload(overrides: Record<string, unknown> = {}, playerOverrides: Record<string, unknown> = {}) {
  return {
    gameId: 9_123_456,
    duration: 2400,
    players: [
      {
        profileId: 21_050_396,
        name: "Alguien",
        civilization: "english",
        team: 1,
        apm: 137,
        result: "win",
        actions: { feudalAge: [215], castleAge: [512], imperialAge: [1180] },
        buildOrder: [
          { id: "v", pbgid: VILLAGER_PBGID, type: "unit", destroyed: [900, 900] },
          { id: "g", pbgid: GILDED_VILLAGER_PBGID, type: "unit", destroyed: [800] },
          { id: "m", pbgid: MOUNTED_VILLAGER_PBGID, type: "unit" },
          { id: "otro", pbgid: 127_490, type: "building", destroyed: [10, 20, 30] },
        ],
        ...playerOverrides,
      },
    ],
    ...overrides,
  };
}

const PROFILE = 21_050_396;
const OTRO_PROFILE = 7_328_774;

/** Un `fetch` que responde siempre lo mismo y cuenta las llamadas. */
function fetchQueResponde(
  status: number,
  body: unknown = null,
): { fetch: typeof globalThis.fetch; llamadas: () => string[] } {
  const llamadas: string[] = [];

  const fake = (async (input: RequestInfo | URL) => {
    llamadas.push(String(input));

    return body === null
      ? new Response(null, { status })
      : new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;

  return { fetch: fake, llamadas: () => llamadas };
}

const OPCIONES = {
  apiBase: "https://aoe4world.com",
  userAgent: "LigaHispanaAOE4/0.1 (sync AoE4World)",
  timeoutMs: 1000,
};

/* -------------------------------------------------------------------------- */

describe("parseGameSummary", () => {
  it("lee el APM, las edades y las pérdidas del jugador que se pide", () => {
    expect(parseGameSummary(payload(), PROFILE)).toEqual({
      apm: 137,
      feudalAgeSeconds: 215,
      castleAgeSeconds: 512,
      imperialAgeSeconds: 1180,
      // El aldeano se destruyó dos veces en el mismo segundo: cuentan las dos.
      villagersLost: 2,
      gildedVillagersLost: 1,
      // El montado no trae `destroyed`: sobrevivió.
      mountedVillagersLost: 0,
    });
  });

  it("de las edades gana el primer instante (se puede volver a pasar de edad)", () => {
    const metrics = parseGameSummary(
      payload({}, { actions: { feudalAge: [600, 180], castleAge: [], imperialAge: [900, 400] } }),
      PROFILE,
    );

    expect(metrics?.feudalAgeSeconds).toBe(180);
    expect(metrics?.castleAgeSeconds).toBeNull();
    expect(metrics?.imperialAgeSeconds).toBe(400);
  });

  it("sin `actions`, las edades quedan a null pero las pérdidas se siguen leyendo", () => {
    const metrics = parseGameSummary(payload({}, { actions: undefined }), PROFILE);

    expect(metrics).toMatchObject({
      apm: 137,
      feudalAgeSeconds: null,
      castleAgeSeconds: null,
      imperialAgeSeconds: null,
      villagersLost: 2,
    });
  });

  it("sin `buildOrder` los tres recuentos quedan a null, no a cero", () => {
    // No es lo mismo "no perdió aldeanos" que "no se pudo leer": el objetivo
    // `defensor-del-pueblo` solo puede contar la primera.
    const metrics = parseGameSummary(payload({}, { buildOrder: undefined }), PROFILE);

    expect(metrics).toMatchObject({
      villagersLost: null,
      gildedVillagersLost: null,
      mountedVillagersLost: null,
    });
  });

  it("un `buildOrder` vacío cuenta cero, que es un dato, no una ausencia", () => {
    const metrics = parseGameSummary(payload({}, { buildOrder: [] }), PROFILE);

    expect(metrics).toMatchObject({
      villagersLost: 0,
      gildedVillagersLost: 0,
      mountedVillagersLost: 0,
    });
  });

  it("sin `apm` no hay marca de summary: queda a null", () => {
    expect(parseGameSummary(payload({}, { apm: undefined }), PROFILE)?.apm).toBeNull();
  });

  it("no inventa pérdidas de otras unidades", () => {
    // El edificio del `buildOrder` va destruido tres veces y no suma en ningún
    // recuento de aldeanos.
    const metrics = parseGameSummary(payload(), PROFILE);

    expect(metrics?.villagersLost).toBe(2);
  });

  it("si el jugador no está en el payload, no hay nada que leer", () => {
    expect(parseGameSummary(payload(), OTRO_PROFILE)).toBeNull();
  });

  it("rechaza lo que no tiene la forma esperada", () => {
    expect(parseGameSummary(null, PROFILE)).toBeNull();
    expect(parseGameSummary("lo que sea", PROFILE)).toBeNull();
    expect(parseGameSummary({ players: "no es una lista" }, PROFILE)).toBeNull();
    expect(parseGameSummary({}, PROFILE)).toBeNull();
  });

  it("lee las cadenas numéricas, como el resto de la frontera de confianza", () => {
    const metrics = parseGameSummary(payload({}, { apm: "150" }), PROFILE);

    expect(metrics?.apm).toBe(150);
  });
});

describe("gameSummaryUrl", () => {
  it("compone la ruta del sitio con `camelize` y sin barra doble", () => {
    expect(gameSummaryUrl("https://aoe4world.com/", 21_050_396, "253759716")).toBe(
      "https://aoe4world.com/players/21050396/games/253759716/summary?camelize=true",
    );
  });
});

describe("fetchGameSummary", () => {
  it("un 200 legible es un `summary`", async () => {
    const { fetch: fake, llamadas } = fetchQueResponde(200, payload());

    const outcome = await fetchGameSummary(PROFILE, "9123456", { ...OPCIONES, fetch: fake });

    expect(outcome.kind).toBe("summary");
    expect(llamadas()).toHaveLength(1);
    expect(llamadas()[0]).toContain("?camelize=true");
  });

  it("un 404 es `none`: la partida no tiene summary, y es concluyente", async () => {
    const { fetch: fake } = fetchQueResponde(404);

    const outcome = await fetchGameSummary(PROFILE, "9123456", { ...OPCIONES, fetch: fake });

    expect(outcome).toEqual({ kind: "none", reason: null });
  });

  it("un 5xx es `failure`: no se sabe nada y no se escribe nada", async () => {
    const { fetch: fake } = fetchQueResponde(503);

    const outcome = await fetchGameSummary(PROFILE, "9123456", { ...OPCIONES, fetch: fake });

    expect(outcome.kind).toBe("failure");
  });

  it("un 200 ilegible también es `failure`, no un `none`", async () => {
    // La respuesta dice 200 pero no trae a ese jugador: no se puede concluir que la
    // partida no tenga summary.
    const { fetch: fake } = fetchQueResponde(200, payload({}, { profileId: OTRO_PROFILE }));

    const outcome = await fetchGameSummary(PROFILE, "9123456", { ...OPCIONES, fetch: fake });

    expect(outcome.kind).toBe("failure");
  });

  it("un fallo de red es `failure` y no lanza", async () => {
    const roto = (async () => {
      throw new Error("sin red");
    }) as typeof globalThis.fetch;

    const outcome = await fetchGameSummary(PROFILE, "9123456", { ...OPCIONES, fetch: roto });

    expect(outcome.kind).toBe("failure");
  });

  it("un `gameId` que no es un entero no sale a la red", async () => {
    const { fetch: fake, llamadas } = fetchQueResponde(200, payload());

    const outcome = await fetchGameSummary(PROFILE, "no-es-un-numero", { ...OPCIONES, fetch: fake });

    expect(outcome.kind).toBe("failure");
    expect(llamadas()).toHaveLength(0);
  });

  it("con el mock activo se lee la fixture y no se sale a la red", async () => {
    const roto = (async () => {
      throw new Error("no debería llamarse");
    }) as typeof globalThis.fetch;

    const outcome = await fetchGameSummary(PROFILE, "9123456", {
      ...OPCIONES,
      fetch: roto,
      mock: true,
    });

    expect(outcome.kind).toBe("summary");
  });

  it("la fixture del mock lleva ids que el lector reconoce", async () => {
    // Guarda contra la deriva: si un `pbgid` de `mock/summary.ts` dejara de estar en
    // los conjuntos del módulo, la pérdida se leería como cero y esta prueba lo diría.
    const metrics = parseGameSummary(mockGameSummaryPayload(PROFILE, "9123456"), PROFILE);

    expect(metrics?.apm).not.toBeNull();
    expect(typeof metrics?.villagersLost).toBe("number");
    expect(typeof metrics?.gildedVillagersLost).toBe("number");
    expect(typeof metrics?.mountedVillagersLost).toBe("number");
    expect(VILLAGER_PBGIDS.has(VILLAGER_PBGID)).toBe(true);
  });
});

describe("planSummaryBackfill", () => {
  function candidate(
    gameId: string,
    finishedAt: string,
    summaryCheckedAt: string | null = null,
    profileId = 1,
    playerId = `p${profileId}`,
  ): SummaryBackfillCandidate {
    return {
      gameId,
      playerId,
      profileId,
      finishedAt: new Date(finishedAt),
      summaryCheckedAt: summaryCheckedAt === null ? null : new Date(summaryCheckedAt),
    };
  }

  const NOW = new Date("2026-10-17T12:00:00.000Z");

  function ids(plan: readonly SummaryBackfillCandidate[]): string[] {
    return plan.map((item) => item.gameId);
  }

  it("va de la partida más nueva a la más vieja", () => {
    const plan = planSummaryBackfill(
      [
        candidate("1", "2026-10-16T10:00:00.000Z"),
        candidate("3", "2026-10-17T10:00:00.000Z"),
        candidate("2", "2026-10-16T20:00:00.000Z"),
      ],
      { now: NOW },
    );

    expect(ids(plan)).toEqual(["3", "2", "1"]);
  });

  it("desempata por `gameId` y luego por jugador, para que la cola sea estable", () => {
    const plan = planSummaryBackfill(
      [
        candidate("20", "2026-10-17T10:00:00.000Z", null, 2, "pb"),
        candidate("20", "2026-10-17T10:00:00.000Z", null, 1, "pa"),
        candidate("3", "2026-10-17T10:00:00.000Z", null, 3, "pc"),
      ],
      { now: NOW },
    );

    // `gameId` es una cadena (el `int4` no da para un id de AoE4World), así que su
    // desempate es **lexicográfico**: "20" va antes que "3".
    expect(plan.map((item) => `${item.gameId}/${item.playerId}`)).toEqual(["20/pa", "20/pb", "3/pc"]);
  });

  it("corta por el presupuesto", () => {
    const rows = Array.from({ length: SUMMARY_MAX_PER_RUN + 5 }, (_, index) =>
      candidate(`${index}`, `2026-10-17T10:00:${String(index).padStart(2, "0")}.000Z`),
    );

    const plan = planSummaryBackfill(rows, { now: NOW });

    expect(plan).toHaveLength(SUMMARY_MAX_PER_RUN);
    // Lo más nuevo primero: los cinco más viejos quedan fuera.
    expect(ids(plan)).not.toContain("0");
    expect(ids(plan)).toContain("24");
  });

  it("no reintenta una partida intentada hace menos del margen", () => {
    const reciente = "2026-10-17T11:30:00.000Z";

    const plan = planSummaryBackfill(
      [
        candidate("1", "2026-10-17T10:00:00.000Z", reciente),
        candidate("2", "2026-10-17T09:00:00.000Z"),
      ],
      { now: NOW },
    );

    expect(ids(plan)).toEqual(["2"]);
  });

  it("sí reintenta una partida intentada más allá del margen", () => {
    const limite = new Date(NOW.getTime() - SUMMARY_RETRY_DELAY_MS - 1_000).toISOString();

    const plan = planSummaryBackfill([candidate("1", "2026-10-17T10:00:00.000Z", limite)], {
      now: NOW,
    });

    expect(ids(plan)).toEqual(["1"]);
  });

  it("lo que nunca se ha intentado siempre entra", () => {
    const plan = planSummaryBackfill([candidate("1", "2026-10-01T10:00:00.000Z")], { now: NOW });

    expect(ids(plan)).toEqual(["1"]);
  });
});
