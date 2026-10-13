import { describe, expect, it } from "vitest";

import { MatchResult } from "@/generated/prisma/enums";
import { OBJECTIVE_COUNT, OBJECTIVE_POINTS } from "@/lib/objectives";
import {
  DEFAULT_RULESET,
  LEGACY_RULESET_VERSION,
  RULESET_VERSION,
  SCORING_RULESET_KEY,
  compareStandings,
  countsAsRanked,
  mergeRuleset,
  rankApprovedPlayers,
  ruleLabel,
  type AggregatedRow,
  type ScoringRuleset,
  type ScoringWindow,
} from "@/lib/scoring";
import type { TeamTierContext } from "@/lib/ranked-match";

/**
 * El motor de puntos, en lo que se puede comprobar sin base de datos.
 *
 * `recomputeScores()` es una transacción de Prisma y aquí no se puede ejecutar, así
 * que lo que se prueba es lo que la rodea y es puro: el ruleset con el que arranca
 * el motor (`mergeRuleset`) y la regla de qué cuenta como partida clasificatoria
 * (`countsAsRanked`, que `scoring.ts` reexporta de `ranked-match.ts`).
 *
 * Un ruleset mal escrito no puede tumbar el torneo, y ese es exactamente el
 * motivo de que `mergeRuleset` avise en vez de lanzar: cada rama de `warnings`
 * que aparece abajo es una forma de romperlo que alguien podría dejar pasar por
 * un `Setting` editado a mano.
 */

/** Ventana de las comprobaciones; la de `DEFAULT_RULESET` es la misma. */
const VENTANA: ScoringWindow = {
  from: "2026-09-15T00:00:00.000Z",
  to: "2026-10-15T00:00:00.000Z",
};

/** Documento guardado mínimo y válido: solo la versión. */
const VALIDO = { version: RULESET_VERSION };

function partida(overrides: Partial<Parameters<typeof countsAsRanked>[0]> = {}) {
  return {
    mode: "rm_solo",
    result: MatchResult.WIN,
    startedAt: new Date("2026-09-20T12:00:00.000Z"),
    finishedAt: new Date("2026-09-20T12:30:00.000Z"),
    revertedAt: null,
    ...overrides,
  };
}

describe("reglas v4 (constantes del motor)", () => {
  it("el ruleset por defecto es el de la versión que declara el código", () => {
    expect(DEFAULT_RULESET.version).toBe(RULESET_VERSION);
    expect(RULESET_VERSION).toBe(4);
    expect(LEGACY_RULESET_VERSION).toBe(3);
    expect(SCORING_RULESET_KEY).toBe("scoring.ruleset");
  });

  it("el catálogo arranca completo: ningún objetivo desactivado", () => {
    expect(DEFAULT_RULESET.disabledObjectives).toEqual([]);
  });

  it("la etiqueta por defecto es la que calcula `ruleLabel()`", () => {
    // Ya no es una constante: sale de los puntos por victoria y de los objetivos
    // activos, así que el texto guardado y el del código no pueden divergir.
    expect(DEFAULT_RULESET.label).toBe(ruleLabel(DEFAULT_RULESET));
    expect(DEFAULT_RULESET.label).toContain("2 puntos por victoria clasificatoria");
    expect(DEFAULT_RULESET.label).toContain(`más ${OBJECTIVE_COUNT} objetivos`);
  });

  it("las familias por defecto son las dos ladders ranked", () => {
    // `mode` colapsa 2v2, 3v3 y 4v4 en `rm_team`, así que son dos, no cuatro.
    expect(DEFAULT_RULESET.modes).toEqual(["rm_solo", "rm_team"]);
  });

  it("los valores por defecto son los acordados", () => {
    expect(DEFAULT_RULESET.pointsPerWin).toBe(2);
    // Por defecto la civ aleatoria no cuenta: no dice nada de la civilización de
    // nadie, así que no puede contar para los objetivos de civilización.
    expect(DEFAULT_RULESET.countRandomizedCivs).toBe(false);
  });

  it("el catálogo sigue siendo el de 82 objetivos de docs/OBJETIVOS.md", () => {
    expect(OBJECTIVE_COUNT).toBe(82);
    // El desglose de `PlayerScore` y `Setting["scoring.ruleset"].objectives` se
    // indexan por id, así que un objetivo sin puntos o con un id repetido
    // desaparecería de la clasificación sin que nada fallara.
    expect(Object.keys(OBJECTIVE_POINTS)).toHaveLength(OBJECTIVE_COUNT);
    expect(DEFAULT_RULESET.objectives).toEqual(OBJECTIVE_POINTS);
    for (const [id, points] of Object.entries(OBJECTIVE_POINTS)) {
      expect(points, `puntos del objetivo ${id}`).toBeGreaterThan(0);
    }
  });
});

