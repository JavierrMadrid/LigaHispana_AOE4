import { describe, expect, it } from "vitest";

import { ObjectiveLeadKind } from "@/generated/prisma/enums";
import type { ObjectiveAwarded } from "@/lib/objectives";
import {
  OBJECTIVE_LEAD_RANK,
  currentLeadHolders,
  leadChanges,
  leadHolders,
  type LeadEventRow,
} from "@/lib/objective-leads";

/**
 * El registro de poseedores de competiciones: la parte pura del log `ObjectiveLeadEvent`.
 *
 * Lo que decide **qué hay que anotar** —deducir el poseedor del estado ya anotado
 * (`leadHolders()`) y compararlo con el que acaba de calcular el motor (`leadChanges()`)—
 * son funciones puras, así que se comprueban aquí sin base de datos. Lo único que toca la
 * base es `reconcileObjectiveLeadEvents()`, que es una lectura del registro de la edición y
 * una escritura de la diferencia: eso es Prisma y sale en `npm run verify:sync`.
 *
 * Los dos casos que no se pueden ver aquí y que sí importan: que la lectura venga filtrada
 * por la edición activa (`editionFrom`) y que las dos filas de un cambio se escriban con el
 * mismo `at`. Los dos son de la reconciliación, no de las funciones puras.
 */

/** Ids reales del catálogo: `rey-1v1` y `loco-por-ganar` son competiciones y `imparable`, un logro. */
const REY = "rey-1v1";
const LOCO = "loco-por-ganar";
const LOGRO = "imparable";

/** Un cambio anotado en el registro, con lo mínimo que leen las funciones puras. */
function fila(
  objectiveId: string,
  playerId: string,
  kind: ObjectiveLeadKind,
  at: string,
): LeadEventRow {
  return { objectiveId, playerId, kind, at: new Date(at) };
}

const T1 = "2026-09-01T10:00:00.000Z";
const T2 = "2026-09-02T10:00:00.000Z";

describe("ObjectiveLeadKind", () => {
  it("se declara LOST antes que GAINED, que es el orden que aplica Postgres", () => {
    // Las dos filas de un cambio comparten instante, así que el orden de declaración es el
    // que decide cuál sale delante en un `orderBy` de `kind` con el mismo `dir` que el
    // resto (la ganancia, en descendente). Si alguien reordena el enum, esto lo dice.
    expect(Object.values(ObjectiveLeadKind)).toEqual(["LOST", "GAINED"]);
  });

  it("OBJECTIVE_LEAD_RANK dice lo mismo que la declaración del enum", () => {
    expect(OBJECTIVE_LEAD_RANK[ObjectiveLeadKind.GAINED]).toBeGreaterThan(
      OBJECTIVE_LEAD_RANK[ObjectiveLeadKind.LOST],
    );
    expect(Object.values(ObjectiveLeadKind)).toEqual(
      Object.entries(OBJECTIVE_LEAD_RANK)
        .sort(([, a], [, b]) => a - b)
        .map(([kind]) => kind),
    );
  });
});

describe("leadHolders", () => {
  it("sin filas no inventa poseedores", () => {
    expect([...leadHolders([])]).toEqual([]);
  });

  it("una competición con una sola ganancia la posee quien ganó", () => {
    expect(leadHolders([fila(REY, "p1", ObjectiveLeadKind.GAINED, T1)])).toEqual(
      new Map([[REY, "p1"]]),
    );
  });

  it("una ganancia seguida de una pérdida deja la competición sin poseedor", () => {
    const holders = leadHolders([
      fila(REY, "p1", ObjectiveLeadKind.GAINED, T1),
      fila(REY, "p1", ObjectiveLeadKind.LOST, T2),
    ]);

    expect(holders.get(REY)).toBeNull();
  });

  it("un cambio de poseedor deja al nuevo, no al anterior", () => {
    const holders = leadHolders([
      fila(REY, "p1", ObjectiveLeadKind.GAINED, T1),
      fila(REY, "p1", ObjectiveLeadKind.LOST, T2),
      fila(REY, "p2", ObjectiveLeadKind.GAINED, T2),
    ]);

    expect(holders.get(REY)).toBe("p2");
  });

  it("a igual instante, la ganancia es el estado que queda", () => {
    // Las dos filas de un cambio comparten `at`: el desempate por `kind` decide.
    const holders = leadHolders([
      fila(REY, "p1", ObjectiveLeadKind.LOST, T1),
      fila(REY, "p2", ObjectiveLeadKind.GAINED, T1),
    ]);

    expect(holders.get(REY)).toBe("p2");
  });

  it("no depende del orden en que lleguen las filas", () => {
    const filas = [
      fila(REY, "p1", ObjectiveLeadKind.GAINED, T1),
      fila(REY, "p1", ObjectiveLeadKind.LOST, T2),
      fila(REY, "p2", ObjectiveLeadKind.GAINED, T2),
      fila(LOCO, "p3", ObjectiveLeadKind.GAINED, T2),
      fila(LOCO, "p4", ObjectiveLeadKind.GAINED, T1),
    ];
    const esperado = new Map([
      [REY, "p2"],
      [LOCO, "p3"],
    ]);

    expect(leadHolders(filas)).toEqual(esperado);
    expect(leadHolders([...filas].reverse())).toEqual(esperado);
    expect(leadHolders([filas[2], filas[0], filas[4], filas[1], filas[3]])).toEqual(esperado);
  });
});

