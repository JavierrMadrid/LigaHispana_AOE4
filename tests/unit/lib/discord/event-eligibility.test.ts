import { describe, expect, it } from "vitest";

import {
  applyEligibilityVerdicts,
  eligibilityGrew,
  planEligibilityChecks,
  type EligibilityCandidate,
  type EligibilityVerdict,
} from "@/lib/discord/event-eligibility";
import type { EditionEventEligibility } from "@/lib/edition-events";

/**
 * El snapshot de elegibilidad de los eventos: a quién se comprueba, qué se conserva y
 * qué no se escribe.
 *
 * Solo se prueba la parte **pura**: la decisión de a quién preguntar y cómo se combinan
 * los veredictos en el snapshot. La llamada a Discord y la escritura en `Setting` se
 * quedan en el worker y no se tocan aquí. Lo que se fija son los dos invariantes del
 * snapshot: un `unknown` no se marca como comprobado y **nadie sale** de
 * `eligiblePlayerIds`.
 */

function candidato(overrides: Partial<EligibilityCandidate> = {}): EligibilityCandidate {
  return {
    id: "p1",
    name: "Ana",
    discordUserId: "111",
    ...overrides,
  };
}

function snapshot(overrides: Partial<EditionEventEligibility> = {}): EditionEventEligibility {
  return {
    checkedAt: "2026-09-20T16:00:00.000Z",
    checkedPlayerIds: [],
    eligiblePlayerIds: [],
    ...overrides,
  };
}

function veredicto(
  playerId: string,
  membership: EligibilityVerdict["membership"],
): EligibilityVerdict {
  return { playerId, membership };
}

describe("planEligibilityChecks", () => {
  const aprobados = [
    candidato(),
    candidato({ id: "p2", name: "Bea" }),
    candidato({ id: "p3", name: "Carla", discordUserId: null }),
  ];

  it("sin snapshot se comprueba a todos", () => {
    expect(planEligibilityChecks(aprobados, null).map((c) => c.id)).toEqual(["p1", "p2", "p3"]);
  });

  it("no vuelve a comprobar a quien ya está en `checkedPlayerIds`", () => {
    expect(
      planEligibilityChecks(aprobados, snapshot({ checkedPlayerIds: ["p1"] })).map((c) => c.id),
    ).toEqual(["p2", "p3"]);
  });

  it("con todos comprobados no queda nadie", () => {
    expect(
      planEligibilityChecks(
        aprobados,
        snapshot({ checkedPlayerIds: ["p1", "p2", "p3"] }),
      ),
    ).toEqual([]);
  });
});

describe("applyEligibilityVerdicts", () => {
  it("marca como comprobados solo los veredictos concluyentes", () => {
    const merged = applyEligibilityVerdicts(
      null,
      [veredicto("p1", "member"), veredicto("p2", "not-member"), veredicto("p3", "unknown")],
      "2026-09-20T17:00:00.000Z",
    );

    expect(merged.checkedPlayerIds).toEqual(["p1", "p2"]);
    expect(merged.eligiblePlayerIds).toEqual(["p1"]);
    expect(merged.checkedAt).toBe("2026-09-20T17:00:00.000Z");
  });

  it("un `unknown` no marca ni reparte nada", () => {
    const merged = applyEligibilityVerdicts(null, [veredicto("p1", "unknown")], "2026-09-20T17:00:00.000Z");

    expect(merged.checkedPlayerIds).toEqual([]);
    expect(merged.eligiblePlayerIds).toEqual([]);
  });

  it("no quita a nadie de elegibles: quien estaba dentro sigue cobrando", () => {
    const anterior = snapshot({
      checkedPlayerIds: ["p1", "p2"],
      eligiblePlayerIds: ["p1"],
    });

    const merged = applyEligibilityVerdicts(
      anterior,
      [veredicto("p1", "not-member"), veredicto("p2", "member")],
      "2026-09-20T18:00:00.000Z",
    );

    expect(merged.checkedPlayerIds).toEqual(["p1", "p2"]);
    expect(merged.eligiblePlayerIds).toEqual(["p1", "p2"]);
  });

  it("suma a los aprobados a mitad del evento sin repetir ids", () => {
    const anterior = snapshot({
      checkedPlayerIds: ["p1"],
      eligiblePlayerIds: ["p1"],
    });

    const merged = applyEligibilityVerdicts(
      anterior,
      [veredicto("p1", "member"), veredicto("p9", "member")],
      "2026-09-20T19:00:00.000Z",
    );

    expect(merged.checkedPlayerIds).toEqual(["p1", "p9"]);
    expect(merged.eligiblePlayerIds).toEqual(["p1", "p9"]);
  });
});

describe("eligibilityGrew", () => {
  it("sin jugadores nuevos no hay nada que escribir", () => {
    const anterior = snapshot({ checkedPlayerIds: ["p1"], eligiblePlayerIds: ["p1"] });

    expect(eligibilityGrew(anterior, anterior)).toBe(false);
    expect(eligibilityGrew(null, snapshot())).toBe(false);
  });

  it("con jugadores nuevos hay que escribir", () => {
    const anterior = snapshot({ checkedPlayerIds: ["p1"] });
    const merged = applyEligibilityVerdicts(
      anterior,
      [veredicto("p2", "not-member")],
      "2026-09-20T18:00:00.000Z",
    );

    expect(eligibilityGrew(anterior, merged)).toBe(true);
  });
});