describe("mergeRuleset: lo que se puede reconfigurar", () => {
  it("con un documento válido sin más campos se queda en los valores por defecto", () => {
    const { ruleset, warnings } = mergeRuleset(VALIDO);

    expect(warnings).toEqual([]);
    expect(ruleset).toEqual(DEFAULT_RULESET);
  });

  it("el documento por defecto se puede volver a guardar sin avisos", () => {
    // Es lo que pasa cada vez que `recomputeScores()` publica el ruleset: si el
    // documento por defecto se rechazara a sí mismo, el motor avisaría en cada
    // recálculo sin que nadie hubiera tocado nada.
    const { ruleset, warnings } = mergeRuleset(DEFAULT_RULESET);

    expect(warnings).toEqual([]);
    expect(ruleset).toEqual(DEFAULT_RULESET);
  });

  it("aplica los puntos por victoria", () => {
    const { ruleset, warnings } = mergeRuleset({
      ...VALIDO,
      pointsPerWin: 12,
    });

    expect(warnings).toEqual([]);
    expect(ruleset.pointsPerWin).toBe(12);
  });

  it("aplica la lista de familias del ruleset", () => {
    const { ruleset, warnings } = mergeRuleset({
      ...VALIDO,
      modes: ["rm_solo", "rm_team", "custom_1v1"],
    });

    expect(warnings).toEqual([]);
    expect(ruleset.modes).toEqual(["rm_solo", "rm_team", "custom_1v1"]);
  });

  it("aplica la ventana del torneo y la normaliza a ISO UTC", () => {
    const { ruleset, warnings } = mergeRuleset({
      ...VALIDO,
      window: { from: "2026-11-01T01:00:00+01:00", to: null },
    });

    expect(warnings).toEqual([]);
    // El mismo instante que se escribió, en UTC: la frontera no puede depender de
    // la zona desde la que se mire el `Setting`.
    expect(ruleset.window).toEqual({ from: "2026-11-01T00:00:00.000Z", to: null });
  });

  it("aplica la civ aleatoria cuando el documento dice que sí", () => {
    const { ruleset, warnings } = mergeRuleset({ ...VALIDO, countRandomizedCivs: true });

    expect(warnings).toEqual([]);
    expect(ruleset.countRandomizedCivs).toBe(true);
  });

  it("aplica los puntos de un objetivo existente por su id", () => {
    const { ruleset, warnings } = mergeRuleset({
      ...VALIDO,
      objectives: { "loco-por-ganar": 90 },
    });

    expect(warnings).toEqual([]);
    expect(ruleset.objectives["loco-por-ganar"]).toBe(90);
    // El resto del catálogo no se toca.
    expect(ruleset.objectives["bienhadado"]).toBe(
      DEFAULT_RULESET.objectives["bienhadado"],
    );
  });
});

