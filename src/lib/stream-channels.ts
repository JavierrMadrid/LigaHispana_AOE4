/**
 * Normalización de los canales de directo, para **leerlos de la base de datos**.
 *
 * Es la pieza que usa el DAL (`src/lib/public.ts`, `src/lib/admin.ts`) y los
 * scripts que dan de alta jugadores a partir de lo que publica AoE4World, donde
 * un canal llega como URL y hay que recortarlo a su forma canónica. Antes de
 * este módulo cada consumidor llevaba su copia —`src/lib/twitch.ts` y otra dentro
 * de `public.ts`, que ya se habían desincronizado en el detalle de si aceptaban
 * `null`—, y con tres plataformas eso ya no se sostiene: un mismo canal puede
 * salir como `null` en la clasificación y como enlace en el panel según qué copia
 * se ejecutara. Aquí hay **una** por plataforma y ninguna más.
 *
 * ## Por qué no es el mismo módulo que `player-input.ts`
 *
 * Porque hacen cosas distintas. Los parsers de `player-input.ts` validan **lo que
 * alguien escribe en un formulario**: reciben `FormDataEntryValue | null`,
 * distinguen "vacío" de "inválido" para que el formulario diga el motivo, y
 * rechazan las URL `/c/…` y `/user/…` de YouTube con un motivo explícito. Estas
 * funciones son la red de seguridad de lo que **ya está guardado**: aceptan tanto
 * el nombre suelto como la URL completa, porque un humano teclea cualquiera de las
 * dos en el panel, y devuelven `null` —"no hay canal"— sin decir por qué, porque
 * aquí no hay un formulario al que explicarle nada.
 *
 * ## Por qué no importa nada
 *
 * Porque el criterio de canal tiene que ser el mismo en el servidor, en el panel
 * y en cualquier comprobación, y un módulo que arrastra la base de datos o el
 * entorno no se puede usar desde todas partes. No hay aquí nada que leer de
 * `Setting` ni ninguna credencial: solo patrones.
 *
 * ## Formas canónicas
 *
 * | Plataforma | Se guarda | Enlace |
 * |---|---|---|
 * | Twitch | nombre en minúsculas, sin arroba | `twitch.tv/<canal>` |
 * | YouTube | handle en minúsculas, **sin arroba** | `youtube.com/@<handle>` |
 * | Kick | slug en minúsculas | `kick.com/<slug>` |
 *
 * El handle de YouTube va sin arroba porque es la forma que consume `forHandle` de
 * la API de YouTube y la que se compone en la URL: la arroba solo aparece al
 * escribirla.
 */

const TWITCH_CHANNEL_PATTERN = /^[a-z0-9_]{3,25}$/;
const YOUTUBE_HANDLE_PATTERN = /^[a-z0-9._-]{3,30}$/;
const KICK_SLUG_PATTERN = /^[a-z0-9._-]{3,25}$/;

/** Formas que no llevan el handle dentro, de las que no se puede derivar. */
const YOUTUBE_LEGACY_URL = /^(?:https?:\/\/)?(?:[\w-]+\.)*youtube\.com\/(?:c|user)\//i;

/** Dominio de Twitch dentro de una URL, con `www.` opcional y esquema opcional. */
const TWITCH_URL = /^(?:https?:\/\/)?(?:www\.)?twitch\.tv\/([^/?#]+)/;

/**
 * Dominio de YouTube dentro de una URL.
 *
 * Sin anclar porque aparecen subdominios (`m.youtube.com`) y porque lo que
 * importa es el handle que va detrás de la barra, no el dominio entero.
 */
const YOUTUBE_URL = /youtube\.com\/@([a-z0-9._-]{3,30})/i;

/** Mismo criterio para Kick: el slug es lo que va detrás de `kick.com/`. */
const KICK_URL = /kick\.com\/([a-z0-9._-]{3,25})/i;

function trimmed(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * `null` cuando no hay nada que normalizar, y también cuando lo que hay no es un
 * canal. Quien tenga un respaldo (por ejemplo el `twitchUrl` de la ladder) debe
 * usarlo antes de rendirse: son dos intentos distintos, no dos formas de decir
 * "no hay canal".
 */
function canonical(value: string | null | undefined, pattern: RegExp): string | null {
  const candidate = trimmed(value).toLowerCase();

  return pattern.test(candidate) ? candidate : null;
}

/**
 * Nombre del canal de Twitch en minúsculas, o `null` si lo que se le pasa no es un
 * canal válido.
 *
 * Acepta a propósito las dos formas: el nombre suelto y la URL completa
 * (`twitch.tv/canal`, con `www.`, sin esquema o con parámetros añadidos), porque
 * un humano teclea cualquiera de las dos en el panel de admin.
 */
export function normalizeTwitchChannel(value: string | null | undefined): string | null {
  const candidate = trimmed(value).toLowerCase();

  if (TWITCH_CHANNEL_PATTERN.test(candidate)) {
    return candidate;
  }

  const fromUrl = candidate.match(TWITCH_URL);

  if (fromUrl === null) {
    return null;
  }

  const channel = fromUrl[1].replace(/^@/, "");

  return TWITCH_CHANNEL_PATTERN.test(channel) ? channel : null;
}

/**
 * Handle del canal de YouTube en minúsculas y **sin arroba**, o `null`.
 *
 * Las URL `/c/…` y `/user/…` devuelven `null` siempre: el identificador del canal
 * es un `UC…` del que el handle no se puede derivar sin preguntar a la API, y
 * devolver el trozo de URL produciría un canal que no existe. Es el mismo motivo
 * por el que `parseYoutubeChannel()` las rechaza al escribir, y está escrito en
 * los dos sitios porque son dos capas distintas con la misma regla.
 */
export function normalizeYoutubeChannel(value: string | null | undefined): string | null {
  const candidate = trimmed(value);

  if (candidate === "") {
    return null;
  }

  if (YOUTUBE_LEGACY_URL.test(candidate)) {
    return null;
  }

  const fromUrl = candidate.match(YOUTUBE_URL);

  return canonical(fromUrl === null ? candidate.replace(/^@/, "") : fromUrl[1], YOUTUBE_HANDLE_PATTERN);
}

/**
 * Slug del canal de Kick en minúsculas, o `null`.
 *
 * No tiene el caso especial de YouTube: Kick no tuvo nombres de canal antes del
 * slug, así que una URL que no sea `kick.com/<algo>` no es un canal.
 */
export function normalizeKickChannel(value: string | null | undefined): string | null {
  const candidate = trimmed(value);

  if (candidate === "") {
    return null;
  }

  const fromUrl = candidate.match(KICK_URL);

  return canonical(fromUrl === null ? candidate : fromUrl[1], KICK_SLUG_PATTERN);
}