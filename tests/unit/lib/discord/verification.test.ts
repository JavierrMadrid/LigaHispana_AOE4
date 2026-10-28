import { describe, expect, it } from "vitest";

import {
  isDiscordVerificationConfigured,
  missingDiscordVerificationEnv,
  type DiscordConfig,
} from "@/lib/discord/env";
import {
  VERIFICATION_ENV_NAMES,
  missingVerificationEnv,
  parseVerificationCustomId,
  planApproval,
  resolveVerificationClick,
  verificationCanBeApprovedWithout,
  verificationCanBeResent,
  verificationCustomId,
  verificationDmMessage,
  verificationDmText,
  verificationGateApplies,
  verificationLinksDiscord,
  verificationResolvedText,
  verificationStaleText,
  type VerificationConfig,
  type VerificationDecision,
  type VerificationPlayerStatus,
  type VerificationState,
} from "@/lib/discord/verification";

/**
 * La puerta de verificación del alta de admin (issue 119).
 *
 * Lo que se fija aquí es lo que no puede decidirse en dos sitios a la vez: cuándo
 * una fila está sujeta, qué hace aprobar según haya privado o no, y qué pulsaciones
 * de los botones se pueden aplicar. Todo es puro: ni base de datos, ni red, ni
 * variables de entorno.
 */

const PENDIENTE: VerificationState = { requestedAt: new Date("2026-10-01T10:00:00Z"), verifiedAt: null };
const VERIFICADA: VerificationState = { requestedAt: new Date("2026-10-01T10:00:00Z"), verifiedAt: new Date("2026-10-01T10:05:00Z") };
const SIN_PUERTA: VerificationState = { requestedAt: null, verifiedAt: null };

/** Las cuatro credenciales puestas, que es lo que hay en producción. */
const CONFIG_COMPLETA: VerificationConfig = {
  botToken: "token",
  guildId: "servidor",
  clientId: "aplicacion",
  publicKey: "clave",
};

/** La misma configuración con lo que se quiera cambiar. */
function conConfig(overrides: Partial<VerificationConfig> = {}): VerificationConfig {
  return { ...CONFIG_COMPLETA, ...overrides };
}

/**
 * La configuración entera de Discord, que es lo que leen el guard y el aviso.
 *
 * Se pasa siempre explícita para no tocar ni los bindings del Worker ni `process.env`:
 * el test sigue siendo puro, y lo que se comprueba es la decisión, no la lectura.
 */
const CONFIG_DISCORD: DiscordConfig = {
  botToken: "token",
  guildId: "servidor",
  announceChannelId: null,
  participantRoleId: null,
  clientId: "aplicacion",
  clientSecret: "secreto",
  redirectUri: null,
  inviteUrl: null,
  linkSecret: "firma",
  publicKey: "clave",
  apiBase: "https://discord.com/api/v10",
  timeoutMs: 8_000,
  userAgent: "test",
  maxChecksPerRun: 10,
  roleMaxPerRun: 10,
  rosterMaxPages: 20,
  rosterTtlHours: 12,
};

describe("credenciales que faltan para verificar el alta", () => {
  it("con las cuatro puestas no falta ninguna", () => {
    expect(missingVerificationEnv(CONFIG_COMPLETA)).toEqual([]);
  });

  it("nota cada una por separado, por su nombre de variable", () => {
    const casos: [string, VerificationConfig][] = [
      ["DISCORD_BOT_TOKEN", conConfig({ botToken: null })],
      ["DISCORD_GUILD_ID", conConfig({ guildId: null })],
      ["DISCORD_CLIENT_ID", conConfig({ clientId: null })],
      ["DISCORD_PUBLIC_KEY", conConfig({ publicKey: null })],
    ];

    for (const [nombre, config] of casos) {
      expect(missingVerificationEnv(config)).toEqual([nombre]);
    }
  });

  it("con varias ausentes las devuelve en el orden de la lista", () => {
    // Lo que se fija es el orden, no el conjunto: el aviso del panel se pinta tal
    // cual, y un orden que cambie con la configuración no se puede leer.
    expect(
      missingVerificationEnv(
        conConfig({ botToken: null, clientId: null, publicKey: null }),
      ),
    ).toEqual(["DISCORD_BOT_TOKEN", "DISCORD_CLIENT_ID", "DISCORD_PUBLIC_KEY"]);
  });

  it("sin ninguna, están las cuatro y en el mismo orden que la constante", () => {
    const faltan = missingVerificationEnv(
      conConfig({ botToken: null, guildId: null, clientId: null, publicKey: null }),
    );

    expect(faltan).toEqual([...VERIFICATION_ENV_NAMES]);
    expect(faltan).toEqual([
      "DISCORD_BOT_TOKEN",
      "DISCORD_GUILD_ID",
      "DISCORD_CLIENT_ID",
      "DISCORD_PUBLIC_KEY",
    ]);
  });

  it("un valor vacío no cuenta como ausente: eso lo decide la lectura del entorno", () => {
    // `null` es lo que devuelve `readString()` cuando la variable no está o está en
    // blanco. Tratar aquí `""` como ausente daría al guard de `env.ts` una condición
    // distinta de la del aviso del panel.
    expect(missingVerificationEnv(conConfig({ botToken: "" }))).toEqual([]);
  });
});