describe("mergeRuleset: lo que se rechaza, siempre con aviso", () => {
  it("un valor que no es un objeto se descarta entero", () => {
    for (const guardado of [null, undefined, 3, "scoring.ruleset", [], true]) {
      const { ruleset, warnings } = mergeRuleset(guardado);

      expect(ruleset).toEqual(DEFAULT_RULESET);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("no es un objeto");
    }
  });

  it("una versión distinta invalida el documento entero, no campo a campo", () => {
    // El motivo está en el docblock: un documento de otra versión puede describir
    // otra estructura, así que aplicar "lo que se parezca" sería peor que usar los
    // valores por defecto y decirlo.
    const { ruleset, warnings } = mergeRuleset({
      version: RULESET_VERSION + 1,
      pointsPerWin: 99,
      modes: ["custom_1v1"],
      objectives: { "loco-por-ganar": 1 },
    });

    expect(ruleset).toEqual(DEFAULT_RULESET);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("se ignoran las reglas guardadas");
  });

  it("una versión ausente también invalida el documento", () => {
    const { ruleset, warnings } = mergeRuleset({ pointsPerWin: 99 });

    expect(ruleset).toEqual(DEFAULT_RULESET);
    expect(warnings.some((w) => w.includes(`no es ${RULESET_VERSION}`))).toBe(true);
  });

  it("la etiqueta la calcula el código, no el documento guardado", () => {
    // Es texto de producto y aparece en la interfaz: un `label` guardado que
    // describiera otra versión de las reglas haría que `/objetivos` mintiera.
    const { ruleset, warnings } = mergeRuleset({ ...VALIDO, label: "10 puntos por ganar" });

    expect(ruleset.label).toBe(ruleLabel(DEFAULT_RULESET));
    expect(warnings.some((w) => w.startsWith("label se ignora"))).toBe(true);
  });

  it("un entero positivo es lo único que se aplica en `pointsPerWin`", () => {
    for (const malo of [0, -10, 1.5, "10", null, Number.NaN]) {
      const { ruleset, warnings } = mergeRuleset({ ...VALIDO, pointsPerWin: malo });

      expect(ruleset.pointsPerWin).toBe(DEFAULT_RULESET.pointsPerWin);
      expect(warnings.some((w) => w.startsWith("pointsPerWin"))).toBe(true);
    }
  });

  it("una lista de familias vacía o mal formada se descarta", () => {
    for (const malo of [[], "rm_solo", ["rm_solo", 3], ["RM_Solo"], ["con guion"], null]) {
      const { ruleset, warnings } = mergeRuleset({ ...VALIDO, modes: malo });

      expect(ruleset.modes).toEqual(DEFAULT_RULESET.modes);
      expect(warnings.some((w) => w.startsWith("modes"))).toBe(true);
    }
  });

  it("`countRandomizedCivs` que no es booleano se descarta", () => {
    const { ruleset, warnings } = mergeRuleset({ ...VALIDO, countRandomizedCivs: "true" });

    expect(ruleset.countRandomizedCivs).toBe(false);
    expect(warnings).toContain("countRandomizedCivs no es un booleano");
  });

  it("los puntos de un objetivo que no existe se ignoran sin tumbar el resto", () => {
    const id = "objetivo-inventado";
    const { ruleset, warnings } = mergeRuleset({
      ...VALIDO,
      objectives: { [id]: 50, "loco-por-ganar": 90 },
    });

    expect(ruleset.objectives["loco-por-ganar"]).toBe(90);
    expect(ruleset.objectives[id]).toBeUndefined();
    expect(warnings.some((w) => w.includes("no existe"))).toBe(true);
  });

  it("los puntos de un objetivo que no son un entero positivo se ignoran", () => {
    const { ruleset, warnings } = mergeRuleset({
      ...VALIDO,
      objectives: { "loco-por-ganar": -1 },
    });

    expect(ruleset.objectives["loco-por-ganar"]).toBe(
      DEFAULT_RULESET.objectives["loco-por-ganar"],
    );
    expect(warnings.some((w) => w.includes('objectives["loco-por-ganar"]'))).toBe(true);
  });

  it("`objectives` que no es un objeto se descarta entero", () => {
    const { ruleset, warnings } = mergeRuleset({ ...VALIDO, objectives: [90] });

    expect(ruleset.objectives).toEqual(DEFAULT_RULESET.objectives);
    expect(warnings).toContain("objectives no es un objeto");
  });
});

describe("mergeRuleset: la ventana se valida como ventana", () => {
  it("una ventana sin `from` se descarta entera", () => {
    const { ruleset, warnings } = mergeRuleset({ ...VALIDO, window: { to: null } });

    expect(ruleset.window).toEqual(DEFAULT_RULESET.window);
    expect(warnings.some((w) => w.includes("window.from"))).toBe(true);
  });

  it("una ventana con `to` anterior al `from` se descarta entera", () => {
    // No puntuaría ninguna partida, y eso es un error de configuración, no una
    // decisión: por eso no se aplica "a medias" con el `from` bueno.
    const { ruleset, warnings } = mergeRuleset({
      ...VALIDO,
      window: { from: "2026-10-15T00:00:00Z", to: "2026-09-15T00:00:00Z" },
    });

    expect(ruleset.window).toEqual(DEFAULT_RULESET.window);
    expect(warnings.some((w) => w.includes("no puntuaría nada"))).toBe(true);
  });

  it("un `to` que no viene se hereda del documento por defecto, con aviso", () => {
    // Abrir la ventana hay que pedirlo escribiendo `null`, no por olvidarse la clave.
    const { ruleset, warnings } = mergeRuleset({
      ...VALIDO,
      window: { from: "2026-11-01T00:00:00Z" },
    });

    expect(ruleset.window.to).toBe(DEFAULT_RULESET.window.to);
    expect(warnings.some((w) => w.includes("escribe null"))).toBe(true);
  });
});

