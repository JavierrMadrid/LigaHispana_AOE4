import { describe, expect, it } from "vitest";

import type { Aoe4WorldConfig } from "@/lib/aoe4world/env";
import {
  gameSummaryUrl,
  historyCheckIsDue,
  historyProbeCandidates,
  historyVerdictFromProbes,
  HISTORY_CHECK_TTL_HOURS,
  HISTORY_CHECK_TTL_MS,
  HISTORY_PROBE_GAMES,
  LADDER_PUBLICATION_LAG_MINUTES,
  MISSING_MATCHES_MIN_GAMES,
  ladderGapVerdict,
  planHistoryCheck,
  probeGameSummary,
  probeHistoryVisibility,
  type HistoryProbeCandidate,
  type HistoryProbeMatch,
  type HistoryProbeResult,
  type LadderGapInput,
} from "@/lib/history-visibility";
import type { ScoringWindow } from "@/lib/ranked-match";

/**
 * ¿Está el historial de partidas de este jugador abierto?
 *
 * Lo que se comprueba aquí es la parte que decide **qué se afirma**: que solo se
 * sondean partidas que ya sabemos resueltas, que el veredicto exige pruebas, y que
 * un fallo de red nunca se convierte en un "cerrado". Todo lo demás (la base de datos,
 * cuándo se llama a esta función) es de quien la llama en el worker.
 *
 * Sin red y sin temporizadores reales: la llamada se hace con un `fetch` falso que
 * devuelve una respuesta de mentira, y el plazo se comprueba con el reloj que se le
 * pasa.
 */

const VENTANA: ScoringWindow = {
  from: "2026-09-15T00:00:00.000Z",
  to: "2026-10-15T00:00:00.000Z",
};

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

/** Un `rawJson` de partida como lo guarda el worker: el payload de la API tal cual. */
function partida(options: {
  gameId: number;
  startedAt: string;
  /** `null` es lo que llega cuando la API no manda `state`. */
  state?: string | null;
  leaderboard?: string;
}): Record<string, unknown> {
  return {
    game_id: options.gameId,
    started_at: options.startedAt,
    duration: 1_800,
    map: "Gizal_03",
    leaderboard: options.leaderboard ?? "rm_solo",
    kind: "rm_1v1",
    state: options.state === undefined ? "processed" : options.state,
    ongoing: false,
    teams: [],
  };
}

function partidaGuardada(
  gameId: number,
  startedAt: string,
  extra: Partial<HistoryProbeMatch> = {},
): HistoryProbeMatch {
  return {
    gameId: String(gameId),
    leaderboard: extra.leaderboard ?? "rm_solo",
    startedAt: new Date(startedAt),
    rawJson: extra.rawJson ?? partida({ gameId, startedAt }),
  };
}

function gameIds(candidatas: readonly HistoryProbeCandidate[]): string[] {
  return candidatas.map((candidata) => candidata.gameId);
}

/** Un `fetch` que responde siempre lo mismo y cuenta cuántas veces se le llamó. */
function fetchQueResponde(status: number): {
  fetch: typeof globalThis.fetch;
  llamadas: () => string[];
} {
  const llamadas: string[] = [];

  const fake = (async (input: RequestInfo | URL) => {
    llamadas.push(String(input));

    return new Response(null, { status });
  }) as typeof globalThis.fetch;

  return { fetch: fake, llamadas: () => llamadas };
}

function resultado(gameId: string, outcome: HistoryProbeResult["outcome"]): HistoryProbeResult {
  return { gameId, outcome, reason: outcome === "unknown" ? "sin respuesta" : null };
}

/* -------------------------------------------------------------------------- */

