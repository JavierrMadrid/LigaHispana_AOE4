import { describe, expect, it } from "vitest";

import {
  ANSIOSO_ID,
  DEFENDER_ID,
  FAST_CASTLE_ID,
  FAST_FEUDAL_ID,
  FAST_IMPERIAL_ID,
  IMPARABLE_ID,
  JUGON_ID,
  OBJECTIVES_SNAPSHOT_VERSION,
  OBJECTIVE_COUNT,
  OBJECTIVE_DEFINITIONS,
  OBJECTIVE_POINTS,
  POLIFACETICO_ID,
  POR_TIERRA_ID,
  VICTORIAS_ID,
  apmRunStreak,
  computeObjectives,
  currentTournamentStreak,
  hasFixedPrize,
  matchAchievements,
  objectiveStanding,
  objectivesSnapshotFingerprint,
  readObjectivesSnapshotValue,
  type ObjectiveContender,
  type ObjectiveOption,
  type ObjectiveView,
  type PlayerAggregate,
} from "@/lib/objectives";
import { DEFAULT_RULESET, RULESET_VERSION } from "@/lib/scoring";

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
    currentStreak: null,
    shortWins: 0,
    longWins: 0,
    apmStreak: 0,
    apmStreakEndsAt: 0,
    fastFeudal: 0,
    fastCastle: 0,
    fastImperial: 0,
    defenderMatches: 0,
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

/** Filas mínimas para la racha actual: solo cuenta el `result`. */
function results(...values: string[]): { result: string }[] {
  return values.map((result) => ({ result }));
}

describe("currentTournamentStreak", () => {
  it("sin partidas devuelve null (no 0)", () => {
    expect(currentTournamentStreak([])).toBeNull();
  });

  it("una victoria es +1", () => {
    expect(currentTournamentStreak(results("WIN"))).toBe(1);
  });

  it("una victoria seguida de una derrota es -1", () => {
    expect(currentTournamentStreak(results("WIN", "LOSS"))).toBe(-1);
  });

  it("una derrota y dos victorias es +2 (mira el tramo final)", () => {
    expect(currentTournamentStreak(results("LOSS", "WIN", "WIN"))).toBe(2);
  });

  it("dos derrotas seguidas es -2", () => {
    expect(currentTournamentStreak(results("LOSS", "LOSS"))).toBe(-2);
  });
});

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