describe("mergeRuleset: no toca el documento por defecto", () => {
  it("fusionar un documento muy distinto deja `DEFAULT_RULESET` intacto", () => {
    // `defaultRuleset()` clona a mano por esto: `DEFAULT_RULESET` es un objeto
    // exportado y compartido, y una fusión que lo modificara dejaría al motor con
    // un ruleset distinto del que dice el código para el resto de la ejecución.
    const antes = structuredClone(DEFAULT_RULESET);

    mergeRuleset({
      ...VALIDO,
      pointsPerWin: 99,
      modes: ["custom_1v1"],
      window: { from: "2027-01-01T00:00:00Z", to: null },
      countRandomizedCivs: true,
      objectives: { "loco-por-ganar": 1 },
    });

    expect(DEFAULT_RULESET).toEqual(antes);
  });

  it("dos fusiones del mismo documento dan rulesets iguales", () => {
    const guardado = {
      ...VALIDO,
      pointsPerWin: 15,
      objectives: { "bienhadado": 75, "loco-por-ganar": 80 },
    };

    expect(mergeRuleset(guardado).ruleset).toEqual(mergeRuleset(guardado).ruleset);
  });
});

describe("mergeRuleset: la migración v3 → v4", () => {
  /**
   * Documento v3 tal y como está hoy en producción: los mismos campos que la v4 salvo
   * `disabledObjectives`, que en la v3 no existe.
   */
  const V3 = {
    version: LEGACY_RULESET_VERSION,
    label: "2 puntos por victoria clasificatoria más 82 objetivos: 29 competiciones y 53 logros",
    modes: ["rm_solo"],
    window: { from: "2026-09-15T00:00:00.000Z", to: "2026-10-15T00:00:00.000Z" },
    pointsPerWin: 3,
    countRandomizedCivs: true,
    objectives: { "loco-por-ganar": 90 },
  };

  it("un documento v3 se migra en vez de descartarse", () => {
    const { ruleset, warnings } = mergeRuleset(V3);

    expect(ruleset.version).toBe(RULESET_VERSION);
    expect(ruleset.pointsPerWin).toBe(3);
    expect(ruleset.modes).toEqual(["rm_solo"]);
    expect(ruleset.countRandomizedCivs).toBe(true);
    expect(ruleset.objectives["loco-por-ganar"]).toBe(90);
    expect(ruleset.disabledObjectives).toEqual([]);
    expect(warnings.some((w) => w.includes("se migran"))).toBe(true);
  });

  it("el documento migrado lleva la etiqueta recalculada, no la guardada", () => {
    // La etiqueta de la v3 se escribió cuando el catálogo entero estaba activo: si se
    // copiara tal cual, el motor anunciaría unos objetivos que ya no son los suyos.
    const { ruleset } = mergeRuleset(V3);

    expect(ruleset.label).toBe(ruleLabel(ruleset));
    expect(ruleset.label).not.toBe(V3.label);
  });

  it("el documento migrado se puede volver a guardar sin avisos", () => {
    // Es la propiedad de la que depende `ensureRuleset()`: publica una vez el
    // documento migrado y, a partir de ahí, ni avisa en cada lectura ni lo reescribe.
    const migrado = mergeRuleset(V3).ruleset;
    const segunda = mergeRuleset(migrado);

    expect(segunda.warnings).toEqual([]);
    expect(segunda.ruleset).toEqual(migrado);
  });

  it("una versión más antigua o futura sigue descartándose entera", () => {
    for (const version of [1, 2, 5, 99]) {
      const { ruleset, warnings } = mergeRuleset({ ...V3, version });

      expect(ruleset).toEqual(DEFAULT_RULESET);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("se ignoran las reglas guardadas");
    }
  });
});

