import { describe, expect, it } from "vitest";

import { ObjectiveProgressKind } from "@/generated/prisma/enums";
import {
  OBJECTIVE_DEFINITIONS,
  type ObjectiveBeneficiary,
  type ObjectiveContender,
  type ObjectiveDefinition,
  type ObjectiveOption,
} from "@/lib/objectives";
import {
  clampObjectiveProgress,
  currentObjectiveProgress,
  diffObjectiveProgress,
  objectiveMaxProgress,
  objectiveProgressKey,
  optionMaxProgress,
  planObjectiveProgressStateWrites,
  type ObjectiveProgressStateRow,
} from "@/lib/objective-progress";

/**
 * El progreso de los objetivos: la parte pura de `ObjectiveProgressState` y
 * `ObjectiveProgressEvent`.
 *
 * Lo que se comprueba aquí es la **decisión**: qué estado tiene hoy cada jugador y
 * qué eventos hay que anexar para pasar del guardado al actual. La lectura y la
 * escritura de las dos tablas son Prisma y viven en la reconciliación, que se
 * comprueba con datos de verdad.
 */

/** Contendiente mínimo: todo relleno salvo lo que el caso necesite. */
function contender(
  profileId: number,
  value: number,
  overrides: Partial<ObjectiveContender> = {},
): ObjectiveContender {
  return {
    profileId,
    name: `Jugador ${profileId}`,
    avatarUrl: null,
    profileUrl: null,
    value,
    matches: value,
    eligible: true,
    ...overrides,
  };
}

/** Beneficiario mínimo: cuenta como repetición y como puntos. */
function beneficiario(profileId: number, count: number): ObjectiveBeneficiary {
  return {
    profileId,
    name: `Jugador ${profileId}`,
    avatarUrl: null,
    profileUrl: null,
    points: count,
    count,
  };
}

/** Una opción del catálogo, con los campos que la función no lee a cero. */
function baseOption(overrides: Partial<ObjectiveOption> = {}): ObjectiveOption {
  return {
    id: "loco-por-ganar",
    group: "actividad",
    kind: "competition",
    label: "Objetivo",
    description: "…",
    metric: "partidas",
    points: 50,
    parent: null,
    holder: null,
    ranking: [],
    beneficiaries: [],
    target: null,
    ...overrides,
  };
}

/** Una fila de estado, con la forma que devuelve la lectura de la edición. */
function fila(
  objectiveId: string,
  playerId: string,
  value: number,
  completed: boolean,
  repetition: number | null = null,
): ObjectiveProgressStateRow {
  return { objectiveId, playerId, value, completed, repetition };
}

/** Un mapa de estado indexado como lo indexa la reconciliación. */
function estado(
  ...filas: ObjectiveProgressStateRow[]
): Map<string, ObjectiveProgressStateRow> {
  return new Map(
    filas.map((f) => [objectiveProgressKey(f.playerId, f.objectiveId), f]),
  );
}

/** Una definición del catálogo por id. */
function definition(id: string): ObjectiveDefinition {
  const encontrada = OBJECTIVE_DEFINITIONS.find((item) => item.id === id);

  if (encontrada === undefined) {
    throw new Error(`No existe el objetivo ${id}`);
  }

  return encontrada;
}

const LOCO = "loco-por-ganar";
const IMPARABLE = "imparable";
const VICTORIAS = "victorias";
const POR_TIERRA = "por-tierra-y-agua";
const LIDER_JAPANESE = "lider-japanese";

describe("objectiveMaxProgress: el tope de cada objetivo del catálogo", () => {
  it("las competiciones no tienen tope", () => {
    expect(objectiveMaxProgress(definition(LOCO), 9)).toBeNull();
    expect(objectiveMaxProgress(definition("rey-1v1"), 9)).toBeNull();
  });

  it("`victorias` no tiene tope porque no se completa nunca", () => {
    expect(objectiveMaxProgress(definition(VICTORIAS), 9)).toBeNull();
  });

  it("los logros con umbral fijo usan su `target`", () => {
    expect(objectiveMaxProgress(definition(IMPARABLE), 9)).toBe(14);
    expect(objectiveMaxProgress(definition(LIDER_JAPANESE), 9)).toBe(3);
  });

  it("un objetivo binario tiene tope 1", () => {
    expect(objectiveMaxProgress(definition("avance-relampago-feudal"), 9)).toBe(1);
  });

  it("`por-tierra-y-agua` tiene el tamaño del pool activo", () => {
    expect(objectiveMaxProgress(definition(POR_TIERRA), 9)).toBe(9);
    expect(objectiveMaxProgress(definition(POR_TIERRA), 4)).toBe(4);
  });

  it("con el pool vacío `por-tierra-y-agua` no tiene máximo", () => {
    expect(objectiveMaxProgress(definition(POR_TIERRA), 0)).toBeNull();
  });
});

