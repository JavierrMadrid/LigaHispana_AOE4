import { describe, expect, it } from "vitest";

import { computePlayerAlerts, type AlertMatch } from "@/lib/alerts/compute";
import { DEFAULT_ALERTS_RULESET } from "@/lib/alerts/rules";
import type { ScoringWindow } from "@/lib/ranked-match";

/**
 * El motor de alertas sobre secuencias de partidas escritas a mano.
 *
 * Es un módulo puro —no lee la base ni sale a la red— y por eso se le puede pasar
 * cualquier secuencia y comprobar la regla entera. Lo que se cubre son los bordes
 * que el docblock del módulo declara: el umbral de cada regla, el `null` que
 * degrada en vez de acusar, el tramo que sigue abierto y el cierre de torneo.
 *
 * Las reglas R4 (`TEAMMATE_ELO_GAP`) y R5 (`LOW_DIVISION_TEAM_GAME`) se retiraron
 * y **no** tienen casos aquí: su caso pasó a ser la condición de equipos de
 * `ranked-match.ts`, y sus casos viven en `tests/unit/lib/ranked-match.test.ts`.
 */

const PERFIL_JUGADOR = 9_100_001;
const COMPAÑERO = 9_100_002;
const COMPAÑERO_2 = 9_100_003;
const RIVAL = 9_100_004;
const RIVAL_2 = 9_100_005;
/** Rival de la partida que cierra un tramo: no aparece en ninguna otra. */
const RIVAL_DE_CIERRE = 9_100_007;

const VENTANA: ScoringWindow = {
  from: "2026-09-15T00:00:00.000Z",
  to: "2026-10-15T00:00:00.000Z",
};

/** Torneo en curso: una racha abierta todavía no avisa. */
const DURANTE = new Date("2026-10-01T12:00:00.000Z");
/** Torneo cerrado: la racha del final se avisa con el conteo que tenga. */
const DESPUES = new Date("2026-10-20T12:00:00.000Z");

const JUGADOR = {
  id: "jugador-alertas",
  profileId: PERFIL_JUGADOR,
  name: "Jugador Alertas",
};

type Raw = { profileId: number | null; name: string; rating: number | null };

/**
 * Payload en la forma en que la API lo manda: equipos anidados, cada entrada
 * envuelta en `{ player: {...} }`. Se escribe a mano y **no** con `normalizeGame`,
 * para que la comprobación mida el motor de alertas y no el normalizador.
 */
function payload(options: {
  indice: number;
  kind: "rm_1v1" | "rm_2v2";
  propio: Raw[];
  rival: Raw[];
}): Record<string, unknown> {
  const envolver = (players: Raw[]) =>
    players.map((player) => ({
      player: {
        profile_id: player.profileId,
        name: player.name,
        rating: player.rating,
        result: "win",
        civilization: "english",
        civilization_randomized: false,
      },
    }));

  return {
    game_id: 8_000_000 + options.indice,
    started_at: new Date(Date.parse(VENTANA.from) + (options.indice + 1) * 3_600_000).toISOString(),
    duration: 1800,
    state: "processed",
    kind: options.kind,
    leaderboard: options.kind === "rm_1v1" ? "rm_solo" : "rm_team",
    ongoing: false,
    teams: [envolver(options.rival), envolver(options.propio)],
  };
}

/**
 * Construye la secuencia en orden, numando cada partida por su posición. Exige que
 * las llamadas se hagan en orden de `startedAt` porque es lo que llega de la base y
 * lo que sostiene tanto las rachas como el "quién llegó primero".
 */
