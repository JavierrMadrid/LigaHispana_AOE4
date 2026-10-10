import { describe, expect, it } from "vitest";

import { computePlayerAlerts, type AlertMatch } from "@/lib/alerts/compute";
import type { LadderCutoffs, LadderCutoffsTable } from "@/lib/alerts/division-cutoffs";
import { DEFAULT_ALERTS_RULESET } from "@/lib/alerts/rules";
import { SUBDIVISION_RANK_LEVELS } from "@/lib/divisions";
import type { ScoringWindow } from "@/lib/ranked-match";

/**
 * El motor de alertas sobre secuencias de partidas escritas a mano.
 *
 * Es un módulo puro —no lee la base ni sale a la red— y por eso se le puede pasar
 * cualquier secuencia y comprobar la regla entera. Lo que se cubre son los bordes
 * que el docblock del módulo declara: el umbral de cada regla, el derecho (`>=`) de
 * R4 y R5, el `null` que degrada en vez de acusar, el tramo que sigue abierto y el
 * cierre de torneo.
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

/**
 * Cortes inventados pero **monótonos y de la misma escala** que la ladder real: se
 * construyen hacia abajo desde `conqueror_3` en pasos de 100, así cada escalón vale
 * exactamente 100 de elo y las cuentas salen a mano. Lo que importa es la
 * aritmética de escalones, no el rating exacto.
 */
function ladder(nombre: string): LadderCutoffs {
  return {
    ladder: nombre,
    derivedAt: VENTANA.from,
    totalCount: 50_000,
    cutoffs: SUBDIVISION_RANK_LEVELS.map((rankLevel, index) => ({
      rankLevel,
      minRating: 3000 - index * 100,
    })),
    requests: 1,
  };
}

const CORTES: LadderCutoffsTable = { rm_team: ladder("rm_team") };

type Raw = { profileId: number | null; name: string; rating: number | null };

/**
 * Payload en la forma en que la API lo manda: equipos anidados, cada entrada
 * envuelta en `{ player: {...} }`. Se escribe a mano y **no** con `normalizeGame`,
 * para que la comprobación mida el motor de alertas y no el normalizador.
 */