describe("historyProbeCandidates", () => {
  it("coge las `processed` de la ladder pedida, dentro de la ventana y más recientes primero", () => {
    const candidatas = historyProbeCandidates(
      [
        partidaGuardada(1, "2026-09-20T10:00:00Z"),
        partidaGuardada(2, "2026-10-01T10:00:00Z"),
        partidaGuardada(3, "2026-09-25T10:00:00Z"),
      ],
      { window: VENTANA },
    );

    expect(gameIds(candidatas)).toEqual(["2", "3", "1"]);
  });

  it("descarta `new` e `invalid`: dan 404 con el historial abierto", () => {
    // Es el motivo de que el corte sea de tres partidas y no de una: una partida
    // invalida sola produciría una alarma a alguien con el historial perfectamente
    // público.
    const candidatas = historyProbeCandidates(
      [
        partidaGuardada(1, "2026-10-01T10:00:00Z", {
          rawJson: partida({ gameId: 1, startedAt: "2026-10-01T10:00:00Z", state: "new" }),
        }),
        partidaGuardada(2, "2026-10-01T09:00:00Z", {
          rawJson: partida({ gameId: 2, startedAt: "2026-10-01T09:00:00Z", state: "invalid" }),
        }),
        partidaGuardada(3, "2026-10-01T08:00:00Z", {
          rawJson: partida({ gameId: 3, startedAt: "2026-10-01T08:00:00Z", state: null }),
        }),
        partidaGuardada(4, "2026-10-01T07:00:00Z"),
      ],
      { window: VENTANA, limit: 10 },
    );

    expect(gameIds(candidatas)).toEqual(["4"]);
  });

  it("descarta las de otra ladder y las de fuera de la ventana", () => {
    const candidatas = historyProbeCandidates(
      [
        partidaGuardada(1, "2026-10-01T10:00:00Z", { leaderboard: "rm_team" }),
        partidaGuardada(2, "2026-09-01T10:00:00Z"),
        partidaGuardada(3, "2026-10-15T00:00:00Z"),
        partidaGuardada(4, "2026-10-14T23:59:59Z"),
      ],
      { window: VENTANA, limit: 10 },
    );

    // `3` es exactamente el `to`, que es **exclusivo**, y `1` es de equipos.
    expect(gameIds(candidatas)).toEqual(["4"]);
  });

  it("se queda con las `HISTORY_PROBE_GAMES` más recientes", () => {
    const candidatas = historyProbeCandidates(
      [1, 2, 3, 4, 5].map((n) => partidaGuardada(n, new Date(Date.UTC(2026, 9, n)).toISOString())),
      { window: VENTANA },
    );

    expect(candidatas).toHaveLength(HISTORY_PROBE_GAMES);
    expect(gameIds(candidatas)).toEqual(["5", "4", "3"]);
  });

  it("desempata por `gameId` cuando dos partidas empiezan a la vez", () => {
    // Dos participantes de la liga en la misma partida tienen el mismo `startedAt`, y
    // sin desempate la lista dependería del orden en que llegaran las filas. El
    // criterio es comparación de texto y no `localeCompare()`, que depende del locale
    // del runtime, así que "20" va antes que "3".
    const entrada = [
      partidaGuardada(20, "2026-10-01T10:00:00Z"),
      partidaGuardada(3, "2026-10-01T10:00:00Z"),
    ];
    const esperado = ["20", "3"];

    expect(gameIds(historyProbeCandidates(entrada, { window: VENTANA }))).toEqual(esperado);
    expect(gameIds(historyProbeCandidates([...entrada].reverse(), { window: VENTANA }))).toEqual(
      esperado,
    );
  });

  it("un `rawJson` ilegible se descarta y no tira el resto de la lista", () => {
    const candidatas = historyProbeCandidates(
      [
        partidaGuardada(1, "2026-10-01T10:00:00Z", { rawJson: "esto no es un payload" }),
        partidaGuardada(2, "2026-10-01T09:00:00Z", { rawJson: { game_id: 2 } }),
        partidaGuardada(3, "2026-10-01T08:00:00Z"),
      ],
      { window: VENTANA, limit: 10 },
    );

    expect(gameIds(candidatas)).toEqual(["3"]);
  });

  it("la ladder por defecto es `rm_solo` y el límite son las tres", () => {
    expect(HISTORY_PROBE_GAMES).toBe(3);
    expect(LADDER_PUBLICATION_LAG_MINUTES).toBe(75);
  });
});

/* -------------------------------------------------------------------------- */

