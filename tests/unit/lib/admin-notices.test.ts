import { describe, expect, it } from "vitest";

import {
  adminNoticeChannelText,
  adminNoticeDmText,
  adminNoticePlan,
  playerRemovedIsParticipant,
  type AdminNotice,
} from "@/lib/admin-notices";

/**
 * Los avisos de las acciones de administración: qué toca y qué se dice.
 *
 * Todo es puro y sin red ni base de datos. Lo que se fija es lo que no puede fallar: que
 * la baja de una solicitud **no** diga «retirado del torneo» (nunca entró), que el
 * privado y el global sean independientes, y que un punto no se anuncie en plural.
 *
 * Las actuaciones administrativas (expulsiones, anulaciones y reversiones) se prueban
 * en `admin-acts.test.ts`: tienen su propio módulo porque llevan razón pública.
 */

const EDICION = "Liga Hispana AoE IV";

function baja(status: "PENDING" | "APPROVED" | "REJECTED" | "BANNED", matchCount: number): AdminNotice {
  return { kind: "player-removed", editionName: EDICION, name: "BeastWizard", status, matchCount };
}

describe("playerRemovedIsParticipant", () => {
  it("un APPROVED o un BANNED habían entrado al torneo", () => {
    expect(playerRemovedIsParticipant("APPROVED")).toBe(true);
    expect(playerRemovedIsParticipant("BANNED")).toBe(true);
    expect(playerRemovedIsParticipant("PENDING")).toBe(false);
    expect(playerRemovedIsParticipant("REJECTED")).toBe(false);
  });
});

describe("adminNoticePlan", () => {
  it("sin token no se puede avisar de nada", () => {
    expect(adminNoticePlan({ hasToken: false, hasAccount: true, hasChannel: true })).toEqual({
      dm: false,
      channel: false,
    });
  });

  it("con token, cuenta y canal salen los dos", () => {
    expect(adminNoticePlan({ hasToken: true, hasAccount: true, hasChannel: true })).toEqual({
      dm: true,
      channel: true,
    });
  });

  it("sin cuenta no hay privado, pero sí global", () => {
    expect(adminNoticePlan({ hasToken: true, hasAccount: false, hasChannel: true })).toEqual({
      dm: false,
      channel: true,
    });
  });

  it("sin canal no hay global, pero sí privado", () => {
    expect(adminNoticePlan({ hasToken: true, hasAccount: true, hasChannel: false })).toEqual({
      dm: true,
      channel: false,
    });
  });

  it("sin cuenta ni canal no hay ninguno", () => {
    expect(adminNoticePlan({ hasToken: true, hasAccount: false, hasChannel: false })).toEqual({
      dm: false,
      channel: false,
    });
  });
});

describe("adminNoticeChannelText", () => {
  it("la baja de un participante dice que se le retira y cuántas partidas caen", () => {
    const texto = adminNoticeChannelText(baja("APPROVED", 3), null);

    expect(texto).toContain(EDICION);
    expect(texto).toContain("BeastWizard ha sido retirado del torneo.");
    expect(texto).toContain("Sus 3 partidas clasificatorias dejan de contar.");
  });

  it("con una sola partida clasificatoria, singular", () => {
    expect(adminNoticeChannelText(baja("APPROVED", 1), null)).toContain(
      "Su partida clasificatoria deja de contar.",
    );
  });

  it("sin partidas clasificatorias no habla de partidas", () => {
    const texto = adminNoticeChannelText(baja("APPROVED", 0), null);

    expect(texto).toContain("ha sido retirado del torneo.");
    expect(texto).not.toContain("dejan de contar");
  });

  it("la baja de una solicitud no dice que se le retira del torneo", () => {
    for (const status of ["PENDING", "REJECTED"] as const) {
      const texto = adminNoticeChannelText(baja(status, 0), null);

      expect(texto).toContain("la solicitud de BeastWizard ha sido descartada.");
      expect(texto).not.toContain("retirado");
      expect(texto).not.toContain("dejan de contar");
    }
  });

  it("con dominio configurado añade el enlace; sin él, no inventa una dirección", () => {
    const conEnlace = adminNoticeChannelText(baja("APPROVED", 2), "https://laligahispana.es/");
    const sinEnlace = adminNoticeChannelText(baja("APPROVED", 2), null);

    expect(conEnlace).toContain("Más información: https://laligahispana.es/");
    expect(sinEnlace).not.toContain("http");
    expect(sinEnlace).not.toContain("Más información");
  });
});

describe("adminNoticeDmText", () => {
  it("al participante retirado se le habla en segunda persona", () => {
    const texto = adminNoticeDmText(baja("APPROVED", 3));

    expect(texto).toContain(EDICION);
    expect(texto).toContain("se te ha retirado del torneo.");
    expect(texto).toContain("Si crees que es un error, habla con la organización.");
  });

  it("a la solicitud descartada no se le dice que se la retira del torneo", () => {
    const texto = adminNoticeDmText(baja("PENDING", 0));

    expect(texto).toContain("tu solicitud de inscripción ha sido descartada.");
    expect(texto).not.toContain("retirado");
  });

  it("el privado no lleva enlace", () => {
    expect(adminNoticeDmText(baja("APPROVED", 2))).not.toContain("http");
  });
});
