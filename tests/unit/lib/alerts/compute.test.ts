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
      teammates: Array<[number | null, string, number | null]>;
    }): AlertMatch {
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
          propio: [
            { profileId: PERFIL_JUGADOR, name: JUGADOR.name, rating: 1500 },
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
  now?: Date;
  window?: ScoringWindow;
}) {
  return computePlayerAlerts({
    player: JUGADOR,
    matches: options.matches,
    ruleset: DEFAULT_ALERTS_RULESET,
    scoring: { modes: ["rm_solo", "rm_team"], window: options.window ?? VENTANA },
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