function secuencia() {
  const partidas: AlertMatch[] = [];

  /** Siguiente posición de la secuencia. */
  function indice() {
    return partidas.length;
  }

  const startedAt = () => new Date(Date.parse(VENTANA.from) + (indice() + 1) * 3_600_000);

  /**
   * Los campos del resumen, que ninguna regla de racha mira: una partida sin
   * `summaryAnomalies` y sin intentos no aporta nada a las reglas del resumen.
   */
  function sinSummary(started: Date): Pick<
    AlertMatch,
    "apm" | "finishedAt" | "summaryCheckedAt" | "summaryLastAttemptAt" | "summaryAnomalies"
  > {
    return {
      apm: null,
      finishedAt: new Date(started.getTime() + 30 * 60_000),
      summaryCheckedAt: null,
      summaryLastAttemptAt: null,
      summaryAnomalies: null,
    };
  }

  return {
    solo(options: {
      durationSeconds?: number | null;
      opponentProfileId?: number | null;
      opponentName?: string | null;
    } = {}): AlertMatch {
      const rival = options.opponentProfileId === undefined ? RIVAL : options.opponentProfileId;
      const nombre = options.opponentName === undefined ? "Rival Fijo" : options.opponentName;
      const inicio = startedAt();
      const partida: AlertMatch = {
        gameId: String(800_000 + indice()),
        mode: "rm_solo",
        opponentProfileId: rival,
        opponentName: nombre,
        startedAt: inicio,
        durationSeconds: options.durationSeconds === undefined ? 1800 : options.durationSeconds,
        rawJson: payload({
          indice: indice(),
          kind: "rm_1v1",
          propio: [{ profileId: PERFIL_JUGADOR, name: JUGADOR.name, rating: 1500 }],
          rival: [{ profileId: rival ?? RIVAL, name: nombre ?? "Rival Fijo", rating: 1500 }],
        }),
        ...sinSummary(inicio),
      };

      partidas.push(partida);

      return partida;
    },

    equipo(options: {
      teammates: Array<[number | null, string, number | null]>;
    }): AlertMatch {
      const inicio = startedAt();
      const partida: AlertMatch = {
        gameId: String(800_000 + indice()),
        mode: "rm_team",
        opponentProfileId: RIVAL_2,
        opponentName: "Rival Externo",
        startedAt: inicio,
        durationSeconds: 1800,
        rawJson: payload({
          indice: indice(),
          kind: "rm_2v2",
          propio: [
            { profileId: PERFIL_JUGADOR, name: JUGADOR.name, rating: 1500 },
            ...options.teammates.map(([profileId, name, rating]) => ({ profileId, name, rating })),
          ],
          rival: [{ profileId: RIVAL_2, name: "Rival Externo", rating: 1500 }],
        }),
        ...sinSummary(inicio),
      };

      partidas.push(partida);

      return partida;
    },

    /**
     * Una clasificatoria larga contra un rival que no sale en ninguna otra partida:
     * no aporta flag a ninguna regla y sirve para cerrar el tramo anterior.
     */
    cierre(): AlertMatch {
      return this.solo({
        durationSeconds: 1800,
        opponentProfileId: RIVAL_DE_CIERRE,
        opponentName: "Rival de cierre",
      });
    },

    /** `n` 1v1 seguidas con el mismo rival. */
    contraRival(n: number, opciones: { opponentProfileId?: number } = {}): void {
      for (let i = 0; i < n; i += 1) {
        this.solo({ opponentProfileId: opciones.opponentProfileId });
      }
    },

    /** `n` de equipo seguidas con el mismo compañero, a 1500 de elo. */
    conCompanero(n: number, companero: number = COMPAÑERO): void {
      for (let i = 0; i < n; i += 1) {
        this.equipo({ teammates: [[companero, "Compañero", 1500]] });
      }
    },

    /** Lo construido hasta ahora, que es lo que se le pasa al motor. */
    partidas(): AlertMatch[] {
      return [...partidas];
    },
  };
}

function evaluar(options: {
  matches: AlertMatch[];
  now?: Date;
  window?: ScoringWindow;
  summaryReviewWindowMs?: number;
}) {
  return computePlayerAlerts({
    player: JUGADOR,
    matches: options.matches,
    ruleset: DEFAULT_ALERTS_RULESET,
    scoring: { modes: ["rm_solo", "rm_team"], window: options.window ?? VENTANA },
    summaryReviewWindowMs: options.summaryReviewWindowMs ?? 24 * 3_600_000,
    now: options.now ?? DURANTE,
  });
}

/** Solo las alertas de una regla, que es como se leen los casos. */
function de(evaluacion: ReturnType<typeof evaluar>, regla: string) {
  return evaluacion.alerts.filter((alert) => alert.rule === regla);
}

