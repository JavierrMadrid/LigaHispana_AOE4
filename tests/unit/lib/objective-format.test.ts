import { describe, expect, it } from "vitest";

import {
  completedContenders,
  completionSummary,
  contenderShare,
  contenderShareOfObjective,
  contenderValue,
  formatMapPool,
  hasNoCap,
  hasReachedTarget,
  objectiveCloseness,
  objectiveStandingsView,
  objectiveTitle,
  orderByObjectiveProgress,
  orderByObjectiveRanking,
  prizeLabel,
  standingsCountLabel,
} from "@/lib/objective-format";
import type {
  ObjectiveBeneficiary,
  ObjectiveContender,
  ObjectiveKind,
  ObjectiveMetric,
  ObjectiveOption,
} from "@/lib/objectives";

/**
 * El formato de las cifras de un objetivo.
 *
 * `contenderValue` es puro: se le da un objetivo y un contendiente y devuelve el
 * texto. Aquí se comprueban las dos formas de leer un número —el avance de un
 * logro sobre su umbral y el valor de la métrica de una competición— y las
 * unidades, que es donde se cuelan los plurales sueltos.
 */

function contender(value: number): ObjectiveContender {
  return {
    profileId: 1,
    name: "Jugador",
    avatarUrl: null,
    profileUrl: null,
    value,
    matches: value,
    eligible: false,
    detail: null,
  };
}

function option(
  metric: ObjectiveMetric,
  kind: ObjectiveKind,
  target: number | null,
): ObjectiveOption {
  return {
    id: "objetivo",
    group: "actividad",
    kind,
    label: "Objetivo",
    description: "Regla del objetivo.",
    metric,
    points: 10,
    parent: null,
    holder: null,
    ranking: [],
    beneficiaries: [],
    target: target === null ? null : { unit: metric, value: target },
  };
}

describe("contenderValue: avance de un logro", () => {
  it.each([
    ["civilizaciones", 23, 12, "12/23 civilizaciones"],
    ["victorias", 3, 2, "2/3 victorias"],
    ["partidas", 3, 1, "1/3 partidas"],
    ["racha", 5, 2, "2/5 victorias seguidas"],
    ["dias", 14, 7, "7/14 días"],
    ["mapas", 9, 5, "5/9 mapas"],
  ] as const)("%s: %i/%i", (metric, target, value, expected) => {
    expect(contenderValue(option(metric, "achievement", target), contender(value))).toBe(expected);
  });

  it("satura el avance en el umbral aunque el valor lo supere", () => {
    expect(contenderValue(option("dias", "achievement", 14), contender(20))).toBe("14/14 días");
  });
});

describe("contenderValue: valor de una competición", () => {
  it("no tiene umbral que enseñar", () => {
    expect(contenderValue(option("partidas", "competition", null), contender(50))).toBe(
      "50 partidas",
    );
    expect(contenderValue(option("victorias", "competition", null), contender(12))).toBe(
      "12 victorias",
    );
  });

  it("usa el singular cuando el valor es uno", () => {
    expect(contenderValue(option("victorias", "competition", null), contender(1))).toBe(
      "1 victoria",
    );
    expect(contenderValue(option("racha", "competition", null), contender(1))).toBe(
      "1 victoria seguida",
    );
    expect(contenderValue(option("partidas", "competition", null), contender(1))).toBe("1 partida");
  });
});

function beneficiary(profileId: number): ObjectiveBeneficiary {
  return {
    profileId,
    name: `Jugador ${profileId}`,
    avatarUrl: null,
    profileUrl: null,
    points: 10,
    count: 1,
  };
}

