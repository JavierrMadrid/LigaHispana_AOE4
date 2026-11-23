import { describe, expect, it } from "vitest";

import { ObjectKind, PlayerStatus } from "@/generated/prisma/enums";
import {
  buildObjectHistoryEvents,
  compareObjectHistory,
  filterObjectHistoryEvents,
  paginateObjectHistory,
  readObjectHistoryFilters,
  type ObjectHistoryAwardSource,
  type ObjectHistoryEvent,
  type ObjectHistoryPlayerSource,
  type ObjectHistoryThrowSource,
} from "@/lib/object-history";
import { dateRangeWhere } from "@/lib/query-params";

/**
 * El feed público de objetos: el mapeo de las cuatro clases, las fechas de
 * respaldo, la regla de aprobados, el orden total y la paginación.
 *
 * Son las piezas puras de `src/lib/object-history.ts`, así que se prueban con
 * filas sintéticas, sin base de datos. Lo que no se comprueba aquí es que las
 * consultas devuelvan exactamente estas filas ni que el `orderBy` de SQL diga lo
 * mismo que el comparador: aquí el orden se resuelve en memoria con
 * `compareObjectHistory()`.
 */

const T1 = new Date("2026-09-01T10:00:00.000Z");
const T2 = new Date("2026-09-02T12:00:00.000Z");
const T3 = new Date("2026-09-03T09:00:00.000Z");
const T4 = new Date("2026-09-04T18:00:00.000Z");

function roster(
  entries: Array<{
    id: string;
    name: string;
    profileId: number;
    status?: PlayerStatus;
  }>,
): Map<string, ObjectHistoryPlayerSource> {
  return new Map(
    entries.map((entry) => [
      entry.id,
      {
        name: entry.name,
        profileId: entry.profileId,
        status: entry.status ?? PlayerStatus.APPROVED,
      },
    ]),
  );
}

function award(overrides: Partial<ObjectHistoryAwardSource> = {}): ObjectHistoryAwardSource {
  return {
    id: "a1",
    kind: ObjectKind.RELIQUIA,
    penaltyId: "sin-guarecer-reliquias",
    winnerId: "p1",
    winnerMatchId: "m1",
    holderId: "p1",
    day: new Date("2026-09-01T00:00:00.000Z"),
    exitedAt: null,
    satisfiedByMatchId: null,
    ...overrides,
  };
}

function objectThrow(
  overrides: Partial<ObjectHistoryThrowSource> = {},
): ObjectHistoryThrowSource {
  return {
    id: "t1",
    fromId: "p1",
    toId: "p2",
    at: T3,
    returned: false,
    award: { kind: ObjectKind.RELIQUIA, penaltyId: "sin-guarecer-reliquias" },
    ...overrides,
  };
}

function event(
  overrides: Partial<ObjectHistoryEvent> & { id: string; at: Date },
): ObjectHistoryEvent {
  return {
    kind: "AWARD",
    player: { name: "Uno", profileId: 1 },
    opponent: null,
    object: { kind: ObjectKind.RELIQUIA, name: "Reliquia pagana" },
    penalty: { id: "sin-guarecer-reliquias", text: "No se pueden guarecer reliquias." },
    ...overrides,
  };
}

const CUATRO_JUGADORES = roster([
  { id: "p1", name: "Uno", profileId: 101 },
  { id: "p2", name: "Dos", profileId: 202 },
  { id: "p3", name: "Tres", profileId: 303 },
  { id: "p4", name: "Cuatro", profileId: 404 },
]);