describe("optionMaxProgress: el tope de una opción ya calculada", () => {
  it("las competiciones no tienen tope", () => {
    expect(optionMaxProgress(baseOption({ kind: "competition", target: null }))).toBeNull();
  });

  it("los logros con umbral usan el `target` resuelto", () => {
    expect(
      optionMaxProgress(
        baseOption({
          id: IMPARABLE,
          kind: "achievement",
          metric: "dias",
          target: { unit: "dias", value: 14 },
        }),
      ),
    ).toBe(14);
  });

  it("`victorias` sale sin tope porque su `target` es `null`", () => {
    expect(
      optionMaxProgress(baseOption({ id: VICTORIAS, kind: "achievement", target: null })),
    ).toBeNull();
  });
});

describe("clampObjectiveProgress: entero no negativo dentro del tope", () => {
  it("recorta al máximo", () => {
    expect(clampObjectiveProgress(15, 14)).toBe(14);
  });

  it("no baja de cero", () => {
    expect(clampObjectiveProgress(0, 14)).toBe(0);
    expect(clampObjectiveProgress(-1, 14)).toBe(0);
  });

  it("sin máximo no recorta", () => {
    expect(clampObjectiveProgress(5, null)).toBe(5);
  });

  it("trunca la parte decimal", () => {
    expect(clampObjectiveProgress(2.9, 14)).toBe(2);
  });

  it("un valor no finito es cero", () => {
    expect(clampObjectiveProgress(Number.NaN, 14)).toBe(0);
    expect(clampObjectiveProgress(Number.POSITIVE_INFINITY, null)).toBe(0);
  });

  it("un máximo no finito o negativo se trata como cero", () => {
    expect(clampObjectiveProgress(5, Number.NaN)).toBe(0);
    expect(clampObjectiveProgress(5, -3)).toBe(0);
  });
});