describe("completionSummary: cuántos han completado un logro", () => {
  /**
   * Un objetivo con umbral y sus contendientes: `values` son los valores del ranking,
   * de modo que el recuento se mide contra el umbral (3 en este caso) y no contra quién
   * cobra algo.
   */
  function withValues(values: number[], kind: ObjectiveKind = "achievement"): ObjectiveOption {
    return {
      ...option("victorias", kind, kind === "achievement" ? 3 : null),
      beneficiaries: values.map((_, index) => beneficiary(index + 1)),
      ranking: values.map((value, index) => ({
        ...contender(value),
        profileId: index + 1,
      })),
    };
  }

  it("un logro se lee sobre el total de contendientes", () => {
    expect(completionSummary(withValues([3, 3, 3, 1]), 12)).toBe("3 de 12 lo han completado");
  });

  it("singular cuando lo completa uno", () => {
    expect(completionSummary(withValues([3, 1]), 12)).toBe("1 de 12 lo ha completado");
  });

  it("cobrar sin llegar al umbral no cuenta como completado", () => {
    // `imparable` paga desde el primer día: con tres de catorce no lo ha completado
    // nadie, aunque los nueve cobren.
    const imparable: ObjectiveOption = {
      ...option("dias", "achievement", 14),
      beneficiaries: Array.from({ length: 9 }, (_, index) => beneficiary(index + 1)),
      ranking: Array.from({ length: 9 }, (_, index) => ({
        ...contender(3),
        profileId: index + 1,
      })),
    };

    expect(completionSummary(imparable, 9)).toBe("Todavía nadie lo ha completado");
  });

  it("sin nadie en el umbral no se inventa la fracción", () => {
    expect(completionSummary(withValues([1, 2]), 12)).toBe("Todavía nadie lo ha completado");
  });

  it("una competición no cuenta completadores: dice si hay poseedor", () => {
    const competition = withValues([], "competition");

    expect(completionSummary(competition, 12)).toBe("Sin poseedor todavía");
    expect(completionSummary({ ...competition, holder: contender(50) }, 12)).toBe(
      "Poseedor marcado",
    );
  });

  it("un logro sin tope no habla de completadores: dice la regla", () => {
    const noCap = withValues([12, 7], "achievement");
    noCap.target = null;

    expect(completionSummary(noCap, 12)).toBe("Sin tope: cada victoria suma");
  });
});

describe("hasReachedTarget: el umbral es lo que marca «completado»", () => {
  it("un logro acumulativo lo alcanza al llegar a su umbral", () => {
    const imparable = option("dias", "achievement", 14);

    expect(hasReachedTarget(imparable, 13)).toBe(false);
    expect(hasReachedTarget(imparable, 14)).toBe(true);
    expect(hasReachedTarget(imparable, 20)).toBe(true);
  });

  it("un logro binario es equivalente a cumplirlo", () => {
    const logro = option("victorias", "achievement", 3);

    expect(hasReachedTarget(logro, 2)).toBe(false);
    expect(hasReachedTarget(logro, 3)).toBe(true);
  });

  it("un logro sin tope no llega nunca", () => {
    expect(hasReachedTarget(option("victorias", "achievement", null), 999)).toBe(false);
  });

  it("una competición no se mide por su valor", () => {
    expect(hasReachedTarget(option("partidas", "competition", null), 999)).toBe(false);
  });
});

describe("completedContenders: el recuento del umbral", () => {
  it("cuenta solo a los que llegan al umbral, no a los que cobran", () => {
    const imparable: ObjectiveOption = {
      ...option("dias", "achievement", 14),
      beneficiaries: [beneficiary(1), beneficiary(2), beneficiary(3)],
      ranking: [
        { ...contender(14), profileId: 1 },
        { ...contender(9), profileId: 2 },
        { ...contender(3), profileId: 3 },
      ],
    };

    expect(completedContenders(imparable)).toBe(1);
  });

  it("un logro sin tope no tiene completados", () => {
    const noCap: ObjectiveOption = {
      ...option("victorias", "achievement", null),
      ranking: [{ ...contender(24), profileId: 1 }],
    };

    expect(completedContenders(noCap)).toBe(0);
  });
});

describe("hasNoCap: el logro que no se completa", () => {
  it("un logro sin umbral no tiene tope", () => {
    expect(hasNoCap(option("victorias", "achievement", null))).toBe(true);
  });

  it("un logro con umbral sí lo tiene", () => {
    expect(hasNoCap(option("dias", "achievement", 14))).toBe(false);
  });

  it("una competición no es un logro sin tope, aunque no tenga umbral", () => {
    expect(hasNoCap(option("partidas", "competition", null))).toBe(false);
  });
});

describe("standingsCountLabel: el recuento de la cabecera", () => {
  it("un objetivo normal cuenta contendientes", () => {
    expect(standingsCountLabel(option("dias", "achievement", 14), 13)).toBe("13 contendientes");
    expect(standingsCountLabel(option("racha", "competition", null), 1)).toBe("1 contendiente");
  });

  it("un logro sin tope cuenta a quien ya cobra, no a aspirantes", () => {
    const noCap = option("victorias", "achievement", null);

    expect(standingsCountLabel(noCap, 9)).toBe("9 jugadores");
    expect(standingsCountLabel(noCap, 1)).toBe("1 jugador");
  });
});

