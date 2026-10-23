import { describe, expect, it } from "vitest";

import {
  ADMIN_ACT_DISCORD_MESSAGE_MAX_LENGTH,
  ADMIN_ACT_KIND_LABELS,
  ADMIN_ACT_PRIVATE_INFO_MAX_LENGTH,
  ADMIN_ACT_PUBLIC_REASON_MAX_LENGTH,
  adminActChannelText,
  adminActDmText,
  adminActState,
  adminActSummary,
  isAdminActRevertible,
  readAdminActKind,
  truncateAdminActMessage,
  validateAdminActReasons,
  type AdminActNoticeFields,
} from "@/lib/admin-acts";

/**
 * Las piezas puras de las actuaciones administrativas.
 *
 * Lo que se fija aquí es lo que no puede fallar: la concordancia de los resúmenes, que
 * una reversión sea final, las validaciones de longitud y —sobre todo— que el aviso no
 * pueda llevar la información privada.
 */

describe("readAdminActKind", () => {
  it("acepta los tres tipos y rechaza cualquier otra cosa", () => {
    expect(readAdminActKind("BAN")).toBe("BAN");
    expect(readAdminActKind("MATCH_ANNULMENT")).toBe("MATCH_ANNULMENT");
    expect(readAdminActKind("REVERSAL")).toBe("REVERSAL");
    expect(readAdminActKind("ban")).toBeNull();
    expect(readAdminActKind("")).toBeNull();
    expect(readAdminActKind(null)).toBeNull();
  });
});

describe("isAdminActRevertible", () => {
  it("todo se revierte menos una reversión, que es final", () => {
    expect(isAdminActRevertible("BAN")).toBe(true);
    expect(isAdminActRevertible("MATCH_ANNULMENT")).toBe(true);
    expect(isAdminActRevertible("REVERSAL")).toBe(false);
  });
});

describe("adminActState", () => {
  it("una reversión siempre es final, aunque no esté marcada", () => {
    expect(adminActState("REVERSAL", null)).toBe("final");
    expect(adminActState("REVERSAL", "2026-10-01T00:00:00.000Z")).toBe("final");
  });

  it("las demás están vigentes hasta que otra las revierte", () => {
    expect(adminActState("BAN", null)).toBe("active");
    expect(adminActState("MATCH_ANNULMENT", "2026-10-01T00:00:00.000Z")).toBe("reverted");
  });
});

describe("adminActSummary", () => {
  it("la expulsión nombra al jugador", () => {
    expect(adminActSummary({ kind: "BAN", playerName: "BeastWizard" })).toBe(
      "Expulsión de BeastWizard",
    );
  });

  it("la anulación concuerda en singular y en plural", () => {
    expect(
      adminActSummary({ kind: "MATCH_ANNULMENT", playerName: "BeastWizard", matchCount: 1 }),
    ).toBe("Anulación de 1 partida de BeastWizard");
    expect(
      adminActSummary({ kind: "MATCH_ANNULMENT", playerName: "BeastWizard", matchCount: 3 }),
    ).toBe("Anulación de 3 partidas de BeastWizard");
  });

  it("la reversión concuerda en singular y en plural", () => {
    expect(
      adminActSummary({ kind: "REVERSAL", playerName: "BeastWizard", targetCount: 1 }),
    ).toBe("Reversión de 1 actuación de BeastWizard");
    expect(
      adminActSummary({ kind: "REVERSAL", playerName: "BeastWizard", targetCount: 2 }),
    ).toBe("Reversión de 2 actuaciones de BeastWizard");
  });
});