describe("currentObjectiveProgress: el estado de cada jugador y objetivo", () => {
  const jugadores = new Map<number, string>([
    [1, "a"],
    [2, "b"],
  ]);

  it("en una competición solo el poseedor está completado", () => {
    const option = baseOption({
      id: LOCO,
      holder: contender(1, 30),
      ranking: [contender(1, 30), contender(2, 20)],
    });

    const estados = currentObjectiveProgress([option], jugadores);

    expect(estados.get(objectiveProgressKey("a", LOCO))).toEqual({
      objectiveId: LOCO,
      playerId: "a",
      value: 30,
      completed: true,
      repetition: null,
    });
    expect(estados.get(objectiveProgressKey("b", LOCO))).toEqual({
      objectiveId: LOCO,
      playerId: "b",
      value: 20,
      completed: false,
      repetition: null,
    });
  });

  it("en un logro repetible cada beneficiario cobra con su repetición", () => {
    const option = baseOption({
      id: IMPARABLE,
      kind: "achievement",
      metric: "dias",
      target: { unit: "dias", value: 14 },
      ranking: [contender(1, 10), contender(2, 3)],
      beneficiaries: [beneficiario(1, 10), beneficiario(2, 3)],
    });

    const estados = currentObjectiveProgress([option], jugadores);

    expect(estados.get(objectiveProgressKey("a", IMPARABLE))).toEqual({
      objectiveId: IMPARABLE,
      playerId: "a",
      value: 10,
      completed: true,
      repetition: 10,
    });
    expect(estados.get(objectiveProgressKey("b", IMPARABLE))).toEqual({
      objectiveId: IMPARABLE,
      playerId: "b",
      value: 3,
      completed: true,
      repetition: 3,
    });
  });

  it("el valor y la repetición se recortan al tope", () => {
    const option = baseOption({
      id: IMPARABLE,
      kind: "achievement",
      metric: "dias",
      target: { unit: "dias", value: 14 },
      ranking: [contender(1, 20)],
      beneficiaries: [beneficiario(1, 20)],
    });

    const estados = currentObjectiveProgress([option], jugadores);

    expect(estados.get(objectiveProgressKey("a", IMPARABLE))).toMatchObject({
      value: 14,
      completed: true,
      repetition: 14,
    });
  });

  it("en un logro con tope, el valor se recorta y el que no llega no está completado", () => {
    const option = baseOption({
      id: LIDER_JAPANESE,
      group: "civilizacion",
      kind: "achievement",
      metric: "victorias",
      target: { unit: "victorias", value: 3 },
      ranking: [contender(1, 4), contender(2, 2)],
      beneficiaries: [beneficiario(1, 1)],
    });

    const estados = currentObjectiveProgress([option], jugadores);

    expect(estados.get(objectiveProgressKey("a", LIDER_JAPANESE))).toEqual({
      objectiveId: LIDER_JAPANESE,
      playerId: "a",
      value: 3,
      completed: true,
      repetition: null,
    });
    expect(estados.get(objectiveProgressKey("b", LIDER_JAPANESE))).toEqual({
      objectiveId: LIDER_JAPANESE,
      playerId: "b",
      value: 2,
      completed: false,
      repetition: null,
    });
  });

  it("`victorias` no recorta y el que no ha ganado no entra", () => {
    const option = baseOption({
      id: VICTORIAS,
      kind: "achievement",
      metric: "victorias",
      target: null,
      ranking: [contender(1, 5), contender(2, 0)],
      beneficiaries: [beneficiario(1, 5)],
    });

    const estados = currentObjectiveProgress([option], jugadores);

    expect(estados.get(objectiveProgressKey("a", VICTORIAS))).toEqual({
      objectiveId: VICTORIAS,
      playerId: "a",
      value: 5,
      completed: true,
      repetition: 5,
    });
    expect(estados.has(objectiveProgressKey("b", VICTORIAS))).toBe(false);
  });

  it("un `profileId` que no está en el mapa de jugadores se ignora", () => {
    const option = baseOption({
      id: LOCO,
      holder: contender(1, 30),
      ranking: [contender(1, 30), contender(9, 40)],
    });

    const estados = currentObjectiveProgress([option], jugadores);

    expect([...estados.keys()]).toEqual([objectiveProgressKey("a", LOCO)]);
  });
});

