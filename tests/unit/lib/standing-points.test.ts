import { describe, expect, it } from "vitest";

import { standingPointsBreakdown } from "@/lib/standing-points";

function breakdown(points: unknown, earned: unknown) {
  return { objectives: { points, earned } };
}

const unavailable = { pointsAccumulated: null, pointsByLeadership: null };

describe("reparto entre puntos acumulados y por liderato", () => {
  it("mantiene victorias y logros juntos y separa solo las competiciones", () => {
    expect(standingPointsBreakdown(102, breakdown(82, ["loco-por-ganar", "imbatible"])))
      .toEqual({ pointsAccumulated: 52, pointsByLeadership: 50 });
    expect(standingPointsBreakdown(52, breakdown(32, ["imbatible"])))
      .toEqual({ pointsAccumulated: 52, pointsByLeadership: 0 });
    expect(standingPointsBreakdown(70, breakdown(50, ["loco-por-ganar"])))
      .toEqual({ pointsAccumulated: 20, pointsByLeadership: 50 });
  });

  it("conserva todos los puntos por victorias y los totales vacíos", () => {
    expect(standingPointsBreakdown(20, breakdown(0, [])))
      .toEqual({ pointsAccumulated: 20, pointsByLeadership: 0 });
    expect(standingPointsBreakdown(0, null))
      .toEqual({ pointsAccumulated: 0, pointsByLeadership: 0 });
    expect(standingPointsBreakdown(0, breakdown(0, [])))
      .toEqual({ pointsAccumulated: 0, pointsByLeadership: 0 });
  });

  it("usa lo realmente cobrado por Imparable, incluido su tope", () => {
    for (const dailyPoints of [1, 5, 14]) {
      const total = 20 + 50 + 32 + dailyPoints;
      const result = standingPointsBreakdown(total, breakdown(50 + 32 + dailyPoints, [
        "loco-por-ganar", "imbatible", "imparable",
      ]));
      expect(result).toEqual({ pointsAccumulated: 20 + 32 + dailyPoints, pointsByLeadership: 50 });
      expect(result.pointsAccumulated! + result.pointsByLeadership!).toBe(total);
    }
  });

  it("aplica los puntos configurados sin convertir el tope diario en una suma nominal", () => {
    expect(standingPointsBreakdown(161, breakdown(141, ["loco-por-ganar", "imbatible", "imparable"]), {
      "loco-por-ganar": 90, imbatible: 48, imparable: 7,
    })).toEqual({ pointsAccumulated: 71, pointsByLeadership: 90 });
  });

  it("deduplica objetivos sin contar dos veces su liderato", () => {
    expect(standingPointsBreakdown(70, breakdown(50, ["loco-por-ganar", "loco-por-ganar"])))
      .toEqual({ pointsAccumulated: 20, pointsByLeadership: 50 });
  });

  it("no inventa un grupo para ids desconocidos ni tipos incorrectos", () => {
    expect(standingPointsBreakdown(70, breakdown(50, ["desconocido"]))).toEqual(unavailable);
    expect(standingPointsBreakdown(70, breakdown(50, ["loco-por-ganar", 123]))).toEqual(unavailable);
  });

  it.each([
    null, {}, [], { objectives: null }, { objectives: [] },
    breakdown(0, null), breakdown("50", ["loco-por-ganar"]),
    breakdown(NaN, []), breakdown(Infinity, []), breakdown(-1, []), breakdown(1.5, []),
    breakdown(71, ["loco-por-ganar"]), breakdown(49, ["loco-por-ganar"]),
    breakdown(51, ["loco-por-ganar"]), breakdown(0, ["imparable"]), breakdown(15, ["imparable"]),
  ])("declara no disponible un desglose incompleto o incoherente: %j", (stored) => {
    expect(standingPointsBreakdown(70, stored)).toEqual(unavailable);
  });

  it("detecta overrides incompatibles con los premios guardados, incluso si caben en el total", () => {
    const stored = breakdown(82, ["loco-por-ganar", "imbatible"]);
    expect(standingPointsBreakdown(150, stored, { "loco-por-ganar": 90 })).toEqual(unavailable);
    expect(standingPointsBreakdown(150, stored, { "loco-por-ganar": 40 })).toEqual(unavailable);
  });

  it.each([-1, NaN, Infinity, 1.5])("rechaza un total inválido: %s", (total) => {
    expect(standingPointsBreakdown(total, breakdown(0, []))).toEqual(unavailable);
  });
});
