import { describe, expect, it } from "vitest";

import { AdminActionType } from "@/generated/prisma/enums";
import { adminActionDetails, adminActionSummary, puntos } from "@/lib/admin-actions";

/**
 * La frase que se guarda en `AdminAction.summary` es la que pinta el historial tal
 * cual, así que sus formas son un contrato: si la baja de un jugador dijera "y sus N
 * partidas" a secas, el número se leería como las filas de `Match` importadas en vez
 * de como las partidas clasificatorias del torneo. Aquí se fijan las tres formas de
 * `PLAYER_REMOVED` (0, 1 y N) y las de los tipos que ya existían, para que un cambio
 * de redacción no cuele sin querer.
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
});
