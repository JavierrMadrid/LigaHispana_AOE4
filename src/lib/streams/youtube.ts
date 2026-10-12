import "server-only";

import { isRecord } from "@/lib/json";
import { getStreamsConfig, type StreamsConfig } from "./env";
import { StreamsError, type StreamsHttpClient, type StreamsRequestOptions } from "./http";
import {
  readYoutubeChannelResolution,
  writeYoutubeChannelResolution,
  type YouTubeChannelIds,
} from "./youtube-cache";

/**
 * Detección de directo en YouTube con la **Data API v3**.
 *
 * ## Por qué no se usa `search.list`, que es lo que parece obvio
 *
 * `search.list?eventType=live` es la vía pública natural, pero **no sale del fondo
 * de 10 000 unidades al día** del resto de la API: tiene su **propia cuota de 100
 * llamadas al día** (documentación de Google, "Determine quota cost"). El worker
 * corre cada diez minutos, así que con dos canales con canal hace ~288 búsquedas al
 * día: la cuota se agotaba **todos los días**, y desde ese momento hasta la
 * medianoche del Pacífico cada comprobación fallaba con un `429` de "Search Queries
 * per day". Ese tramo de horas sin poder mirar dejaba el estado **congelado**: un
 * `true` escrito por la tarde se quedaba encendido hasta el día siguiente, y un
 * directo que empezaba dentro del hueco no se encendía nunca.
 *
 * ## Los tres endpoints que sí salen del fondo común
 *
 * Están en el orden que impone el coste, y los tres suman tres unidades en el peor
 * caso (con la resolución ya cacheada, dos):
 *
 * 1. `channels.list?part=contentDetails&forHandle=@handle` → el `channelId` **y**
 *    `items[0].contentDetails.relatedPlaylists.uploads`, el id de la playlist de
 *    subidas. Es la llamada con el límite por minuto más estricto, así que se hace
 *    **una vez** por canal y se guarda en `Setting` (`youtube-cache.ts`): ni el
 *    `channelId` ni la playlist de un canal cambian.
 * 2. `playlistItems.list?part=contentDetails&playlistId=<uploads>&maxResults=5` → los
 *    ids de las últimas subidas. 1 unidad. Un directo **en curso sí está** en la
 *    playlist de subidas, pero no siempre el primero —una subida corta publicada
 *    mientras se emite puede colocarse delante—, y por eso se piden cinco.
 * 3. `videos.list?part=snippet,liveStreamingDetails&id=<ids separados por comas>` → **1 unidad
 *    para todos los ids**, porque este endpoint cobra por llamada y no por id. En directo =
 *    el `snippet` dice `live` y no hay `actualEndTime` (ver `videoIsLive()`).
 *
 * ## Por qué no `liveBroadcasts.list`
 *
 * Exige `mine=true` y la credencial OAuth de **ese** canal: es para quien administra
 * el canal, no para un tercero que quiere saber si alguien emite.
 *
 * ## Sin `YOUTUBE_API_KEY` no se hace nada
 *
 * `isYoutubeConfigured()` es lo que decide, y el llamante no llega hasta aquí sin
 * comprobarlo: una petición sin clave saldría con un `403` en cada pasada y llenaría
 * el log de errores de algo que es esperable (ver el docblock de `env.ts`).
 */

/** Cuántas subidas se miran. Cinco porque el directo no siempre es la primera. */
const UPLOAD_PLAYLIST_MAX_RESULTS = 5;

/**
 * `channels.list` → `{ channelId, uploadsPlaylistId }`.
 *
 * Una respuesta con `items` vacío significa "no hay ningún canal con ese handle": la
 * API lo responde con `200` y `items: []`, no con un `404`, así que es un caso normal
 * y no un error. Un canal sin `contentDetails.relatedPlaylists.uploads` deja la
 * playlist en `null`: existe, pero sin ella no se puede comprobar nada.
 */
export function readChannelIds(payload: unknown): YouTubeChannelIds {
  if (!isRecord(payload) || !Array.isArray(payload.items)) {
    throw new StreamsError(
      "YouTube no devolvió la forma esperada en channels.list (falta `items`).",
      { retryable: true },
    );
  }

  const first = payload.items[0];

  if (!isRecord(first)) {
    return { channelId: null, uploadsPlaylistId: null };
  }

  return {
    channelId: readId(first.id),
    uploadsPlaylistId: readUploadsPlaylistId(first),
  };
}

/**
 * `playlistItems.list` → los ids de las subidas, en el orden en que llegan.
 *
 * Un item sin `contentDetails.videoId` se salta en vez de invalidar la respuesta: lo
 * que importa es la lista de ids, y un item que no se entiende no puede convertir en
 * un fallo una respuesta que sí traía los otros.
 */