describe("mergeRuleset: los objetivos desactivados", () => {
  it("aplica la lista y recalcula la etiqueta con los que quedan", () => {
    const { ruleset, warnings } = mergeRuleset({
      ...VALIDO,
      disabledObjectives: ["loco-por-ganar", "rey-1v1"],
    });

    expect(warnings).toEqual([]);
    expect(ruleset.disabledObjectives).toEqual(["loco-por-ganar", "rey-1v1"]);
    expect(ruleset.label).toContain(`más ${OBJECTIVE_COUNT - 2} objetivos`);
  });

  it("un id que no está en el catálogo se avisa y se ignora, sin tumbar el resto", () => {
    const { ruleset, warnings } = mergeRuleset({
      ...VALIDO,
      disabledObjectives: ["objetivo-inventado", "rey-1v1"],
    });

    expect(ruleset.disabledObjectives).toEqual(["rey-1v1"]);
    expect(warnings.some((w) => w.includes("objetivo-inventado"))).toBe(true);
  });

  it("un id repetido cuenta una sola vez", () => {
    const { ruleset, warnings } = mergeRuleset({
      ...VALIDO,
      disabledObjectives: ["rey-1v1", "rey-1v1"],
    });

    expect(ruleset.disabledObjectives).toEqual(["rey-1v1"]);
    expect(warnings.some((w) => w.includes("repetido"))).toBe(true);
  });

  it("lo que no es una lista se descarta entero", () => {
    for (const malo of ["rey-1v1", 3, { "rey-1v1": true }, null]) {
      const { ruleset, warnings } = mergeRuleset({ ...VALIDO, disabledObjectives: malo });

      expect(ruleset.disabledObjectives).toEqual([]);
      expect(warnings.some((w) => w.startsWith("disabledObjectives"))).toBe(true);
    }
  });

  it("un documento sin el campo deja el catálogo completo activo", () => {
    const { ruleset, warnings } = mergeRuleset(VALIDO);

    expect(ruleset.disabledObjectives).toEqual([]);
    expect(warnings).toEqual([]);
  });
});

describe("ruleLabel", () => {
  const base: Pick<ScoringRuleset, "pointsPerWin" | "disabledObjectives"> = {
    pointsPerWin: 2,
    disabledObjectives: [],
  };

  it("cuenta los objetivos activos por forma de cobrar", () => {
    // 29 competiciones (loco-por-ganar, bienhadado, los 4 rey-* y los 23 masterizando-*)
    // y 53 logros: es el reparto de `docs/OBJETIVOS.md`, y la etiqueta lo dice.
    expect(ruleLabel(base)).toBe(
      "2 puntos por victoria clasificatoria más 82 objetivos: 29 competiciones y 53 logros",
    );
  });

  it("un objetivo desactivado deja de anunciarse", () => {
    expect(ruleLabel({ ...base, disabledObjectives: ["rey-1v1"] })).toBe(
      "2 puntos por victoria clasificatoria más 81 objetivos: 28 competiciones y 53 logros",
    );
  });

  it("los puntos por victoria van en singular cuando son uno", () => {
    expect(ruleLabel({ ...base, pointsPerWin: 1 })).toContain("1 punto por victoria clasificatoria");
  });

  it("con todo el catálogo apagado no anuncia objetivos", () => {
    expect(ruleLabel({ ...base, disabledObjectives: Object.keys(OBJECTIVE_POINTS) })).toBe(
      "2 puntos por victoria clasificatoria, sin objetivos",
    );
  });

  it("es puro: no toca el documento por defecto", () => {
    const antes = structuredClone(DEFAULT_RULESET);

    ruleLabel({ ...base, disabledObjectives: ["rey-1v1", "loco-por-ganar"] });

    expect(DEFAULT_RULESET).toEqual(antes);
  });
});

