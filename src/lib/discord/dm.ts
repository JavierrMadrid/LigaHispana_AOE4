import "server-only";

import { type DiscordHttpClient } from "@/lib/discord/http";
import { matchRosterUsername } from "@/lib/discord/membership";
import { readDiscordRosterCache } from "@/lib/discord/roster-cache";
import { isRecord } from "@/lib/json";

/**
 * Mensajes privados de Discord: resolver la cuenta, abrir el canal y publicar en él.
 *
 * Vive aquí y no en cada módulo que manda privados porque son **tres llamadas que
 * siempre van juntas** y ya las compartían los avisos de administración: abrir el
 * canal del DM (`POST /users/@me/channels`) y publicar en él
 * (`POST /channels/{id}/messages`) no cambian según quién los pida, y tener dos
 * copias significaba que un arreglo en una (un error más claro, un payload con
 * componentes) no llegaba a la otra.
 *
 * ## La cuenta, y por qué se resuelve aquí
 *
 * La normal es `discordUserId` (la firma el OAuth). Si solo hay `@usuario` (alta de
 * admin), se resuelve contra el **roster cacheado** con `matchRosterUsername()`, la
 * misma resolución que usa la comprobación de pertenencia. Sin roster, o si el
 * nombre no cuadra o es ambiguo, no hay cuenta y no es un fallo: quien llama decide
 * qué hacer con ese `null`.
 *
 * ## El prefijo del log
 *
 * Cada funcionalidad que manda privados tiene su prefijo (`[admin-act-notice]`,
 * `[discord-verification]`), y se pasa para que un fallo de la caché del roster se
 * pueda buscar por el módulo que lo sufrió. Nunca se loguea el cuerpo del mensaje
 * ni el token: lo único que sale es el `@usuario` que no se pudo resolver.
 */

/** La persona destinataria, con lo que hace falta para resolver su cuenta. */
export type DiscordDmTarget = {
  name: string;
  discordUserId: string | null;
  discordUsername: string | null;
};

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : `Error desconocido: ${String(error)}`;
}

/**
 * La cuenta de Discord de una persona, o `null` si no se puede resolver.
 *
 * `discordUserId` manda; si no lo hay, se busca el `@usuario` en el roster cacheado.
 * Un fallo leyendo el roster sale como aviso y deja la cuenta en `null`: perder el
 * privado es preferible a tumbar la acción que lo pidió. `logPrefix` lo pone quien
 * llama, para que el aviso se pueda buscar por el módulo que lo sufrió.
 */
export async function resolveDiscordAccount(
  player: DiscordDmTarget,
  logPrefix: string,
): Promise<string | null> {
  if (player.discordUserId !== null) {
    return player.discordUserId;
  }

  if (player.discordUsername === null) {
    return null;
  }

  try {
    const cache = await readDiscordRosterCache();

    if (cache === null) {
      return null;
    }

    const encontrado = matchRosterUsername(player.discordUsername, cache.members);

    return typeof encontrado === "object" ? encontrado.id : null;
  } catch (error) {
    console.warn(
      `${logPrefix} No se ha podido resolver la cuenta de @${player.discordUsername}: ${toErrorMessage(error)}`,
    );

    return null;
  }
}

/** Abre el canal privado con una cuenta (`POST /users/@me/channels`) y devuelve su id. */
export async function openDmChannel(
  client: DiscordHttpClient,
  botToken: string,
  userId: string,
): Promise<string> {
  const payload = await client.request("POST", "/users/@me/channels", {
    authorization: `Bot ${botToken}`,
    json: { recipient_id: userId },
  });

  const id = isRecord(payload) ? payload["id"] : null;

  if (typeof id !== "string" || id === "") {
    throw new Error("Discord no ha devuelto el canal del mensaje privado.");
  }

  return id;
}

/** Publica en un canal concreto (el del privado, que no es el de avisos). */
export async function postToChannel(
  client: DiscordHttpClient,
  botToken: string,
  channelId: string,
  content: string,
): Promise<void> {
  await client.request("POST", `/channels/${channelId}/messages`, {
    authorization: `Bot ${botToken}`,
    json: { content },
  });
}

/**
 * Publica un mensaje **con cuerpo completo** en el canal privado de una cuenta.
 *
 * Es la variante de `postToChannel()` para los mensajes que no son solo texto: el
 * privado de verificación lleva botones y `allowed_mentions`, y pasarlos por aquí
 * evita que quien llama tenga que abrir el canal y componer la ruta a mano.
 *
 * Devuelve el id del mensaje publicado, que hoy nadie usa: se devuelve igualmente
 * porque es el único dato que Discord da de lo que se acaba de mandar y quien tenga
 * que investigar un privado que no llegó lo agradece.
 */
export async function postDirectMessage(
  client: DiscordHttpClient,
  botToken: string,
  userId: string,
  message: unknown,
): Promise<string | null> {
  const channelId = await openDmChannel(client, botToken, userId);

  const payload = await client.request("POST", `/channels/${channelId}/messages`, {
    authorization: `Bot ${botToken}`,
    json: message,
  });

  const id = isRecord(payload) ? payload["id"] : null;

  return typeof id === "string" ? id : null;
}