export function readUploadedVideoIds(payload: unknown): string[] {
  if (!isRecord(payload) || !Array.isArray(payload.items)) {
    throw new StreamsError(
      "YouTube no devolvió la forma esperada en playlistItems.list (falta `items`).",
      { retryable: true },
    );
  }

  const ids: string[] = [];

  for (const item of payload.items) {
    if (!isRecord(item) || !isRecord(item.contentDetails)) {
      continue;
    }

    const id = readId(item.contentDetails.videoId);

    if (id !== null) {
      ids.push(id);
    }
  }

  return ids;
}

/**
 * ¿Hay algún directo entre los items de `videos.list`?
 *
 * El criterio vive en `videoIsLive()`: el `snippet` diciendo `live` **y** sin
 * `actualEndTime`. Un payload sin `items` no se lee como "no hay directo": es un
 * fallo, porque no se puede distinguir "no hay vídeos" de "esto no es la respuesta
 * que esperaba".
 */
export function anyVideoIsLive(payload: unknown): boolean {
  if (!isRecord(payload) || !Array.isArray(payload.items)) {
    throw new StreamsError(
      "YouTube no devolvió la forma esperada en videos.list (falta `items`).",
      { retryable: true },
    );
  }

  return payload.items.some((item) => videoIsLive(item));
}