describe("prizeLabel: el pie de la placa de premio", () => {
  it("un premio cerrado se lee en puntos", () => {
    expect(prizeLabel(option("dias", "achievement", 14))).toBe("puntos");
    expect(prizeLabel(option("racha", "competition", null))).toBe("puntos");
  });

  it("un objetivo sin tope paga por unidad y lo dice", () => {
    expect(prizeLabel(option("victorias", "achievement", null))).toBe("puntos por victoria");
  });

  it("la unidad sale de la métrica, no del id", () => {
    expect(prizeLabel(option("dias", "achievement", null))).toBe("puntos por día");
  });
});

describe("objectiveTitle: el rótulo con sus repeticiones", () => {
  it("sin repeticiones es la etiqueta a secas", () => {
    expect(objectiveTitle({ label: "Imparable", count: 1 })).toBe("Imparable");
  });

  it("con repeticiones, el multiplicador va delante", () => {
    expect(objectiveTitle({ label: "Imparable", count: 2 })).toBe("2×Imparable");
    expect(objectiveTitle({ label: "Victorias", count: 24 })).toBe("24×Victorias");
  });
});

describe("formatMapPool", () => {
  it("une los nombres con coma y un espacio", () => {
    expect(formatMapPool(["Atacama", "Baltic", "Dry Arabia"])).toBe(
      "Atacama, Baltic, Dry Arabia",
    );
  });

  it("recorta los espacios y descarta los nombres vacíos", () => {
    expect(formatMapPool([" Atacama ", "", "Baltic", "  "])).toBe("Atacama, Baltic");
  });

  it("un solo mapa se queda sin coma", () => {
    expect(formatMapPool(["Atacama"])).toBe("Atacama");
    expect(formatMapPool([])).toBe("");
  });
});

describe("objectiveCloseness: fracción común a logros y competiciones", () => {
  it("un logro mide su avance sobre el umbral", () => {
    expect(
      objectiveCloseness({
        kind: "achievement",
        value: 12,
        target: { unit: "civilizaciones", value: 23 },
        position: null,
      }),
    ).toBeCloseTo(12 / 23);
  });

  it("un logro satura en 1 al superar el umbral", () => {
    expect(
      objectiveCloseness({
        kind: "achievement",
        value: 20,
        target: { unit: "dias", value: 14 },
        position: 1,
      }),
    ).toBe(1);
  });

  it("un logro sin umbral no tiene cercanía que medir", () => {
    expect(
      objectiveCloseness({ kind: "achievement", value: 5, target: null, position: 2 }),
    ).toBe(0);
  });

  it("una competición mide la inversa del puesto", () => {
    const distance = (position: number) =>
      objectiveCloseness({ kind: "competition", value: 50, target: null, position });

    expect(distance(1)).toBe(1);
    expect(distance(2)).toBe(0.5);
    expect(distance(4)).toBe(0.25);
    expect(distance(0)).toBe(0);
  });

  it("una competición sin puesto no mide nada", () => {
    expect(
      objectiveCloseness({ kind: "competition", value: 50, target: null, position: null }),
    ).toBe(0);
  });

  it("permite comparar los dos tipos en una sola escala", () => {
    const almostDone = objectiveCloseness({
      kind: "achievement",
      value: 9,
      target: { unit: "victorias", value: 10 },
      position: null,
    });
    const secondPlace = objectiveCloseness({
      kind: "competition",
      value: 50,
      target: null,
      position: 2,
    });

    expect(almostDone).toBeGreaterThan(secondPlace);
  });
});

