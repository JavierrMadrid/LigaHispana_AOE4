/**
 * Normalización del canal de Twitch.
 *
 * Vive aquí y no en `public.ts` porque lo necesitan dos capas: la que lee la
 * clasificación (que hoy tiene su propia copia) y los scripts que dan de alta un
 * jugador a partir de lo que publica AoE4World, donde el canal llega como URL
 * (`twitch_url`) y hay que recortarlo a nombre de canal.
 *
 * Acepta a propósito las dos formas: el nombre suelto y la URL completa, porque
 * un humano teclea cualquiera de las dos en el panel de admin.
 */

const TWITCH_CHANNEL_PATTERN = /^[a-z0-9_]{3,25}$/;

/**
 * Nombre de canal en minúsculas, o `null` si lo que se le pasa no es un canal
 * válido. `null` significa "no hay canal", no "el canal es este": quien tenga
 * un respaldo (por ejemplo el `twitchUrl` de la ladder) debe usarlo antes de
 * rendirse.
 */
export function normalizeTwitchChannel(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const trimmed = value.trim().toLowerCase();

  if (TWITCH_CHANNEL_PATTERN.test(trimmed)) {
    return trimmed;
  }

  const fromUrl = trimmed.match(/^(?:https?:\/\/)?(?:www\.)?twitch\.tv\/([^/?#]+)/);

  if (fromUrl === null) {
    return null;
  }

  const channel = fromUrl[1].replace(/^@/, "");

  return TWITCH_CHANNEL_PATTERN.test(channel) ? channel : null;
}