function payload(options: {
  indice: number;
  kind: "rm_1v1" | "rm_2v2";
  averageMmr?: number | null;
  averageRating?: number | null;
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
    average_mmr: options.averageMmr ?? null,
    average_rating: options.averageRating ?? null,
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

  return {
    solo(options: {
      durationSeconds?: number | null;
      opponentProfileId?: number | null;
      opponentName?: string | null;
    } = {}): AlertMatch {
      const rival = options.opponentProfileId === undefined ? RIVAL : options.opponentProfileId;
      const nombre = options.opponentName === undefined ? "Rival Fijo" : options.opponentName;
      const partida: AlertMatch = {
        gameId: String(800_000 + indice()),
        mode: "rm_solo",
        opponentProfileId: rival,
        opponentName: nombre,
        startedAt: startedAt(),
        durationSeconds: options.durationSeconds === undefined ? 1800 : options.durationSeconds,
        rawJson: payload({
          indice: indice(),
          kind: "rm_1v1",
          propio: [{ profileId: PERFIL_JUGADOR, name: JUGADOR.name, rating: 1500 }],
          rival: [{ profileId: rival ?? RIVAL, name: nombre ?? "Rival Fijo", rating: 1500 }],
        }),
      };

      partidas.push(partida);

      return partida;
    },

    equipo(options: {
      selfRating?: number | null;
      teammates: Array<[number | null, string, number | null]>;
      /** Media de rating de la partida (`average_rating`), la que compara R5. */
      averageRating?: number | null;
      /**
       * Media de `mmr` (`average_mmr`). El motor **no** la usa para R5; está en el
       * builder para poder comprobar que una partida con un `mmr` disparatado no
       * levanta la alerta.
       */
      averageMmr?: number | null;
    }): AlertMatch {
      const ratingPropio = options.selfRating === undefined ? 1500 : options.selfRating;
      const partida: AlertMatch = {
        gameId: String(800_000 + indice()),
        mode: "rm_team",
        opponentProfileId: RIVAL_2,
        opponentName: "Rival Externo",
        startedAt: startedAt(),
        durationSeconds: 1800,
        rawJson: payload({
          indice: indice(),
          kind: "rm_2v2",
          averageRating: options.averageRating,
          averageMmr: options.averageMmr,
          propio: [
            { profileId: PERFIL_JUGADOR, name: JUGADOR.name, rating: ratingPropio },
            ...options.teammates.map(([profileId, name, rating]) => ({ profileId, name, rating })),
          ],
          rival: [{ profileId: RIVAL_2, name: "Rival Externo", rating: 1500 }],
        }),
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
  cutoffs?: LadderCutoffsTable | null;
  now?: Date;
  window?: ScoringWindow;
}) {
  return computePlayerAlerts({
    player: JUGADOR,
    matches: options.matches,
    ruleset: DEFAULT_ALERTS_RULESET,
    scoring: { modes: ["rm_solo", "rm_team"], window: options.window ?? VENTANA },
    cutoffs: options.cutoffs === undefined ? CORTES : options.cutoffs,
    now: options.now ?? DURANTE,
  });
}

/** Solo las alertas de una regla, que es como se leen los ocho casos. */
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

  it("un compañero sin `profile_id` no es sujeto, pero su elo sigue contando para R4", () => {
    const s = secuencia();
    for (let i = 0; i < 3; i += 1) {
      s.equipo({ teammates: [[null, "Sin id", 2500]] });
    }
    s.cierre();

    const evaluacion = evaluar({ matches: s.partidas() });

    expect(de(evaluacion, "REPEATED_TEAMMATE_STREAK")).toHaveLength(0);
    expect(de(evaluacion, "TEAMMATE_ELO_GAP")).toHaveLength(1);
  });
});

describe("R4 — brecha de elo con un compañero", () => {
  it("el borde son 500 y el derecho es incluido: 499 no avisa y 500 sí", () => {
    const justo = secuencia();
    justo.equipo({ selfRating: 1500, teammates: [[COMPAÑERO, "Compañero", 2000]] });
    justo.cierre();

    const corto = secuencia();
    corto.equipo({ selfRating: 1500, teammates: [[COMPAÑERO, "Compañero", 1999]] });
    corto.cierre();

    expect(de(evaluar({ matches: justo.partidas() }), "TEAMMATE_ELO_GAP")).toHaveLength(1);
    expect(de(evaluar({ matches: corto.partidas() }), "TEAMMATE_ELO_GAP")).toHaveLength(0);
  });

  it("la brecha es en valor absoluto: un compañero muy por debajo también cuenta", () => {
    const s = secuencia();
    s.equipo({ selfRating: 2500, teammates: [[COMPAÑERO, "Compañero", 2000]] });
    s.cierre();

    const alerta = de(evaluar({ matches: s.partidas() }), "TEAMMATE_ELO_GAP")[0];

    expect(alerta?.details.eloGap).toBe(500);
    expect(alerta?.summary).toContain("500 de elo");
  });

  it("con varios compañeros cuenta la mayor brecha de la partida", () => {
    const s = secuencia();
    s.equipo({
      selfRating: 1500,
      teammates: [
        [COMPAÑERO, "Compañero", 1550],
        [COMPAÑERO_2, "Otro", 2100],
      ],
    });
    s.cierre();

    expect(de(evaluar({ matches: s.partidas() }), "TEAMMATE_ELO_GAP")[0]?.details.eloGap).toBe(600);
  });

  it("sin rating propio no hay contra qué comparar, y no es una brecha pequeña", () => {
    const s = secuencia();
    s.equipo({ selfRating: null, teammates: [[COMPAÑERO, "Compañero", 2500]] });
    s.cierre();

    expect(de(evaluar({ matches: s.partidas() }), "TEAMMATE_ELO_GAP")).toHaveLength(0);
  });

  it("sin rating del compañero tampoco hay diferencia que mirar", () => {
    const s = secuencia();
    s.equipo({ selfRating: 1500, teammates: [[COMPAÑERO, "Compañero", null]] });
    s.cierre();

    expect(de(evaluar({ matches: s.partidas() }), "TEAMMATE_ELO_GAP")).toHaveLength(0);
  });

  it("no mira las 1v1", () => {
    const s = secuencia();
    s.contraRival(2);
    s.cierre();

    expect(de(evaluar({ matches: s.partidas() }), "TEAMMATE_ELO_GAP")).toHaveLength(0);
  });
});

describe("R5 — equipo en una división muy distinta", () => {
  /**
   * Los cortes que produce `alerts:cutoffs` contra la `rm_team` real (octubre de
   * 2026): la escala de verdad, no la inventada por pasos de 100. Se escriben a
   * mano para que la comprobación sea pura, y son los que hacen que los números
   * reales de la regresión caigan donde caen en producción.
   */
  function ladderReal(): LadderCutoffs {
    const minRating: Record<string, number> = {
      conqueror_3: 1600,
      conqueror_2: 1500,
      conqueror_1: 1400,
      diamond_3: 1350,
      diamond_2: 1300,
      diamond_1: 1200,
      platinum_3: 1150,
      platinum_2: 1100,
      platinum_1: 1000,
      gold_3: 900,
      gold_2: 800,
      gold_1: 700,
      silver_3: 650,
      silver_2: 600,
      silver_1: 500,
      bronze_3: 450,
      bronze_2: 400,
      bronze_1: 0,
    };

    return {
      ladder: "rm_team",
      derivedAt: VENTANA.from,
      totalCount: 56_844,
      cutoffs: SUBDIVISION_RANK_LEVELS.map((rankLevel) => ({
        rankLevel,
        minRating: minRating[rankLevel] ?? 0,
      })),
      requests: 1,
    };
  }

  it("tres escalones avisan y dos no, comparando el rating del jugador con la media de rating", () => {
    // El índice **crece al bajar**, así que el flag sale con
    // `abs(indicePartida - indiceJugador) >= 3`: un jugador `gold_3` (2100) en una
    // partida de media `silver_3` (1800) son tres, mientras que con `gold_1`
    // (1900) son dos.
    const tres = secuencia();
    tres.equipo({ selfRating: 2100, averageRating: 1800, teammates: [[COMPAÑERO, "Compañero", 1500]] });
    tres.cierre();

    const dos = secuencia();
    dos.equipo({ selfRating: 2100, averageRating: 1900, teammates: [[COMPAÑERO, "Compañero", 1500]] });
    dos.cierre();

    expect(de(evaluar({ matches: tres.partidas() }), "LOW_DIVISION_TEAM_GAME")).toHaveLength(1);
    expect(de(evaluar({ matches: dos.partidas() }), "LOW_DIVISION_TEAM_GAME")).toHaveLength(0);
  });

  it("avisa en las dos direcciones: una partida muy por encima también cuenta", () => {
    const s = secuencia();
    s.equipo({ selfRating: 1500, averageRating: 2100, teammates: [[COMPAÑERO, "Compañero", 1500]] });
    s.cierre();

    const alerta = de(evaluar({ matches: s.partidas() }), "LOW_DIVISION_TEAM_GAME")[0];

    expect(alerta?.details.steps).toBe(-6);
    expect(alerta?.summary).toContain("por encima");
  });

  it("el detalle lleva los dos lados de la cuenta y la media de rating, no el mmr", () => {
    const s = secuencia();
    s.equipo({
      selfRating: 2100,
      averageRating: 1500,
      averageMmr: 9999,
      teammates: [[COMPAÑERO, "Compañero", 1500]],
    });
    s.cierre();

    const alerta = de(evaluar({ matches: s.partidas() }), "LOW_DIVISION_TEAM_GAME")[0];

    // El `average_mmr` de 9999 no aparece: la partida se tradujo con su
    // `average_rating`, que es la escala de los cortes.
    expect(alerta?.details).toMatchObject({
      selfRating: 2100,
      averageRating: 1500,
      gameSubdivision: "bronze_3",
      playerSubdivision: "gold_3",
    });
    expect(alerta?.details).not.toHaveProperty("averageMmr");
    expect(alerta?.details.steps).toBe(6);
  });

  it("los números reales de arribas94 no son una alerta: rating con rating, no con mmr", () => {
    // Partida 252055272: `self.rating` 727, `average_rating` 851 (rating) frente a
    // `self.mmr` 1212 y `average_mmr` 1254. Con los cortes reales, 727 es `gold_1` y
    // 851 `gold_2`: **un** escalón, por debajo del umbral de tres. Con la comparación
    // vieja (727 contra el `average_mmr` de 1254, que cae en `diamond_1`) el desfase
    // era de seis escalones: era la escala del `mmr`, no la del rating.
    const s = secuencia();
    s.equipo({
      selfRating: 727,
      averageRating: 851,
      averageMmr: 1254,
      teammates: [[COMPAÑERO, "Compañero", 700]],
    });
    s.cierre();

    const evaluacion = evaluar({ matches: s.partidas(), cutoffs: { rm_team: ladderReal() } });

    expect(de(evaluacion, "LOW_DIVISION_TEAM_GAME")).toHaveLength(0);
    // La partida se ha podido leer: la ausencia de alerta es del cálculo, no de un
    // `rawJson` roto.
    expect(evaluacion.unreadableMatches).toBe(0);
  });

  it("la misma partida con la media de rating muy por debajo sí avisa", () => {
    const s = secuencia();
    s.equipo({
      selfRating: 727,
      averageRating: 500,
      averageMmr: 500,
      teammates: [[COMPAÑERO, "Compañero", 700]],
    });
    s.cierre();

    const alerta = de(
      evaluar({ matches: s.partidas(), cutoffs: { rm_team: ladderReal() } }),
      "LOW_DIVISION_TEAM_GAME",
    )[0];

    // 727 es `gold_1` (índice 11) y 500 `silver_1` (índice 14): tres escalones por
    // debajo, justo el borde del umbral.
    expect(alerta?.details.steps).toBe(3);
  });

  it("busca los cortes por la familia (`rm_team`), no por el literal de la partida", () => {
    // Las dos magnitudes que se comparan son rating de la familia de equipos:
    // traducirlas con los cortes de otra daría escalones que no existen. La
    // búsqueda va por `match.mode`, así que unos cortes solo de `rm_solo` no
    // sirven para una partida de equipo aunque su `leaderboard` literal fuera
    // `rm_2v2` (que es justo el caso que la familia resuelve).
    const s = secuencia();
    s.equipo({ selfRating: 2100, averageRating: 1500, teammates: [[COMPAÑERO, "Compañero", 1500]] });
    s.cierre();

    const soloCortes: LadderCutoffsTable = { rm_solo: ladder("rm_solo") };

    expect(de(evaluar({ matches: s.partidas() }), "LOW_DIVISION_TEAM_GAME")).toHaveLength(1);
    expect(
      de(evaluar({ matches: s.partidas(), cutoffs: soloCortes }), "LOW_DIVISION_TEAM_GAME"),
    ).toHaveLength(0);
  });

  it("sin la media de rating de la partida se salta sin avisar: es un hueco de datos", () => {
    const s = secuencia();
    s.equipo({ selfRating: 2100, averageRating: null, teammates: [[COMPAÑERO, "Compañero", 1500]] });
    s.cierre();

    const evaluacion = evaluar({ matches: s.partidas() });

    expect(de(evaluacion, "LOW_DIVISION_TEAM_GAME")).toHaveLength(0);
    expect(evaluacion.unreadableMatches).toBe(0);
  });

  it("sin el rating del jugador en la partida se salta sin avisar: es un hueco de datos", () => {
    const s = secuencia();
    s.equipo({ selfRating: null, averageRating: 1500, teammates: [[COMPAÑERO, "Compañero", 1500]] });
    s.cierre();

    const evaluacion = evaluar({ matches: s.partidas() });

    expect(de(evaluacion, "LOW_DIVISION_TEAM_GAME")).toHaveLength(0);
    expect(evaluacion.unreadableMatches).toBe(0);
  });

  it("sin cortes cacheados la regla se omite entera, con aviso de la evaluación", () => {
    const s = secuencia();
    s.equipo({ selfRating: 2100, averageRating: 1000, teammates: [[COMPAÑERO, "Compañero", 1500]] });
    s.cierre();

    const evaluacion = evaluar({ matches: s.partidas(), cutoffs: null });

    expect(de(evaluacion, "LOW_DIVISION_TEAM_GAME")).toHaveLength(0);
    // Lo dice aunque no haya ninguna partida de equipo: quien lee el resumen tiene
    // que saber que hay una regla sin evaluar, no deducirlo de que no salió.
    expect(evaluacion.globalWarnings.some((w) => w.includes("R5"))).toBe(true);
  });
});

describe("rachas abiertas y cierre de torneo", () => {
  it("un tramo que llega al final de la secuencia no avisa todavía", () => {
    // R4 y R5 tienen umbral 1, así que su única partida con el flag es el último
    // tramo de la secuencia: avisa cuando llega la siguiente clasificatoria.
    const s = secuencia();
    const partida = s.equipo({
      selfRating: 1500,
      teammates: [[COMPAÑERO, "Compañero", 2100]],
    });

    const evaluacion = evaluar({ matches: s.partidas() });

    expect(evaluacion.alerts).toHaveLength(0);
    expect(evaluacion.openStreaks).toHaveLength(1);
    expect(evaluacion.openStreaks[0]).toMatchObject({
      rule: "TEAMMATE_ELO_GAP",
      count: 1,
      threshold: 1,
      lastGameId: partida.gameId,
    });
  });

  it("con el torneo ya terminado el mismo tramo se avisa por fin de torneo", () => {
    // Sin este caso, una racha que acaba con la última partida del torneo no se
    // avisaría nunca.
    const s = secuencia();
    s.equipo({ selfRating: 1500, teammates: [[COMPAÑERO, "Compañero", 2100]] });

    const evaluacion = evaluar({ matches: s.partidas(), now: DESPUES });

    expect(de(evaluacion, "TEAMMATE_ELO_GAP")[0]?.kind).toBe("STREAK_AT_TOURNAMENT_END");
    expect(evaluacion.closedAtTournamentEnd).toBe(1);
  });

  it("con la ventana abierta por la derecha el torneo no se cierra nunca", () => {
    const s = secuencia();
    s.equipo({ selfRating: 1500, teammates: [[COMPAÑERO, "Compañero", 2100]] });

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
    s.equipo({ selfRating: 1500, teammates: [[COMPAÑERO, "Compañero", 2100]] });
    s.cierre();

    const evaluacion = evaluar({ matches: s.partidas(), now: DESPUES });

    expect(de(evaluacion, "TEAMMATE_ELO_GAP")[0]?.kind).toBe("STREAK_CLOSED");
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
    };
    const s = secuencia();
    s.conCompanero(2);
    s.cierre();

    const evaluacion = evaluar({ matches: [rota, ...s.partidas()] });

    // R3 exige 3 y solo hay 2 legibles: no se acusa a nadie de una secuencia que no
    // se pudo leer entera.
    expect(de(evaluacion, "REPEATED_TEAMMATE_STREAK")).toHaveLength(0);
    // R3, R4 y R5 releen el payload por su cuenta, así que una partida ilegible se
    // cuenta una vez por cada regla de equipo que la habría mirado.
    expect(evaluacion.unreadableMatches).toBe(3);
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
    };

    expect(evaluar({ matches: [rota] }).unreadableMatches).toBe(0);
  });
});

describe("idempotencia", () => {
  it("dos evaluaciones de la misma secuencia dan las mismas claves de dedupe", () => {
    // Es lo que hace que `createMany({ skipDuplicates: true })` baste para no
    // duplicar nada: el cron, el panel y el cierre pueden correr a la vez.
    const s = secuencia();
    s.solo({ durationSeconds: 100 });
    s.solo({ durationSeconds: 100 });
    s.equipo({ selfRating: 1500, teammates: [[COMPAÑERO, "Compañero", 2100]] });
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