describe("buildObjectHistoryEvents", () => {
  it("mapea los cuatro tipos con su fecha, sujeto, contrario y catálogo", () => {
    const sources = {
      awards: [
        award({ id: "a1" }),
        award({
          id: "a2",
          kind: ObjectKind.MONEDA,
          penaltyId: "sin-2tc",
          winnerMatchId: "m1",
          holderId: "p2",
          exitedAt: T2,
          satisfiedByMatchId: "m2",
        }),
        // Retirada: no genera FULFILL.
        award({
          id: "a3",
          kind: ObjectKind.MONUMENTO,
          penaltyId: "sin-fuertes",
          exitedAt: T4,
          satisfiedByMatchId: null,
        }),
      ],
      throws: [
        objectThrow({ id: "t1" }),
        objectThrow({
          id: "t2",
          returned: true,
          at: T4,
          award: { kind: ObjectKind.MONEDA, penaltyId: "sin-2tc" },
        }),
      ],
      matchStarts: new Map([
        ["m1", T1],
        ["m2", T2],
      ]),
      players: CUATRO_JUGADORES,
    };

    const events = buildObjectHistoryEvents(sources);
    const byId = new Map(events.map((row) => [row.id, row]));

    expect(byId.get("award:a1")).toMatchObject({
      kind: "AWARD",
      at: T1,
      player: { name: "Uno", profileId: 101 },
      opponent: null,
      object: { kind: ObjectKind.RELIQUIA, name: "Reliquia pagana" },
      penalty: {
        id: "sin-guarecer-reliquias",
        text: "No se pueden guarecer reliquias.",
      },
    });

    expect(byId.get("award:a2")).toMatchObject({
      kind: "AWARD",
      at: T1,
      player: { name: "Uno", profileId: 101 },
      object: { kind: ObjectKind.MONEDA, name: "Moneda del Rey falsificada" },
    });

    expect(byId.get("fulfill:a2")).toMatchObject({
      kind: "FULFILL",
      at: T2,
      // El sujeto es el portador, no el ganador.
      player: { name: "Dos", profileId: 202 },
      opponent: null,
      object: { kind: ObjectKind.MONEDA, name: "Moneda del Rey falsificada" },
      penalty: { id: "sin-2tc", text: "No se puede hacer 2TC." },
    });

    expect(byId.get("throw:t1")).toMatchObject({
      kind: "THROW",
      at: T3,
      player: { name: "Uno", profileId: 101 },
      opponent: { name: "Dos", profileId: 202 },
    });

    expect(byId.get("throw:t2")).toMatchObject({
      kind: "RETURN",
      at: T4,
      player: { name: "Uno", profileId: 101 },
      opponent: { name: "Dos", profileId: 202 },
      object: { kind: ObjectKind.MONEDA, name: "Moneda del Rey falsificada" },
    });

    // El premio retirado no tiene cumplimiento.
    expect(byId.has("fulfill:a3")).toBe(false);
    expect(events).toHaveLength(6);
  });

  it("cae a award.day y a exitedAt cuando la partida citada ya no existe", () => {
    const sources = {
      awards: [
        award({
          id: "sin-partida",
          winnerMatchId: "desaparecida",
          day: new Date("2026-09-05T00:00:00.000Z"),
        }),
        award({
          id: "cumplido-sin-partida",
          satisfiedByMatchId: "desaparecida",
          exitedAt: T4,
        }),
      ],
      throws: [],
      matchStarts: new Map<string, Date>(),
      players: CUATRO_JUGADORES,
    };

    const events = buildObjectHistoryEvents(sources);
    const byId = new Map(events.map((row) => [row.id, row]));

    expect(byId.get("award:sin-partida")?.at).toEqual(
      new Date("2026-09-05T00:00:00.000Z"),
    );
    expect(byId.get("fulfill:cumplido-sin-partida")?.at).toEqual(T4);
  });

  it("una retirada no genera FULFILL aunque tenga exitedAt", () => {
    const sources = {
      awards: [award({ id: "retirado", exitedAt: T4, satisfiedByMatchId: null })],
      throws: [],
      matchStarts: new Map([["m1", T1]]),
      players: CUATRO_JUGADORES,
    };

    const events = buildObjectHistoryEvents(sources);

    expect(events.map((row) => row.id)).toEqual(["award:retirado"]);
  });

  it("descarta al sujeto no aprobado y conserva el evento con opponent nulo", () => {
    const players = roster([
      { id: "p1", name: "Uno", profileId: 101 },
      { id: "p2", name: "Dos", profileId: 202, status: PlayerStatus.PENDING },
    ]);
    const sources = {
      awards: [
        // Ganador no aprobado: ni premio ni cumplimiento.
        award({
          id: "ganador-pendiente",
          winnerId: "p2",
          holderId: "p2",
          satisfiedByMatchId: "m2",
          exitedAt: T2,
        }),
      ],
      throws: [
        // Lanzador no aprobado: el evento no sale.
        objectThrow({ id: "desde-pendiente", fromId: "p2", toId: "p1" }),
        // Objetivo no aprobado: el evento sale con el contrario a null.
        objectThrow({ id: "hacia-pendiente", fromId: "p1", toId: "p2" }),
      ],
      matchStarts: new Map([
        ["m1", T1],
        ["m2", T2],
      ]),
      players,
    };

    const events = buildObjectHistoryEvents(sources);

    expect(events.map((row) => row.id)).toEqual(["throw:hacia-pendiente"]);
    expect(events[0].player).toEqual({ name: "Uno", profileId: 101 });
    expect(events[0].opponent).toBeNull();
  });

  it("resuelve el texto de la desventaja y deja null si su id ya no está", () => {
    const sources = {
      awards: [award({ id: "desconocida", penaltyId: "ya-no-existe" })],
      throws: [],
      matchStarts: new Map([["m1", T1]]),
      players: CUATRO_JUGADORES,
    };

    const [row] = buildObjectHistoryEvents(sources);

    expect(row.penalty).toEqual({ id: "ya-no-existe", text: null });
  });
});

