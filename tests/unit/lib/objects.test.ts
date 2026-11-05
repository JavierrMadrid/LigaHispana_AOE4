import { describe, expect, it } from "vitest";

import { ObjectKind } from "@/generated/prisma/enums";
import {
  OBJECT_CATALOG,
  OBJECT_KINDS,
  isMatchBlocked,
  objectDay,
  objectKindForWinReason,
  pickDailyAwards,
  pickPenalty,
  returnProbability,
  sameTargetBlocked,
  sameThrowerBlocked,
  throwReturnProbability,
  type AwardMatch,
} from "@/lib/objects";

/**
 * Los objetos utilizables del POC de la issue 134.
 *
 * Todo lo que se prueba aquí es puro: las fechas y el azar entran por parámetro y
 * no hay base de datos, red ni reloj. Los casos están escritos con fechas UTC
 * explícitas para que el día UTC no dependa del huso de la máquina que ejecuta los
 * tests.
 */

function at(iso: string): Date {
  return new Date(iso);
}

function match(overrides: Partial<AwardMatch> & { id: string }): AwardMatch {
  return {
    gameId: overrides.id,
    playerId: `p-${overrides.id}`,
    startedAt: at("2026-11-04T10:00:00.000Z"),
    winReason: "Conquest",
    ...overrides,
  };
}

describe("objectDay", () => {
  it("lleva cualquier instante del día a la medianoche UTC", () => {
    expect(objectDay(at("2026-11-04T00:00:00.000Z")).toISOString()).toBe(
      "2026-11-04T00:00:00.000Z",
    );
    expect(objectDay(at("2026-11-04T23:59:59.999Z")).toISOString()).toBe(
      "2026-11-04T00:00:00.000Z",
    );
    // El borde superior ya es el día siguiente, no el anterior.
    expect(objectDay(at("2026-11-05T00:00:00.000Z")).toISOString()).toBe(
      "2026-11-05T00:00:00.000Z",
    );
  });

  it("usa el día UTC, no el del huso horario del proceso", () => {
    // 01:30 del día 5 en +02:00 son las 23:30 UTC del día 4.
    expect(objectDay(at("2026-11-05T01:30:00+02:00")).toISOString()).toBe(
      "2026-11-04T00:00:00.000Z",
    );
    // 23:30 del día 4 en -02:00 son las 01:30 UTC del día 5.
    expect(objectDay(at("2026-11-04T23:30:00-02:00")).toISOString()).toBe(
      "2026-11-05T00:00:00.000Z",
    );
  });

  it("no muta la fecha de entrada", () => {
    const input = at("2026-11-04T23:59:00.000Z");

    objectDay(input);

    expect(input.toISOString()).toBe("2026-11-04T23:59:00.000Z");
  });
});

describe("objectKindForWinReason", () => {
  it("mapea los motivos confirmados y los probables sin distinguir mayúsculas", () => {
    expect(objectKindForWinReason("Conquest")).toBe(ObjectKind.MONEDA);
    expect(objectKindForWinReason("conquest")).toBe(ObjectKind.MONEDA);
    expect(objectKindForWinReason("Conquista")).toBe(ObjectKind.MONEDA);
    expect(objectKindForWinReason("Elimination")).toBe(ObjectKind.MONEDA);

    expect(objectKindForWinReason("Sacred Victory")).toBe(ObjectKind.RELIQUIA);
    expect(objectKindForWinReason("SACRED VICTORY")).toBe(ObjectKind.RELIQUIA);
    expect(objectKindForWinReason("Religious Victory")).toBe(ObjectKind.RELIQUIA);
    expect(objectKindForWinReason("Victoria sagrada")).toBe(ObjectKind.RELIQUIA);

    expect(objectKindForWinReason("Wonder")).toBe(ObjectKind.MONUMENTO);
    expect(objectKindForWinReason("Maravilla")).toBe(ObjectKind.MONUMENTO);
  });

  it("tolera espacios de sobra alrededor del literal", () => {
    expect(objectKindForWinReason("  Sacred Victory  ")).toBe(ObjectKind.RELIQUIA);
  });

  it("lo que no mapea no da objeto: ni SURRENDER, ni desconocidos, ni null", () => {
    expect(objectKindForWinReason("Surrender")).toBeNull();
    expect(objectKindForWinReason("Military Victory")).toBeNull();
    expect(objectKindForWinReason("")).toBeNull();
    expect(objectKindForWinReason("   ")).toBeNull();
    expect(objectKindForWinReason(null)).toBeNull();
  });
});

