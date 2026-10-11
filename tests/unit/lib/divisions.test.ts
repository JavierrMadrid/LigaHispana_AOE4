import { describe, expect, it } from "vitest";

import {
  DIVISIONS,
  SUBDIVISION_RANK_LEVELS,
  divisionFromRankLevel,
  subdivisionIndex,
} from "@/lib/divisions";

/**
 * El catálogo de divisiones y el orden de las 18 subdivisiones.
 *
 * Son datos, no cálculo, y por eso lo que se comprueba no es que devuelvan lo
 * correcto caso a caso sino las dos invariantes de las que depende el resto: que el
 * prefijo de cada división sea el que usa AoE4World y que el orden fuerte → débil
 * sea el que hace que "tres escalones por debajo" signifique algo.
 */

describe("DIVISIONS", () => {
  it("son las seis divisiones con su prefijo de AoE4World", () => {
    expect(DIVISIONS.map((division) => [division.id, division.rankLevelPrefix])).toEqual([
      ["bronce", "bronze"],
      ["plata", "silver"],
      ["oro", "gold"],
      ["platino", "platinum"],
      ["diamante", "diamond"],
      ["conquistador", "conqueror"],
    ]);
  });

  it("cada división tiene rótulo en español y los ids no se repiten", () => {
    const ids = DIVISIONS.map((division) => division.id);

    expect(new Set(ids).size).toBe(ids.length);
    for (const division of DIVISIONS) {
      expect(division.label.length).toBeGreaterThan(0);
    }
  });
});

describe("divisionFromRankLevel", () => {
  it("cualquier subdivisión cae en su división, comparando antes del guion", () => {
    // `rank_level` llega como string libre (`gold_2`, `bronze_1`), así que los tres
    // pasos de cada división tienen que dar la misma.
    expect(divisionFromRankLevel("gold_3")).toBe("oro");
    expect(divisionFromRankLevel("gold_1")).toBe("oro");
    expect(divisionFromRankLevel("platinum_2")).toBe("platino");
    expect(divisionFromRankLevel("conqueror_1")).toBe("conquistador");
  });

  it("el prefijo sin número también resuelve", () => {
    expect(divisionFromRankLevel("gold")).toBe("oro");
  });

  it("no se engancha a un prefijo que solo empieza igual", () => {
    // Sin el guion, `golden_2` se leería como oro.
    expect(divisionFromRankLevel("golden_2")).toBeNull();
  });

  it("sin clasificar o con un valor desconocido devuelve `null`", () => {
    for (const valor of [null, "", "   ", "unranked", "plata_1"]) {
      expect(divisionFromRankLevel(valor), String(valor)).toBeNull();
    }
  });

  it("no le importa cómo venga escrito el `rank_level`", () => {
    expect(divisionFromRankLevel("  GOLD_2  ")).toBe("oro");
  });
});

describe("SUBDIVISION_RANK_LEVELS", () => {
  it("son las 18, de la más fuerte a la más débil", () => {
    expect(SUBDIVISION_RANK_LEVELS).toHaveLength(18);
    expect(SUBDIVISION_RANK_LEVELS[0]).toBe("conqueror_3");
    expect(SUBDIVISION_RANK_LEVELS.at(-1)).toBe("bronze_1");
  });

  it("cada división aparece con sus tres subdivisiones, en el orden 3, 2, 1", () => {
    // El paso interno (3 → 2 → 1) es del `rank_level` de AoE4World y no está en
    // ningún otro sitio del proyecto: por eso esta lista se escribe entera a mano en
    // vez de derivarse de `DIVISIONS`.
    expect(SUBDIVISION_RANK_LEVELS.filter((nivel) => nivel.startsWith("gold_"))).toEqual([
      "gold_3",
      "gold_2",
      "gold_1",
    ]);
  });

  it("ninguna subdivisión se repite y todas caen en una división del catálogo", () => {
    expect(new Set(SUBDIVISION_RANK_LEVELS).size).toBe(18);

    for (const nivel of SUBDIVISION_RANK_LEVELS) {
      expect(divisionFromRankLevel(nivel), nivel).not.toBeNull();
    }
  });
});

describe("subdivisionIndex", () => {
  it("el índice crece al bajar, y eso es lo que hace la cuenta de R5", () => {
    // R5 calcula `steps = indicePartida - indiceJugador`, así que "tres escalones por
    // debajo" son tres posiciones de diferencia: desde `gold_3` la partida cae a
    // `silver_3`, y desde `gold_1` a `silver_1`.
    const escalones = (jugador: string, partida: string) =>
      (subdivisionIndex(partida) ?? -1) - (subdivisionIndex(jugador) ?? -1);

    expect(escalones("gold_3", "silver_3")).toBe(3);
    expect(escalones("gold_1", "silver_1")).toBe(3);
    expect(escalones("gold_3", "gold_1")).toBe(2);
  });

  it("la lista de constantes y la posición que devuelve son la misma", () => {
    SUBDIVISION_RANK_LEVELS.forEach((nivel, index) => {
      expect(subdivisionIndex(nivel), nivel).toBe(index);
    });
  });

  it("un valor que no está en la lista devuelve `null`, no `-1`", () => {
    // `null` es "no se puede comparar", y R5 lo trata como "no evaluable" con un
    // aviso; un `-1` se leería como el escalón más fuerte de todos.
    for (const valor of [null, "", "  ", "gold_4", "oro_2"]) {
      expect(subdivisionIndex(valor), String(valor)).toBeNull();
    }
  });

  it("no le importa cómo venga escrito el `rank_level`", () => {
    expect(subdivisionIndex("  GOLD_3 ")).toBe(subdivisionIndex("gold_3"));
  });
});