describe("R1 — partidas cortas", () => {
  it("el umbral son 180 s y el derecho es exclusivo: 179 avisa, 180 no", () => {
    const corta = secuencia();
    corta.solo({ durationSeconds: 179 });
    corta.solo({ durationSeconds: 179 });
    corta.cierre();

    const larga = secuencia();
    larga.solo({ durationSeconds: 180 });
    larga.solo({ durationSeconds: 180 });
    larga.cierre();

    expect(de(evaluar({ matches: corta.partidas() }), "SHORT_MATCH_STREAK")).toHaveLength(1);
    expect(de(evaluar({ matches: larga.partidas() }), "SHORT_MATCH_STREAK")).toHaveLength(0);
  });

  it("el tramo avisa al romperse, y ancla la partida que lo rompió", () => {
    const s = secuencia();
    s.solo({ durationSeconds: 100 });
    s.solo({ durationSeconds: 100 });
    const rompe = s.cierre();

    const alerta = de(evaluar({ matches: s.partidas() }), "SHORT_MATCH_STREAK")[0];

    expect(alerta?.kind).toBe("STREAK_CLOSED");
    expect(alerta?.count).toBe(2);
    expect(alerta?.threshold).toBe(DEFAULT_ALERTS_RULESET.thresholds.shortMatchStreak);
    // El sujeto es el propio jugador: las reglas que no hablan de nadie llevan el
    // sujeto a null, para que no se confundan con el rival o el compañero.
    expect(alerta?.subjectProfileId).toBeNull();
    expect(alerta?.subjectName).toBeNull();
    expect(alerta?.anchorGameId).toBe(rompe.gameId);
  });

  it("una sola corta no avisa: el umbral del tramo son 2", () => {
    const s = secuencia();
    s.solo({ durationSeconds: 100 });
    s.cierre();

    expect(de(evaluar({ matches: s.partidas() }), "SHORT_MATCH_STREAK")).toHaveLength(0);
  });

  it("una partida sin duración rompe el tramo en vez de contarse como corta", () => {
    // Una partida que no se puede juzgar no tiene el flag, y eso es distinto de que
    // el resultado fuera "no es corta": no se puede acusar a nadie de un dato que no
    // existe.
    const s = secuencia();
    s.solo({ durationSeconds: 100 });
    s.solo({ durationSeconds: null });
    s.solo({ durationSeconds: 100 });

    const evaluacion = evaluar({ matches: s.partidas() });

    expect(de(evaluacion, "SHORT_MATCH_STREAK")).toHaveLength(0);
    expect(evaluacion.openStreaks).toHaveLength(1);
  });

  it("el acumulado avisa cada 5, una fila por múltiplo", () => {
    const s = secuencia();
    for (let i = 0; i < 12; i += 1) {
      s.solo({ durationSeconds: 100 });
    }
    s.cierre();

    expect(de(evaluar({ matches: s.partidas() }), "SHORT_MATCH_TOTAL").map((a) => a.count)).toEqual([
      5, 10,
    ]);
  });
});

describe("R2 — rival repetido", () => {
  it("tres 1v1 seguidas contra el mismo rival avisan, y el sujeto es el rival", () => {
    const s = secuencia();
    s.contraRival(3);
    s.cierre();

    const alerta = de(evaluar({ matches: s.partidas() }), "REPEATED_OPPONENT_STREAK")[0];

    expect(alerta?.subjectProfileId).toBe(RIVAL);
    expect(alerta?.subjectName).toBe("Rival Fijo");
    expect(alerta?.count).toBe(3);
  });

  it("cambiar de rival cierra el tramo anterior y abre otro", () => {
    const s = secuencia();
    s.contraRival(3);
    s.contraRival(3, { opponentProfileId: RIVAL_2 });
    s.cierre();

    const rachas = de(evaluar({ matches: s.partidas() }), "REPEATED_OPPONENT_STREAK");

    expect(rachas.map((a) => [a.subjectProfileId, a.count])).toEqual([
      [RIVAL, 3],
      [RIVAL_2, 3],
    ]);
  });

  it("el acumulado es por rival y avisa cada 10", () => {
    const s = secuencia();
    s.contraRival(10);
    s.contraRival(4, { opponentProfileId: RIVAL_2 });
    s.cierre();

    const totales = de(evaluar({ matches: s.partidas() }), "REPEATED_OPPONENT_TOTAL");

    expect(totales).toHaveLength(1);
    expect(totales[0]?.subjectProfileId).toBe(RIVAL);
    expect(totales[0]?.count).toBe(10);
  });

  it("no mira las partidas de equipo: allí el rival guardado es solo el primero", () => {
    const s = secuencia();
    s.conCompanero(3);
    s.cierre();

    expect(de(evaluar({ matches: s.partidas() }), "REPEATED_OPPONENT_STREAK")).toHaveLength(0);
  });

  it("una 1v1 sin `opponentProfileId` no puede ser sujeto", () => {
    const s = secuencia();
    for (let i = 0; i < 3; i += 1) {
      s.solo({ opponentProfileId: null, opponentName: null });
    }
    s.cierre();

    expect(de(evaluar({ matches: s.partidas() }), "REPEATED_OPPONENT_STREAK")).toHaveLength(0);
  });
});