describe("desempate de la clasificación", () => {
  const fila = (profileId: number, total: number, wins: number, matches: number) => ({
    profileId,
    total,
    wins,
    matches,
  });

  const orden = (filas: ReturnType<typeof fila>[]) =>
    [...filas].sort(compareStandings).map((f) => f.profileId);

  it("ordena por total descendente", () => {
    expect(orden([fila(3, 10, 2, 8), fila(1, 20, 1, 9), fila(2, 5, 5, 9)])).toEqual([1, 3, 2]);
  });

  it("a igual total decide la tasa de victorias, y va antes que las victorias", () => {
    // 3/4 (0,75) por delante de 4/6 (0,67): el segundo gana más partidas y aun así
    // queda detrás. Es el cambio de orden de la regla: antes decidían las
    // victorias y ganaba el de 4.
    expect(orden([fila(2, 10, 4, 6), fila(1, 10, 3, 4)])).toEqual([1, 2]);
  });

  it("a igual total y tasa deciden las victorias", () => {
    // Las dos tasas son 0,5: 3/6 frente a 2/4.
    expect(orden([fila(2, 10, 2, 4), fila(1, 10, 3, 6)])).toEqual([1, 2]);
  });

  it("a igual total, tasa y victorias deciden las partidas jugadas", () => {
    // Dos con 0 victorias: la tasa empata (0) y gana quien más partidas jugó.
    expect(orden([fila(2, 0, 0, 0), fila(5, 0, 0, 4)])).toEqual([5, 2]);
  });

  it("la tasa va antes que `profileId`: gana el mejor ratio aunque tenga id mayor", () => {
    expect(orden([fila(1, 10, 3, 5), fila(9, 10, 3, 4)])).toEqual([9, 1]);
  });

  it("misma tupla: el comparador cierra en `profileId`", () => {
    // Con los mismos números el comparador no distingue —en la clasificación
    // comparten puesto—, así que el orden de presentación lo fija `profileId`.
    expect(orden([fila(2, 10, 3, 5), fila(1, 10, 3, 5)])).toEqual([1, 2]);
  });

  it("con `matches` 0 el comparador no produce `NaN`", () => {
    // Un aprobado sin partidas tiene fila con `matches` 0. El producto cruzado vale
    // 0 —no `NaN`, que ordenaría de forma no determinista—, así que la tupla
    // empata y el orden lo cierra `profileId`.
    const sinPartidas = fila(5, 0, 0, 0);
    const otraSinPartidas = fila(2, 0, 0, 0);

    expect(compareStandings(sinPartidas, otraSinPartidas)).toBe(3);
    expect(orden([sinPartidas, otraSinPartidas])).toEqual([2, 5]);
  });
});