describe("historyCheckIsDue", () => {
  const AHORA = new Date("2026-10-05T12:00:00.000Z");

  it("sin comprobar nunca, toca; dentro de las 12 h, no; justo al cumplirlas, sí", () => {
    expect(historyCheckIsDue(null, AHORA)).toBe(true);
    expect(
      historyCheckIsDue(new Date(AHORA.getTime() - (HISTORY_CHECK_TTL_MS - 60_000)), AHORA),
    ).toBe(false);
    expect(historyCheckIsDue(new Date(AHORA.getTime() - HISTORY_CHECK_TTL_MS), AHORA)).toBe(true);
  });

  it("acepta un plazo más corto, que es lo que sirve tras un `unknown`", () => {
    const haceUnaHora = new Date(AHORA.getTime() - 3_600_000);

    expect(historyCheckIsDue(haceUnaHora, AHORA)).toBe(false);
    expect(historyCheckIsDue(haceUnaHora, AHORA, 30 * 60_000)).toBe(true);
  });

  it("y `planHistoryCheck()` dice lo mismo, porque usa esta función", () => {
    // La preselección del worker usa esta y la comprobación final usa aquella: si se
    // desincronizaran, el worker traería partidas de un jugador que después no comprueba.
    const historyCheckedAt = new Date(AHORA.getTime() - HISTORY_CHECK_TTL_MS + 1);
    const candidates: HistoryProbeCandidate[] = [1, 2, 3].map((gameId) => ({
      gameId: String(gameId),
      startedAt: new Date("2026-10-01T10:00:00Z"),
    }));

    expect(historyCheckIsDue(historyCheckedAt, AHORA)).toBe(false);
    expect(planHistoryCheck({ historyCheckedAt, candidates, now: AHORA })).toEqual({
      action: "skip",
      reason: "reciente",
    });
  });
});

/* -------------------------------------------------------------------------- */

describe("ladderGapVerdict", () => {
  const AHORA = new Date("2026-10-05T12:00:00.000Z");
  /** La ladder dice que esta persona jugó hace dos horas. */
  const LADDER = new Date("2026-10-05T10:00:00.000Z");
  const hace7h = new Date("2026-10-05T05:00:00.000Z");

  function entrada(overrides: Partial<LadderGapInput> = {}): LadderGapInput {
    return {
      gamesCount: 200,
      lastGameAt: LADDER,
      newestOurs: hace7h,
      window: VENTANA,
      now: AHORA,
      ...overrides,
    };
  }

  it("si la ladder va dos horas por delante de lo nuestro, salta", () => {
    // Es el caso de la regla: la ladder registra una partida de hace dos horas y la
    // nuestra más reciente es de hace siete, con un margen de publicación de 75 min.
    expect(ladderGapVerdict(entrada())).toEqual({ status: "ahead", lagMinutes: 300 });
  });

  it("un desfase dentro del margen no dice nada: la ladder va por delante de por sí", () => {
    // El caso que mide el margen: sin él, esto avisaría de todos los jugadores que
    // acaban de jugar, que es lo contrario de una alarma.
    const cerca = new Date(LADDER.getTime() - LADDER_PUBLICATION_LAG_MINUTES * 60_000 + 60_000);

    expect(ladderGapVerdict(entrada({ newestOurs: cerca }))).toEqual({
      status: "ok",
      reason: "dentro-del-margen",
    });
  });

  it("justo en el margen tampoco salta: la comparación es `>` y no `>=`", () => {
    const justo = new Date(LADDER.getTime() - LADDER_PUBLICATION_LAG_MINUTES * 60_000);

    expect(ladderGapVerdict(entrada({ newestOurs: justo }))).toEqual({
      status: "ok",
      reason: "dentro-del-margen",
    });
  });

  it("sin partidas de ladder no se puede comparar nada", () => {
    expect(ladderGapVerdict(entrada({ gamesCount: null }))).toEqual({
      status: "ok",
      reason: "sin-datos",
    });
    expect(ladderGapVerdict(entrada({ lastGameAt: null }))).toEqual({
      status: "ok",
      reason: "sin-datos",
    });
  });

  it("con menos del mínimo de partidas, no se mira: no es alguien cuya ausencia signifique", () => {
    // El caso del encargo: alguien que jugó 9 partidas en septiembre y nada desde
    // entonces no está ocultando nada, simplemente no está jugando.
    for (const gamesCount of [0, 1, 9]) {
      expect(ladderGapVerdict(entrada({ gamesCount }))).toEqual({
        status: "ok",
        reason: "pocas-partidas",
      });
    }
    expect(MISSING_MATCHES_MIN_GAMES).toBe(10);
    expect(ladderGapVerdict(entrada({ gamesCount: 10 })).status).toBe("ahead");
  });

  it("si la última partida de la ladder es de antes del torneo, no dice nada", () => {
    expect(ladderGapVerdict(entrada({ lastGameAt: new Date("2026-09-01T10:00:00Z") }))).toEqual({
      status: "ok",
      reason: "fuera-de-ventana",
    });
    // El `to` de la ventana es exclusivo, igual que en el resto del proyecto.
    expect(ladderGapVerdict(entrada({ lastGameAt: new Date("2026-10-15T00:00:00Z") }))).toEqual({
      status: "ok",
      reason: "fuera-de-ventana",
    });
  });

  it("sin ninguna partida nuestra en la ventana, la referencia es `now` y el signo cambia", () => {
    // El borde que evita acusar a un jugador recién aprobado: si la ladder registra
    // una partida de hace media hora, es que la acaba de jugar y todavía no se ha
    // publicado. La publicación nos puede deber 75 min, no más.
    const recienAprobado = new Date(AHORA.getTime() - 30 * 60_000);

    expect(ladderGapVerdict(entrada({ newestOurs: null, lastGameAt: recienAprobado }))).toEqual({
      status: "ok",
      reason: "dentro-del-margen",
    });

    // Y si la que la ladder registra es de hace dos horas, sí: la ladder lleva dos horas
    // diciendo que jugó y no la tenemos. **El signo es el contrario** al caso normal, y
    // por eso el caso `null` tiene su propia línea: con la resta tal cual daría un hueco
    // negativo y esta regla no saltaría nunca en el único caso para el que existe.
    expect(ladderGapVerdict(entrada({ newestOurs: null }))).toEqual({
      status: "ahead",
      lagMinutes: 120,
    });
  });

  it("el mínimo es un parámetro, para poder probarlo sin depender del de por defecto", () => {
    expect(ladderGapVerdict(entrada({ gamesCount: 3, minGames: 3 })).status).toBe("ahead");
    expect(ladderGapVerdict(entrada({ gamesCount: 3, minGames: 10 }))).toEqual({
      status: "ok",
      reason: "pocas-partidas",
    });
  });
});