describe("orderByObjectiveProgress", () => {
  function achievement(value: number, target: number, label: string) {
    return {
      label,
      kind: "achievement" as const,
      value,
      target: { unit: "victorias" as const, value: target },
      position: null,
    };
  }

  it("pone primero al más avanzado", () => {
    const ordered = orderByObjectiveProgress([
      achievement(1, 3, "uno"),
      achievement(3, 3, "tres"),
      achievement(2, 3, "dos"),
    ]);

    expect(ordered.map((item) => item.label)).toEqual(["tres", "dos", "uno"]);
  });

  it("un subobjetivo conseguido (100 %) va el primero", () => {
    const ordered = orderByObjectiveProgress([
      achievement(2, 3, "casi"),
      achievement(3, 3, "conseguido"),
      achievement(0, 3, "cero"),
    ]);

    expect(ordered[0].label).toBe("conseguido");
  });

  it("mide las competiciones por su puesto", () => {
    const ordered = orderByObjectiveProgress([
      { label: "cuarto", kind: "competition" as const, value: 10, target: null, position: 4 },
      { label: "lider", kind: "competition" as const, value: 10, target: null, position: 1 },
      { label: "sin puesto", kind: "competition" as const, value: 0, target: null, position: null },
    ]);

    expect(ordered.map((item) => item.label)).toEqual(["lider", "cuarto", "sin puesto"]);
  });

  it("conserva el orden de entrada a igual avance", () => {
    const ordered = orderByObjectiveProgress([
      achievement(1, 3, "a"),
      achievement(1, 3, "b"),
      achievement(1, 3, "c"),
    ]);

    expect(ordered.map((item) => item.label)).toEqual(["a", "b", "c"]);
  });

  it("no muta la entrada", () => {
    const input = [achievement(1, 3, "uno"), achievement(3, 3, "tres")];
    const ordered = orderByObjectiveProgress(input);

    expect(input.map((item) => item.label)).toEqual(["uno", "tres"]);
    expect(ordered.map((item) => item.label)).toEqual(["tres", "uno"]);
  });
});

describe("orderByObjectiveRanking", () => {
  function ranked(profileId: number): ObjectiveContender {
    return {
      profileId,
      name: `Jugador ${profileId}`,
      avatarUrl: null,
      profileUrl: null,
      value: profileId,
      matches: 0,
      eligible: false,
      detail: null,
    };
  }

  function participant(profileId: number) {
    return {
      profileId,
      name: `Jugador ${profileId}`,
      avatarUrl: null,
      profileUrl: `https://aoe4world.com/players/${profileId}`,
    };
  }

  const ids = (placements: { participant: { profileId: number } }[]) =>
    placements.map((placement) => placement.participant.profileId);

  it("pone primero a quien disputa, en el orden del ranking, y deja al final al resto sin reordenarlo", () => {
    const players = [1, 2, 3, 4].map(participant);

    expect(ids(orderByObjectiveRanking(players, [ranked(3), ranked(1)]))).toEqual([3, 1, 2, 4]);
  });

  it("anota el puesto 1-based de cada disputante y deja sin puesto a quien no disputa", () => {
    const players = [1, 2, 3].map(participant);
    const placements = orderByObjectiveRanking(players, [ranked(3), ranked(1)]);

    expect(placements.map((placement) => placement.position)).toEqual([1, 2, null]);
    expect(placements[0].contender?.profileId).toBe(3);
    expect(placements[2].contender).toBeNull();
  });

  it("respeta el orden de entrada de quien no disputa", () => {
    const players = [4, 2, 1, 3].map(participant);

    expect(ids(orderByObjectiveRanking(players, [ranked(3), ranked(1)]))).toEqual([3, 1, 4, 2]);
  });

  it("ignora entradas del ranking que no estén entre los participantes", () => {
    const players = [1, 2].map(participant);

    expect(ids(orderByObjectiveRanking(players, [ranked(9), ranked(2), ranked(1)]))).toEqual([
      2, 1,
    ]);
  });

  it("con el ranking vacío deja el listado intacto y sin puestos", () => {
    const players = [2, 1].map(participant);
    const placements = orderByObjectiveRanking(players, []);

    expect(ids(placements)).toEqual([2, 1]);
    expect(placements.map((placement) => placement.position)).toEqual([null, null]);
  });

  it("no muta el array de entrada", () => {
    const players = [1, 2].map(participant);
    const placements = orderByObjectiveRanking(players, [ranked(2), ranked(1)]);

    expect(players.map((player) => player.profileId)).toEqual([1, 2]);
    expect(ids(placements)).toEqual([2, 1]);
  });

  it("un profileId repetido en el ranking usa su primera posición", () => {
    const players = [1, 2].map(participant);

    expect(ids(orderByObjectiveRanking(players, [ranked(2), ranked(2), ranked(1)]))).toEqual([
      2, 1,
    ]);
  });
});

