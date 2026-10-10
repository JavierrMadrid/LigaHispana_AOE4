import { describe, expect, it } from "vitest";

import {
  IMPARABLE_ID,
  JUGON_ID,
  OBJECTIVE_POINTS,
  POLIFACETICO_ID,
  computeObjectives,
  objectiveStanding,
  type ObjectiveContender,
  type ObjectiveOption,
  type PlayerAggregate,
} from "@/lib/objectives";
import { DEFAULT_RULESET } from "@/lib/scoring";

/**
 * El motor de objetivos en lo que se puede comprobar sin base de datos.
 *
 * `computeObjectives` es puro: recibe los agregados por jugador (que en el motor
 * salen de `loadObjectivePlayers`) y devuelve el reparto. Aquí se construyen esos
 * agregados a mano, así que se puede comprobar el reparto de los **logros** (que
 * cobra todo el que cumple), el tope de `imparable` y los umbrales de los
 * subobjetivos sin tocar Postgres.
 */

/** Registro de civilización de un jugador, con lo mínimo que leen los objetivos. */
function civ(matches: number, wins: number, lastWinAt = 0) {
  return { matches, wins, lastWinAt };
}

/** Agregado mínimo: todo a cero salvo lo que diga el caso. */
function aggregate(profileId: number, overrides: Partial<PlayerAggregate> = {}): PlayerAggregate {
  return {
    playerId: `p${profileId}`,
    profileId,
    name: `Jugador ${profileId}`,
    avatarUrl: null,
    rankLevel: null,
    matches: 0,
    wins: 0,
    lastMatchAt: 0,
    lastWinAt: 0,
    streak: 0,
    streakEndsAt: 0,
    shortWins: 0,
    longWins: 0,
    playedDays: new Set(),
    byFormat: new Map(),
    byCiv: new Map(),
    byMap: new Map(),
    ...overrides,
  };
}

function optionById(options: ObjectiveOption[], id: string): ObjectiveOption {
  const option = options.find((candidate) => candidate.id === id);

  if (option === undefined) {
    throw new Error(`No existe el objetivo ${id}`);
  }

  return option;
}

function playerIds(profileIds: { profileId: number }[]): number[] {
  return profileIds.map((item) => item.profileId).sort((a, b) => a - b);
}

describe("objetivos de logro: los cobra todo el que cumple", () => {
  it("un lider-<civ> reparte entre todos los que llegan al umbral de victorias", () => {
    const players = [
      aggregate(1, { byCiv: new Map([["french", civ(3, 3)]]) }),
      aggregate(2, { byCiv: new Map([["french", civ(5, 4)]]) }),
      // Con 2 victorias no llega al umbral de 3: aparece en el ranking, no cobra.
      aggregate(3, { byCiv: new Map([["french", civ(4, 2)]]) }),
    ];

    const { options, pointsByPlayer } = computeObjectives(players, DEFAULT_RULESET, []);

    const lider = optionById(options, "lider-french");

    expect(lider.kind).toBe("achievement");
    expect(lider.holder).toBeNull();
    expect(lider.target).toEqual({ unit: "victorias", value: 3 });
    expect(playerIds(lider.beneficiaries)).toEqual([1, 2]);
    expect(lider.beneficiaries.every((b) => b.points === lider.points)).toBe(true);

    // Los tres están en el ranking (tienen victorias con la civ), pero solo los
    // dos que cumplen salen marcados como elegibles.
    expect(lider.ranking.length).toBe(3);
    expect(lider.ranking.filter((c) => c.eligible).length).toBe(2);

    expect(pointsByPlayer.get("p1")?.earned).toContain("lider-french");
    expect(pointsByPlayer.get("p2")?.earned).toContain("lider-french");
    expect(pointsByPlayer.get("p3")?.earned ?? []).not.toContain("lider-french");
  });

  it("acolito-<civ> exige partidas jugadas, no victorias", () => {
    const players = [
      aggregate(1, { byCiv: new Map([["english", civ(3, 0)]]) }),
      aggregate(2, { byCiv: new Map([["english", civ(2, 2)]]) }),
    ];

    const { options } = computeObjectives(players, DEFAULT_RULESET, []);
    const acolito = optionById(options, "acolito-english");

    expect(acolito.target).toEqual({ unit: "partidas", value: 3 });
    expect(playerIds(acolito.beneficiaries)).toEqual([1]);
    expect(acolito.ranking.find((c) => c.profileId === 2)?.eligible).toBe(false);
  });

  it("agresor e imbatible usan sus umbrales propios", () => {
    const players = [
      aggregate(1, { shortWins: 3, streak: 5 }),
      aggregate(2, { shortWins: 2, streak: 4 }),
    ];

    const { options } = computeObjectives(players, DEFAULT_RULESET, []);

    expect(playerIds(optionById(options, "agresor").beneficiaries)).toEqual([1]);
    expect(playerIds(optionById(options, "imbatible").beneficiaries)).toEqual([1]);
  });

  it("polifacetico y jugon son las cabezas de sus familias", () => {
    const players = [aggregate(1, { byCiv: new Map([["french", civ(3, 3)]]) })];
    const { options } = computeObjectives(players, DEFAULT_RULESET, []);

    expect(optionById(options, POLIFACETICO_ID).parent).toBeNull();
    expect(optionById(options, JUGON_ID).parent).toBeNull();
    expect(optionById(options, "lider-french").parent).toBe(POLIFACETICO_ID);
    expect(optionById(options, "acolito-french").parent).toBe(JUGON_ID);
  });

  it("una competición sigue teniendo un único poseedor", () => {
    const players = [
      aggregate(1, { byCiv: new Map([["french", civ(3, 3)]]) }),
      aggregate(2, { byCiv: new Map([["french", civ(5, 4)]]) }),
    ];

    const { options } = computeObjectives(players, DEFAULT_RULESET, []);
    const masterizando = optionById(options, "masterizando-french");

    expect(masterizando.kind).toBe("competition");
    expect(masterizando.holder?.profileId).toBe(2);
    expect(masterizando.beneficiaries).toEqual([]);
    expect(masterizando.target).toBeNull();
  });
});

