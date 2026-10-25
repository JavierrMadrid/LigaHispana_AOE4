import { describe, expect, it } from "vitest";

import { AdminActionType } from "@/generated/prisma/enums";
import { adminActionDetails, adminActionSummary, puntos } from "@/lib/admin-actions";

/**
 * La frase que se guarda en `AdminAction.summary` es la que pinta el historial tal
 * cual, así que sus formas son un contrato: si la baja de un jugador dijera "y sus N
 * partidas" a secas, el número se leería como las filas de `Match` importadas en vez
 * de como las partidas clasificatorias del torneo. Aquí se fijan las tres formas de
 * `PLAYER_REMOVED` (0, 1 y N), las de las dos direcciones de aprobar/rechazar, las de
 * los tipos que ya existían y las de la gestión de admins y la configuración, para
 * que un cambio de redacción no cuele sin querer.
 */

function daDeBaja(matchCount: number): string {
  return adminActionSummary({
    type: AdminActionType.PLAYER_REMOVED,
    name: "BeastWizard",
    profileId: 123456,
    matchCount,
  });
}

describe("adminActionSummary", () => {
  describe("PLAYER_REMOVED", () => {
    it("con 0 partidas clasificatorias lo dice sin inventarse un número", () => {
      expect(daDeBaja(0)).toBe("Baja de BeastWizard, que no tenía partidas clasificatorias");
    });

    it("con 1 usa el singular", () => {
      expect(daDeBaja(1)).toBe("Baja de BeastWizard y su 1 partida clasificatoria");
    });

    it("con N usa el plural", () => {
      expect(daDeBaja(87)).toBe("Baja de BeastWizard y sus 87 partidas clasificatorias");
    });

    it("el número son partidas clasificatorias, no filas importadas", () => {
      // El caso real que motivó el cambio: 230 filas de `Match` en cascada frente a
      // las que de verdad puntuaban dentro de la ventana.
      expect(daDeBaja(12)).toContain("12 partidas clasificatorias");
    });
  });

  it("PLAYER_CREATED identifica al jugador por su profileId", () => {
    expect(
      adminActionSummary({
        type: AdminActionType.PLAYER_CREATED,
        name: "BeastWizard",
        profileId: 123456,
        status: "APPROVED",
      }),
    ).toBe("Alta de BeastWizard (AoE4World 123456)");
  });

  it("PLAYER_EDITED enumera los campos que cambiaron", () => {
    expect(
      adminActionSummary({
        type: AdminActionType.PLAYER_EDITED,
        name: "BeastWizard",
        profileId: 123456,
        cambios: [
          { campo: "name", etiqueta: "nombre", antes: "Beast", despues: "BeastWizard" },
          { campo: "twitchChannel", etiqueta: "canal de Twitch", antes: null, despues: "beast" },
        ],
      }),
    ).toBe("Edición de BeastWizard (AoE4World 123456): nombre, canal de Twitch");
  });

  it("PLAYER_APPROVED dice quién y con qué perfil", () => {
    expect(
      adminActionSummary({
        type: AdminActionType.PLAYER_APPROVED,
        name: "Vortix",
        profileId: 5364911,
        statusBefore: "PENDING",
        statusAfter: "APPROVED",
      }),
    ).toBe("Aprobación de Vortix (AoE4World 5364911)");
  });

  it("la aprobación sin verificación se distingue de la normal", () => {
    expect(
      adminActionSummary({
        type: AdminActionType.PLAYER_APPROVED,
        name: "Vortix",
        profileId: 5364911,
        statusBefore: "PENDING",
        statusAfter: "APPROVED",
        withoutVerification: true,
      }),
    ).toBe("Aprobación sin verificación de Vortix (AoE4World 5364911)");
  });

  it("PLAYER_REJECTED dice quién y con qué perfil", () => {
    expect(
      adminActionSummary({
        type: AdminActionType.PLAYER_REJECTED,
        name: "Vortix",
        profileId: 5364911,
        statusBefore: "PENDING",
        statusAfter: "REJECTED",
      }),
    ).toBe("Rechazo de Vortix (AoE4World 5364911)");
  });

  it("MATCH_POINTS_REVERTED dice los puntos y la partida", () => {
    expect(
      adminActionSummary({
        type: AdminActionType.MATCH_POINTS_REVERTED,
        playerName: "BeastWizard",
        profileId: 123456,
        gameId: "G-12345",
        points: 2,
      }),
    ).toBe("Revertidos 2 puntos de la partida G-12345 de BeastWizard");
  });

  it("MATCH_POINTS_RESTORED dice los puntos y la partida", () => {
    expect(
      adminActionSummary({
        type: AdminActionType.MATCH_POINTS_RESTORED,
        playerName: "BeastWizard",
        profileId: 123456,
        gameId: "G-12345",
        points: 0,
      }),
    ).toBe("Restaurados 0 puntos de la partida G-12345 de BeastWizard");
  });

  it("ADMIN_ADDED con invitación nueva dice que se ha enviado el correo", () => {
    expect(
      adminActionSummary({
        type: AdminActionType.ADMIN_ADDED,
        email: "pedro@correo.com",
        mode: "invited",
      }),
    ).toBe("Invitación enviada a pedro@correo.com");
  });

  it("ADMIN_ADDED de una cuenta que ya existía lo dice, porque no se manda correo", () => {
    expect(
      adminActionSummary({
        type: AdminActionType.ADMIN_ADDED,
        email: "pedro@correo.com",
        mode: "linked",
      }),
    ).toBe("Alta de pedro@correo.com, que ya tenía cuenta en la web");
  });

  it("ADMIN_DEACTIVATED nombra el correo dado de baja", () => {
    expect(
      adminActionSummary({ type: AdminActionType.ADMIN_DEACTIVATED, email: "pedro@correo.com" }),
    ).toBe("Baja de pedro@correo.com");
  });

  it("ADMIN_REACTIVATED nombra el correo reactivado", () => {
    expect(
      adminActionSummary({ type: AdminActionType.ADMIN_REACTIVATED, email: "pedro@correo.com" }),
    ).toBe("Reactivación de pedro@correo.com");
  });

  it("ACTION_REVERTED lleva el resumen de la acción revertida para no cruzar filas", () => {
    expect(
      adminActionSummary({
        type: AdminActionType.ACTION_REVERTED,
        actionId: "act_123",
        actionSummary: "Baja de BeastWizard y sus 3 partidas clasificatorias",
      }),
    ).toBe("Revertida la acción: Baja de BeastWizard y sus 3 partidas clasificatorias");
  });

  it("CONFIG_CHANGED enumera los campos que cambiaron", () => {
    expect(
      adminActionSummary({
        type: AdminActionType.CONFIG_CHANGED,
        cambios: [
          {
            campo: "window.from",
            etiqueta: "inicio del torneo",
            antes: "2026-01-01",
            despues: "2026-02-01",
          },
          {
            campo: "objectives",
            etiqueta: "objetivos activos",
            antes: "82",
            despues: "80",
          },
        ],
      }),
    ).toBe("Cambio de configuración: inicio del torneo, objetivos activos");
  });
});

