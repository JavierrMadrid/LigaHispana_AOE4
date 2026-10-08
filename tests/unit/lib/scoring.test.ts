import { describe, expect, it } from "vitest";

import { MatchResult } from "@/generated/prisma/enums";
import { OBJECTIVE_COUNT, OBJECTIVE_POINTS } from "@/lib/objectives";
import {
  DEFAULT_RULESET,
  RULESET_VERSION,
  RULE_LABEL,
  SCORING_RULESET_KEY,
  countsAsRanked,
  mergeRuleset,
  type ScoringWindow,
} from "@/lib/scoring";

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

describe("reglas v3 (constantes del motor)", () => {
  it("el ruleset por defecto es el de la versión que declara el código", () => {
    expect(DEFAULT_RULESET.version).toBe(RULESET_VERSION);
    expect(SCORING_RULESET_KEY).toBe("scoring.ruleset");
  });

  it("las familias por defecto son las dos ladders ranked", () => {
    // `mode` colapsa 2v2, 3v3 y 4v4 en `rm_team`, así que son dos, no cuatro.
    expect(DEFAULT_RULESET.modes).toEqual(["rm_solo", "rm_team"]);
  });

  it("los valores por defecto son los acordados", () => {
    expect(DEFAULT_RULESET.pointsPerWin).toBe(10);
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

  it("la etiqueta la fija el código, no el documento guardado", () => {
    // Es texto de producto y aparece en la interfaz: un `label` guardado que
    // describiera otra versión de las reglas haría que `/objetivos` mintiera.
    const { ruleset, warnings } = mergeRuleset({ ...VALIDO, label: "10 puntos por ganar" });

    expect(ruleset.label).toBe(RULE_LABEL);
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

describe("qué cuenta como partida clasificatoria", () => {
  // El `null` es el caso de toda la fila que ya estaba en la base cuando se añadió
  // `Player.registeredAt`: cuenta desde el principio de la ventana.
  it("una partida resuelta, rankeada, dentro de la ventana y no revertida cuenta", () => {
    expect(countsAsRanked(partida(), VENTANA, null)).toBe(true);
  });

  it("una partida en curso no cuenta, ni a favor ni en contra", () => {
    // Sin `finishedAt` la API todavía no ha publicado el desenlace.
    expect(countsAsRanked(partida({ finishedAt: null }), VENTANA, null)).toBe(false);
    // Y sin `result` tampoco, que es el mismo hecho por el otro lado.
    expect(countsAsRanked(partida({ result: null }), VENTANA, null)).toBe(false);
  });

  it("una partida revertida deja de contar aunque siga en la tabla", () => {
    expect(
      countsAsRanked(partida({ revertedAt: new Date("2026-09-21T00:00:00Z") }), VENTANA, null),
    ).toBe(false);
  });

  it("solo cuentan las familias ranked del ruleset", () => {
    expect(countsAsRanked(partida({ mode: "rm_team" }), VENTANA, null)).toBe(true);
    for (const modo of ["rm_1v1", "qm_ffa", "ew_1v1", "custom_8v8", null]) {
      expect(countsAsRanked(partida({ mode: modo }), VENTANA, null), String(modo)).toBe(false);
    }
  });

  it("la ventana va sobre `startedAt`, con `from` incluido y `to` excluido", () => {
    // Lo que decide es cuándo se jugó, no cuándo se publicó el resultado: una
    // partida empezada el último día puede terminar después y sigue contando.
    expect(
      countsAsRanked(partida({ startedAt: new Date("2026-09-15T00:00:00.000Z") }), VENTANA, null),
    ).toBe(true);
    expect(
      countsAsRanked(partida({ startedAt: new Date("2026-10-15T00:00:00.000Z") }), VENTANA, null),
    ).toBe(false);
    expect(
      countsAsRanked(partida({ startedAt: new Date("2026-10-14T23:59:59.999Z") }), VENTANA, null),
    ).toBe(true);
  });

  it("con `to` a `null` la ventana está abierta por la derecha", () => {
    const abierta: ScoringWindow = { from: "2026-09-15T00:00:00.000Z", to: null };

    expect(countsAsRanked(partida({ startedAt: new Date("2030-01-01T00:00:00Z") }), abierta, null)).toBe(
      true,
    );
  });

  it("una victoria cuenta lo mismo que una derrota", () => {
    // La clasificación cuenta `wins` y `matches` por separado: perder una
    // clasificatoria no puede restar puntos, solo no sumarlos.
    expect(countsAsRanked(partida({ result: MatchResult.LOSS }), VENTANA, null)).toBe(true);
  });

  it("con `registeredAt` el corte sube y las partidas anteriores dejan de contar", () => {
    // `partida()` arranca el 20 de septiembre a las 12:00, así que con el alta de
    // esa misma medianoche deja de contar y con la del 19 sigue contando.
    expect(countsAsRanked(partida(), VENTANA, new Date("2026-09-20T12:00:00.000Z"))).toBe(true);
    expect(countsAsRanked(partida(), VENTANA, new Date("2026-09-20T12:00:00.001Z"))).toBe(false);
    // Un alta anterior a la ventana es lo mismo que no tener fecha: es el caso de
    // todo el que ya estaba inscrito.
    expect(countsAsRanked(partida(), VENTANA, new Date("2026-09-01T00:00:00.000Z"))).toBe(true);
  });
});