describe("objetivos desactivados: no se computan, no se publican y no dan puntos", () => {
  /**
   * Un ruleset con objetivos apagados.
   *
   * Se arma a mano y no con `mergeRuleset()` porque lo que se prueba aquí es el
   * **cómputo**, no la validación del documento: `computeObjectives` solo mira
   * `disabledObjectives` y los puntos, no la etiqueta.
   */
  function conDesactivados(...ids: string[]): typeof DEFAULT_RULESET {
    return { ...DEFAULT_RULESET, disabledObjectives: ids };
  }

  it("un objetivo desactivado no sale en las opciones ni reparte puntos", () => {
    const players = [aggregate(1, { byCiv: new Map([["french", civ(3, 3)]]) })];

    const { options, pointsByPlayer, awarded, holders } = computeObjectives(
      players,
      conDesactivados("lider-french"),
      [],
    );

    expect(options.some((option) => option.id === "lider-french")).toBe(false);
    expect(pointsByPlayer.get("p1")?.earned ?? []).not.toContain("lider-french");
    expect(awarded.some((entry) => entry.id === "lider-french")).toBe(false);

    // Y lo que **no** se apaga sigue igual: la hermana del mismo registro de civ, la
    // cabeza de la familia y la competición.
    expect(optionById(options, "acolito-french").beneficiaries.map((b) => b.profileId)).toEqual([1]);
    expect(optionById(options, POLIFACETICO_ID)).toBeDefined();
    expect(optionById(options, "masterizando-french").holder?.profileId).toBe(1);
    // Los objetivos que quedan activos siguen contando como "cobrados".
    expect(holders).toBeGreaterThan(0);
  });

  it("una competición desactivada no se lleva los puntos de nadie", () => {
    const players = [
      aggregate(1, { matches: 10, lastMatchAt: 100 }),
      aggregate(2, { matches: 5, lastMatchAt: 200 }),
    ];

    const activo = computeObjectives(players, DEFAULT_RULESET, []);
    const apagado = computeObjectives(players, conDesactivados("loco-por-ganar"), []);

    // Con el objetivo activo lo cobra el que más partidas jugó…
    expect(activo.pointsByPlayer.get("p1")?.earned).toContain("loco-por-ganar");
    // …y apagado no lo cobra nadie, ni siquiera aparece en las opciones.
    expect(apagado.pointsByPlayer.get("p1")?.earned ?? []).not.toContain("loco-por-ganar");
    expect(apagado.options.some((option) => option.id === "loco-por-ganar")).toBe(false);
  });

  it("apagar la cabeza de una familia no apaga a sus hijos", () => {
    // Es la decisión del documento: la familia es una agrupación de la interfaz, no
    // una dependencia, así que cada objetivo se apaga por su id.
    const players = [aggregate(1, { byCiv: new Map([["french", civ(3, 3)]]) })];

    const { options } = computeObjectives(players, conDesactivados(POLIFACETICO_ID), []);

    expect(options.some((option) => option.id === POLIFACETICO_ID)).toBe(false);
    expect(optionById(options, "lider-french").parent).toBe(POLIFACETICO_ID);
    expect(optionById(options, "lider-french").beneficiaries.map((b) => b.profileId)).toEqual([1]);
  });

  it("con el catálogo entero apagado no queda ninguna opción ni ningún punto", () => {
    const players = [
      aggregate(1, { matches: 5, wins: 3, byCiv: new Map([["french", civ(3, 3)]]) }),
    ];

    const { options, pointsByPlayer, awarded } = computeObjectives(
      players,
      conDesactivados(...Object.keys(OBJECTIVE_POINTS)),
      [],
    );

    expect(options).toEqual([]);
    expect(awarded).toEqual([]);
    expect(pointsByPlayer.size).toBe(0);
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

  it("las repeticiones son los días reales, sin el tope de los puntos", () => {
    // Es lo que permite pintar "20×Imparable +14": se cobran 14 puntos, pero el
    // objetivo se ha conseguido 20 veces.
    const players = [aggregate(1, { playedDays: days(20), matches: 20 })];
    const { options } = computeObjectives(players, DEFAULT_RULESET, []);

    expect(optionById(options, IMPARABLE_ID).beneficiaries[0]).toMatchObject({
      points: 14,
      count: 20,
    });
  });
});

describe("victorias: puntos por victoria, sin tope", () => {
  it("paga pointsPerWin por cada victoria y anota las victorias como repeticiones", () => {
    const players = [
      aggregate(1, { wins: 4, matches: 9, lastWinAt: 500 }),
      aggregate(2, { wins: 1, matches: 2, lastWinAt: 200 }),
      // Sin victorias no disputa el objetivo: no entra ni en el ranking.
      aggregate(3, { wins: 0, matches: 3 }),
    ];

    const { options, pointsByPlayer } = computeObjectives(players, DEFAULT_RULESET, []);
    const victorias = optionById(options, VICTORIAS_ID);

    expect(victorias.kind).toBe("achievement");
    expect(victorias.holder).toBeNull();
    // Sin umbral: el objetivo se repite con cada victoria y no se completa.
    expect(victorias.target).toBeNull();
    expect(playerIds(victorias.beneficiaries)).toEqual([1, 2]);
    expect(victorias.beneficiaries[0]).toMatchObject({ points: 8, count: 4 });
    expect(victorias.beneficiaries[1]).toMatchObject({ points: 2, count: 1 });

    expect(pointsByPlayer.get("p1")?.awards[VICTORIAS_ID]).toEqual({ points: 8, count: 4 });
    expect(pointsByPlayer.get("p3")?.earned ?? []).not.toContain(VICTORIAS_ID);
  });

  it("el importe sale de `pointsPerWin`, no de un punto guardado para el objetivo", () => {
    // Es la fuente única: un `objectives["victorias"]` retocado se ignora.
    const ruleset = { ...DEFAULT_RULESET, pointsPerWin: 5, objectives: { ...OBJECTIVE_POINTS, [VICTORIAS_ID]: 99 } };
    const players = [aggregate(1, { wins: 3, matches: 3, lastWinAt: 100 })];

    const { options, pointsByPlayer } = computeObjectives(players, ruleset, []);

    expect(optionById(options, VICTORIAS_ID).points).toBe(5);
    expect(optionById(options, VICTORIAS_ID).beneficiaries[0]?.points).toBe(15);
    expect(pointsByPlayer.get("p1")?.awards[VICTORIAS_ID]).toEqual({ points: 15, count: 3 });
  });

  it("el ranking son todos los que han ganado algo, ordenados por victorias", () => {
    const players = [
      aggregate(1, { wins: 1, matches: 5 }),
      aggregate(2, { wins: 6, matches: 9 }),
      aggregate(3, { wins: 0, matches: 2 }),
    ];

    const { options } = computeObjectives(players, DEFAULT_RULESET, []);
    const victorias = optionById(options, VICTORIAS_ID);

    expect(playerIds(victorias.ranking)).toEqual([1, 2]);
    expect(victorias.ranking[0].profileId).toBe(2);
    expect(victorias.ranking.every((contender) => contender.eligible)).toBe(true);
  });
});

describe("hasFixedPrize: qué cuenta la suma nominal", () => {
  function definition(id: string) {
    const found = OBJECTIVE_DEFINITIONS.find((item) => item.id === id);

    if (found === undefined) {
      throw new Error(`No existe el objetivo ${id}`);
    }

    return found;
  }

  it("todo el catálogo reparte un premio fijo menos el objetivo de victorias", () => {
    const sinPremio = OBJECTIVE_DEFINITIONS.filter((item) => !hasFixedPrize(item));

    expect(sinPremio.map((item) => item.id)).toEqual([VICTORIAS_ID]);
  });

  it("los objetivos con tope sí cuentan, incluido `por-tierra-y-agua`", () => {
    // Su tope es el tamaño del pool y solo se conoce al calcular, pero el premio es
    // fijo: no crece con las partidas.
    expect(hasFixedPrize(definition(POR_TIERRA_ID))).toBe(true);
    expect(hasFixedPrize(definition(IMPARABLE_ID))).toBe(true);
    expect(hasFixedPrize(definition("rey-1v1"))).toBe(true);
    expect(hasFixedPrize(definition(VICTORIAS_ID))).toBe(false);
  });

  it("el catálogo nominal sigue sumando 4.721 puntos", () => {
    // Es la cifra de `docs/OBJETIVOS.md`, que es la que resume la banda de
    // `/puntuacion`. `victorias` queda fuera porque reparte por victoria y sin tope.
    const total = OBJECTIVE_DEFINITIONS.filter(hasFixedPrize).reduce(
      (sum, item) => sum + item.points,
      0,
    );

    expect(total).toBe(4721);
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

  it("publica los mapas que faltan, con las partidas que faltan en cada uno", () => {
    // `missing` es 1..3 y los mapas completos no aparecen; el umbral por mapa no se
    // publica porque el dato ya va masticado. El jugador tiene `Gorge` completo, que
    // es lo que le mete en el ranking del objetivo.
    const jugador = aggregate(2, {
      byMap: new Map([
        ["Gorge", 3],
        ["Dry Arabia", 2],
        ["Baltic", 1],
        ["Atacama", 0],
      ]),
    });

    const { options } = computeObjectives([jugador], DEFAULT_RULESET, [
      "Gorge",
      "Dry Arabia",
      "Baltic",
      "Atacama",
      "Nagari",
    ]);
    const contender = optionById(options, "por-tierra-y-agua").ranking[0];

    expect(contender.mapGaps).toEqual([
      { map: "Dry Arabia", missing: 1 },
      { map: "Baltic", missing: 2 },
      // `Atacama` y `Nagari` empatan a 3 faltantes: el orden del pool los deja en el
      // mismo orden en que están en el pool.
      { map: "Atacama", missing: 3 },
      { map: "Nagari", missing: 3 },
    ]);
  });

  it("los objetivos que no son de mapas no publican avance por mapa", () => {
    const jugador = aggregate(1, { wins: 3, matches: 4, byCiv: new Map([["french", civ(3, 3)]]) });
    const { options } = computeObjectives([jugador], DEFAULT_RULESET, ["Gorge"]);

    expect(optionById(options, VICTORIAS_ID).ranking[0].mapGaps).toBeUndefined();
    expect(optionById(options, "lider-french").ranking[0].mapGaps).toBeUndefined();
    expect(optionById(options, "masterizando-french").holder?.mapGaps).toBeUndefined();
  });
});

describe("los objetivos del summary", () => {
  it("ansioso usa la racha de APM: umbral 3 y el valor es la racha más larga", () => {
    const players = [
      aggregate(1, { apmStreak: 3, apmStreakEndsAt: 500, matches: 6, wins: 2 }),
      // Con 2 seguidas aparece en el ranking pero no cobra.
      aggregate(2, { apmStreak: 2, apmStreakEndsAt: 400, matches: 5, wins: 4 }),
    ];

    const { options, pointsByPlayer } = computeObjectives(players, DEFAULT_RULESET, []);

    const ansioso = optionById(options, ANSIOSO_ID);

    expect(ansioso.kind).toBe("achievement");
    expect(ansioso.group).toBe("racha");
    expect(ansioso.target).toEqual({ unit: "racha-partidas", value: 3 });
    expect(ansioso.points).toBe(6);
    expect(playerIds(ansioso.beneficiaries)).toEqual([1]);
    expect(ansioso.ranking.find((c) => c.profileId === 2)?.eligible).toBe(false);
    expect(pointsByPlayer.get("p1")?.awards[ANSIOSO_ID]).toEqual({ points: 6, count: 1 });
  });

  it("los tres avance-relampago-* se cobran con una sola partida", () => {
    const players = [
      aggregate(1, { fastFeudal: 2, fastCastle: 1, fastImperial: 0, matches: 6 }),
      aggregate(2, { fastFeudal: 0, fastCastle: 0, fastImperial: 0, matches: 3 }),
    ];

    const { options } = computeObjectives(players, DEFAULT_RULESET, []);

    const esperado = [
      [FAST_FEUDAL_ID, 4, 2],
      [FAST_CASTLE_ID, 8, 1],
    ] as const;

    for (const [id, points, value] of esperado) {
      const option = optionById(options, id);

      expect(option.group, id).toBe("hazanas");
      expect(option.target, id).toEqual({ unit: "partidas", value: 1 });
      expect(option.points, id).toBe(points);
      expect(option.ranking.find((c) => c.profileId === 1)?.value, id).toBe(value);
      expect(playerIds(option.beneficiaries), id).toEqual([1]);
    }

    // Sin imperial rápido, el objetivo existe pero no lo cobra nadie.
    const imperial = optionById(options, FAST_IMPERIAL_ID);
    expect(imperial.points).toBe(12);
    expect(imperial.beneficiaries).toEqual([]);
    expect(imperial.ranking).toEqual([]);
  });

  it("defensor-del-pueblo se cobra con una partida larga con pocas bajas", () => {
    const players = [
      aggregate(1, { defenderMatches: 1, matches: 4 }),
      aggregate(2, { defenderMatches: 0, matches: 4 }),
    ];

    const { options, pointsByPlayer } = computeObjectives(players, DEFAULT_RULESET, []);
    const defensor = optionById(options, DEFENDER_ID);

    expect(defensor.group).toBe("hazanas");
    expect(defensor.target).toEqual({ unit: "partidas", value: 1 });
    expect(defensor.points).toBe(12);
    expect(playerIds(defensor.beneficiaries)).toEqual([1]);
    expect(pointsByPlayer.get("p2")?.earned ?? []).not.toContain(DEFENDER_ID);
  });
});

describe("apmRunStreak", () => {
  function games(...apms: (number | null)[]): { apm: number | null; finishedAtMs: number }[] {
    return apms.map((apm, index) => ({ apm, finishedAtMs: (index + 1) * 100 }));
  }

  it("sin partidas devuelve racha 0", () => {
    expect(apmRunStreak([])).toEqual({ streak: 0, endsAt: 0 });
  });

  it("tres partidas seguidas por encima del umbral son una racha de 3", () => {
    expect(apmRunStreak(games(120, 130, 200))).toEqual({ streak: 3, endsAt: 300 });
  });

  it("se queda con la racha más larga, no con la última", () => {
    expect(apmRunStreak(games(150, 150, 150, 90, 150))).toEqual({ streak: 3, endsAt: 300 });
  });

  it("una partida sin summary rompe la racha: no se sabe si cumplía", () => {
    // Las tres primeras van seguidas por encima del umbral, pero la cuarta no tiene
    // summary: encadenarlas sería inventarse el APM de esa partida.
    expect(apmRunStreak(games(150, 150, null, 150, 150))).toEqual({ streak: 2, endsAt: 200 });
  });

  it("justo por debajo del umbral no cuenta", () => {
    expect(apmRunStreak(games(150, 119, 150))).toEqual({ streak: 1, endsAt: 100 });
  });
});

describe("matchAchievements", () => {
  /** Una fila con los siete campos que mira la función, todo a `null`. */
  function row(overrides: Partial<Parameters<typeof matchAchievements>[0]> = {}) {
    return {
      durationSeconds: null,
      feudalAgeSeconds: null,
      castleAgeSeconds: null,
      imperialAgeSeconds: null,
      villagersLost: null,
      gildedVillagersLost: null,
      mountedVillagersLost: null,
      ...overrides,
    };
  }

  it("una partida sin summary no cumple ninguna hazaña", () => {
    expect(matchAchievements(row())).toEqual({
      fastFeudal: false,
      fastCastle: false,
      fastImperial: false,
      defender: false,
    });
  });

  it("las edades se comparan en estricto: 4, 9 y 16 minutos son el límite", () => {
    expect(matchAchievements(row({ feudalAgeSeconds: 239 })).fastFeudal).toBe(true);
    expect(matchAchievements(row({ feudalAgeSeconds: 240 })).fastFeudal).toBe(false);
    expect(matchAchievements(row({ castleAgeSeconds: 539 })).fastCastle).toBe(true);
    expect(matchAchievements(row({ castleAgeSeconds: 540 })).fastCastle).toBe(false);
    expect(matchAchievements(row({ imperialAgeSeconds: 959 })).fastImperial).toBe(true);
    expect(matchAchievements(row({ imperialAgeSeconds: 960 })).fastImperial).toBe(false);
  });

  it("defensor exige partida de 15 minutos o más y las tres cuentas por debajo del tope", () => {
    const defensiva = row({
      durationSeconds: 900,
      villagersLost: 2,
      gildedVillagersLost: 1,
      mountedVillagersLost: 0,
    });

    expect(matchAchievements(defensiva).defender).toBe(true);
    // Cada condición por separado lo tumba.
    expect(matchAchievements({ ...defensiva, durationSeconds: 899 }).defender).toBe(false);
    expect(matchAchievements({ ...defensiva, villagersLost: 3 }).defender).toBe(false);
    expect(matchAchievements({ ...defensiva, gildedVillagersLost: 2 }).defender).toBe(false);
    expect(matchAchievements({ ...defensiva, mountedVillagersLost: 1 }).defender).toBe(false);
    // Y una pérdida sin leer no se puede dar por buena.
    expect(matchAchievements({ ...defensiva, mountedVillagersLost: null }).defender).toBe(false);
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

  it("el catálogo tiene 88 objetivos", () => {
    expect(OBJECTIVE_COUNT).toBe(OBJECTIVE_DEFINITIONS.length);
    expect(OBJECTIVE_COUNT).toBe(88);
  });

  it("las competiciones dicen en su descripción cómo se desempata", () => {
    // Es el desempate 3 de `docs/OBJETIVOS.md`, y va en la tarjeta porque decide
    // quién cobra.
    const conDesempate = ["loco-por-ganar", "bienhadado", "rey-1v1", "masterizando-japanese"];

    for (const id of conDesempate) {
      expect(OBJECTIVE_DEFINITIONS.find((item) => item.id === id)?.description, id).toContain(
        "En caso de empate, lo cobra quien alcanzó esa cifra antes.",
      );
    }
  });
});

describe("snapshot de la vista de objetivos", () => {
  /** Documento guardado mínimo y válido: `ObjectiveView` más la marca de forma. */
  function snapshot(overrides: Record<string, unknown> = {}) {
    return {
      snapshotVersion: OBJECTIVES_SNAPSHOT_VERSION,
      fingerprint: "00000000",
      ruleSetVersion: RULESET_VERSION,
      rule: "regla",
      pointsPerWin: 2,
      window: { from: "2026-09-15T00:00:00.000Z", to: null },
      mapPool: ["Gorge"],
      options: [{ id: "loco-por-ganar", ranking: [], beneficiaries: [] }],
      ...overrides,
    };
  }

  it("un documento válido se devuelve como vista", () => {
    const view = readObjectivesSnapshotValue(snapshot(), RULESET_VERSION);

    expect(view).not.toBeNull();
    expect(view?.ruleSetVersion).toBe(RULESET_VERSION);
    expect(view?.mapPool).toEqual(["Gorge"]);
    expect(view?.options.map((option) => option.id)).toEqual(["loco-por-ganar"]);
  });

  it("sin la marca de forma o con otra se cae al cómputo en vivo", () => {
    expect(
      readObjectivesSnapshotValue(
        snapshot({ snapshotVersion: OBJECTIVES_SNAPSHOT_VERSION + 1 }),
        RULESET_VERSION,
      ),
    ).toBeNull();
    expect(
      readObjectivesSnapshotValue(snapshot({ snapshotVersion: undefined }), RULESET_VERSION),
    ).toBeNull();
  });

  it("un snapshot de la forma anterior no vale: la vista cambió de forma", () => {
    // La v2 añadió `count` a los beneficiarios y `mapGaps` al contendiente de
    // `por-tierra-y-agua`, y la v3 el catálogo de 88 objetivos (los cinco del
    // summary): un documento con la forma o el catálogo viejo se rechaza y la vista
    // se recalcula en vivo, que es lo que evita publicar un reparto a medias.
    expect(
      readObjectivesSnapshotValue(snapshot({ snapshotVersion: 1 }), RULESET_VERSION),
    ).toBeNull();
    expect(
      readObjectivesSnapshotValue(snapshot({ snapshotVersion: 2 }), RULESET_VERSION),
    ).toBeNull();
    expect(OBJECTIVES_SNAPSHOT_VERSION).toBe(3);
  });

  it("un snapshot de otra versión de las reglas no vale", () => {
    expect(
      readObjectivesSnapshotValue(snapshot({ ruleSetVersion: RULESET_VERSION - 1 }), RULESET_VERSION),
    ).toBeNull();
  });

  it("rechaza lo que no es un objeto", () => {
    expect(readObjectivesSnapshotValue(null, RULESET_VERSION)).toBeNull();
    expect(readObjectivesSnapshotValue("vista", RULESET_VERSION)).toBeNull();
    expect(readObjectivesSnapshotValue([], RULESET_VERSION)).toBeNull();
  });

  it("rechaza unas opciones que no son lista o una ventana ilegible", () => {
    expect(readObjectivesSnapshotValue(snapshot({ options: {} }), RULESET_VERSION)).toBeNull();
    expect(readObjectivesSnapshotValue(snapshot({ window: { to: null } }), RULESET_VERSION)).toBeNull();
  });

  it("rechaza una opción sin id, ranking o beneficiarios", () => {
    expect(
      readObjectivesSnapshotValue(
        snapshot({ options: [{ ranking: [], beneficiaries: [] }] }),
        RULESET_VERSION,
      ),
    ).toBeNull();
    expect(
      readObjectivesSnapshotValue(
        snapshot({ options: [{ id: "x", beneficiaries: [] }] }),
        RULESET_VERSION,
      ),
    ).toBeNull();
    expect(
      readObjectivesSnapshotValue(snapshot({ options: [{ id: "x", ranking: [] }] }), RULESET_VERSION),
    ).toBeNull();
  });

  it("no valida de más: un campo desconocido no invalida el snapshot", () => {
    expect(
      readObjectivesSnapshotValue(snapshot({ extra: "lo que sea" }), RULESET_VERSION),
    ).not.toBeNull();
  });
});

describe("objectivesSnapshotFingerprint", () => {
  function view(overrides: Partial<ObjectiveView> = {}): ObjectiveView {
    return {
      ruleSetVersion: RULESET_VERSION,
      rule: "regla",
      pointsPerWin: 2,
      window: { from: "2026-09-15T00:00:00.000Z", to: null },
      mapPool: ["Gorge"],
      options: [],
      ...overrides,
    };
  }

  it("es estable para la misma vista", () => {
    expect(objectivesSnapshotFingerprint(view())).toBe(objectivesSnapshotFingerprint(view()));
  });

  it("cambia cuando cambia cualquier parte de la vista", () => {
    const base = objectivesSnapshotFingerprint(view());

    expect(objectivesSnapshotFingerprint(view({ pointsPerWin: 3 }))).not.toBe(base);
    expect(objectivesSnapshotFingerprint(view({ mapPool: ["Gorge", "Dry Arabia"] }))).not.toBe(base);
    expect(
      objectivesSnapshotFingerprint(view({ window: { from: "2026-09-16T00:00:00.000Z", to: null } })),
    ).not.toBe(base);
    // Desactivar un objetivo quita su opción de la vista, y el snapshot tiene que
    // reescribirse: si la huella no cambiara, la web seguiría publicando un objetivo
    // apagado hasta el siguiente recálculo con novedades.
    expect(
      objectivesSnapshotFingerprint(
        view({
          options: [
            {
              id: "loco-por-ganar",
              group: "actividad",
              kind: "competition",
              label: "Loco por ganar",
              description: "…",
              metric: "partidas",
              points: 50,
              parent: null,
              holder: null,
              ranking: [],
              beneficiaries: [],
              target: null,
            },
          ],
        }),
      ),
    ).not.toBe(base);
  });
});