describe("pickDailyAwards", () => {
  it("de cada tipo y día gana la partida más temprana", () => {
    const awards = pickDailyAwards([
      match({ id: "m-tarde", playerId: "tarde", startedAt: at("2026-11-04T18:00:00.000Z") }),
      match({ id: "m-primera", playerId: "primera", startedAt: at("2026-11-04T09:00:00.000Z") }),
      match({ id: "m-media", playerId: "media", startedAt: at("2026-11-04T12:00:00.000Z") }),
    ]);

    expect(awards).toEqual([
      {
        kind: ObjectKind.MONEDA,
        day: at("2026-11-04T00:00:00.000Z"),
        winnerId: "primera",
        winnerMatchId: "m-primera",
        // `heldSince` es el inicio de la partida, no la medianoche del día.
        heldSince: at("2026-11-04T09:00:00.000Z"),
      },
    ]);
  });

  it("con el mismo instante desempata por gameId, y no por el orden de entrada", () => {
    const mismaHora = at("2026-11-04T09:00:00.000Z");
    const partidas = [
      match({ id: "m-b", gameId: "9002", playerId: "b", startedAt: mismaHora }),
      match({ id: "m-a", gameId: "9001", playerId: "a", startedAt: mismaHora }),
    ];

    expect(pickDailyAwards(partidas)[0]?.winnerId).toBe("a");
    expect(pickDailyAwards([...partidas].reverse())[0]?.winnerId).toBe("a");
  });

  it("días distintos generan un objeto por día", () => {
    const awards = pickDailyAwards([
      match({ id: "dia-4", startedAt: at("2026-11-04T10:00:00.000Z") }),
      match({ id: "dia-5", startedAt: at("2026-11-05T00:00:00.000Z") }),
    ]);

    expect(awards.map((award) => award.day.toISOString())).toEqual([
      "2026-11-04T00:00:00.000Z",
      "2026-11-05T00:00:00.000Z",
    ]);
  });

  it("tipos distintos del mismo día conviven, ordenados por el catálogo", () => {
    const awards = pickDailyAwards([
      match({ id: "maravilla", winReason: "Wonder" }),
      match({ id: "conquista", winReason: "Conquest" }),
      match({ id: "sagrada", winReason: "Sacred Victory" }),
    ]);

    expect(awards.map((award) => award.kind)).toEqual([
      ObjectKind.RELIQUIA,
      ObjectKind.MONEDA,
      ObjectKind.MONUMENTO,
    ]);
  });

  it("no genera nada si el motivo no mapea", () => {
    const awards = pickDailyAwards([
      match({ id: "rendicion", winReason: "Surrender" }),
      match({ id: "sin-motivo", winReason: null }),
      match({ id: "raro", winReason: "Military Victory" }),
    ]);

    expect(awards).toEqual([]);
  });

  it("no propone un (tipo, día) que ya existe", () => {
    const awards = pickDailyAwards(
      [match({ id: "m1", startedAt: at("2026-11-04T10:00:00.000Z") })],
      {
        taken: [
          // Una hora cualquiera del mismo día: se normaliza a medianoche antes de comparar.
          { kind: ObjectKind.MONEDA, day: at("2026-11-04T17:45:00.000Z") },
        ],
      },
    );

    expect(awards).toEqual([]);
  });
});