describe("planHistoryCheck", () => {
  const AHORA = new Date("2026-10-05T12:00:00.000Z");
  const candidatas: HistoryProbeCandidate[] = [1, 2, 3].map((gameId) => ({
    gameId: String(gameId),
    startedAt: new Date("2026-10-01T10:00:00Z"),
  }));

  it("sin comprobar nunca, toca", () => {
    expect(
      planHistoryCheck({ historyCheckedAt: null, candidates: candidatas, now: AHORA }),
    ).toEqual({
      action: "check",
      candidates: candidatas,
    });
  });

  it("dentro de las 12 h no se toca, y justo al cumplirlas sí", () => {
    const hace11h59 = new Date(AHORA.getTime() - (HISTORY_CHECK_TTL_MS - 60_000));
    const hace12h = new Date(AHORA.getTime() - HISTORY_CHECK_TTL_MS);

    expect(HISTORY_CHECK_TTL_HOURS).toBe(12);
    expect(
      planHistoryCheck({ historyCheckedAt: hace11h59, candidates: candidatas, now: AHORA }),
    ).toEqual({ action: "skip", reason: "reciente" });
    expect(
      planHistoryCheck({ historyCheckedAt: hace12h, candidates: candidatas, now: AHORA }),
    ).toEqual({ action: "check", candidates: candidatas });
  });

  it("el plazo se puede acortar por parámetro, que es lo que sirve tras un `unknown`", () => {
    const haceUnaHora = new Date(AHORA.getTime() - 3_600_000);

    expect(
      planHistoryCheck({
        historyCheckedAt: haceUnaHora,
        candidates: candidatas,
        now: AHORA,
        ttlMs: 30 * 60_000,
      }),
    ).toEqual({ action: "check", candidates: candidatas });
  });

  it("con menos de tres candidatas no se sale a la red", () => {
    for (const numero of [0, 1, 2]) {
      const pocas = candidatas.slice(0, numero);

      expect(planHistoryCheck({ historyCheckedAt: null, candidates: pocas, now: AHORA })).toEqual({
        action: "skip",
        reason: "sin-candidatas",
      });
    }
  });

  it("la caché se mira antes que las partidas: no se lee nada para saltarse", () => {
    expect(
      planHistoryCheck({
        historyCheckedAt: new Date(AHORA.getTime() - 60_000),
        candidates: [],
        now: AHORA,
      }),
    ).toEqual({ action: "skip", reason: "reciente" });
  });
});

/* -------------------------------------------------------------------------- */