describe("puntos", () => {
  it("singular y plural como en el historial", () => {
    expect(puntos(1)).toBe("1 punto");
    expect(puntos(0)).toBe("0 puntos");
    expect(puntos(7)).toBe("7 puntos");
  });
});

describe("adminActionDetails", () => {
  it("guarda el matchCount de la baja tal como va en la frase", () => {
    expect(
      adminActionDetails({
        type: AdminActionType.PLAYER_REMOVED,
        name: "BeastWizard",
        profileId: 123456,
        matchCount: 12,
      }),
    ).toEqual({ name: "BeastWizard", profileId: 123456, matchCount: 12 });
  });

  it("la aprobación guarda el estado de antes y el de después", () => {
    expect(
      adminActionDetails({
        type: AdminActionType.PLAYER_APPROVED,
        name: "Vortix",
        profileId: 5364911,
        statusBefore: "PENDING",
        statusAfter: "APPROVED",
      }),
    ).toEqual({
      name: "Vortix",
      profileId: 5364911,
      statusBefore: "PENDING",
      statusAfter: "APPROVED",
    });
  });

  it("la aprobación sin verificación deja la marca en `details`", () => {
    expect(
      adminActionDetails({
        type: AdminActionType.PLAYER_APPROVED,
        name: "Vortix",
        profileId: 5364911,
        statusBefore: "PENDING",
        statusAfter: "APPROVED",
        withoutVerification: true,
      }),
    ).toEqual({
      name: "Vortix",
      profileId: 5364911,
      statusBefore: "PENDING",
      statusAfter: "APPROVED",
      withoutVerification: true,
    });
  });

  it("el rechazo distingue de dónde venía: un APPROVED que sale de la clasificación", () => {
    expect(
      adminActionDetails({
        type: AdminActionType.PLAYER_REJECTED,
        name: "Vortix",
        profileId: 5364911,
        statusBefore: "APPROVED",
        statusAfter: "REJECTED",
      }),
    ).toEqual({
      name: "Vortix",
      profileId: 5364911,
      statusBefore: "APPROVED",
      statusAfter: "REJECTED",
    });
  });

  it("el alta de admin guarda el modo, para saber si se mandó correo", () => {
    expect(
      adminActionDetails({
        type: AdminActionType.ADMIN_ADDED,
        email: "pedro@correo.com",
        mode: "linked",
      }),
    ).toEqual({ email: "pedro@correo.com", mode: "linked" });
  });

  it("la baja y la reactivación de admin guardan el correo", () => {
    expect(
      adminActionDetails({ type: AdminActionType.ADMIN_DEACTIVATED, email: "pedro@correo.com" }),
    ).toEqual({ email: "pedro@correo.com" });

    expect(
      adminActionDetails({ type: AdminActionType.ADMIN_REACTIVATED, email: "pedro@correo.com" }),
    ).toEqual({ email: "pedro@correo.com" });
  });

  it("la reversión de una acción guarda a qué acción apunta", () => {
    expect(
      adminActionDetails({
        type: AdminActionType.ACTION_REVERTED,
        actionId: "act_123",
        actionSummary: "Baja de BeastWizard",
      }),
    ).toEqual({ actionId: "act_123", actionSummary: "Baja de BeastWizard" });
  });

  it("el cambio de configuración aplana los campos como la edición de jugador", () => {
    expect(
      adminActionDetails({
        type: AdminActionType.CONFIG_CHANGED,
        cambios: [
          {
            campo: "window.from",
            etiqueta: "inicio del torneo",
            antes: "2026-01-01",
            despues: "2026-02-01",
          },
        ],
      }),
    ).toEqual({
      campos: "window.from",
      "window.from.antes": "2026-01-01",
      "window.from.despues": "2026-02-01",
    });
  });
});