describe("rankApprovedPlayers: todos los aprobados tienen fila", () => {
  /** Agregado de ejemplo; por defecto, un jugador sin partidas. */
  function agregado(overrides: Partial<AggregatedRow> = {}): AggregatedRow {
    return { matchPoints: 0, wins: 0, matches: 0, byMode: {}, ...overrides };
  }

  const byModeCero = {
    rm_solo: { wins: 0, points: 0, matches: 0 },
    rm_team: { wins: 0, points: 0, matches: 0 },
  };

  it("un aprobado sin partidas sale con todo a cero, en el último puesto", () => {
    // Es la regla nueva: un aprobado sin ninguna clasificatoria ya no desaparece de
    // la tabla, y su desglose lleva las familias con ceros para que quien lo lea no
    // tenga que tratar un objeto que puede faltar.
    const filas = rankApprovedPlayers(
      [
        { id: "a", profileId: 1 },
        { id: "b", profileId: 2 },
      ],
      new Map([["b", agregado({ matchPoints: 6, wins: 3, matches: 4 })]]),
      new Map(),
      DEFAULT_RULESET,
    );

    expect(filas).toHaveLength(2);
    expect(filas[1]).toEqual({
      playerId: "a",
      profileId: 1,
      total: 0,
      wins: 0,
      matches: 0,
      byMode: byModeCero,
      objectives: { points: 0, earned: [] },
      rank: 2,
    });
    expect(filas[0].playerId).toBe("b");
    expect(filas[0].rank).toBe(1);
  });

  it("nadie se pierde: hay una fila por cada aprobado", () => {
    const players = [
      { id: "a", profileId: 11 },
      { id: "b", profileId: 22 },
      { id: "c", profileId: 33 },
    ];

    const filas = rankApprovedPlayers(
      players,
      new Map([["b", agregado({ matchPoints: 2, wins: 1, matches: 1 })]]),
      new Map(),
      DEFAULT_RULESET,
    );

    expect(filas.map((f) => f.profileId).sort((x, y) => x - y)).toEqual([11, 22, 33]);
  });

  it("sin empates los puestos son 1..N", () => {
    const filas = rankApprovedPlayers(
      [
        { id: "a", profileId: 1 },
        { id: "b", profileId: 2 },
        { id: "c", profileId: 3 },
      ],
      new Map([
        ["c", agregado({ matchPoints: 4, wins: 2, matches: 2 })],
        ["b", agregado({ matchPoints: 2, wins: 1, matches: 3 })],
      ]),
      new Map(),
      DEFAULT_RULESET,
    );

    expect(filas.map((f) => f.playerId)).toEqual(["c", "b", "a"]);
    expect(filas.map((f) => f.rank)).toEqual([1, 2, 3]);
  });

  it("los empates comparten puesto y se saltan el hueco (1, 2, 2, 4)", () => {
    // `b` y `c` tienen la misma tupla (mismo total, misma tasa, mismas victorias y
    // mismas partidas), así que comparten el puesto 2 y el 3 queda vacío.
    const filas = rankApprovedPlayers(
      [
        { id: "a", profileId: 1 },
        { id: "b", profileId: 2 },
        { id: "c", profileId: 3 },
        { id: "d", profileId: 4 },
      ],
      new Map([
        ["a", agregado({ matchPoints: 4, wins: 2, matches: 2 })],
        ["b", agregado({ matchPoints: 2, wins: 1, matches: 2 })],
        ["c", agregado({ matchPoints: 2, wins: 1, matches: 2 })],
      ]),
      new Map(),
      DEFAULT_RULESET,
    );

    expect(filas.map((f) => [f.playerId, f.rank])).toEqual([
      ["a", 1],
      ["b", 2],
      ["c", 2],
      ["d", 4],
    ]);
  });

  it("los puntos de objetivos se suman a quien los tiene", () => {
    const filas = rankApprovedPlayers(
      [
        { id: "a", profileId: 1 },
        { id: "b", profileId: 2 },
      ],
      new Map([["a", agregado({ matchPoints: 4, wins: 2, matches: 3 })]]),
      new Map([["a", { points: 125, earned: ["rey-1v1", "loco-por-ganar"] }]]),
      DEFAULT_RULESET,
    );

    const filaA = filas.find((f) => f.playerId === "a");

    expect(filaA?.total).toBe(129);
    expect(filaA?.objectives).toEqual({
      points: 125,
      earned: ["rey-1v1", "loco-por-ganar"],
    });
  });

  it("una entrada de `totals` que no sea de un aprobado se ignora", () => {
    // Se itera sobre los aprobados, no sobre los agregados: alguien que dejó de
    // estar aprobado entre el agregado y esta llamada no puede colarse.
    const filas = rankApprovedPlayers(
      [{ id: "a", profileId: 1 }],
      new Map([["fantasma", agregado({ matchPoints: 99, wins: 9, matches: 9 })]]),
      new Map(),
      DEFAULT_RULESET,
    );

    expect(filas).toHaveLength(1);
    expect(filas[0].playerId).toBe("a");
    expect(filas[0].total).toBe(0);
  });

  it("el orden respeta `compareStandings`", () => {
    // Mismo total: gana la mejor tasa de victorias; con la misma, más victorias; y
    // con lo mismo, más partidas. `sinPartidas` cierra la tabla con 0 puntos.
    const filas = rankApprovedPlayers(
      [
        { id: "sinPartidas", profileId: 9 },
        { id: "peorWinrate", profileId: 5 },
        { id: "mismoTotalMenosVictorias", profileId: 1 },
        { id: "mejor", profileId: 8 },
      ],
      new Map([
        ["peorWinrate", agregado({ matchPoints: 10, wins: 3, matches: 5 })],
        ["mismoTotalMenosVictorias", agregado({ matchPoints: 10, wins: 2, matches: 4 })],
        ["mejor", agregado({ matchPoints: 10, wins: 3, matches: 4 })],
      ]),
      new Map(),
      DEFAULT_RULESET,
    );

    expect(filas.map((f) => f.playerId)).toEqual([
      "mejor",
      "peorWinrate",
      "mismoTotalMenosVictorias",
      "sinPartidas",
    ]);
  });
});