describe("historyVerdictFromProbes", () => {
  it("tres 404 alarman: `closed` es la única afirmación de la regla", () => {
    expect(
      historyVerdictFromProbes([
        resultado("1", "closed"),
        resultado("2", "closed"),
        resultado("3", "closed"),
      ]),
    ).toBe("closed");
  });

  it("un solo 200 cancela y da `public`", () => {
    expect(
      historyVerdictFromProbes([
        resultado("1", "closed"),
        resultado("2", "public"),
        resultado("3", "closed"),
      ]),
    ).toBe("public");
  });

  it("un error de red no alarma: dos 404 y un `unknown` no son tres 404", () => {
    // El caso que separa este módulo del que sería fácil escribir: si el corte de
    // red se leyera como "no hay summary", bastaría un mal rato de AoE4World para
    // acusar a un jugador.
    expect(
      historyVerdictFromProbes([
        resultado("1", "closed"),
        resultado("2", "closed"),
        resultado("3", "unknown"),
      ]),
    ).toBe("unknown");
  });

  it("menos de tres 404 no afirman nada", () => {
    expect(historyVerdictFromProbes([resultado("1", "closed"), resultado("2", "closed")])).toBe(
      "unknown",
    );
    expect(historyVerdictFromProbes([])).toBe("unknown");
  });

  it("cualquier respuesta que no sea 404 deja el veredicto en `unknown`", () => {
    expect(historyVerdictFromProbes([resultado("1", "unknown"), resultado("2", "unknown")])).toBe(
      "unknown",
    );
  });
});

/* -------------------------------------------------------------------------- */

describe("gameSummaryUrl", () => {
  it("usa el `profileId` pelado, que es lo que acepta la ruta", () => {
    expect(gameSummaryUrl("https://aoe4world.com", 21_050_396, "253759716")).toBe(
      "https://aoe4world.com/players/21050396/games/253759716",
    );
  });

  it("tolera una barra final en la base", () => {
    expect(gameSummaryUrl("https://aoe4world.com/", 7_328_774, "42")).toBe(
      "https://aoe4world.com/players/7328774/games/42",
    );
  });
});

/* -------------------------------------------------------------------------- */