describe("returnProbability", () => {
  it("reparte la diferencia de puestos entre el total de jugadores", () => {
    // 6 - 1 = 5, entre 10 jugadores: 0,5.
    expect(returnProbability({ targetRank: 6, throwerRank: 1, totalPlayers: 10 })).toBe(0.5);
  });

  it("la resta va target menos thrower: lanzar a alguien peor devuelve más", () => {
    const aPeor = returnProbability({ targetRank: 10, throwerRank: 1, totalPlayers: 10 });
    const aMejor = returnProbability({ targetRank: 1, throwerRank: 10, totalPlayers: 10 });

    expect(aPeor).toBe(0.9);
    expect(aMejor).toBe(0.01);
    expect(aMejor).toBeLessThan(aPeor);
  });

  it("acota a [0,01, 0,99]", () => {
    expect(returnProbability({ targetRank: 100, throwerRank: 1, totalPlayers: 10 })).toBe(0.99);
    expect(returnProbability({ targetRank: 1, throwerRank: 1, totalPlayers: 10 })).toBe(0.01);
    expect(returnProbability({ targetRank: 2, throwerRank: 1, totalPlayers: 100 })).toBe(0.01);
  });

  it("con menos de un jugador no hay proporción y devuelve el mínimo", () => {
    expect(returnProbability({ targetRank: 3, throwerRank: 1, totalPlayers: 0 })).toBe(0.01);
    expect(returnProbability({ targetRank: 3, throwerRank: 1, totalPlayers: -4 })).toBe(0.01);
  });
});

describe("throwReturnProbability", () => {
  it("con los dos puestos es la misma probabilidad de `returnProbability`", () => {
    expect(throwReturnProbability({ targetRank: 6, throwerRank: 1, totalPlayers: 10 })).toBe(0.5);
  });

  it("si falta uno de los puestos degrada al mínimo, no lanza", () => {
    // Un alta recién aprobada puede no tener aún fila en `PlayerScore`; el
    // lanzamiento no se bloquea por eso.
    expect(
      throwReturnProbability({ targetRank: null, throwerRank: 1, totalPlayers: 10 }),
    ).toBe(0.01);
    expect(
      throwReturnProbability({ targetRank: 3, throwerRank: null, totalPlayers: 10 }),
    ).toBe(0.01);
  });

  it("con menos de un clasificado también devuelve el mínimo", () => {
    expect(throwReturnProbability({ targetRank: 3, throwerRank: 1, totalPlayers: 0 })).toBe(0.01);
  });
});

describe("pickPenalty", () => {
  it("con draw 0 da la primera y con draw casi 1 la última", () => {
    for (const kind of OBJECT_KINDS) {
      const { penalties } = OBJECT_CATALOG[kind];

      expect(pickPenalty(kind, () => 0)).toBe(penalties[0]);
      expect(pickPenalty(kind, () => 0.999)).toBe(penalties[2]);
      // Un draw de 1 se acota en vez de devolver `undefined`.
      expect(pickPenalty(kind, () => 1)).toBe(penalties[2]);
    }
  });

  it("reparte el rango en tercios", () => {
    const ids = [0, 0.34, 0.67].map((draw) => pickPenalty(ObjectKind.MONEDA, () => draw).id);

    expect(ids).toEqual(["sin-2tc", "sin-militares-5min", "sin-barcos-pesqueros"]);
  });

  it("consume el azar una sola vez", () => {
    let calls = 0;

    pickPenalty(ObjectKind.RELIQUIA, () => {
      calls += 1;

      return 0.5;
    });

    expect(calls).toBe(1);
  });

  it("el catálogo es el del POC: tres objetos, tres desventajas y nueve ids únicos", () => {
    const ids = new Set<string>();

    expect(OBJECT_KINDS).toHaveLength(3);

    for (const kind of OBJECT_KINDS) {
      const definition = OBJECT_CATALOG[kind];

      expect(definition.kind).toBe(kind);
      expect(definition.name.length).toBeGreaterThan(0);
      expect(definition.penalties).toHaveLength(3);

      for (const penalty of definition.penalties) {
        expect(ids.has(penalty.id)).toBe(false);
        expect(penalty.text.length).toBeGreaterThan(0);
        ids.add(penalty.id);
      }
    }

    expect(ids.size).toBe(9);
  });
});