describe("qué cuenta como partida clasificatoria", () => {
  /**
   * Contexto de equipos **sin cortes**: la condición de compañeros no se puede
   * comprobar, así que estos casos miden las otras cinco. La condición de equipos
   * tiene sus propias comprobaciones en `ranked-match.test.ts`, que es donde vive.
   */
  const SIN_EQUIPOS: TeamTierContext = { profileId: 9_000_001, cutoffs: null };

  // El `null` es el caso de toda la fila que ya estaba en la base cuando se añadió
  // `Player.registeredAt`: cuenta desde el principio de la ventana.
  it("una partida resuelta, rankeada, dentro de la ventana y no revertida cuenta", () => {
    expect(countsAsRanked(partida(), VENTANA, null, SIN_EQUIPOS)).toBe(true);
  });

  it("una partida en curso no cuenta, ni a favor ni en contra", () => {
    // Sin `finishedAt` la API todavía no ha publicado el desenlace.
    expect(countsAsRanked(partida({ finishedAt: null }), VENTANA, null, SIN_EQUIPOS)).toBe(false);
    // Y sin `result` tampoco, que es el mismo hecho por el otro lado.
    expect(countsAsRanked(partida({ result: null }), VENTANA, null, SIN_EQUIPOS)).toBe(false);
  });

  it("una partida revertida deja de contar aunque siga en la tabla", () => {
    expect(
      countsAsRanked(
        partida({ revertedAt: new Date("2026-09-21T00:00:00Z") }),
        VENTANA,
        null,
        SIN_EQUIPOS,
      ),
    ).toBe(false);
  });

  it("solo cuentan las familias ranked del ruleset", () => {
    expect(countsAsRanked(partida({ mode: "rm_team" }), VENTANA, null, SIN_EQUIPOS)).toBe(true);
    for (const modo of ["rm_1v1", "qm_ffa", "ew_1v1", "custom_8v8", null]) {
      expect(countsAsRanked(partida({ mode: modo }), VENTANA, null, SIN_EQUIPOS), String(modo)).toBe(
        false,
      );
    }
  });

  it("la ventana va sobre `startedAt`, con `from` incluido y `to` excluido", () => {
    // Lo que decide es cuándo se jugó, no cuándo se publicó el resultado: una
    // partida empezada el último día puede terminar después y sigue contando.
    expect(
      countsAsRanked(
        partida({ startedAt: new Date("2026-09-15T00:00:00.000Z") }),
        VENTANA,
        null,
        SIN_EQUIPOS,
      ),
    ).toBe(true);
    expect(
      countsAsRanked(
        partida({ startedAt: new Date("2026-10-15T00:00:00.000Z") }),
        VENTANA,
        null,
        SIN_EQUIPOS,
      ),
    ).toBe(false);
    expect(
      countsAsRanked(
        partida({ startedAt: new Date("2026-10-14T23:59:59.999Z") }),
        VENTANA,
        null,
        SIN_EQUIPOS,
      ),
    ).toBe(true);
  });

  it("con `to` a `null` la ventana está abierta por la derecha", () => {
    const abierta: ScoringWindow = { from: "2026-09-15T00:00:00.000Z", to: null };

    expect(
      countsAsRanked(
        partida({ startedAt: new Date("2030-01-01T00:00:00Z") }),
        abierta,
        null,
        SIN_EQUIPOS,
      ),
    ).toBe(true);
  });

  it("una victoria cuenta lo mismo que una derrota", () => {
    // La clasificación cuenta `wins` y `matches` por separado: perder una
    // clasificatoria no puede restar puntos, solo no sumarlos.
    expect(countsAsRanked(partida({ result: MatchResult.LOSS }), VENTANA, null, SIN_EQUIPOS)).toBe(
      true,
    );
  });

  it("con `registeredAt` el corte sube y las partidas anteriores dejan de contar", () => {
    // `partida()` arranca el 20 de septiembre a las 12:00, así que con el alta de
    // esa misma medianoche deja de contar y con la del 19 sigue contando.
    expect(
      countsAsRanked(partida(), VENTANA, new Date("2026-09-20T12:00:00.000Z"), SIN_EQUIPOS),
    ).toBe(true);
    expect(
      countsAsRanked(partida(), VENTANA, new Date("2026-09-20T12:00:00.001Z"), SIN_EQUIPOS),
    ).toBe(false);
    // Un alta anterior a la ventana es lo mismo que no tener fecha: es el caso de
    // todo el que ya estaba inscrito.
    expect(
      countsAsRanked(partida(), VENTANA, new Date("2026-09-01T00:00:00.000Z"), SIN_EQUIPOS),
    ).toBe(true);
  });
});