describe("compareObjectHistory", () => {
  it("ordena por fecha descendente", () => {
    expect(compareObjectHistory(event({ id: "a", at: T2 }), event({ id: "b", at: T1 }))).toBeLessThan(
      0,
    );
    expect(compareObjectHistory(event({ id: "a", at: T1 }), event({ id: "b", at: T2 }))).toBeGreaterThan(
      0,
    );
  });

  it("a igual instante desempata por tipo y después por id", () => {
    const premio = event({ id: "a", at: T1, kind: "AWARD" });
    const lanzamiento = event({ id: "b", at: T1, kind: "THROW" });
    const cumplimiento = event({ id: "c", at: T1, kind: "FULFILL" });

    expect(compareObjectHistory(premio, lanzamiento)).toBeLessThan(0);
    expect(compareObjectHistory(lanzamiento, cumplimiento)).toBeLessThan(0);
    expect(compareObjectHistory(event({ id: "a", at: T1 }), event({ id: "b", at: T1 }))).toBeLessThan(
      0,
    );
  });

  it("es un orden total: ningún par de filas distintas empata", () => {
    const rows = [
      event({ id: "b", at: T1 }),
      event({ id: "a", at: T1 }),
      event({ id: "a", at: T1, kind: "THROW" }),
      event({ id: "z", at: T1, kind: "RETURN" }),
      event({ id: "a", at: T2, kind: "FULFILL" }),
    ].sort(compareObjectHistory);

    for (let i = 0; i < rows.length; i += 1) {
      for (let j = i + 1; j < rows.length; j += 1) {
        expect(compareObjectHistory(rows[i], rows[j])).toBeLessThan(0);
        expect(compareObjectHistory(rows[j], rows[i])).toBeGreaterThan(0);
      }
    }
  });
});

