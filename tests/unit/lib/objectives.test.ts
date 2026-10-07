import { describe, expect, it } from "vitest";

import {
  objectiveMinimum,
  objectiveStanding,
  type ObjectiveContender,
} from "@/lib/objectives";
import type { ScoringMinimums } from "@/lib/scoring";

/**
 * Posición y distancia al primero dentro del ranking de un objetivo.
 *
 * Es la parte pura de la ficha de un participante: no toca la base ni el
 * ruleset, solo el ranking ya ordenado que publica `computeObjectives`. Por eso
 * se comprueba aquí y no con una lectura de verdad.
 */

/** Contendiente mínimo: por defecto `matches` igual a `value` para no torcer tests. */
function contender(profileId: number, value: number, matches = value): ObjectiveContender {
  return {
    profileId,
    name: `Jugador ${profileId}`,
    avatarUrl: null,
    profileUrl: `https://aoe4world.com/players/${profileId}`,
    value,
    matches,
    eligible: true,
    detail: null,
  };
}

describe("objectiveStanding", () => {
  // Ranking ordenado por la métrica de forma descendente, como lo entrega el
  // motor tras aplicar la cadena de desempate.
  const ranking = [contender(1, 50), contender(2, 40), contender(3, 30), contender(4, 20)];

  it("el líder está en la posición 1 y a distancia 0", () => {
    expect(objectiveStanding("partidas", ranking, 1)).toEqual({ position: 1, distance: 0 });
  });

  it("un participante intermedio tiene su puesto y la diferencia con el líder", () => {
    expect(objectiveStanding("victorias", ranking, 3)).toEqual({ position: 3, distance: 20 });
  });

  it("fuera del ranking no se inventa ni posición ni distancia", () => {
    expect(objectiveStanding("victorias", ranking, 99)).toEqual({
      position: null,
      distance: null,
    });
  });

  it("en winrate la distancia es la diferencia de ratios, no de victorias", () => {
    const winrate = [contender(1, 10, 12), contender(2, 8, 12)];
    const standing = objectiveStanding("winrate", winrate, 2);

    expect(standing.position).toBe(2);
    // 10/12 − 8/12, no 10 − 8.
    expect(standing.distance).toBeCloseTo(2 / 12, 10);
  });

  it("en winrate dos ratios iguales distan 0 aunque el desempate los ponga en distinto puesto", () => {
    const winrate = [contender(1, 5, 10), contender(2, 6, 12)];

    expect(objectiveStanding("winrate", winrate, 2)).toEqual({ position: 2, distance: 0 });
  });
});

/**
 * Mínimo exigido por objetivo.
 *
 * Regla pura que traduce los mínimos del ruleset (`winrate`, `streak`,
 * `masterizar`) al mínimo de un objetivo concreto. Se comprueba aquí porque no
 * toca la base ni el ruleset: solo el objetivo y los mínimos que recibe.
 */
describe("objectiveMinimum", () => {
  const minimums: ScoringMinimums = { winrate: 10, streak: 8, masterizar: 10 };

  it("winrate exige el mínimo de partidas de `minimums.winrate`", () => {
    expect(objectiveMinimum({ id: "prohibido-perder", metric: "winrate" }, minimums)).toEqual({
      unit: "partidas",
      value: 10,
    });
  });

  it("racha exige el mínimo de partidas de `minimums.streak`", () => {
    expect(objectiveMinimum({ id: "golpe-de-suerte", metric: "racha" }, minimums)).toEqual({
      unit: "partidas",
      value: 8,
    });
  });

  it("masterizar-* exige victorias con la civilización, no partidas", () => {
    expect(objectiveMinimum({ id: "masterizar-japanese", metric: "victorias" }, minimums)).toEqual({
      unit: "victorias",
      value: 10,
    });
  });

  it("masterizarlos-a-todos no exige mínimo configurable pese al grupo", () => {
    expect(objectiveMinimum({ id: "masterizarlos-a-todos", metric: "victorias" }, minimums)).toBeNull();
  });

  it("un objetivo sin mínimo (actividad, divisiones, formatos) devuelve null", () => {
    expect(objectiveMinimum({ id: "loco-por-ganar", metric: "partidas" }, minimums)).toBeNull();
    expect(objectiveMinimum({ id: "otp", metric: "victorias" }, minimums)).toBeNull();
    expect(objectiveMinimum({ id: "sensei-oro", metric: "victorias" }, minimums)).toBeNull();
    expect(objectiveMinimum({ id: "rey-1v1", metric: "victorias" }, minimums)).toBeNull();
  });
});