describe("el guard de env y el aviso del panel", () => {
  it("dicen lo mismo sobre la misma configuración", () => {
    // La coherencia no es cosmética: si el guard aprobara y el aviso callara, el alta
    // se aprobaría sin privado sin que nadie se entere. Se prueban las dos caras de
    // cada credencial, que es donde pueden divergir.
    const configuraciones: DiscordConfig[] = [
      CONFIG_DISCORD,
      { ...CONFIG_DISCORD, botToken: null },
      { ...CONFIG_DISCORD, guildId: null },
      { ...CONFIG_DISCORD, clientId: null },
      { ...CONFIG_DISCORD, publicKey: null },
    ];

    for (const config of configuraciones) {
      const faltan = missingDiscordVerificationEnv(config);

      expect(missingVerificationEnv(config)).toEqual(faltan);
      expect(isDiscordVerificationConfigured(config)).toBe(faltan.length === 0);
    }
  });
});

describe("custom_id de los botones", () => {
  it("el sí y el no se distinguen en el prefijo", () => {
    expect(verificationCustomId("confirm", "abc")).toBe("pv:c:abc");
    expect(verificationCustomId("decline", "abc")).toBe("pv:d:abc");
  });

  it("se leen de vuelta con su decisión y su token", () => {
    expect(parseVerificationCustomId("pv:c:abc")).toEqual({ decision: "confirm", token: "abc" });
    expect(parseVerificationCustomId("pv:d:abc")).toEqual({ decision: "decline", token: "abc" });
  });

  it("un componente de otro módulo no se toca", () => {
    expect(parseVerificationCustomId("otro:boton")).toBeNull();
    expect(parseVerificationCustomId("")).toBeNull();
  });

  it("un prefijo sin token no es un botón válido", () => {
    expect(parseVerificationCustomId("pv:c:")).toBeNull();
    expect(parseVerificationCustomId("pv:d:")).toBeNull();
  });

  it("el token puede llevar cualquier cosa detrás del prefijo", () => {
    // No se valida la forma: quien decide si vale es la búsqueda por token en la
    // base. Aquí solo se separa el prefijo.
    expect(parseVerificationCustomId("pv:c:un-token-con-guiones-1234")).toEqual({
      decision: "confirm",
      token: "un-token-con-guiones-1234",
    });
  });
});

describe("texto del privado", () => {
  const input = { editionName: "Liga Hispana AoE IV", playerName: "BeastWizard", profileId: 123456 };

  it("dice la edición, el nombre y el perfil de AoE4World", () => {
    const texto = verificationDmText(input);

    expect(texto).toContain("Liga Hispana AoE IV");
    expect(texto).toContain("BeastWizard");
    expect(texto).toContain("123456");
  });

  it("deja claro que puede decir que no", () => {
    const texto = verificationDmText(input);

    expect(texto).toContain("¿Confirmas que quieres participar?");
    expect(texto).toContain("pulsa No");
  });

  it("lleva dos botones con los estilos de sí y no y las menciones desactivadas", () => {
    const mensaje = verificationDmMessage(input, "token-1");
    const fila = mensaje.components[0];

    expect(fila.type).toBe(1);
    expect(fila.components).toHaveLength(2);
    expect(fila.components[0]).toEqual({
      type: 2,
      style: 3,
      label: "Sí, participo",
      custom_id: "pv:c:token-1",
    });
    expect(fila.components[1]).toEqual({
      type: 2,
      style: 4,
      label: "No, no participo",
      custom_id: "pv:d:token-1",
    });
    expect(mensaje.allowed_mentions).toEqual({ parse: [] });
    expect(mensaje.content).toBe(verificationDmText(input));
  });
});

describe("la puerta", () => {
  it("aplica cuando se pidió verificar y no hay confirmación", () => {
    expect(verificationGateApplies(PENDIENTE)).toBe(true);
  });

  it("no aplica a una fila que ya confirmó", () => {
    expect(verificationGateApplies(VERIFICADA)).toBe(false);
  });

  it("no aplica a una fila sin solicitud: es el estado de lo antiguo y de /participar", () => {
    expect(verificationGateApplies(SIN_PUERTA)).toBe(false);
  });
});