function readId(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function readUploadsPlaylistId(channel: Record<string, unknown>): string | null {
  const contentDetails = channel.contentDetails;

  if (!isRecord(contentDetails)) {
    return null;
  }

  const relatedPlaylists = contentDetails.relatedPlaylists;

  if (!isRecord(relatedPlaylists)) {
    return null;
  }

  return readId(relatedPlaylists.uploads);
}

/**
 * ¿Está este vídeo emitiéndose ahora mismo?
 *
 * Hacen falta **dos** condiciones, y cada una cubre lo que la otra deja pasar:
 *
 * - `snippet.liveBroadcastContent` es lo que distingue "está emitiendo" (`live`) de
 *   "emitió hace un rato" (`none`, que es lo que pasa al terminar) y de "va a emitir"
 *   (`upcoming`). Mirar solo los tiempos no basta: el canal `juanmolina7` del torneo
 *   tiene una emisión de 2016 con `actualStartTime` **sin** `actualEndTime` que sigue
 *   marcada como `upcoming`, y con los tiempos se leería como un directo eterno.
 * - La **ausencia** de `actualEndTime` es lo que distingue un directo en curso de uno
 *   que acaba de terminar: durante unos minutos después del final el `snippet` puede
 *   seguir diciendo `live`, y sin esta condición el icono se quedaría encendido un
 *   rato de más, que es justo el síntoma que este módulo existe para no dar.
 *
 * Una subida normal no trae `liveStreamingDetails`: no es un directo. Y sin el campo
 * del `snippet` (una versión de la API anterior a que existiera) el criterio son los
 * tiempos —empezó y no ha terminado—, que es lo mejor que se puede afirmar con lo que
 * hay; se prefiere eso a devolver un "no está" que no se sabe.
 */
function videoIsLive(item: unknown): boolean {
  if (!isRecord(item) || !isRecord(item.liveStreamingDetails)) {
    return false;
  }

  const { actualStartTime, actualEndTime } = item.liveStreamingDetails;

  if (typeof actualEndTime === "string" && actualEndTime !== "") {
    return false;
  }

  const snippet = item.snippet;
  const state = isRecord(snippet) ? snippet.liveBroadcastContent : undefined;

  if (typeof state === "string") {
    return state === "live";
  }

  return typeof actualStartTime === "string" && actualStartTime !== "";
}

/**
 * `channelId` y playlist de subidas de un handle, desde la caché cuando se puede.
 *
 * Devuelve `null` **con un solo significado**: YouTube conoce la API y ha dicho que
 * ese handle no existe. Es un caso que se cachea (el `null` también) para no repetir
 * la pregunta cada pasada. Un canal que existe pero llega sin playlist de subidas
 * sale como `{ channelId, uploadsPlaylistId: null }`, y quien llama decide qué hacer
 * con él.
 */
async function resolveChannel(
  handle: string,
  http: StreamsHttpClient,
  config: StreamsConfig,
  options: StreamsRequestOptions | undefined,
  now: Date,
): Promise<YouTubeChannelIds | null> {
  const cached = await readYoutubeChannelResolution(handle, now);

  if (cached !== null) {
    return { channelId: cached.channelId, uploadsPlaylistId: cached.uploadsPlaylistId };
  }

  const url = new URL(`${config.youtubeApiBase}/channels`);

  // `contentDetails` y no `id`: la playlist de subidas viaja ahí, y pedir las dos
  // cosas en una llamada cuesta lo mismo que pedir solo el `channelId`.
  url.searchParams.set("part", "contentDetails");
  url.searchParams.set("forHandle", `@${handle}`);
  url.searchParams.set("key", config.youtubeApiKey ?? "");

  const payload = await http.fetchJson(url, options);
  const ids = readChannelIds(payload);

  // Se guarda **también** el `null`: un handle mal escrito es lo más probable y
  // repetir la pregunta cada pasada sería la forma más rápida de gastar cuota.
  await writeYoutubeChannelResolution(handle, ids, now);

  return ids;
}

/**
 * ¿Está **este canal** (con su playlist de subidas ya resuelta) emitiendo?
 *
 * Va separada de `isYoutubeChannelLive()` por un motivo concreto: resolver el handle
 * necesita la caché de `Setting`, así que la parte que decide si hay directo —que es
 * la que sale a la red y la que interpreta lo que vuelve— quedaría imposible de
 * comprobar sin base de datos. Con la playlist como parámetro, esa parte se puede
 * verificar contra un cliente HTTP falso, sin red y sin base.
 *
 * Sin ninguna subida devuelve `false` **sin preguntar por los detalles**: no hay
 * vídeo que pueda estar emitiéndose, y eso lo ha dicho la API, no un fallo.
 */
export async function isYoutubeStreamLive(
  uploadsPlaylistId: string,
  http: StreamsHttpClient,
  config: StreamsConfig = getStreamsConfig(),
  options: StreamsRequestOptions = {},
): Promise<boolean> {
  const uploadsUrl = new URL(`${config.youtubeApiBase}/playlistItems`);

  uploadsUrl.searchParams.set("part", "contentDetails");
  uploadsUrl.searchParams.set("playlistId", uploadsPlaylistId);
  uploadsUrl.searchParams.set("maxResults", String(UPLOAD_PLAYLIST_MAX_RESULTS));
  uploadsUrl.searchParams.set("key", config.youtubeApiKey ?? "");

  const ids = readUploadedVideoIds(await http.fetchJson(uploadsUrl, options));

  if (ids.length === 0) {
    return false;
  }

  const videosUrl = new URL(`${config.youtubeApiBase}/videos`);

  // `snippet` no se puede saltar: su `liveBroadcastContent` es la mitad del criterio
  // de "está emitiendo" (ver `videoIsLive()`), y cuesta lo mismo que pedir solo los
  // detalles, porque `videos.list` cobra por llamada y no por campo.
  videosUrl.searchParams.set("part", "snippet,liveStreamingDetails");
  // Los ids van en **una** llamada y separados por comas: `videos.list` cobra una
  // unidad por llamada, no por id.
  videosUrl.searchParams.set("id", ids.join(","));
  videosUrl.searchParams.set("key", config.youtubeApiKey ?? "");

  return anyVideoIsLive(await http.fetchJson(videosUrl, options));
}

/**
 * ¿Está este canal de YouTube (`@handle`) emitiendo ahora mismo?
 *
 * `null` cuando no se ha podido saber, y el llamante **no** escribe nada en ese
 * caso: un `false` escrito por un fallo publicaría "no está en directo" cuando lo
 * cierto es "no lo sabemos", que es la afirmación que este módulo no puede hacer.
 *
 * Hay dos `null` distintos, y los dos caen del lado de "no escribir": entender la
 * respuesta del canal (una forma rara en `channels.list`) y no tener con qué
 * comprobar (un canal cuya playlist de subidas no ha llegado).
 *
 * Sin `YOUTUBE_API_KEY` devuelve `null` sin salir a la red, que es la degradación
 * documentada en `env.ts`: la detección de YouTube está apagada.
 */
export async function isYoutubeChannelLive(
  handle: string,
  http: StreamsHttpClient,
  config: StreamsConfig = getStreamsConfig(),
  options: StreamsRequestOptions = {},
  now: Date = new Date(),
): Promise<boolean | null> {
  if (config.youtubeApiKey === null) {
    return null;
  }

  const channel = await resolveChannel(handle, http, config, options, now);

  if (channel === null) {
    // No es un fallo: YouTube conoce la API y ha dicho que ese handle no existe. Es
    // un `false` legítimo, y además la resolución ya quedó cacheada para no repetir
    // la pregunta cada cinco minutos.
    return false;
  }

  if (channel.uploadsPlaylistId === null) {
    // El canal existe pero sin playlist de subidas no hay nada que preguntar. No se
    // escribe nada y la caché lo vuelve a resolver en la próxima pasada.
    return null;
  }

  return isYoutubeStreamLive(channel.uploadsPlaylistId, http, config, options);
}
