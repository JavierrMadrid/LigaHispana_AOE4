import { describe, expect, it } from "vitest";

import { MatchResult } from "@/generated/prisma/enums";
import { asJsonValue } from "@/lib/aoe4world/parse";
import type { Aoe4WorldGame, JsonInput } from "@/lib/aoe4world/types";
import {
  backfillPlan,
  backfillProgressStalled,
  countTournamentMatches,
  groupProfileIds,
  nextBackfillWatchdog,
  nextGamesCursor,
  playersToQueueForBackfill,
  seedGamesCursor,
  shouldAdvanceGamesCursor,
  shouldRefreshProfile,
  splitGamesByPlayer,
  type BackfillPlayerState,
  type BackfillWatchdogState,
  type GamesBatch,
} from "@/lib/aoe4world/sync";
import type { NormalizedMatch } from "@/lib/aoe4world/normalize";
import type { LadderCutoffsTable } from "@/lib/alerts/division-cutoffs";
import { SUBDIVISION_RANK_LEVELS } from "@/lib/divisions";
import type { ScoringWindow, TeamTierContext } from "@/lib/ranked-match";

/**
 * La costura pura del contador `matchesCounted` del sincronizador.
 *
 * `countTournamentMatches()` es la regla única (`countsAsRanked()`) aplicada a
 * una lista de partidas normalizadas, con la ventana del ruleset, el `registeredAt`
 * del jugador y el contexto de equipos (`profileId` y cortes). Aquí se comprueban
 * los bordes que deciden si una partida "cuenta como nueva para el torneo":
 * resuelta, dentro de la ventana y del corte de inscripción, de una familia que
 * puntúa y —en equipos— con los compañeros a un escalón o menos. El paso de "en
 * curso a resuelta" (que decide
 * `persistMatches`/`reconcileUnfinishedMatches` sobre la fila guardada) necesita
 * base de datos y no se prueba aquí.
 */

const VENTANA: ScoringWindow = {
  from: "2026-09-15T00:00:00.000Z",
  to: "2026-10-15T00:00:00.000Z",
};

/** El jugador de las fixtures; es el dueño de las partidas normalizadas. */
const PERFIL = 9_000_001;
const COMPAÑERO = 9_000_002;

/** Sin cortes, la condición de equipos no se puede comprobar y la partida cuenta. */
const SIN_CORTES: TeamTierContext = { profileId: PERFIL, cutoffs: null };

/**
 * Cortes inventados pero **monótonos y de la misma escala** que la ladder real: se
 * construyen hacia abajo desde `conqueror_3` en pasos de 100, así cada escalón vale
 * exactamente 100 de elo y las cuentas salen a mano.
 */
const CORTES: LadderCutoffsTable = {
  rm_team: {
    ladder: "rm_team",
    derivedAt: VENTANA.from,
    totalCount: 50_000,
    cutoffs: SUBDIVISION_RANK_LEVELS.map((rankLevel, index) => ({
      rankLevel,
      minRating: 3000 - index * 100,
    })),
    requests: 1,
  },
};

const CON_CORTES: TeamTierContext = { profileId: PERFIL, cutoffs: CORTES };

/** Payload de una partida de equipo con este jugador y un compañero, con ratings. */
function payloadEquipo(propio: number, companero: number): JsonInput {
  const entrada = (profileId: number, rating: number) => ({
    player: { profile_id: profileId, name: "Jugador", rating },
  });

  return asJsonValue({
    game_id: 9_000_001,
    started_at: "2026-09-20T12:00:00.000Z",
    teams: [[entrada(PERFIL, propio), entrada(COMPAÑERO, companero)]],
  });
}

function match(overrides: Partial<NormalizedMatch> = {}): NormalizedMatch {
  return {
    gameId: "1",
    leaderboard: "rm_solo",
    mode: "rm_solo",
    opponentProfileId: null,
    opponentName: null,
    civ: null,
    opponentCiv: null,
    civRandomized: false,
    map: null,
    result: MatchResult.WIN,
    startedAt: new Date("2026-09-20T12:00:00.000Z"),
    finishedAt: new Date("2026-09-20T12:30:00.000Z"),
    durationSeconds: 1800,
    rawJson: {},
    ...overrides,
  };
}