describe("R3 — compañero repetido", () => {
  it("tres de equipo seguidas con el mismo compañero avisan", () => {
    const s = secuencia();
    s.conCompanero(3);
    s.cierre();

    const alerta = de(evaluar({ matches: s.partidas() }), "REPEATED_TEAMMATE_STREAK")[0];

    expect(alerta?.subjectProfileId).toBe(COMPAÑERO);
    expect(alerta?.count).toBe(3);
  });

  it("la unidad de «consecutiva» es la clasificatoria completa: una 1v1 rompe el tramo", () => {
    // Es deliberado: lo que se vigila es el comportamiento seguido, no el orden en
    // que llegaron las partidas.
    const s = secuencia();
    s.conCompanero(2);
    s.cierre();
    s.conCompanero(2);
    s.cierre();

    expect(de(evaluar({ matches: s.partidas() }), "REPEATED_TEAMMATE_STREAK")).toHaveLength(0);
  });

  it("dos compañeros distintos en el mismo 2v2 cuentan como dos sujetos", () => {
    const s = secuencia();
    for (let i = 0; i < 3; i += 1) {
      s.equipo({
        teammates: [
          [COMPAÑERO, "Compañero", 1500],
          [COMPAÑERO_2, "Otro compañero", 1500],
        ],
      });
    }
    s.cierre();

    const rachas = de(evaluar({ matches: s.partidas() }), "REPEATED_TEAMMATE_STREAK");

    expect(rachas.map((a) => a.subjectProfileId).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([
      COMPAÑERO,
      COMPAÑERO_2,
    ]);
  });

  it("el acumulado es un único aviso al llegar a 7, ni uno más aunque se llegue a 14", () => {
    const s = secuencia();
    s.conCompanero(14);
    s.cierre();

    const totales = de(evaluar({ matches: s.partidas() }), "REPEATED_TEAMMATE_TOTAL");

    expect(totales).toHaveLength(1);
    expect(totales[0]?.count).toBe(7);
    expect(totales[0]?.threshold).toBe(DEFAULT_ALERTS_RULESET.thresholds.repeatedTeammateTotal);
  });

  it("un compañero sin `profile_id` no es sujeto: no tiene identidad con la que contar", () => {
    const s = secuencia();
    for (let i = 0; i < 3; i += 1) {
      s.equipo({ teammates: [[null, "Sin id", 2500]] });
    }
    s.cierre();

    const evaluacion = evaluar({ matches: s.partidas() });

    expect(de(evaluacion, "REPEATED_TEAMMATE_STREAK")).toHaveLength(0);
  });
});

describe("rachas abiertas y cierre de torneo", () => {
  it("un tramo que llega al final de la secuencia no avisa todavía", () => {
    // Un tramo que llega al final de la secuencia está **abierto**: avisa cuando
    // llegue la siguiente clasificatoria, que es justo lo que significa "la racha
    // se rompe".
    const s = secuencia();
    s.conCompanero(3);

    const evaluacion = evaluar({ matches: s.partidas() });

    expect(evaluacion.alerts).toHaveLength(0);
    expect(evaluacion.openStreaks).toHaveLength(1);
    expect(evaluacion.openStreaks[0]).toMatchObject({
      rule: "REPEATED_TEAMMATE_STREAK",
      count: 3,
      threshold: 3,
      lastGameId: s.partidas().at(-1)?.gameId,
    });
  });

  it("con el torneo ya terminado el mismo tramo se avisa por fin de torneo", () => {
    // Sin este caso, una racha que acaba con la última partida del torneo no se
    // avisaría nunca.
    const s = secuencia();
    s.conCompanero(3);

    const evaluacion = evaluar({ matches: s.partidas(), now: DESPUES });

    expect(de(evaluacion, "REPEATED_TEAMMATE_STREAK")[0]?.kind).toBe("STREAK_AT_TOURNAMENT_END");
    expect(evaluacion.closedAtTournamentEnd).toBe(1);
  });

  it("con la ventana abierta por la derecha el torneo no se cierra nunca", () => {
    const s = secuencia();
    s.conCompanero(3);

    const evaluacion = evaluar({
      matches: s.partidas(),
      now: DESPUES,
      window: { from: VENTANA.from, to: null },
    });

    expect(evaluacion.alerts).toHaveLength(0);
    expect(evaluacion.openStreaks).toHaveLength(1);
  });

  it("un tramo que se rompió antes no se vuelve a avisar por el cierre", () => {
    const s = secuencia();
    s.conCompanero(3);
    s.cierre();

    const evaluacion = evaluar({ matches: s.partidas(), now: DESPUES });

    expect(de(evaluacion, "REPEATED_TEAMMATE_STREAK")[0]?.kind).toBe("STREAK_CLOSED");
    expect(evaluacion.closedAtTournamentEnd).toBe(0);
  });
});

describe("lo que degrada sin romper", () => {
  it("un `rawJson` ilegible no lanza y no aporta flags a las reglas de equipo", () => {
    const rota: AlertMatch = {
      gameId: "800-900",
      mode: "rm_team",
      opponentProfileId: RIVAL,
      opponentName: "Rival",
      startedAt: new Date("2026-09-15T01:00:00.000Z"),
      durationSeconds: 1800,
      rawJson: { game_id: "no-es-un-numero", teams: "esto no es una lista" },
      apm: null,
      finishedAt: new Date("2026-09-15T01:30:00.000Z"),
      summaryCheckedAt: null,
      summaryLastAttemptAt: null,
      summaryAnomalies: null,
    };
    const s = secuencia();
    s.conCompanero(2);
    s.cierre();

    const evaluacion = evaluar({ matches: [rota, ...s.partidas()] });

    // R3 exige 3 y solo hay 2 legibles: no se acusa a nadie de una secuencia que no
    // se pudo leer entera.
    expect(de(evaluacion, "REPEATED_TEAMMATE_STREAK")).toHaveLength(0);
    // R3 es la única regla que relee el payload, así que la partida ilegible se
    // cuenta una vez.
    expect(evaluacion.unreadableMatches).toBe(1);
    expect(evaluacion.warnings.some((w) => w.includes("rawJson ilegible"))).toBe(true);
  });

  it("una 1v1 con `rawJson` ilegible no cuenta: ninguna regla de equipo la mira", () => {
    const rota: AlertMatch = {
      gameId: "800-901",
      mode: "rm_solo",
      opponentProfileId: RIVAL,
      opponentName: "Rival",
      startedAt: new Date("2026-09-15T01:00:00.000Z"),
      durationSeconds: 1800,
      rawJson: "no es un payload",
      apm: null,
      finishedAt: new Date("2026-09-15T01:30:00.000Z"),
      summaryCheckedAt: null,
      summaryLastAttemptAt: null,
      summaryAnomalies: null,
    };

    expect(evaluar({ matches: [rota] }).unreadableMatches).toBe(0);
  });
});

describe("las tres reglas por partida, desde el resumen", () => {
  /** Una partida clasificatoria con el resumen que diga la prueba. */
  function conResumen(options: {
    gameId?: string;
    anomalies: unknown;
    apm?: number | null;
    startedAt?: Date;
    mode?: string | null;
    durationSeconds?: number | null;
  }): AlertMatch {
    const base = secuencia().solo();

    return {
      ...base,
      gameId: options.gameId ?? base.gameId,
      mode: options.mode ?? base.mode,
      ...(options.startedAt === undefined ? {} : { startedAt: options.startedAt }),
      ...(options.durationSeconds === undefined
        ? {}
        : { durationSeconds: options.durationSeconds }),
      apm: options.apm === undefined ? 120 : options.apm,
      summaryAnomalies: options.anomalies,
    };
  }

  const anomalies = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    buildOrderReadable: true,
    firstVillagerSeconds: 21,
    militaryNoGrowth: null,
    noResourceGain: null,
    ...overrides,
  });

  it("sin aldeanos en el arranque avisa, y ancla la partida", () => {
    const match = conResumen({ anomalies: anomalies({ firstVillagerSeconds: null }) });

    const alerta = de(evaluar({ matches: [match] }), "NO_VILLAGERS_FIRST_MINUTES")[0];

    expect(alerta).toMatchObject({
      kind: "MATCH_DETECTED",
      count: 0,
      // El umbral es el del ruleset: es lo que dispara la regla y lo que la frase
      // necesita para decir "en los primeros N minutos".
      threshold: DEFAULT_ALERTS_RULESET.thresholds.noVillagersFirstSeconds,
      anchorGameId: match.gameId,
      subjectProfileId: null,
    });
    expect(alerta?.summary).toBe("No hizo ningún aldeano en los primeros 5 minutos.");
    expect(alerta?.details).toMatchObject({ firstVillagerSeconds: null });
  });

  it("un aldeano dentro del umbral no avisa, y uno justo después sí", () => {
    const dentro = conResumen({
      anomalies: anomalies({ firstVillagerSeconds: DEFAULT_ALERTS_RULESET.thresholds.noVillagersFirstSeconds }),
    });
    const fuera = conResumen({
      anomalies: anomalies({
        firstVillagerSeconds: DEFAULT_ALERTS_RULESET.thresholds.noVillagersFirstSeconds + 1,
      }),
    });

    expect(de(evaluar({ matches: [dentro] }), "NO_VILLAGERS_FIRST_MINUTES")).toHaveLength(0);
    expect(de(evaluar({ matches: [fuera] }), "NO_VILLAGERS_FIRST_MINUTES")).toHaveLength(1);
  });

  it("si el `buildOrder` no se pudo leer, la regla de aldeanos NO se evalúa", () => {
    // Es la diferencia entre "no hizo aldeanos" y "no sabemos qué hizo": con
    // `buildOrderReadable: false` no hay acusación posible.
    const match = conResumen({
      anomalies: anomalies({ buildOrderReadable: false, firstVillagerSeconds: null }),
    });

    expect(de(evaluar({ matches: [match] }), "NO_VILLAGERS_FIRST_MINUTES")).toHaveLength(0);
  });

  it("una partida que duró menos que la ventana no avisa: esos minutos no se jugaron", () => {
    // 240 s es menos que los 300 s de la ventana, así que no se puede decir que no
    // hiciera aldeanos "en los primeros 5 minutos".
    const match = conResumen({
      anomalies: anomalies({ firstVillagerSeconds: null }),
      durationSeconds: 240,
    });

    expect(de(evaluar({ matches: [match] }), "NO_VILLAGERS_FIRST_MINUTES")).toHaveLength(0);
  });

  it("una partida que llegó a la ventana sí avisa", () => {
    const match = conResumen({
      anomalies: anomalies({ firstVillagerSeconds: null }),
      durationSeconds: 360,
    });

    expect(de(evaluar({ matches: [match] }), "NO_VILLAGERS_FIRST_MINUTES")).toHaveLength(1);
  });

  it("el tramo militar cuenta solo lo que queda después de la gracia", () => {
    const cubre = conResumen({
      anomalies: anomalies({ militaryNoGrowth: [{ fromSeconds: 0, toSeconds: 900 }] }),
    });

    const alerta = de(evaluar({ matches: [cubre] }), "NO_MILITARY_GAP")[0];

    expect(alerta).toMatchObject({
      kind: "MATCH_DETECTED",
      // 900 s del tramo menos 300 de gracia.
      count: 600,
      threshold: DEFAULT_ALERTS_RULESET.thresholds.noMilitaryGapSeconds,
    });
    expect(alerta?.summary).toBe("Pasó 10 minutos seguidos sin progreso militar.");
    expect(alerta?.details).toMatchObject({
      militaryNoGrowthFromSeconds: 0,
      militaryNoGrowthToSeconds: 900,
    });
  });

  it("un tramo que cabe dentro de la gracia no avisa", () => {
    const corto = conResumen({
      anomalies: anomalies({ militaryNoGrowth: [{ fromSeconds: 0, toSeconds: 500 }] }),
    });

    // 500 s de tramo y 300 de gracia: quedan 200, por debajo de los 300 del umbral.
    expect(de(evaluar({ matches: [corto] }), "NO_MILITARY_GAP")).toHaveLength(0);
  });

  it("un tramo tardío no tiene gracia que descontar", () => {
    const tarde = conResumen({
      anomalies: anomalies({ militaryNoGrowth: [{ fromSeconds: 600, toSeconds: 1000 }] }),
    });

    const alerta = de(evaluar({ matches: [tarde] }), "NO_MILITARY_GAP")[0];

    expect(alerta?.count).toBe(400);
  });

  it("mira todos los tramos: un segundo tramo corto pero tardío sí avisa", () => {
    // El tramo más largo empieza antes de la gracia y solo deja 100 s útiles; el
    // segundo, más corto, cuenta entero y es el que dispara la regla.
    const partida = conResumen({
      anomalies: anomalies({
        militaryNoGrowth: [
          { fromSeconds: 0, toSeconds: 400 },
          { fromSeconds: 1000, toSeconds: 1350 },
        ],
      }),
    });

    const alertas = de(evaluar({ matches: [partida] }), "NO_MILITARY_GAP");

    // Una sola alerta por partida, con la evidencia del tramo que la dispara.
    expect(alertas).toHaveLength(1);
    expect(alertas[0]).toMatchObject({
      kind: "MATCH_DETECTED",
      count: 350,
      threshold: 300,
      anchorGameId: partida.gameId,
    });
    expect(alertas[0]?.details).toMatchObject({
      militaryNoGrowthFromSeconds: 1000,
      militaryNoGrowthToSeconds: 1350,
    });
  });

  it("si ningún tramo supera el umbral después de la gracia, no avisa", () => {
    const partida = conResumen({
      anomalies: anomalies({
        militaryNoGrowth: [
          { fromSeconds: 0, toSeconds: 400 },
          { fromSeconds: 1000, toSeconds: 1200 },
        ],
      }),
    });

    // 100 s y 200 s útiles, los dos por debajo de los 300 del umbral.
    expect(de(evaluar({ matches: [partida] }), "NO_MILITARY_GAP")).toHaveLength(0);
  });

  it("sin obtener recursos avisa con los segundos del tramo", () => {
    const match = conResumen({
      anomalies: anomalies({ noResourceGain: { fromSeconds: 120, toSeconds: 300 } }),
    });

    const alerta = de(evaluar({ matches: [match] }), "NO_RESOURCES_GAP")[0];

    expect(alerta).toMatchObject({ kind: "MATCH_DETECTED", count: 180, threshold: 120 });
    expect(alerta?.summary).toBe("Pasó 3 minutos seguidos sin obtener recursos.");
    expect(alerta?.details).toMatchObject({
      noResourceGainFromSeconds: 120,
      noResourceGainToSeconds: 300,
    });
  });

  it("un tramo de recursos por debajo del umbral no avisa", () => {
    const match = conResumen({
      anomalies: anomalies({ noResourceGain: { fromSeconds: 100, toSeconds: 200 } }),
    });

    expect(de(evaluar({ matches: [match] }), "NO_RESOURCES_GAP")).toHaveLength(0);
  });

  it("una partida sin summary legible no genera ninguna alerta por partida", () => {
    // `null` es "no hay summary" y una forma rota es "no se pudo leer": ninguna de
    // las dos acusa a nadie.
    const sinResumen = conResumen({ anomalies: null, apm: null });
    const roto = conResumen({ anomalies: { militaryNoGrowth: { fromSeconds: 900, toSeconds: 0 } } });

    const evaluacion = evaluar({ matches: [sinResumen, roto] });

    expect(de(evaluacion, "NO_VILLAGERS_FIRST_MINUTES")).toHaveLength(0);
    expect(de(evaluacion, "NO_MILITARY_GAP")).toHaveLength(0);
    expect(de(evaluacion, "NO_RESOURCES_GAP")).toHaveLength(0);
  });

  it("es una alerta por partida y regla, no una por jugador", () => {
    // La clave de `MATCH_DETECTED` lleva la partida: dos hallazgos iguales en dos
    // partidas son dos alertas.
    const primera = conResumen({
      gameId: "800-501",
      anomalies: anomalies({ firstVillagerSeconds: null }),
    });
    const segunda = conResumen({
      gameId: "800-502",
      anomalies: anomalies({ firstVillagerSeconds: null }),
      startedAt: new Date("2026-09-15T05:00:00.000Z"),
    });

    const alertas = de(evaluar({ matches: [primera, segunda] }), "NO_VILLAGERS_FIRST_MINUTES");

    expect(alertas).toHaveLength(2);
    expect(new Set(alertas.map((alerta) => alerta.dedupeKey)).size).toBe(2);
    expect(alertas.map((alerta) => alerta.anchorGameId)).toEqual(["800-501", "800-502"]);
  });
});