describe("imparable: 1 punto por día natural, con tope", () => {
  function days(count: number): Set<string> {
    return new Set(Array.from({ length: count }, (_, index) => `2026-09-${index + 1}`));
  }

  it("cobra un punto por día y se queda en el tope aunque haya más días", () => {
    const players = [
      aggregate(1, { playedDays: days(20), matches: 20 }),
      aggregate(2, { playedDays: days(5), matches: 5 }),
    ];

    const { options } = computeObjectives(players, DEFAULT_RULESET, []);
    const imparable = optionById(options, IMPARABLE_ID);

    expect(imparable.target).toEqual({ unit: "dias", value: 14 });
    // El valor del ranking es el número real de días (sin tope)…
    expect(imparable.ranking.find((c) => c.profileId === 1)?.value).toBe(20);
    // …y los puntos que cobra cada uno van con tope.
    expect(imparable.beneficiaries.find((b) => b.profileId === 1)?.points).toBe(14);
    expect(imparable.beneficiaries.find((b) => b.profileId === 2)?.points).toBe(5);
  });
});

describe("por tierra y agua: cubre cada mapa del pool", () => {
  it("solo se completa cuando todos los mapas del pool llegan al mínimo", () => {
    const completo = aggregate(1, {
      byMap: new Map([
        ["Gorge", 3],
        ["Dry Arabia", 3],
      ]),
    });
    const parcial = aggregate(2, {
      byMap: new Map([
        ["Gorge", 3],
        ["Dry Arabia", 1],
      ]),
    });

    const { options } = computeObjectives([completo, parcial], DEFAULT_RULESET, [
      "Gorge",
      "Dry Arabia",
    ]);
    const objetivo = optionById(options, "por-tierra-y-agua");

    expect(objetivo.target).toEqual({ unit: "mapas", value: 2 });
    expect(playerIds(objetivo.beneficiaries)).toEqual([1]);
    expect(objetivo.ranking.find((c) => c.profileId === 2)?.value).toBe(1);
  });
});

describe("objectiveStanding", () => {
  function contender(profileId: number, value: number): ObjectiveContender {
    return {
      profileId,
      name: `Jugador ${profileId}`,
      avatarUrl: null,
      profileUrl: `https://aoe4world.com/players/${profileId}`,
      value,
      matches: value,
      eligible: true,
      detail: null,
    };
  }

  const ranking = [contender(1, 50), contender(2, 40), contender(3, 30)];

  it("el líder está en la posición 1 y a distancia 0", () => {
    expect(objectiveStanding(ranking, 1)).toEqual({ position: 1, distance: 0 });
  });

  it("un participante intermedio tiene su puesto y la diferencia con el líder", () => {
    expect(objectiveStanding(ranking, 3)).toEqual({ position: 3, distance: 20 });
  });

  it("fuera del ranking no se inventa ni posición ni distancia", () => {
    expect(objectiveStanding(ranking, 99)).toEqual({ position: null, distance: null });
  });

  it("un ranking vacío no da posición a nadie", () => {
    expect(objectiveStanding([], 1)).toEqual({ position: null, distance: null });
  });
});

describe("catálogo de puntos", () => {
  it("cada objetivo tiene puntos positivos y una única definición", () => {
    for (const [id, points] of Object.entries(OBJECTIVE_POINTS)) {
      expect(points, `puntos de ${id}`).toBeGreaterThan(0);
    }
  });
});