describe("diffObjectiveProgress: la diferencia entre el estado guardado y el actual", () => {
  it("un estado nuevo completado emite CUMPLIDO", () => {
    const actual = estado(fila(LOCO, "a", 30, true));

    expect(diffObjectiveProgress(new Map(), actual, [])).toEqual([
      {
        objectiveId: LOCO,
        playerId: "a",
        kind: ObjectiveProgressKind.CUMPLIDO,
        ownValue: 30,
        otherValue: null,
        repetition: null,
      },
    ]);
  });

  it("un estado nuevo con progreso parcial emite PROGRESADO", () => {
    const actual = estado(fila(LIDER_JAPANESE, "a", 2, false));

    expect(diffObjectiveProgress(new Map(), actual, [])).toEqual([
      {
        objectiveId: LIDER_JAPANESE,
        playerId: "a",
        kind: ObjectiveProgressKind.PROGRESADO,
        ownValue: 2,
        otherValue: null,
        repetition: null,
      },
    ]);
  });

  it("una subida de valor emite PROGRESADO", () => {
    const previo = estado(fila(LIDER_JAPANESE, "a", 2, false));
    const actual = estado(fila(LIDER_JAPANESE, "a", 3, false));

    expect(diffObjectiveProgress(previo, actual, [])).toEqual([
      {
        objectiveId: LIDER_JAPANESE,
        playerId: "a",
        kind: ObjectiveProgressKind.PROGRESADO,
        ownValue: 3,
        otherValue: null,
        repetition: null,
      },
    ]);
  });

  it("pasar a completado emite CUMPLIDO", () => {
    const previo = estado(fila(IMPARABLE, "a", 13, false, 13));
    const actual = estado(fila(IMPARABLE, "a", 14, true, 14));

    expect(diffObjectiveProgress(previo, actual, [])).toEqual([
      {
        objectiveId: IMPARABLE,
        playerId: "a",
        kind: ObjectiveProgressKind.CUMPLIDO,
        ownValue: 14,
        otherValue: null,
        repetition: 14,
      },
    ]);
  });

  it("perder una competición con nuevo poseedor emite PERDIDO con su valor", () => {
    const previo = estado(fila(LOCO, "a", 30, true));
    const actual = estado(fila(LOCO, "a", 30, false));
    const options = [baseOption({ id: LOCO, holder: contender(2, 40) })];

    expect(diffObjectiveProgress(previo, actual, options)).toEqual([
      {
        objectiveId: LOCO,
        playerId: "a",
        kind: ObjectiveProgressKind.PERDIDO,
        ownValue: 30,
        otherValue: 40,
        repetition: null,
      },
    ]);
  });

  it("perder una competición sin nuevo poseedor emite PERDIDO con `otherValue: null`", () => {
    const previo = estado(fila(LOCO, "a", 30, true));
    const actual = estado(fila(LOCO, "a", 30, false));
    const options = [baseOption({ id: LOCO, holder: null })];

    expect(diffObjectiveProgress(previo, actual, options)).toEqual([
      {
        objectiveId: LOCO,
        playerId: "a",
        kind: ObjectiveProgressKind.PERDIDO,
        ownValue: 30,
        otherValue: null,
        repetition: null,
      },
    ]);
  });

  it("perder un logro no emite nada", () => {
    const previo = estado(fila(IMPARABLE, "a", 14, true, 14));
    const actual = estado(fila(IMPARABLE, "a", 5, false, 5));

    expect(diffObjectiveProgress(previo, actual, [])).toEqual([]);
  });

  it("un estado de competición completado que desaparece emite PERDIDO con `ownValue: 0`", () => {
    const previo = estado(fila(LOCO, "a", 30, true));
    const options = [baseOption({ id: LOCO, holder: contender(2, 40) })];

    expect(diffObjectiveProgress(previo, new Map(), options)).toEqual([
      {
        objectiveId: LOCO,
        playerId: "a",
        kind: ObjectiveProgressKind.PERDIDO,
        ownValue: 0,
        otherValue: 40,
        repetition: null,
      },
    ]);
  });

  it("un estado de logro que desaparece no emite nada", () => {
    const previo = estado(fila(LIDER_JAPANESE, "a", 3, true));

    expect(diffObjectiveProgress(previo, new Map(), [])).toEqual([]);
  });

  it("una bajada de valor sin cambio de completado no emite nada", () => {
    const previo = estado(fila(IMPARABLE, "a", 10, true, 10));
    const actual = estado(fila(IMPARABLE, "a", 8, true, 8));

    expect(diffObjectiveProgress(previo, actual, [])).toEqual([]);
  });

  it("una subida de repetición con el valor recortado emite PROGRESADO", () => {
    const previo = estado(fila(IMPARABLE, "a", 14, true, 14));
    const actual = estado(fila(IMPARABLE, "a", 14, true, 16));

    expect(diffObjectiveProgress(previo, actual, [])).toEqual([
      {
        objectiveId: IMPARABLE,
        playerId: "a",
        kind: ObjectiveProgressKind.PROGRESADO,
        ownValue: 14,
        otherValue: null,
        repetition: 16,
      },
    ]);
  });

  it("el orden del resultado es determinista por jugador y objetivo", () => {
    const actual = estado(
      fila(IMPARABLE, "b", 3, true, 3),
      fila(VICTORIAS, "a", 3, true, 3),
      fila(IMPARABLE, "a", 2, true, 2),
    );

    const drafts = diffObjectiveProgress(new Map(), actual, []);

    expect(drafts.map((draft) => `${draft.playerId}:${draft.objectiveId}`)).toEqual([
      `a:${IMPARABLE}`,
      `a:${VICTORIAS}`,
      `b:${IMPARABLE}`,
    ]);
  });
});