describe("isMatchBlocked", () => {
  const heldSince = at("2026-11-04T10:00:00.000Z");

  it("antes de llegar el objeto, o justo cuando llega, la partida no se bloquea", () => {
    expect(isMatchBlocked(at("2026-11-04T09:59:59.999Z"), { heldSince, exitedAt: null })).toBe(
      false,
    );
    // La comparación es estricta: una partida empezada al mismo instante ya estaba
    // en marcha cuando llegó el objeto.
    expect(isMatchBlocked(heldSince, { heldSince, exitedAt: null })).toBe(false);
  });

  it("pendiente y con la partida empezada después, sí", () => {
    expect(isMatchBlocked(at("2026-11-04T10:00:00.001Z"), { heldSince, exitedAt: null })).toBe(
      true,
    );
    expect(isMatchBlocked(at("2026-11-06T10:00:00.000Z"), { heldSince, exitedAt: null })).toBe(
      true,
    );
  });

  it("con exitedAt solo se bloquea el tramo abierto, y el borde no", () => {
    const exitedAt = at("2026-11-05T00:00:00.000Z");

    expect(isMatchBlocked(at("2026-11-04T23:59:59.999Z"), { heldSince, exitedAt })).toBe(true);
    // La partida que cumple la desventaja sella `exitedAt` en su `startedAt`: cuenta.
    expect(isMatchBlocked(exitedAt, { heldSince, exitedAt })).toBe(false);
    expect(isMatchBlocked(at("2026-11-05T10:00:00.000Z"), { heldSince, exitedAt })).toBe(false);
  });

  it("sin portador no bloquea nada", () => {
    expect(
      isMatchBlocked(at("2026-11-06T10:00:00.000Z"), { heldSince: null, exitedAt: null }),
    ).toBe(false);
  });

  it("vale con una fila de dominio, no hace falta el tipo de Prisma", () => {
    const award = {
      id: "award-1",
      kind: ObjectKind.MONEDA,
      winnerId: "p-1",
      heldSince,
      exitedAt: null,
    };

    expect(isMatchBlocked(at("2026-11-04T11:00:00.000Z"), award)).toBe(true);
  });
});

describe("sameTargetBlocked", () => {
  const day = at("2026-11-04T12:00:00.000Z");

  it("el mismo objetivo el mismo día UTC ya está bloqueado", () => {
    const throws = [{ toId: "p-2", at: at("2026-11-04T08:00:00.000Z") }];

    expect(sameTargetBlocked(throws, "p-2", day)).toBe(true);
  });

  it("otro objetivo, otro día o ningún lanzamiento: no bloquea", () => {
    const throws = [{ toId: "p-2", at: at("2026-11-04T08:00:00.000Z") }];

    expect(sameTargetBlocked(throws, "p-3", day)).toBe(false);
    expect(sameTargetBlocked(throws, "p-2", at("2026-11-05T12:00:00.000Z"))).toBe(false);
    expect(sameTargetBlocked([], "p-2", day)).toBe(false);
  });

  it("el borde de medianoche separa los días", () => {
    const ultimoSegundo = [{ toId: "p-2", at: at("2026-11-04T23:59:59.999Z") }];

    expect(sameTargetBlocked(ultimoSegundo, "p-2", at("2026-11-04T00:00:00.000Z"))).toBe(true);
    expect(sameTargetBlocked(ultimoSegundo, "p-2", at("2026-11-05T00:00:00.000Z"))).toBe(false);
  });
});

describe("sameThrowerBlocked", () => {
  const day = at("2026-11-04T12:00:00.000Z");

  it("el portador que ya lanzó ese día UTC no puede repetir", () => {
    const throws = [{ fromId: "p-1", toId: "p-2", at: at("2026-11-04T08:00:00.000Z") }];

    expect(sameThrowerBlocked(throws, "p-1", day)).toBe(true);
  });

  it("cuenta el lanzamiento se devolviera o no: el límite es por persona y día", () => {
    // El portador que lanzó ayer sí puede lanzar hoy; otro portador, no.
    const ayer = [{ fromId: "p-1", toId: "p-2", at: at("2026-11-03T23:59:59.999Z") }];

    expect(sameThrowerBlocked(ayer, "p-1", day)).toBe(false);
    expect(sameThrowerBlocked(ayer, "p-9", day)).toBe(false);
  });

  it("un objeto que cambió de manos deja lanzar al portador nuevo", () => {
    const throws = [{ fromId: "p-1", toId: "p-2", at: at("2026-11-04T08:00:00.000Z") }];

    expect(sameThrowerBlocked(throws, "p-2", day)).toBe(false);
  });
});
