import { describe, expect, it } from "vitest";

import { compareObjectThrowTargets } from "@/lib/object-awards";

/**
 * El orden del desplegable de lanzamiento.
 *
 * Es la única parte de `object-awards.ts` que se puede probar sin base: el resto son
 * consultas y transacciones. Lo que se fija es el criterio que la UI hereda: puesto
 * ascendente, quien no tiene puesto al final y, dentro del empate, nombre y perfil.
 */

function target(rank: number | null, name: string, profileId: number) {
  return { rank, name, profileId };
}

describe("compareObjectThrowTargets", () => {
  it("ordena por puesto y deja al final a quien no tiene fila de clasificación", () => {
    const desordenados = [
      target(null, "Sin puesto", 9),
      target(2, "Zeta", 3),
      target(1, "Beta", 2),
      target(1, "Alfa", 5),
      target(1, "Alfa", 4),
    ];

    expect([...desordenados].sort(compareObjectThrowTargets)).toEqual([
      target(1, "Alfa", 4),
      target(1, "Alfa", 5),
      target(1, "Beta", 2),
      target(2, "Zeta", 3),
      target(null, "Sin puesto", 9),
    ]);
  });

  it("no depende del orden de entrada en los empates", () => {
    const a = target(3, "Mismo", 7);
    const b = target(3, "Mismo", 8);

    expect(compareObjectThrowTargets(a, b)).toBeLessThan(0);
    expect(compareObjectThrowTargets(b, a)).toBeGreaterThan(0);
    expect(compareObjectThrowTargets(a, a)).toBe(0);
  });
});