/** El ruleset solo aporta la ventana a la costura; el resto no la afecta. */
const ruleset = { window: VENTANA };

describe("countTournamentMatches", () => {
  it("cuenta una partida resuelta dentro de la ventana y de una familia del ruleset", () => {
    expect(countTournamentMatches([match()], ruleset, null, SIN_CORTES)).toBe(1);
  });

  it("cuenta también las derrotas: lo que decide es que la partida cuente, no si se ganó", () => {
    expect(
      countTournamentMatches([match({ result: MatchResult.LOSS })], ruleset, null, SIN_CORTES),
    ).toBe(1);
  });

  it("no cuenta una partida empezada antes de la ventana", () => {
    const preVentana = match({ startedAt: new Date("2026-09-14T23:59:59.000Z") });

    expect(countTournamentMatches([preVentana], ruleset, null, SIN_CORTES)).toBe(0);
  });

  it("no cuenta una partida empezada en el límite superior: `to` es exclusivo", () => {
    const enElLimite = match({ startedAt: new Date("2026-10-15T00:00:00.000Z") });

    expect(countTournamentMatches([enElLimite], ruleset, null, SIN_CORTES)).toBe(0);
  });

  it("no cuenta una partida en curso (`finishedAt` nulo)", () => {
    const enCurso = match({ finishedAt: null, result: null });

    expect(countTournamentMatches([enCurso], ruleset, null, SIN_CORTES)).toBe(0);
  });

  it("no cuenta una partida de un modo que no puntúa", () => {
    const custom = match({ mode: "custom", leaderboard: "custom" });

    expect(countTournamentMatches([custom], ruleset, null, SIN_CORTES)).toBe(0);
  });

  it("no cuenta una partida anterior al corte de inscripción del jugador", () => {
    const registeredAt = new Date("2026-09-25T00:00:00.000Z");

    expect(countTournamentMatches([match()], ruleset, registeredAt, SIN_CORTES)).toBe(0);
    expect(
      countTournamentMatches(
        [match({ startedAt: new Date("2026-09-25T00:00:00.000Z") })],
        ruleset,
        registeredAt,
        SIN_CORTES,
      ),
    ).toBe(1);
  });

  it("en una lista mixta suma solo las que cumplen la regla", () => {
    const matches = [
      match({ gameId: "1" }),
      match({ gameId: "2", result: MatchResult.LOSS }),
      match({ gameId: "3", finishedAt: null, result: null }),
      match({ gameId: "4", mode: "ffa_1v1" }),
      match({ gameId: "5", startedAt: new Date("2026-09-01T00:00:00.000Z") }),
    ];

    expect(countTournamentMatches(matches, ruleset, null, SIN_CORTES)).toBe(2);
  });

  it("con cortes, no cuenta una partida de equipo con un compañero a dos escalones", () => {
    // Con estos cortes (100 de elo por escalón de subdivisión, 3 por división) el
    // oro va del índice 9 al 11, la plata del 12 al 14 y el bronce del 15 al 17:
    // 2100 es oro, 1799 plata (un escalón: cuenta), y 1599 bronce y 2700 diamante
    // están a dos (no cuenta).
    const deEquipo = (propio: number, companero: number) =>
      match({ mode: "rm_team", rawJson: payloadEquipo(propio, companero) });

    expect(
      countTournamentMatches([deEquipo(2100, 1799)], ruleset, null, CON_CORTES),
      "a un escalón cuenta",
    ).toBe(1);
    expect(
      countTournamentMatches([deEquipo(2100, 1799)], ruleset, null, SIN_CORTES),
      "y sin cortes también, porque no se puede comprobar",
    ).toBe(1);
    expect(
      countTournamentMatches([deEquipo(2100, 1599)], ruleset, null, CON_CORTES),
      "a dos escalones por abajo no cuenta",
    ).toBe(0);
    expect(
      countTournamentMatches([deEquipo(2100, 2700)], ruleset, null, CON_CORTES),
      "y a dos por arriba tampoco",
    ).toBe(0);
  });

  it("sin cortes la condición de equipos no se puede comprobar y la partida cuenta", () => {
    const deEquipo = match({ mode: "rm_team", rawJson: payloadEquipo(2100, 1500) });

    expect(countTournamentMatches([deEquipo], ruleset, null, CON_CORTES)).toBe(0);
    expect(countTournamentMatches([deEquipo], ruleset, null, SIN_CORTES)).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Cursor global y relleno                                                     */
/* -------------------------------------------------------------------------- */

const VENTANA_DESDE = new Date("2026-09-15T00:00:00.000Z");
const AHORA = new Date("2026-10-21T12:00:00.000Z");
const SOLAPE_MS = 90 * 60_000;
const COTA_MS = 6 * 60 * 60_000;

function juego(
  gameId: number,
  updatedAt: string | null,
  profileIds: readonly number[],
): Aoe4WorldGame {
  return {
    gameId,
    startedAt: new Date("2026-10-01T12:00:00.000Z"),
    updatedAt: updatedAt === null ? null : new Date(updatedAt),
    durationSeconds: 1_800,
    map: null,
    mapId: null,
    leaderboard: "rm_solo",
    kind: "rm_1v1",
    state: "processed",
    ongoing: false,
    justFinished: false,
    averageMmr: null,
    averageRating: null,
    teams: [
      profileIds.map((profileId) => ({
        profileId,
        name: null,
        country: null,
        result: null,
        civilization: null,
        civilizationRandomized: false,
        rating: null,
        mmr: null,
      })),
    ],
    raw: asJsonValue({ game_id: gameId }),
  };
}

describe("groupProfileIds", () => {
  it("trocea en lotes y no deja un lote vacío", () => {
    expect(groupProfileIds([], 50)).toEqual([]);
    expect(groupProfileIds([1], 50)).toEqual([[1]]);
    expect(groupProfileIds([1, 2, 3], 2)).toEqual([[1, 2], [3]]);
    expect(groupProfileIds([1, 2, 3, 4], 2)).toEqual([[1, 2], [3, 4]]);
  });

  it("con más de 50 ids cada lote queda en 50 o menos", () => {
    const ids = Array.from({ length: 51 }, (_, index) => index + 1);
    const lotes = groupProfileIds(ids, 50);

    expect(lotes).toHaveLength(2);
    expect(lotes.map((lote) => lote.length)).toEqual([50, 1]);
  });
});

describe("splitGamesByPlayer", () => {
  it("solo asigna a los ids del lote y reparte la partida compartida a cada uno", () => {
    const compartida = juego(1, "2026-10-20T10:00:00.000Z", [PERFIL, COMPAÑERO]);
    const soloDelLote = juego(2, "2026-10-20T09:00:00.000Z", [PERFIL, 9_999_999]);

    const reparto = splitGamesByPlayer([compartida, soloDelLote], [PERFIL, COMPAÑERO]);

    expect(reparto.get(PERFIL)?.map((game) => game.gameId)).toEqual([1, 2]);
    expect(reparto.get(COMPAÑERO)?.map((game) => game.gameId)).toEqual([1]);
    expect(reparto.has(9_999_999)).toBe(false);
  });
});

describe("seedGamesCursor", () => {
  it("si el acierto cae dentro de la cota, no lo toca", () => {
    const seed = seedGamesCursor(
      { finishedAt: "2026-10-21T11:00:00.000Z" },
      VENTANA_DESDE,
      AHORA,
      SOLAPE_MS,
      COTA_MS,
    );

    expect(seed.seededFrom).toBe("sync.lastRun.finishedAt");
    expect(seed.updatedAt.toISOString()).toBe("2026-10-21T09:30:00.000Z");
  });

  it("si es más viejo que el suelo, sube al suelo", () => {
    const seed = seedGamesCursor(
      { finishedAt: "2026-10-20T00:00:00.000Z" },
      VENTANA_DESDE,
      AHORA,
      SOLAPE_MS,
      COTA_MS,
    );

    // El suelo con la cota son las 06:00; menos 90 min de solape, 04:30.
    expect(seed.updatedAt.toISOString()).toBe("2026-10-21T04:30:00.000Z");
  });

  it("si es más nuevo que ahora, baja al techo", () => {
    const seed = seedGamesCursor(
      { finishedAt: "2026-10-21T13:00:00.000Z" },
      VENTANA_DESDE,
      AHORA,
      SOLAPE_MS,
      COTA_MS,
    );

    expect(seed.updatedAt.toISOString()).toBe("2026-10-21T10:30:00.000Z");
  });

  it("aplica el suelo de la ventana antes de restar el solape", () => {
    const seed = seedGamesCursor(
      { finishedAt: "2026-09-01T00:00:00.000Z" },
      VENTANA_DESDE,
      AHORA,
      SOLAPE_MS,
      0,
    );

    expect(seed.updatedAt.toISOString()).toBe("2026-09-14T22:30:00.000Z");
  });

  it("sin cota (`capMs = 0`) usa el acierto tal cual", () => {
    const seed = seedGamesCursor(
      { finishedAt: "2026-09-20T00:00:00.000Z" },
      VENTANA_DESDE,
      AHORA,
      SOLAPE_MS,
      0,
    );

    expect(seed.updatedAt.toISOString()).toBe("2026-09-19T22:30:00.000Z");
  });

  it("sin rastro o con una fecha ilegible cae a `now − solape`", () => {
    for (const trace of [null, { finishedAt: "ayer" }]) {
      const seed = seedGamesCursor(trace, VENTANA_DESDE, AHORA, SOLAPE_MS, COTA_MS);

      expect(seed.seededFrom).toBe("catch-up");
      expect(seed.updatedAt.toISOString()).toBe("2026-10-21T10:30:00.000Z");
    }
  });
});

describe("nextGamesCursor", () => {
  it("sin partidas con `updatedAt` no hay cursor", () => {
    expect(nextGamesCursor(null, [], SOLAPE_MS)).toBeNull();
    expect(nextGamesCursor(null, [juego(1, null, [PERFIL])], SOLAPE_MS)).toBeNull();
  });

  it("no retrocede aunque las partidas leídas sean viejas", () => {
    const anterior = new Date("2026-10-20T12:00:00.000Z");
    const siguiente = nextGamesCursor(
      anterior,
      [juego(1, "2026-10-20T10:00:00.000Z", [PERFIL])],
      SOLAPE_MS,
    );

    expect(siguiente?.toISOString()).toBe(anterior.toISOString());
  });

  it("avanza con el `updatedAt` más nuevo menos el solape", () => {
    const siguiente = nextGamesCursor(
      new Date("2026-10-20T12:00:00.000Z"),
      [
        juego(1, "2026-10-21T11:00:00.000Z", [PERFIL]),
        juego(2, "2026-10-21T12:00:00.000Z", [PERFIL]),
      ],
      SOLAPE_MS,
    );

    expect(siguiente?.toISOString()).toBe("2026-10-21T10:30:00.000Z");
  });

  it("un lote truncado con su trozo más nuevo leído sí avanza", () => {
    const siguiente = nextGamesCursor(
      new Date("2026-10-20T12:00:00.000Z"),
      [juego(1, "2026-10-21T12:00:00.000Z", [PERFIL])],
      SOLAPE_MS,
    );

    expect(siguiente?.toISOString()).toBe("2026-10-21T10:30:00.000Z");
  });
});

describe("shouldAdvanceGamesCursor", () => {
  const base = {
    directed: false,
    batchesFailed: 0,
    aborted: false,
    maxUpdatedAt: new Date("2026-10-21T12:00:00.000Z"),
  };

  it("avanza solo si no es dirigida, no falló ningún lote, no hay plazo y leyó partidas", () => {
    expect(shouldAdvanceGamesCursor(base)).toBe(true);
    expect(shouldAdvanceGamesCursor({ ...base, directed: true })).toBe(false);
    expect(shouldAdvanceGamesCursor({ ...base, batchesFailed: 1 })).toBe(false);
    expect(shouldAdvanceGamesCursor({ ...base, aborted: true })).toBe(false);
    expect(shouldAdvanceGamesCursor({ ...base, maxUpdatedAt: null })).toBe(false);
  });
});

describe("playersToQueueForBackfill", () => {
  const estados = new Map<number, BackfillPlayerState>([
    [2, { profileId: 2, windowComplete: true, backfillPage: 1 }],
    [3, { profileId: 3, windowComplete: false, backfillPage: 1 }],
    [4, { profileId: 4, windowComplete: false, backfillPage: 7 }],
  ]);

  it("encola solo los lotes truncados con la acción de cada caso", () => {
    const batches: GamesBatch[] = [
      { profileIds: [1, 2, 3, 4], incomplete: true },
      { profileIds: [5], incomplete: false },
    ];

    expect(playersToQueueForBackfill(batches, estados)).toEqual([
      { profileId: 1, action: "rewind" },
      { profileId: 2, action: "rewind" },
      { profileId: 3, action: "rewind" },
      { profileId: 4, action: "keepPage" },
    ]);
  });

  it("deduplica ids repetidos entre lotes truncados", () => {
    const batches: GamesBatch[] = [
      { profileIds: [1, 2], incomplete: true },
      { profileIds: [2, 3], incomplete: true },
    ];

    expect(playersToQueueForBackfill(batches, estados)).toEqual([
      { profileId: 1, action: "rewind" },
      { profileId: 2, action: "rewind" },
      { profileId: 3, action: "rewind" },
    ]);
  });
});

describe("backfillPlan", () => {
  it("con la ventana completa no hay plan", () => {
    expect(
      backfillPlan(
        { windowComplete: true, backfillPage: 1, registeredAt: null },
        VENTANA_DESDE,
        3,
      ),
    ).toBeNull();
  });

  it("empieza por la página 1 y usa la ventana si no hay alta posterior", () => {
    const plan = backfillPlan(
      { windowComplete: false, backfillPage: 1, registeredAt: null },
      VENTANA_DESDE,
      3,
    );

    expect(plan?.since.toISOString()).toBe(VENTANA_DESDE.toISOString());
    expect(plan?.startPage).toBe(1);
    expect(plan?.pages).toBe(3);
  });

  it("respeta la página y el alta posterior a la ventana", () => {
    const registeredAt = new Date("2026-10-01T00:00:00.000Z");
    const plan = backfillPlan(
      { windowComplete: false, backfillPage: 7, registeredAt },
      VENTANA_DESDE,
      3,
    );

    expect(plan?.since.toISOString()).toBe(registeredAt.toISOString());
    expect(plan?.startPage).toBe(7);
    expect(plan?.pages).toBe(3);
  });

  it("una página guardada a 0 se sanea a 1", () => {
    expect(
      backfillPlan(
        { windowComplete: false, backfillPage: 0, registeredAt: null },
        VENTANA_DESDE,
        3,
      )?.startPage,
    ).toBe(1);
  });
});

describe("nextBackfillWatchdog", () => {
  it("en la primera pasada fija el primer mínimo", () => {
    const estado = nextBackfillWatchdog(
      { bulkIncompleteStreak: 0, pendingBestCount: 0, pendingBestAt: null },
      12,
      1,
      AHORA,
    );

    expect(estado).toEqual({
      bulkIncompleteStreak: 1,
      pendingBestCount: 12,
      pendingBestAt: AHORA.toISOString(),
    });
  });

  it("la racha sube, llega a 7 y se resetea en la primera pasada limpia", () => {
    let estado: BackfillWatchdogState = {
      bulkIncompleteStreak: 0,
      pendingBestCount: 0,
      pendingBestAt: null,
    };

    for (let pasada = 1; pasada <= 7; pasada += 1) {
      estado = nextBackfillWatchdog(estado, null, 1, AHORA);
      expect(estado.bulkIncompleteStreak).toBe(pasada);
    }

    estado = nextBackfillWatchdog(estado, null, 0, AHORA);
    expect(estado.bulkIncompleteStreak).toBe(0);
  });

  it("un mínimo nuevo actualiza count y fecha; uno peor los deja intactos", () => {
    const inicial = {
      bulkIncompleteStreak: 2,
      pendingBestCount: 10,
      pendingBestAt: "2026-10-20T10:00:00.000Z",
    };

    expect(nextBackfillWatchdog(inicial, 7, 1, AHORA)).toEqual({
      bulkIncompleteStreak: 3,
      pendingBestCount: 7,
      pendingBestAt: AHORA.toISOString(),
    });
    expect(nextBackfillWatchdog(inicial, 11, 1, AHORA)).toEqual({
      bulkIncompleteStreak: 3,
      pendingBestCount: 10,
      pendingBestAt: "2026-10-20T10:00:00.000Z",
    });
  });

  it("con `pending` a null no toca el mínimo", () => {
    const inicial = {
      bulkIncompleteStreak: 2,
      pendingBestCount: 10,
      pendingBestAt: "2026-10-20T10:00:00.000Z",
    };

    expect(nextBackfillWatchdog(inicial, null, 1, AHORA)).toEqual({
      bulkIncompleteStreak: 3,
      pendingBestCount: 10,
      pendingBestAt: "2026-10-20T10:00:00.000Z",
    });
  });
});

describe("backfillProgressStalled", () => {
  const reciente = "2026-10-21T11:00:00.000Z";
  const viejo = "2026-10-20T10:00:00.000Z";

  it("la racha 6 no alarma y la 7 sí", () => {
    expect(
      backfillProgressStalled(
        { bulkIncompleteStreak: 6, pendingBestAt: reciente },
        5,
        AHORA,
      ),
    ).toBe(false);
    expect(
      backfillProgressStalled(
        { bulkIncompleteStreak: 7, pendingBestAt: reciente },
        5,
        AHORA,
      ),
    ).toBe(true);
  });

  it("un mínimo de 25 h alarma, y uno reciente no", () => {
    expect(
      backfillProgressStalled(
        { bulkIncompleteStreak: 0, pendingBestAt: viejo },
        5,
        AHORA,
      ),
    ).toBe(true);
    expect(
      backfillProgressStalled(
        { bulkIncompleteStreak: 0, pendingBestAt: reciente },
        5,
        AHORA,
      ),
    ).toBe(false);
  });

  it("sin mínimo medido o con el relleno a cero no hay atasco", () => {
    expect(
      backfillProgressStalled(
        { bulkIncompleteStreak: 0, pendingBestAt: null },
        5,
        AHORA,
      ),
    ).toBe(false);
    expect(
      backfillProgressStalled(
        { bulkIncompleteStreak: 7, pendingBestAt: viejo },
        0,
        AHORA,
      ),
    ).toBe(false);
    expect(
      backfillProgressStalled(
        { bulkIncompleteStreak: 7, pendingBestAt: viejo },
        null,
        AHORA,
      ),
    ).toBe(false);
  });

  it("acepta umbrales cortos para probar la regla", () => {
    expect(
      backfillProgressStalled(
        { bulkIncompleteStreak: 1, pendingBestAt: reciente },
        5,
        AHORA,
        { maxIncompleteStreak: 1 },
      ),
    ).toBe(true);
    expect(
      backfillProgressStalled(
        { bulkIncompleteStreak: 0, pendingBestAt: reciente },
        5,
        AHORA,
        { pendingStaleMs: 30_000 },
      ),
    ).toBe(true);
  });
});

describe("shouldRefreshProfile", () => {
  const AHORA_PERFIL = new Date("2026-10-21T12:00:00.000Z");
  const TTL = 60 * 60_000;

  it("sin sello siempre toca pedir el perfil", () => {
    expect(shouldRefreshProfile(null, AHORA_PERFIL, TTL)).toBe(true);
  });

  it("un sello reciente no pide el perfil y uno justo en el TTL sí", () => {
    expect(
      shouldRefreshProfile(new Date(AHORA_PERFIL.getTime() - 59 * 60_000), AHORA_PERFIL, TTL),
    ).toBe(false);
    expect(
      shouldRefreshProfile(new Date(AHORA_PERFIL.getTime() - TTL), AHORA_PERFIL, TTL),
    ).toBe(true);
    expect(
      shouldRefreshProfile(new Date(AHORA_PERFIL.getTime() - TTL - 1), AHORA_PERFIL, TTL),
    ).toBe(true);
  });

  it("una fecha futura se considera fresca", () => {
    expect(
      shouldRefreshProfile(new Date(AHORA_PERFIL.getTime() + TTL), AHORA_PERFIL, TTL),
    ).toBe(false);
  });

  it("ttl 0 desactiva la caché", () => {
    expect(shouldRefreshProfile(AHORA_PERFIL, AHORA_PERFIL, 0)).toBe(true);
  });
});