describe("probeGameSummary", () => {
  const opciones = {
    apiBase: CONFIG.apiBase,
    userAgent: CONFIG.userAgent,
    timeoutMs: CONFIG.timeoutMs,
  };

  it("200 es `public` y 404 es `closed`", async () => {
    const ok = await probeGameSummary(21_050_396, "253759716", {
      ...opciones,
      fetch: fetchQueResponde(200).fetch,
    });
    const ko = await probeGameSummary(7_328_774, "253759716", {
      ...opciones,
      fetch: fetchQueResponde(404).fetch,
    });

    expect(ok).toEqual({ gameId: "253759716", outcome: "public", reason: null });
    expect(ko).toEqual({ gameId: "253759716", outcome: "closed", reason: null });
  });

  it("manda un `HEAD` con el `User-Agent` del cliente, y no uno de navegador", async () => {
    const llamadas: { url: string; init: RequestInit }[] = [];

    const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
      llamadas.push({ url: String(input), init: init ?? {} });

      return new Response(null, { status: 200 });
    }) as typeof globalThis.fetch;

    await probeGameSummary(21_050_396, "1", { ...opciones, fetch: fake });

    expect(llamadas).toHaveLength(1);
    expect(llamadas[0].url).toBe("https://aoe4world.com/players/21050396/games/1");
    expect(llamadas[0].init.method).toBe("HEAD");
    expect((llamadas[0].init.headers as Record<string, string>)["User-Agent"]).toBe(
      CONFIG.userAgent,
    );
    expect(CONFIG.userAgent).not.toContain("Mozilla");
  });

  it("un 5xx no es un `closed`", async () => {
    const probe = await probeGameSummary(21_050_396, "1", {
      ...opciones,
      fetch: fetchQueResponde(503).fetch,
    });

    expect(probe.outcome).toBe("unknown");
    expect(probe.reason).toContain("503");
  });

  it("un `2xx` que no es 200 tampoco decide nada", async () => {
    const probe = await probeGameSummary(21_050_396, "1", {
      ...opciones,
      fetch: fetchQueResponde(204).fetch,
    });

    expect(probe.outcome).toBe("unknown");
  });

  it("un error de red no lanza y no es un `closed`", async () => {
    const rota = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof globalThis.fetch;

    const probe = await probeGameSummary(21_050_396, "1", { ...opciones, fetch: rota });

    expect(probe.outcome).toBe("unknown");
    expect(probe.reason).toContain("fetch failed");
  });

  it("un `gameId` que no es entero no sale a la red: su 404 no significaría nada", async () => {
    const { fetch: fake, llamadas } = fetchQueResponde(404);

    const probe = await probeGameSummary(21_050_396, "no-es-un-numero", {
      ...opciones,
      fetch: fake,
    });

    expect(probe.outcome).toBe("unknown");
    expect(llamadas()).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */

describe("probeHistoryVisibility", () => {
  const candidatas: HistoryProbeCandidate[] = ["1", "2", "3"].map((gameId) => ({
    gameId,
    startedAt: new Date("2026-10-01T10:00:00Z"),
  }));

  it("tres 404 dan `closed` y avisan de lo que no se pudo comprobar", async () => {
    const resultadoCompleto = await probeHistoryVisibility({
      profileId: 7_328_774,
      candidates: candidatas,
      config: CONFIG,
      fetch: fetchQueResponde(404).fetch,
    });

    expect(resultadoCompleto.verdict).toBe("closed");
    expect(resultadoCompleto.probes).toHaveLength(3);
    expect(resultadoCompleto.warnings).toEqual([]);
  });

  it("para en cuanto hay un 200 y no gasta las otras dos", async () => {
    const { fetch: fake, llamadas } = fetchQueResponde(200);

    const resultadoCompleto = await probeHistoryVisibility({
      profileId: 21_050_396,
      candidates: candidatas,
      config: CONFIG,
      fetch: fake,
    });

    expect(resultadoCompleto.verdict).toBe("public");
    expect(llamadas()).toHaveLength(1);
  });

  it("un 404 y luego un corte de red no alarma, y el motivo queda en el rastro", async () => {
    const estados = [404, 404, 503];
    let indice = 0;

    const fake = (async () => {
      const status = estados[indice] ?? 503;
      indice += 1;

      return new Response(null, { status });
    }) as typeof globalThis.fetch;

    const resultadoCompleto = await probeHistoryVisibility({
      profileId: 7_328_774,
      candidates: candidatas,
      config: CONFIG,
      fetch: fake,
    });

    expect(resultadoCompleto.verdict).toBe("unknown");
    expect(resultadoCompleto.warnings).toHaveLength(1);
    expect(resultadoCompleto.warnings[0]).toContain("503");
  });

  it("sin candidatas no sale a la red y no dice nada", async () => {
    const { fetch: fake, llamadas } = fetchQueResponde(404);

    const resultadoCompleto = await probeHistoryVisibility({
      profileId: 7_328_774,
      candidates: [],
      config: CONFIG,
      fetch: fake,
    });

    expect(resultadoCompleto.verdict).toBe("unknown");
    expect(llamadas()).toEqual([]);
  });

  it("con el mock activo no sale a la red: no hay fixtures para esta ruta", async () => {
    // Con `AOE4WORLD_MOCK` los `profileId` son del rango reservado de la simulación y
    // no existen en el sitio, así que salir habría dado 404 para todo: tres
    // acusaciones a jugadores inventados.
    const { fetch: fake, llamadas } = fetchQueResponde(404);

    const resultadoCompleto = await probeHistoryVisibility({
      profileId: 90_000_001,
      candidates: candidatas,
      config: { ...CONFIG, mock: true },
      fetch: fake,
    });

    expect(resultadoCompleto.verdict).toBe("unknown");
    expect(resultadoCompleto.probes).toEqual([]);
    expect(resultadoCompleto.warnings[0]).toContain("AOE4WORLD_MOCK");
    expect(llamadas()).toEqual([]);
  });

  it("más de tres candidatas no se sondean todas: el veredicto ya no cambia", async () => {
    const { fetch: fake, llamadas } = fetchQueResponde(404);

    const resultadoCompleto = await probeHistoryVisibility({
      profileId: 7_328_774,
      candidates: [...candidatas, ...candidatas.map((c) => ({ ...c, gameId: `${c.gameId}9` }))],
      config: CONFIG,
      fetch: fake,
    });

    expect(resultadoCompleto.verdict).toBe("closed");
    expect(llamadas()).toHaveLength(HISTORY_PROBE_GAMES);
  });

  it("con el plazo global agotado no pregunta nada más y avisa", async () => {
    const controlador = new AbortController();
    controlador.abort();

    const { fetch: fake, llamadas } = fetchQueResponde(404);

    const resultadoCompleto = await probeHistoryVisibility({
      profileId: 7_328_774,
      candidates: candidatas,
      config: CONFIG,
      signal: controlador.signal,
      fetch: fake,
    });

    expect(resultadoCompleto.verdict).toBe("unknown");
    expect(resultadoCompleto.warnings).toHaveLength(1);
    expect(llamadas()).toEqual([]);
  });
});