describe("validateAdminActReasons", () => {
  it("la razón pública es obligatoria", () => {
    for (const publicReason of ["", "   ", "\n\t "]) {
      const result = validateAdminActReasons({ publicReason });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.field).toBe("publicReason");
        expect(result.error).toContain("obligatoria");
      }
    }
  });

  it("recorta los extremos y conserva los saltos de línea interiores", () => {
    const result = validateAdminActReasons({
      publicReason: "  Primera línea.\nSegunda línea.  ",
      privateInfo: "  Solo para el panel.  ",
    });

    expect(result).toEqual({
      ok: true,
      publicReason: "Primera línea.\nSegunda línea.",
      privateInfo: "Solo para el panel.",
    });
  });

  it("la información privada vacía es null, no una cadena", () => {
    const result = validateAdminActReasons({ publicReason: "Motivo", privateInfo: "   " });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.privateInfo).toBeNull();
    }
  });

  it("rechaza una razón pública por encima del tope", () => {
    const result = validateAdminActReasons({
      publicReason: "x".repeat(ADMIN_ACT_PUBLIC_REASON_MAX_LENGTH + 1),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.field).toBe("publicReason");
      expect(result.error).toContain(String(ADMIN_ACT_PUBLIC_REASON_MAX_LENGTH));
    }
  });

  it("rechaza una información privada por encima del tope", () => {
    const result = validateAdminActReasons({
      publicReason: "Motivo",
      privateInfo: "x".repeat(ADMIN_ACT_PRIVATE_INFO_MAX_LENGTH + 1),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.field).toBe("privateInfo");
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Avisos                                                                      */
/* -------------------------------------------------------------------------- */

const BASE: AdminActNoticeFields = {
  kind: "BAN",
  editionName: "Liga Hispana AoE IV",
  playerName: "BeastWizard",
  publicReason: "Incumplimiento de las normas del torneo.",
};

describe("adminActChannelText", () => {
  it("lleva la edición, el nombre, el tipo y la razón pública", () => {
    const text = adminActChannelText(BASE);

    expect(text).toContain("Liga Hispana AoE IV");
    expect(text).toContain("BeastWizard ha sido expulsado del torneo.");
    expect(text).toContain("Motivo: Incumplimiento de las normas del torneo.");
  });

  it("la anulación dice cuántas partidas, en singular y en plural", () => {
    expect(
      adminActChannelText({ ...BASE, kind: "MATCH_ANNULMENT", matchCount: 1 }),
    ).toContain("Se anula 1 partida ganada de BeastWizard.");
    expect(
      adminActChannelText({ ...BASE, kind: "MATCH_ANNULMENT", matchCount: 4 }),
    ).toContain("Se anulan 4 partidas ganadas de BeastWizard.");
  });

  it("la reversión enumera las actuaciones revertidas", () => {
    const text = adminActChannelText({
      ...BASE,
      kind: "REVERSAL",
      targetCount: 2,
      targetSummaries: ["Expulsión de BeastWizard", "Anulación de 2 partidas de BeastWizard"],
    });

    expect(text).toContain("Se revierten 2 actuaciones de BeastWizard.");
    expect(text).toContain("Expulsión de BeastWizard");
    expect(text).toContain("Anulación de 2 partidas de BeastWizard");
  });

  it("con dominio añade el enlace; sin él, no inventa una dirección", () => {
    expect(adminActChannelText({ ...BASE, url: "https://laligahispana.es/" })).toContain(
      "Más información: https://laligahispana.es/",
    );
    expect(adminActChannelText(BASE)).not.toContain("Más información");
  });

  it("trunca los mensajes que no caben en Discord", () => {
    const text = adminActChannelText({
      ...BASE,
      publicReason: "x".repeat(ADMIN_ACT_PUBLIC_REASON_MAX_LENGTH),
      url: `https://laligahispana.es/${"y".repeat(2000)}`,
    });

    expect(text.length).toBeLessThanOrEqual(ADMIN_ACT_DISCORD_MESSAGE_MAX_LENGTH);
    expect(text.endsWith("…")).toBe(true);
  });
});

describe("adminActDmText", () => {
  it("habla en segunda persona y lleva la misma razón pública", () => {
    const text = adminActDmText(BASE);

    expect(text).toContain("Has sido expulsado del torneo.");
    expect(text).toContain("Motivo: Incumplimiento de las normas del torneo.");
    expect(text).toContain("habla con la organización");
  });

  it("la anulación y la reversión también van en segunda persona", () => {
    expect(
      adminActDmText({ ...BASE, kind: "MATCH_ANNULMENT", matchCount: 1 }),
    ).toContain("Se ha anulado 1 de tus partidas ganadas.");
    expect(
      adminActDmText({ ...BASE, kind: "MATCH_ANNULMENT", matchCount: 3 }),
    ).toContain("Se han anulado 3 de tus partidas ganadas.");
    expect(
      adminActDmText({ ...BASE, kind: "REVERSAL", targetCount: 1 }),
    ).toContain("Se ha revertido 1 actuación sobre tu participación.");
  });
});

describe("la información privada no entra en el aviso", () => {
  it("el tipo del aviso no admite `privateInfo`", () => {
    // Esta es la prueba de verdad: si alguien añadiera `privateInfo` a
    // `AdminActNoticeFields`, el `@ts-expect-error` dejaría de tener error y el build
    // fallaría. No hay comprobación en tiempo de ejecución porque no hace falta: el
    // dato no se puede pasar.
    // @ts-expect-error - el aviso no admite información privada
    const conPrivada: AdminActNoticeFields = { ...BASE, privateInfo: "Esto no sale del panel." };

    expect(conPrivada).toBeDefined();
    expect(adminActChannelText(BASE)).not.toContain("Esto no sale del panel.");
    expect(adminActDmText(BASE)).not.toContain("Esto no sale del panel.");
  });
});

describe("truncateAdminActMessage", () => {
  it("deja intacto lo que cabe y corta lo que no", () => {
    expect(truncateAdminActMessage("corto", 10)).toBe("corto");

    const corto = truncateAdminActMessage("x".repeat(20), 10);

    expect(corto.length).toBe(10);
    expect(corto.endsWith("…")).toBe(true);
  });

  it("corta por el último espacio si queda cerca del límite", () => {
    const text = `${"a".repeat(95)} ${"b".repeat(50)}`;

    expect(truncateAdminActMessage(text, 100)).toBe(`${"a".repeat(95)}…`);
  });

  it("corta duro si no hay un espacio razonablemente cerca", () => {
    const text = "a".repeat(200);

    expect(truncateAdminActMessage(text, 100)).toBe(`${"a".repeat(99)}…`);
  });
});

describe("ADMIN_ACT_KIND_LABELS", () => {
  it("tiene un rótulo para cada tipo", () => {
    expect(ADMIN_ACT_KIND_LABELS.BAN).toBe("Expulsión");
    expect(ADMIN_ACT_KIND_LABELS.MATCH_ANNULMENT).toBe("Anulación de partidas");
    expect(ADMIN_ACT_KIND_LABELS.REVERSAL).toBe("Reversión de actuaciones");
  });
});