describe("objectiveStandingsView", () => {
  function ranked(profileId: number, value: number): ObjectiveContender {
    return {
      profileId,
      name: `Jugador ${profileId}`,
      avatarUrl: null,
      profileUrl: null,
      value,
      matches: value,
      eligible: false,
      detail: null,
    };
  }

  function participant(profileId: number) {
    return {
      profileId,
      name: `Jugador ${profileId}`,
      avatarUrl: null,
      profileUrl: `https://aoe4world.com/players/${profileId}`,
    };
  }

  const ids = (placements: { participant: { profileId: number } }[]) =>
    placements.map((placement) => placement.participant.profileId);

  it("deja fuera a quien no disputa el objetivo y cuenta solo a los contendientes", () => {
    const players = [1, 2, 3, 4].map(participant);
    const view = objectiveStandingsView(players, [ranked(3, 9), ranked(1, 4)]);

    expect(ids(view.rows)).toEqual([3, 1]);
    expect(view.contenders).toBe(2);
  });

  it("mantiene la fila del jugador resaltado aunque no dispute, sin contarla", () => {
    const players = [1, 2, 3].map(participant);
    const view = objectiveStandingsView(players, [ranked(2, 5)], 3);

    expect(ids(view.rows)).toEqual([2, 3]);
    expect(view.contenders).toBe(1);
    expect(view.rows[1].contender).toBeNull();
    expect(view.rows[1].position).toBeNull();
  });

  it("no repite la fila del resaltado cuando sí disputa", () => {
    const players = [1, 2].map(participant);
    const view = objectiveStandingsView(players, [ranked(2, 5), ranked(1, 1)], 2);

    expect(ids(view.rows)).toEqual([2, 1]);
    expect(view.contenders).toBe(2);
  });

  it("sin ranking no hay filas ni contendientes", () => {
    const view = objectiveStandingsView([1, 2].map(participant), []);

    expect(view.rows).toEqual([]);
    expect(view.contenders).toBe(0);
  });

  it("no cuenta a quien el ranking traiga pero la clasificación no tenga", () => {
    const view = objectiveStandingsView([participant(1)], [ranked(9, 8), ranked(1, 2)]);

    expect(ids(view.rows)).toEqual([1]);
    expect(view.contenders).toBe(1);
  });

  it("respeta los puestos del ranking al recortar la lista", () => {
    const players = [1, 2, 3, 4].map(participant);
    const view = objectiveStandingsView(players, [ranked(4, 7), ranked(2, 3)]);

    expect(view.rows.map((row) => row.position)).toEqual([1, 2]);
  });
});

describe("contenderShare: la fracción contra una referencia", () => {
  it("la referencia llega al final", () => {
    expect(contenderShare(50, 50)).toBe(1);
  });

  it("el resto se mide contra ella", () => {
    expect(contenderShare(25, 50)).toBe(0.5);
    expect(contenderShare(1, 5)).toBe(0.2);
  });

  it("un valor por encima de la referencia se satura", () => {
    expect(contenderShare(60, 50)).toBe(1);
  });

  it("una referencia sin valor no da escala", () => {
    expect(contenderShare(10, 0)).toBe(0);
    expect(contenderShare(10, -3)).toBe(0);
  });

  it("sin valor no hay barra", () => {
    expect(contenderShare(0, 50)).toBe(0);
  });
});

describe("contenderShareOfObjective: qué mide la barra", () => {
  const contender = (value: number) => ({ value });

  it("en un logro con umbral, la barra es el avance del X/X de la fila", () => {
    const imparable = option("dias", "achievement", 14);

    expect(contenderShareOfObjective(imparable, contender(3), 3)).toBeCloseTo(3 / 14);
    expect(contenderShareOfObjective(imparable, contender(7), 7)).toBe(0.5);
    expect(contenderShareOfObjective(imparable, contender(14), 14)).toBe(1);
  });

  it("pasarse del umbral no pasa de la barra llena", () => {
    expect(contenderShareOfObjective(option("dias", "achievement", 14), contender(20), 20)).toBe(1);
  });

  it("el umbral manda aunque el líder de la lista sea otro", () => {
    const logro = option("victorias", "achievement", 3);

    // El líder lleva 3 de 3 y esta fila 2: la barra es su avance, no su parte del líder.
    expect(contenderShareOfObjective(logro, contender(2), 3)).toBeCloseTo(2 / 3);
  });

  it("en una competición se mide contra el líder, que es lo que la ordena", () => {
    const competition = option("partidas", "competition", null);

    expect(contenderShareOfObjective(competition, contender(25), 50)).toBe(0.5);
    expect(contenderShareOfObjective(competition, contender(50), 50)).toBe(1);
  });

  it("en un logro sin tope también, porque no hay umbral", () => {
    const noCap = option("victorias", "achievement", null);

    expect(contenderShareOfObjective(noCap, contender(12), 24)).toBe(0.5);
  });
});
