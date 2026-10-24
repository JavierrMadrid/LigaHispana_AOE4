import { describe, expect, it } from "vitest";

import {
  DISCORD_TIMESTAMP_TOLERANCE_SECONDS,
  ephemeralResponse,
  hexToBytes,
  parseDiscordInteraction,
  pongResponse,
  updateMessageResponse,
  verifyDiscordSignature,
} from "@/lib/discord/interactions";

/**
 * La frontera de las interacciones de Discord (issue 119).
 *
 * La firma se prueba con un par de claves Ed25519 generado aquí mismo: es lo que
 * permite comprobar el caso que de verdad importa —un cuerpo manipulado no pasa—
 * sin red y sin variables de entorno. El reloj entra por parámetro, así que la
 * ventana de cinco minutos tampoco depende de la hora real.
 */

const NOW = new Date("2026-10-01T12:00:00Z");
const TIMESTAMP = String(Math.floor(NOW.getTime() / 1000));

function toHex(bytes: ArrayBuffer | Uint8Array): string {
  const vista = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);

  return Array.from(vista)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function parDeClaves(): Promise<{
  publicKey: string;
  sign: (timestamp: string, body: string) => Promise<string>;
}> {
  const par = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);

  if (!("privateKey" in par)) {
    throw new Error("Se esperaba un par de claves Ed25519.");
  }

  const publicKey = toHex(await crypto.subtle.exportKey("raw", par.publicKey));

  return {
    publicKey,
    sign: async (timestamp, body) => {
      const firma = await crypto.subtle.sign(
        "Ed25519",
        par.privateKey,
        new TextEncoder().encode(`${timestamp}${body}`),
      );

      return toHex(firma);
    },
  };
}

describe("firma de Discord", () => {
  it("una firma correcta y reciente se acepta", async () => {
    const { publicKey, sign } = await parDeClaves();
    const body = JSON.stringify({ type: 1 });

    await expect(
      verifyDiscordSignature({
        publicKey,
        signature: await sign(TIMESTAMP, body),
        timestamp: TIMESTAMP,
        body,
        now: NOW,
      }),
    ).resolves.toBe("ok");
  });

  it("el cuerpo manipulado no pasa", async () => {
    const { publicKey, sign } = await parDeClaves();
    const firmado = JSON.stringify({ type: 1 });
    const recibido = JSON.stringify({ type: 3 });

    await expect(
      verifyDiscordSignature({
        publicKey,
        signature: await sign(TIMESTAMP, firmado),
        timestamp: TIMESTAMP,
        body: recibido,
        now: NOW,
      }),
    ).resolves.toBe("invalid");
  });

  it("otra clave pública no valida la firma", async () => {
    const firmante = await parDeClaves();
    const otro = await parDeClaves();
    const body = JSON.stringify({ type: 1 });

    await expect(
      verifyDiscordSignature({
        publicKey: otro.publicKey,
        signature: await firmante.sign(TIMESTAMP, body),
        timestamp: TIMESTAMP,
        body,
        now: NOW,
      }),
    ).resolves.toBe("invalid");
  });

  it("una firma vieja se rechaza aunque sea válida", async () => {
    const { publicKey, sign } = await parDeClaves();
    const body = JSON.stringify({ type: 1 });
    const viejo = String(Math.floor(NOW.getTime() / 1000) - DISCORD_TIMESTAMP_TOLERANCE_SECONDS - 1);

    await expect(
      verifyDiscordSignature({
        publicKey,
        signature: await sign(viejo, body),
        timestamp: viejo,
        body,
        now: NOW,
      }),
    ).resolves.toBe("stale");
  });

  it("sin cabeceras no se intenta verificar", async () => {
    const { publicKey } = await parDeClaves();

    await expect(
      verifyDiscordSignature({
        publicKey,
        signature: null,
        timestamp: null,
        body: "{}",
        now: NOW,
      }),
    ).resolves.toBe("missing");
  });

  it("una firma o una clave que no son hexadecimales se rechazan como mal formadas", async () => {
    const { publicKey } = await parDeClaves();

    await expect(
      verifyDiscordSignature({
        publicKey,
        signature: "no-es-hexadecimal",
        timestamp: TIMESTAMP,
        body: "{}",
        now: NOW,
      }),
    ).resolves.toBe("malformed");

    await expect(
      verifyDiscordSignature({
        publicKey: "zz",
        signature: "00".repeat(64),
        timestamp: TIMESTAMP,
        body: "{}",
        now: NOW,
      }),
    ).resolves.toBe("malformed");
  });

  it("una clave de la longitud equivocada no se acepta", async () => {
    const { sign } = await parDeClaves();
    const body = "{}";

    await expect(
      verifyDiscordSignature({
        publicKey: "00".repeat(16),
        signature: await sign(TIMESTAMP, body),
        timestamp: TIMESTAMP,
        body,
        now: NOW,
      }),
    ).resolves.toBe("malformed");
  });
});