describe("SUMMARY_NOT_REVIEWED: las partidas que se quedaron sin revisar", () => {
  const AHORA = new Date("2026-10-01T12:00:00.000Z");
  const HACE_25_H = new Date(AHORA.getTime() - 25 * 3_600_000);
  const HACE_23_H = new Date(AHORA.getTime() - 23 * 3_600_000);

  function sinRevisar(options: {
    gameId: string;
    finishedAt: Date;
    attemptedAt: Date | null;
    checkedAt?: Date | null;
    apm?: number | null;
  }): AlertMatch {
    const base = secuencia().solo();

    return {
      ...base,
      gameId: options.gameId,
      startedAt: new Date(options.finishedAt.getTime() - 30 * 60_000),
      finishedAt: options.finishedAt,
      apm: options.apm ?? null,
      summaryCheckedAt: options.checkedAt ?? null,
      summaryLastAttemptAt: options.attemptedAt,
      summaryAnomalies: null,
    };
  }

  it("avisa de las partidas pasada la ventana, con su recuento y sus ids", () => {
    const match = sinRevisar({
      gameId: "800-601",
      finishedAt: HACE_25_H,
      attemptedAt: new Date(HACE_25_H.getTime() + 3_600_000),
    });

    const alerta = de(evaluar({ matches: [match], now: AHORA }), "SUMMARY_NOT_REVIEWED")[0];

    expect(alerta).toMatchObject({
      kind: "STATE_DETECTED",
      count: 1,
      threshold: 1,
      anchorGameId: null,
    });
    expect(alerta?.summary).toBe("1 partida no se ha podido revisar por falta de resumen");
    expect(alerta?.details).toMatchObject({
      unreviewedGameIds: ["800-601"],
      summaryLastAttemptAt: new Date(HACE_25_H.getTime() + 3_600_000).toISOString(),
    });
  });

  it("una partida todavía dentro de la ventana no cuenta: su resumen aún puede llegar", () => {
    const match = sinRevisar({
      gameId: "800-602",
      finishedAt: HACE_23_H,
      attemptedAt: HACE_23_H,
    });

    expect(de(evaluar({ matches: [match], now: AHORA }), "SUMMARY_NOT_REVIEWED")).toHaveLength(0);
  });

  it("una partida que nunca se intentó no avisa: no es que no se pudiera, es que no tocó", () => {
    const match = sinRevisar({ gameId: "800-603", finishedAt: HACE_25_H, attemptedAt: null });

    expect(de(evaluar({ matches: [match], now: AHORA }), "SUMMARY_NOT_REVIEWED")).toHaveLength(0);
  });

  it("una partida con respuesta concluyente no avisa, aunque no tenga métricas", () => {
    // Un 404 es una respuesta: la partida no tiene resumen y eso ya se sabe.
    const match = sinRevisar({
      gameId: "800-604",
      finishedAt: HACE_25_H,
      attemptedAt: HACE_25_H,
      checkedAt: HACE_25_H,
    });

    expect(de(evaluar({ matches: [match], now: AHORA }), "SUMMARY_NOT_REVIEWED")).toHaveLength(0);
  });

  it("una partida con summary no avisa: hay `apm`", () => {
    const match = sinRevisar({
      gameId: "800-605",
      finishedAt: HACE_25_H,
      attemptedAt: HACE_25_H,
      apm: 120,
    });

    expect(de(evaluar({ matches: [match], now: AHORA }), "SUMMARY_NOT_REVIEWED")).toHaveLength(0);
  });

  it("es UNA alerta por jugador, con las partidas de la más reciente a la más antigua", () => {
    const vieja = sinRevisar({
      gameId: "800-606",
      finishedAt: new Date(HACE_25_H.getTime() - 3_600_000),
      attemptedAt: HACE_25_H,
    });
    const nueva = sinRevisar({ gameId: "800-607", finishedAt: HACE_25_H, attemptedAt: HACE_25_H });

    const alertas = de(
      evaluar({ matches: [vieja, nueva], now: AHORA }),
      "SUMMARY_NOT_REVIEWED",
    );

    expect(alertas).toHaveLength(1);
    expect(alertas[0]?.count).toBe(2);
    expect(alertas[0]?.summary).toBe("2 partidas no se han podido revisar por falta de resumen");
    expect(alertas[0]?.details).toMatchObject({ unreviewedGameIds: ["800-607", "800-606"] });
  });

  it("la ventana la decide quien evalúa, no la regla", () => {
    const match = sinRevisar({ gameId: "800-608", finishedAt: HACE_23_H, attemptedAt: HACE_23_H });

    // Con una ventana de 20 h la misma partida ya está fuera de plazo.
    const evaluacion = evaluar({ matches: [match], now: AHORA, summaryReviewWindowMs: 20 * 3_600_000 });

    expect(de(evaluacion, "SUMMARY_NOT_REVIEWED")).toHaveLength(1);
  });
});

describe("idempotencia", () => {
  it("dos evaluaciones de la misma secuencia dan las mismas claves de dedupe", () => {
    // Es lo que hace que `createMany({ skipDuplicates: true })` baste para no
    // duplicar nada: el cron, el panel y el cierre pueden correr a la vez.
    const s = secuencia();
    s.solo({ durationSeconds: 100 });
    s.solo({ durationSeconds: 100 });
    s.conCompanero(3);
    s.cierre();

    const primera = evaluar({ matches: s.partidas() }).alerts.map((a) => a.dedupeKey);
    const segunda = evaluar({ matches: s.partidas() }).alerts.map((a) => a.dedupeKey);

    expect(primera.length).toBeGreaterThan(0);
    expect(segunda).toEqual(primera);
  });

  it("dos alertas distintas nunca comparten clave de dedupe", () => {
    const s = secuencia();
    s.solo({ durationSeconds: 100 });
    s.solo({ durationSeconds: 100 });
    s.solo({ durationSeconds: 100 });
    s.cierre();

    const claves = evaluar({ matches: s.partidas() }).alerts.map((a) => a.dedupeKey);

    expect(claves.length).toBeGreaterThan(1);
    expect(new Set(claves).size).toBe(claves.length);
  });
});
