import { describe, expect, it } from "vitest";

import {
  completionSummary,
  contenderValue,
  formatMapPool,
  objectiveCloseness,
  orderByObjectiveProgress,
  orderByObjectiveRanking,
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
  };
}

describe("completionSummary: cuántos han completado un logro", () => {
  function withBeneficiaries(count: number, kind: ObjectiveKind = "achievement"): ObjectiveOption {
    return {
      ...option("victorias", kind, kind === "achievement" ? 3 : null),
      beneficiaries: Array.from({ length: count }, (_, index) => beneficiary(index + 1)),
    };
  }

  it("un logro se lee sobre el total de participantes", () => {
    expect(completionSummary(withBeneficiaries(3), 12)).toBe("3 de 12 lo han completado");
  });

  it("singular cuando lo completa uno", () => {
    expect(completionSummary(withBeneficiaries(1), 12)).toBe("1 de 12 lo ha completado");
  });

  it("sin completadores todavía no se inventa la fracción", () => {
    expect(completionSummary(withBeneficiaries(0), 12)).toBe("Todavía nadie lo ha completado");
  });

  it("una competición no cuenta completadores: dice si hay poseedor", () => {
    const competition = withBeneficiaries(0, "competition");

    expect(completionSummary(competition, 12)).toBe("Sin poseedor todavía");
    expect(completionSummary({ ...competition, holder: contender(50) }, 12)).toBe(
      "Poseedor marcado",
    );
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