describe("planObjectiveProgressStateWrites: qué filas de estado hay que escribir", () => {
  it("sin estado anterior, todo son altas", () => {
    const actual = estado(fila(LOCO, "a", 30, true), fila(LIDER_JAPANESE, "b", 2, false));

    const plan = planObjectiveProgressStateWrites(new Map(), actual);

    expect(plan.create.map((f) => `${f.playerId}:${f.objectiveId}`)).toEqual([
      `a:${LOCO}`,
      `b:${LIDER_JAPANESE}`,
    ]);
    expect(plan.update).toEqual([]);
    expect(plan.remove).toEqual([]);
  });

  it("un estado idéntico no escribe nada", () => {
    const previo = estado(fila(LOCO, "a", 30, true), fila(LIDER_JAPANESE, "b", 2, false));
    const actual = estado(fila(LOCO, "a", 30, true), fila(LIDER_JAPANESE, "b", 2, false));

    expect(planObjectiveProgressStateWrites(previo, actual)).toEqual({
      create: [],
      update: [],
      remove: [],
    });
  });

  it("un valor distinto es una actualización con los valores actuales", () => {
    const previo = estado(fila(LIDER_JAPANESE, "a", 2, false));
    const actual = estado(fila(LIDER_JAPANESE, "a", 3, false));

    const plan = planObjectiveProgressStateWrites(previo, actual);

    expect(plan.create).toEqual([]);
    expect(plan.update).toEqual([fila(LIDER_JAPANESE, "a", 3, false)]);
    expect(plan.remove).toEqual([]);
  });

  it("un cambio de `completed` es una actualización", () => {
    const previo = estado(fila(LOCO, "a", 30, false));
    const actual = estado(fila(LOCO, "a", 30, true));

    expect(planObjectiveProgressStateWrites(previo, actual).update).toEqual([
      fila(LOCO, "a", 30, true),
    ]);
  });

  it("un cambio de `repetition` es una actualización", () => {
    const previo = estado(fila(IMPARABLE, "a", 14, true, 14));
    const actual = estado(fila(IMPARABLE, "a", 14, true, 16));

    expect(planObjectiveProgressStateWrites(previo, actual).update).toEqual([
      fila(IMPARABLE, "a", 14, true, 16),
    ]);
  });

  it("un estado que ya no está es una baja con los valores anteriores", () => {
    const previo = estado(fila(LOCO, "a", 30, true));

    const plan = planObjectiveProgressStateWrites(previo, new Map());

    expect(plan.create).toEqual([]);
    expect(plan.update).toEqual([]);
    expect(plan.remove).toEqual([fila(LOCO, "a", 30, true)]);
  });

  it("una pasada que mezcla altas, cambios y bajas reparte las tres listas", () => {
    const previo = estado(
      fila(LOCO, "a", 30, true),
      fila(LIDER_JAPANESE, "a", 2, false),
      fila(IMPARABLE, "a", 10, true, 10),
    );
    const actual = estado(
      fila(LOCO, "a", 30, true),
      fila(LIDER_JAPANESE, "a", 3, false),
      fila(VICTORIAS, "a", 5, true, 5),
    );

    const plan = planObjectiveProgressStateWrites(previo, actual);

    expect(plan.create).toEqual([fila(VICTORIAS, "a", 5, true, 5)]);
    expect(plan.update).toEqual([fila(LIDER_JAPANESE, "a", 3, false)]);
    expect(plan.remove).toEqual([fila(IMPARABLE, "a", 10, true, 10)]);
  });

  it("las tres listas salen ordenadas por jugador y objetivo", () => {
    const previo = estado(
      fila(VICTORIAS, "b", 1, false),
      fila(IMPARABLE, "b", 1, false),
      fila(LIDER_JAPANESE, "a", 1, false),
      fila(VICTORIAS, "a", 1, false),
      fila(IMPARABLE, "a", 1, false),
    );
    const actual = estado(
      fila(VICTORIAS, "b", 2, false),
      fila(IMPARABLE, "b", 2, false),
      fila(LIDER_JAPANESE, "a", 2, false),
      fila(LOCO, "b", 1, false),
      fila(LOCO, "a", 1, false),
    );

    const plan = planObjectiveProgressStateWrites(previo, actual);

    const claves = (filas: ObjectiveProgressStateRow[]): string[] =>
      filas.map((f) => `${f.playerId}:${f.objectiveId}`);

    expect(claves(plan.create)).toEqual([`a:${LOCO}`, `b:${LOCO}`]);
    expect(claves(plan.update)).toEqual([
      `a:${LIDER_JAPANESE}`,
      `b:${IMPARABLE}`,
      `b:${VICTORIAS}`,
    ]);
    expect(claves(plan.remove)).toEqual([`a:${IMPARABLE}`, `a:${VICTORIAS}`]);
  });
});
