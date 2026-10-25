import { describe, expect, it } from "vitest";

import { postChannelMessage } from "@/lib/discord/channel";
import type { DiscordConfig } from "@/lib/discord/env";
import type { DiscordHttpClient } from "@/lib/discord/http";

/**
 * El envío al canal de avisos y las menciones que autoriza.
 *
 * Lo que se fija aquí es lo que no puede fallar por un descuido: que un mensaje sin
 * menciones no lleve `allowed_mentions` (para no cambiar lo que ya sale), que los avisos
 * de eventos sigan pudiendo pingear a su rol, y que el aviso de comienzo
 * —el único con texto escrito en el panel— no pueda pingear a nadie aunque un nombre de
 * evento traiga un `@everyone`. El cliente es falso: ni red ni token.
 */

const CONFIG: DiscordConfig & { botToken: string; announceChannelId: string } = {
  botToken: "token-de-prueba",
  guildId: null,
  announceChannelId: "canal",
  participantRoleId: null,
  clientId: null,
  clientSecret: null,
  redirectUri: null,
  inviteUrl: null,
  linkSecret: null,
  publicKey: null,
  apiBase: "https://discord.com/api/v10",
  timeoutMs: 8_000,
  userAgent: "test",
  maxChecksPerRun: 10,
  roleMaxPerRun: 10,
  rosterMaxPages: 20,
  rosterTtlHours: 12,
};

/** Un cliente que apunta el cuerpo de cada petición sin salir a la red. */
function fakeClient() {
  const bodies: Record<string, unknown>[] = [];

  const client = {
    request: async (
      _method: string,
      _path: string,
      options?: { json?: unknown },
    ): Promise<unknown> => {
      bodies.push((options?.json ?? {}) as Record<string, unknown>);

      return null;
    },
  } as unknown as DiscordHttpClient;

  return { client, bodies };
}

describe("postChannelMessage: menciones", () => {
  it("sin opciones manda solo el texto y no toca `allowed_mentions`", async () => {
    const { client, bodies } = fakeClient();

    await postChannelMessage(client, CONFIG, "Hola @everyone");

    expect(bodies).toEqual([{ content: "Hola @everyone" }]);
  });

  it("con `mentionRoleIds` autoriza solo esos roles", async () => {
    const { client, bodies } = fakeClient();

    await postChannelMessage(client, CONFIG, "<@&42> Recordatorio", {
      mentionRoleIds: ["42"],
    });

    expect(bodies).toEqual([
      {
        content: "<@&42> Recordatorio",
        allowed_mentions: { parse: [], roles: ["42"] },
      },
    ]);
  });

  it("con `suppressMentions` manda la lista de roles vacía", async () => {
    const { client, bodies } = fakeClient();

    await postChannelMessage(client, CONFIG, "@everyone empezamos", {
      suppressMentions: true,
    });

    expect(bodies).toEqual([
      {
        content: "@everyone empezamos",
        allowed_mentions: { parse: [], roles: [] },
      },
    ]);
  });

  it("`suppressMentions: false` no cambia nada", async () => {
    const { client, bodies } = fakeClient();

    await postChannelMessage(client, CONFIG, "Hola", { suppressMentions: false });

    expect(bodies).toEqual([{ content: "Hola" }]);
  });

  it("suprimir y mencionar a la vez deja la lista de roles intacta", async () => {
    const { client, bodies } = fakeClient();

    await postChannelMessage(client, CONFIG, "<@&42> Hola", {
      mentionRoleIds: ["42"],
      suppressMentions: true,
    });

    expect(bodies).toEqual([
      { content: "<@&42> Hola", allowed_mentions: { parse: [], roles: ["42"] } },
    ]);
  });
});