describe("hexToBytes", () => {
  it("convierte un hexadecimal par", () => {
    expect(Array.from(hexToBytes("00ff10") ?? [])).toEqual([0, 255, 16]);
  });

  it("rechaza lo que no es hexadecimal o tiene longitud impar", () => {
    expect(hexToBytes("0")).toBeNull();
    expect(hexToBytes("zz")).toBeNull();
    expect(hexToBytes("")).toBeNull();
  });
});

describe("parseDiscordInteraction", () => {
  it("lee un PING", () => {
    expect(parseDiscordInteraction(JSON.stringify({ type: 1, application_id: "app" }))).toEqual({
      ok: true,
      interaction: { kind: "ping", applicationId: "app" },
    });
  });

  it("lee un botón con el usuario en `user` (DM)", () => {
    expect(
      parseDiscordInteraction(
        JSON.stringify({
          type: 3,
          application_id: "app",
          data: { custom_id: "pv:c:token" },
          user: { id: "123" },
        }),
      ),
    ).toEqual({
      ok: true,
      interaction: {
        kind: "component",
        applicationId: "app",
        customId: "pv:c:token",
        userId: "123",
      },
    });
  });

  it("lee el usuario de `member.user` si el botón llega en un servidor", () => {
    const leido = parseDiscordInteraction(
      JSON.stringify({
        type: 3,
        application_id: "app",
        data: { custom_id: "pv:d:token" },
        member: { user: { id: "456" } },
      }),
    );

    expect(leido.ok && leido.interaction.kind === "component" && leido.interaction.userId).toBe("456");
  });

  it("un tipo que no se maneja sale como unsupported", () => {
    expect(parseDiscordInteraction(JSON.stringify({ type: 5, application_id: "app" }))).toEqual({
      ok: true,
      interaction: { kind: "unsupported", applicationId: "app", type: 5 },
    });
  });

  it("un cuerpo que no es JSON, no es objeto o no trae type se rechaza", () => {
    expect(parseDiscordInteraction("no-json")).toEqual({ ok: false, reason: "invalid-json" });
    expect(parseDiscordInteraction("[]")).toEqual({ ok: false, reason: "not-an-object" });
    expect(parseDiscordInteraction(JSON.stringify({ application_id: "app" }))).toEqual({
      ok: false,
      reason: "missing-type",
    });
  });

  it("un componente sin custom_id sale con la cadena vacía, no como error", () => {
    const leido = parseDiscordInteraction(
      JSON.stringify({ type: 3, application_id: "app", data: {}, user: { id: "1" } }),
    );

    expect(leido.ok && leido.interaction.kind === "component" && leido.interaction.customId).toBe("");
  });
});

describe("respuestas", () => {
  it("el PING contesta type 1", () => {
    expect(pongResponse()).toEqual({ type: 1 });
  });

  it("resolver un botón edita el mensaje y le quita los componentes", () => {
    expect(updateMessageResponse("hecho")).toEqual({
      type: 7,
      data: { content: "hecho", components: [] },
    });
  });

  it("un componente ajeno se contesta de forma efímera", () => {
    expect(ephemeralResponse("no")).toEqual({
      type: 4,
      data: { content: "no", flags: 64 },
    });
  });
});