describe("currentLeadHolders", () => {
  it("solo se queda con las competiciones del catálogo", () => {
    const awarded: ObjectiveAwarded[] = [
      { id: REY, playerId: "p1" },
      { id: LOGRO, playerId: "p2" },
      { id: LOCO, playerId: "p3" },
    ];

    expect(currentLeadHolders(awarded)).toEqual(
      new Map([
        [REY, "p1"],
        [LOCO, "p3"],
      ]),
    );
  });

  it("un id que no está en el catálogo no entra", () => {
    expect(currentLeadHolders([{ id: "objetivo-inventado", playerId: "p1" }])).toEqual(new Map());
  });

  it("sin objetivos cobrados no hay poseedores", () => {
    expect(currentLeadHolders([])).toEqual(new Map());
  });
});

describe("leadChanges", () => {
  it("una competición sin estado previo y con poseedor se siembra con una ganancia", () => {
    expect(leadChanges(new Map(), new Map([[REY, "p1"]]))).toEqual([
      { objectiveId: REY, kind: ObjectiveLeadKind.GAINED, playerId: "p1" },
    ]);
  });

  it("un cambio de poseedor anota la pérdida y la ganancia, en ese orden", () => {
    expect(leadChanges(new Map([[REY, "p1"]]), new Map([[REY, "p2"]]))).toEqual([
      { objectiveId: REY, kind: ObjectiveLeadKind.LOST, playerId: "p1" },
      { objectiveId: REY, kind: ObjectiveLeadKind.GAINED, playerId: "p2" },
    ]);
  });

  it("un poseedor que desaparece deja una pérdida", () => {
    expect(leadChanges(new Map([[REY, "p1"]]), new Map())).toEqual([
      { objectiveId: REY, kind: ObjectiveLeadKind.LOST, playerId: "p1" },
    ]);
  });

  it("una competición sin poseedor en los dos lados no anota nada", () => {
    expect(leadChanges(new Map([[REY, null]]), new Map())).toEqual([]);
  });

  it("una competición que ya estaba vacía y ahora tiene poseedor se siembra", () => {
    expect(leadChanges(new Map([[REY, null]]), new Map([[REY, "p1"]]))).toEqual([
      { objectiveId: REY, kind: ObjectiveLeadKind.GAINED, playerId: "p1" },
    ]);
  });

  it("mismo poseedor en los dos lados: no hay nada que anotar (idempotencia)", () => {
    const estado = new Map([
      [REY, "p1"],
      [LOCO, "p2"],
    ]);

    expect(leadChanges(estado, new Map(estado))).toEqual([]);
  });

  it("con varias competiciones, los cambios salen en orden de id", () => {
    // El orden es determinista (por `objectiveId`) y no decide nada de lo que se lee, pero
    // la escritura no puede depender del orden del mapa.
    const cambios = leadChanges(
      new Map([
        [REY, "p1"],
        [LOCO, "p3"],
      ]),
      new Map([
        [LOCO, "p4"],
        [REY, "p2"],
      ]),
    );

    expect(cambios).toEqual([
      { objectiveId: LOCO, kind: ObjectiveLeadKind.LOST, playerId: "p3" },
      { objectiveId: LOCO, kind: ObjectiveLeadKind.GAINED, playerId: "p4" },
      { objectiveId: REY, kind: ObjectiveLeadKind.LOST, playerId: "p1" },
      { objectiveId: REY, kind: ObjectiveLeadKind.GAINED, playerId: "p2" },
    ]);
  });

  it("una competición que no cambia no aparece aunque otras sí", () => {
    const cambios = leadChanges(
      new Map([
        [REY, "p1"],
        [LOCO, "p3"],
      ]),
      new Map([
        [REY, "p1"],
        [LOCO, "p4"],
      ]),
    );

    expect(cambios).toEqual([
      { objectiveId: LOCO, kind: ObjectiveLeadKind.LOST, playerId: "p3" },
      { objectiveId: LOCO, kind: ObjectiveLeadKind.GAINED, playerId: "p4" },
    ]);
  });

  it("la reconciliación es idempotente: aplicar los cambios y volver a comparar no anota nada", () => {
    // Reproduce el ciclo completo de una pasada: el estado anotado se deduce del registro y
    // la lista que sale es la que se anexa. Una segunda pasada con el mismo cómputo tiene que
    // quedarse en blanco, que es lo que sostiene que el worker de 5 minutos no escriba.
    const anotadas: LeadEventRow[] = [fila(REY, "p1", ObjectiveLeadKind.GAINED, T1)];
    const actuales = new Map([
      [REY, "p2"],
      [LOCO, "p3"],
    ]);

    const cambios = leadChanges(leadHolders(anotadas), actuales);

    expect(cambios).toHaveLength(3);

    // Se anexan con el mismo instante las tres, como hace la reconciliación.
    for (const cambio of cambios) {
      anotadas.push(fila(cambio.objectiveId, cambio.playerId, cambio.kind, T2));
    }

    expect(leadChanges(leadHolders(anotadas), actuales)).toEqual([]);
  });
});
