import { describe, expect, it } from "vitest";

import { PlayerStatus } from "@/generated/prisma/enums";
import {
  DEACTIVATABLE_PLAYER_STATUSES,
  RESUBMITTABLE_PLAYER_STATUSES,
  canResubmitRegistration,
  isDeactivatablePlayerStatus,
  resubmissionResetsRegisteredAt,
} from "@/lib/player-status";

/**
 * Las reglas del estado de un participante al cambiar de edición (issue 183).
 *
 * Lo que se fija aquí es lo que decide, a la vez, quién se desactiva al empezar una
 * edición nueva y desde qué estados se puede uno reinscribir. Son puras: ni base de
 * datos, ni red, ni entorno.
 */

/** Los cinco estados del enum, para recorrerlos en las tres preguntas. */
const ESTADOS: readonly PlayerStatus[] = [
  PlayerStatus.PENDING,
  PlayerStatus.APPROVED,
  PlayerStatus.REJECTED,
  PlayerStatus.BANNED,
  PlayerStatus.INACTIVE,
];

describe("DEACTIVATABLE_PLAYER_STATUSES", () => {
  it("solo desactiva a los que estaban dentro o esperando", () => {
    expect([...DEACTIVATABLE_PLAYER_STATUSES]).toEqual(["APPROVED", "PENDING"]);
  });

  it("no incluye estados de los que no hay nada que desactivar", () => {
    expect(DEACTIVATABLE_PLAYER_STATUSES).not.toContain("INACTIVE");
    expect(DEACTIVATABLE_PLAYER_STATUSES).not.toContain("REJECTED");
    expect(DEACTIVATABLE_PLAYER_STATUSES).not.toContain("BANNED");
  });
});

describe("isDeactivatablePlayerStatus", () => {
  it("responde sí a APPROVED y PENDING", () => {
    expect(isDeactivatablePlayerStatus(PlayerStatus.APPROVED)).toBe(true);
    expect(isDeactivatablePlayerStatus(PlayerStatus.PENDING)).toBe(true);
  });

  it("responde no al resto", () => {
    expect(isDeactivatablePlayerStatus(PlayerStatus.REJECTED)).toBe(false);
    expect(isDeactivatablePlayerStatus(PlayerStatus.BANNED)).toBe(false);
    expect(isDeactivatablePlayerStatus(PlayerStatus.INACTIVE)).toBe(false);
  });

  it("coincide con la constante en los cinco estados", () => {
    for (const estado of ESTADOS) {
      expect(isDeactivatablePlayerStatus(estado)).toBe(
        (DEACTIVATABLE_PLAYER_STATUSES as readonly string[]).includes(estado),
      );
    }
  });
});

describe("canResubmitRegistration", () => {
  it("deja repetir la solicitud a un REJECTED", () => {
    expect(canResubmitRegistration(PlayerStatus.REJECTED)).toBe(true);
  });

  it("deja volver a un INACTIVE de la edición anterior", () => {
    expect(canResubmitRegistration(PlayerStatus.INACTIVE)).toBe(true);
  });

  it("bloquea a quien ya está en la liga o esperando revisión", () => {
    expect(canResubmitRegistration(PlayerStatus.APPROVED)).toBe(false);
    expect(canResubmitRegistration(PlayerStatus.PENDING)).toBe(false);
  });

  it("no deja saltarse una expulsión por el formulario público", () => {
    expect(canResubmitRegistration(PlayerStatus.BANNED)).toBe(false);
  });

  it("coincide con la lista que filtra el `updateMany`", () => {
    for (const estado of ESTADOS) {
      expect(canResubmitRegistration(estado)).toBe(
        (RESUBMITTABLE_PLAYER_STATUSES as readonly string[]).includes(estado),
      );
    }
  });
});

describe("resubmissionResetsRegisteredAt", () => {
  it("solo la reinscripción desde INACTIVE es una inscripción nueva", () => {
    expect(resubmissionResetsRegisteredAt(PlayerStatus.INACTIVE)).toBe(true);
  });

  it("un REJECTED conserva la fecha del primer envío", () => {
    expect(resubmissionResetsRegisteredAt(PlayerStatus.REJECTED)).toBe(false);
  });

  it("los estados que ni se reinscriben no resetean nada", () => {
    expect(resubmissionResetsRegisteredAt(PlayerStatus.PENDING)).toBe(false);
    expect(resubmissionResetsRegisteredAt(PlayerStatus.APPROVED)).toBe(false);
    expect(resubmissionResetsRegisteredAt(PlayerStatus.BANNED)).toBe(false);
  });
});
