import { describe, expect, it } from "vitest";

import { AdminActionType } from "@/generated/prisma/enums";
import {
  countsWithoutRevertMark,
  isRevertibleActionType,
  type MatchForScoring,
} from "@/lib/admin-revert";

/**
 * Las dos piezas puras de la reversión: qué tipos se pueden deshacer y la guarda que
 * decide si una partida cuenta con la marca de revertida quitada.
 *
 * La operación en sí (`revertAdminAction()`) necesita la base de datos y no se prueba
 * aquí; lo que se fija es lo que decide **antes** de escribir, que es lo que la
 * interfaz y el test tienen que poder compartir con el servidor.
 */

describe("isRevertibleActionType", () => {
  it("se puede deshacer todo lo que cambia un dato que existe", () => {
    for (const type of [
      AdminActionType.PLAYER_CREATED,
      AdminActionType.PLAYER_EDITED,
      AdminActionType.PLAYER_APPROVED,
      AdminActionType.PLAYER_REJECTED,
      AdminActionType.MATCH_POINTS_REVERTED,
      AdminActionType.MATCH_POINTS_RESTORED,
    ]) {
      expect(isRevertibleActionType(type), type).toBe(true);
    }
  });

  it("no se puede deshacer lo que no deja nada que restaurar", () => {
    // La baja borra el dato; la gestión de admins ya tiene su propia acción reversible;
    // una reversión no se revierte; y la configuración se cambia publicando otra.
    for (const type of [
      AdminActionType.PLAYER_REMOVED,
      AdminActionType.ADMIN_ADDED,
      AdminActionType.ADMIN_DEACTIVATED,
      AdminActionType.ADMIN_REACTIVATED,
      AdminActionType.ACTION_REVERTED,
      AdminActionType.CONFIG_CHANGED,
    ]) {
      expect(isRevertibleActionType(type), type).toBe(false);
    }
  });

  it("cubre el enum entero: ningún tipo se queda sin decidir", () => {
    for (const type of Object.values(AdminActionType)) {
      expect(typeof isRevertibleActionType(type), type).toBe("boolean");
    }
  });
});

/** Una partida 1v1 resuelta dentro de la ventana. */
const PARTIDA: MatchForScoring = {
  id: "match-1",
  gameId: "G-1",
  points: 2,
  revertedAt: null,
  playerId: "player-1",
  mode: "rm_solo",
  result: "WIN",
  startedAt: new Date("2026-09-20T18:00:00.000Z"),
  finishedAt: new Date("2026-09-20T18:20:00.000Z"),
  registeredAt: null,
  rawJson: null,
  playerName: "BeastWizard",
  playerProfileId: 123456,
};

const RULESET = { window: { from: "2026-09-15T00:00:00.000Z", to: "2026-10-15T00:00:00.000Z" } };

describe("countsWithoutRevertMark", () => {
  it("una clasificatoria dentro de la ventana cuenta", () => {
    expect(countsWithoutRevertMark(PARTIDA, RULESET, null)).toBe(true);
  });

  it("la marca de revertida no cambia la respuesta: la pregunta es por la partida sin ella", () => {
    // Es lo que permite deshacer el revert de puntos: la partida que se va a devolver
    // está marcada, y la pregunta es si contaría al quitarle la marca.
    expect(countsWithoutRevertMark({ ...PARTIDA, revertedAt: new Date() }, RULESET, null)).toBe(
      true,
    );
  });

  it("una partida sin resolver no cuenta, así que no hay nada que deshacer", () => {
    expect(countsWithoutRevertMark({ ...PARTIDA, result: null }, RULESET, null)).toBe(false);
  });

  it("una partida fuera de la ventana no cuenta", () => {
    expect(
      countsWithoutRevertMark(
        { ...PARTIDA, startedAt: new Date("2026-09-01T00:00:00.000Z") },
        RULESET,
        null,
      ),
    ).toBe(false);

    expect(
      countsWithoutRevertMark(
        { ...PARTIDA, startedAt: new Date("2026-10-20T00:00:00.000Z") },
        RULESET,
        null,
      ),
    ).toBe(false);
  });

  it("una partida anterior al alta del jugador no cuenta", () => {
    expect(
      countsWithoutRevertMark(
        { ...PARTIDA, registeredAt: new Date("2026-09-25T00:00:00.000Z") },
        RULESET,
        null,
      ),
    ).toBe(false);

    expect(
      countsWithoutRevertMark(
        { ...PARTIDA, registeredAt: new Date("2026-09-01T00:00:00.000Z") },
        RULESET,
        null,
      ),
    ).toBe(true);
  });

  it("una familia que no puntúa no cuenta", () => {
    expect(countsWithoutRevertMark({ ...PARTIDA, mode: "qm_1v1" }, RULESET, null)).toBe(false);
  });
});