describe("filterObjectHistoryEvents", () => {
  it("aplica el rango inclusivo del historial: el día final entra completo", () => {
    const rango = dateRangeWhere("2026-09-01", "2026-09-30");
    const rows = [
      event({ id: "antes", at: new Date("2026-08-31T23:59:59.999Z") }),
      event({ id: "primero", at: new Date("2026-09-01T00:00:00.000Z") }),
      event({ id: "ultimo", at: new Date("2026-09-30T23:59:59.999Z") }),
      event({ id: "despues", at: new Date("2026-10-01T00:00:00.000Z") }),
    ];

    const filtradas = filterObjectHistoryEvents(rows, {
      profileId: null,
      rango,
      editionFrom: null,
    });

    expect(filtradas.map((row) => row.id)).toEqual(["primero", "ultimo"]);
  });

  it("acota a la edición activa si hay suelo de ventana", () => {
    const rows = [
      event({ id: "anterior", at: new Date("2026-08-31T00:00:00.000Z") }),
      event({ id: "dentro", at: new Date("2026-09-01T00:00:00.000Z") }),
    ];

    const filtradas = filterObjectHistoryEvents(rows, {
      profileId: null,
      rango: {},
      editionFrom: new Date("2026-09-01T00:00:00.000Z"),
    });

    expect(filtradas.map((row) => row.id)).toEqual(["dentro"]);
  });

  it("un cumplimiento posterior entra aunque el premio sea anterior al rango", () => {
    const sources = {
      awards: [award({ id: "tardio", satisfiedByMatchId: "m2", exitedAt: T2 })],
      throws: [],
      matchStarts: new Map([
        ["m1", T1],
        ["m2", T4],
      ]),
      players: CUATRO_JUGADORES,
    };

    const filtradas = filterObjectHistoryEvents(buildObjectHistoryEvents(sources), {
      profileId: null,
      rango: dateRangeWhere("2026-09-03", "2026-09-30"),
      editionFrom: null,
    });

    // El premio se dio el día 1 y quedó fuera del rango; el cumplimiento, el 4, entra.
    expect(filtradas.map((row) => row.id)).toEqual(["fulfill:tardio"]);
  });

  it("el filtro de participante incluye los lanzamientos que recibió", () => {
    const sources = {
      awards: [award({ id: "a1", winnerId: "p1", holderId: "p1" })],
      throws: [
        objectThrow({ id: "enviado", fromId: "p1", toId: "p2" }),
        objectThrow({ id: "recibido", fromId: "p3", toId: "p2" }),
        objectThrow({ id: "ajeno", fromId: "p3", toId: "p4" }),
      ],
      matchStarts: new Map([["m1", T1]]),
      players: CUATRO_JUGADORES,
    };

    const filtradas = filterObjectHistoryEvents(buildObjectHistoryEvents(sources), {
      profileId: 202,
      rango: {},
      editionFrom: null,
    });

    expect(filtradas.map((row) => row.id).sort()).toEqual(["throw:enviado", "throw:recibido"]);
    expect(
      filtradas.every(
        (row) => row.player.profileId === 202 || row.opponent?.profileId === 202,
      ),
    ).toBe(true);
  });
});

describe("paginateObjectHistory", () => {
  const rows = Array.from({ length: 5 }, (_, index) =>
    event({ id: `e${index}`, at: new Date(Date.UTC(2026, 8, 1, 10, index)) }),
  );

  it("acota la página pedida a la última con filas", async () => {
    const pagina = await paginateObjectHistory(rows, { page: 99, pageSize: 2 });

    expect(pagina).toMatchObject({ total: 5, page: 3, pageSize: 2, pageCount: 3 });
    expect(pagina.rows.map((row) => row.id)).toEqual(["e4"]);
  });

  it("devuelve página 1 y pageCount 0 cuando no hay filas", async () => {
    const pagina = await paginateObjectHistory([], { page: 7, pageSize: 10 });

    expect(pagina).toEqual({
      rows: [],
      total: 0,
      page: 1,
      pageSize: 10,
      pageCount: 0,
    });
  });
});

describe("readObjectHistoryFilters", () => {
  it("reutiliza el parser de profileId y los bordes de fecha", () => {
    expect(readObjectHistoryFilters({})).toEqual({ profileId: null, rango: {} });
    expect(readObjectHistoryFilters({ jugador: "21050396" }).profileId).toBe(21050396);
    expect(readObjectHistoryFilters({ jugador: "inventado" }).profileId).toBeNull();

    const rango = readObjectHistoryFilters({ from: "2026-09-01", to: "2026-09-30" }).rango;

    expect(rango.gte).toEqual(new Date("2026-09-01T00:00:00.000Z"));
    expect(rango.lt).toEqual(new Date("2026-10-01T00:00:00.000Z"));
  });
});