describe("aprobar", () => {
  it("sin configuración se aprueba como siempre", () => {
    expect(
      planApproval({
        ...PENDIENTE,
        verificationConfigured: false,
        sentAt: null,
        status: "PENDING",
      }),
    ).toBe("approve");
  });

  it("sin puerta se aprueba como siempre", () => {
    expect(
      planApproval({
        ...SIN_PUERTA,
        verificationConfigured: true,
        sentAt: null,
        status: "PENDING",
      }),
    ).toBe("approve");
  });

  it("con la persona ya verificada se aprueba", () => {
    expect(
      planApproval({
        ...VERIFICADA,
        verificationConfigured: true,
        sentAt: null,
        status: "PENDING",
      }),
    ).toBe("approve");
  });

  it("con la puerta activa y sin privado enviado, hay que enviarlo", () => {
    expect(
      planApproval({
        ...PENDIENTE,
        verificationConfigured: true,
        sentAt: null,
        status: "PENDING",
      }),
    ).toBe("send-verification");
  });

  it("con el privado ya enviado no se duplica: se espera la confirmación", () => {
    expect(
      planApproval({
        ...PENDIENTE,
        verificationConfigured: true,
        sentAt: new Date("2026-10-01T10:01:00Z"),
        status: "PENDING",
      }),
    ).toBe("await-confirmation");
  });

  it("re-aprobar un rechazado manda un privado nuevo aunque quede sentAt del anterior", () => {
    // El token se limpió al rechazar, así que los botones del privado viejo no
    // valen: no se puede contestar "esperando confirmación".
    expect(
      planApproval({
        ...PENDIENTE,
        verificationConfigured: true,
        sentAt: new Date("2026-10-01T10:01:00Z"),
        status: "REJECTED",
      }),
    ).toBe("send-verification");
  });
});

describe("reenviar y aprobar sin verificación", () => {
  const base = {
    verificationConfigured: true,
    status: "PENDING" as VerificationPlayerStatus,
    ...PENDIENTE,
  };

  it("se reenvía a un alta pendiente sujeta y sin confirmar", () => {
    expect(verificationCanBeResent(base)).toBe(true);
  });

  it("no se reenvía sin configuración", () => {
    expect(verificationCanBeResent({ ...base, verificationConfigured: false })).toBe(false);
  });

  it("no se reenvía a un aprobado ni a un rechazado", () => {
    expect(verificationCanBeResent({ ...base, status: "APPROVED" })).toBe(false);
    expect(verificationCanBeResent({ ...base, status: "REJECTED" })).toBe(false);
  });

  it("no se reenvía a quien ya confirmó o no está sujeto", () => {
    expect(verificationCanBeResent({ ...base, ...VERIFICADA })).toBe(false);
    expect(verificationCanBeResent({ ...base, ...SIN_PUERTA })).toBe(false);
  });

  it("la aprobación sin verificación solo cabe en un alta pendiente y sin confirmar", () => {
    expect(verificationCanBeApprovedWithout({ status: "PENDING", ...PENDIENTE })).toBe(true);
    expect(verificationCanBeApprovedWithout({ status: "APPROVED", ...PENDIENTE })).toBe(false);
    expect(verificationCanBeApprovedWithout({ status: "PENDING", ...VERIFICADA })).toBe(false);
    expect(verificationCanBeApprovedWithout({ status: "PENDING", ...SIN_PUERTA })).toBe(false);
  });
});

describe("la pulsación de un botón", () => {
  function pulsacion(
    decision: VerificationDecision,
    overrides: Partial<{
      tokenMatches: boolean;
      senderMatches: boolean;
      status: VerificationPlayerStatus;
      state: VerificationState;
    }> = {},
  ) {
    return resolveVerificationClick({
      decision,
      tokenMatches: true,
      senderMatches: true,
      status: "PENDING",
      state: PENDIENTE,
      ...overrides,
    });
  }

  it("el sí de la cuenta destinataria aprueba", () => {
    expect(pulsacion("confirm")).toBe("approve");
  });

  it("el no de la cuenta destinataria rechaza", () => {
    expect(pulsacion("decline")).toBe("reject");
  });

  it("un token que no encuentra fila no hace nada", () => {
    expect(pulsacion("confirm", { tokenMatches: false })).toBe("stale");
  });

  it("una cuenta que no es la destinataria no hace nada", () => {
    expect(pulsacion("confirm", { senderMatches: false })).toBe("stale");
  });

  it("una fila que ya no está pendiente no hace nada", () => {
    expect(pulsacion("confirm", { status: "APPROVED" })).toBe("stale");
    expect(pulsacion("decline", { status: "REJECTED" })).toBe("stale");
    expect(pulsacion("confirm", { status: "BANNED" })).toBe("stale");
  });

  it("una fila ya confirmada o no sujeta no vuelve a resolverse", () => {
    expect(pulsacion("confirm", { state: VERIFICADA })).toBe("stale");
    expect(pulsacion("decline", { state: SIN_PUERTA })).toBe("stale");
  });
});

describe("textos de resultado", () => {
  it("el sí y el no se contestan distinto", () => {
    expect(verificationResolvedText("confirm")).toContain("Alta confirmada");
    expect(verificationResolvedText("decline")).toContain("no quieres participar");
  });

  it("el texto genérico no revela qué falló", () => {
    const texto = verificationStaleText();

    expect(texto).toContain("ya no está vigente");
    expect(texto).not.toContain("token");
    expect(texto).not.toContain("cuenta");
  });
});

describe("vincular la cuenta de Discord al confirmar", () => {
  it("se escribe si no choca con otro participante", () => {
    expect(verificationLinksDiscord(null)).toBe(true);
  });

  it("no se escribe si la cuenta ya es de otra fila", () => {
    expect(verificationLinksDiscord("OtraPersona")).toBe(false);
  });
});
