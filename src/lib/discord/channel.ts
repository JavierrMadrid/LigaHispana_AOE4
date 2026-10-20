import "server-only";

import type { DiscordConfig } from "./env";
import type { DiscordHttpClient } from "./http";

/**
 * El envío de un mensaje al canal de avisos, que es la única llamada a Discord de
 * todos los avisos del torneo.
 *
 * Vive aquí y no en `edition-announcements.ts` —de donde se sigue exportando, para no
 * romper a sus llamadores— porque ahora lo usan **dos** módulos de avisos: los hitos de
 * la edición y los recordatorios de los eventos puntuales
 * (`edition-event-announcements.ts`). Si la petición viviera en el primero, los dos
 * módulos se importarían en círculo; con ella aquí, cada uno importa la petición y
 * nadie importa al otro.
 *
 * El `content` va como JSON y nunca lleva el token: el cliente ya deja el token en la
 * cabecera y no lo escribe en ningún mensaje de error.
 */

/**
 * Con qué menciones sale un mensaje.
 *
 * `mentionRoleIds` no solo autoriza el ping: además pone `allowed_mentions` con
 * `parse: []`, porque sin eso Discord resuelve **cualquier** mención del texto, y un
 * mensaje de recordatorio no puede acabar pingueando a todo el servidor por una
 * arroba que se colara. El texto que menciona a un rol lo escribe quien llama
 * (`<@&id>`), aquí solo se autoriza cuál.
 *
 * `suppressMentions` es para los mensajes que **no** tienen que pingear a nadie pero
 * llevan texto que no escribe este código —el nombre de un evento, por ejemplo—: sin
 * él, un `@everyone` escrito en el panel pingearía al servidor entero. Pone el mismo
 * `allowed_mentions` con la lista de roles vacía.
 */
export type ChannelMessageOptions = {
  /** Roles que el mensaje puede mencionar. Vacío = ninguna mención especial. */
  mentionRoleIds?: readonly string[];
  /** Prohíbe toda mención en el texto, aunque el mensaje no mencione a ningún rol. */
  suppressMentions?: boolean;
};

/**
 * Manda un mensaje al canal de avisos.
 *
 * Es la única llamada de los avisos, y por eso no hay un cliente propio: reutiliza el
 * de `discord/http.ts`, que ya sabe de la base de la API, del `User-Agent` y del
 * timeout, y que **no reintenta** —una pasada del worker cada cinco minutos es un
 * reintento mucho mejor que tres seguidos dentro de la misma invocación—.
 */
export async function postChannelMessage(
  client: DiscordHttpClient,
  config: DiscordConfig & { botToken: string; announceChannelId: string },
  content: string,
  options: ChannelMessageOptions = {},
): Promise<void> {
  const json: Record<string, unknown> = { content };
  const roles = options.mentionRoleIds ?? [];

  if (options.suppressMentions === true || roles.length > 0) {
    json.allowed_mentions = { parse: [], roles: [...roles] };
  }

  await client.request("POST", `/channels/${config.announceChannelId}/messages`, {
    authorization: `Bot ${config.botToken}`,
    json,
  });
}
