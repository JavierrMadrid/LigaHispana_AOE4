import "server-only";

import { isRecord } from "@/lib/json";
import { getStreamsConfig, type StreamsConfig } from "./env";
import { StreamsError, type StreamsHttpClient, type StreamsRequestOptions } from "./http";
import { readYoutubeChannelResolution, writeYoutubeChannelResolution } from "./youtube-cache";

/**
 * Detección de directo en YouTube con la **Data API v3**.
 *
 * Solo hay dos endpoints en juego y están en el orden que impone el coste:
 *
 * 1. `channels.list?part=id&forHandle=@handle` → el `channelId`. Es la llamada
 *    cara: cuesta una unidad de cuota **y** tiene el límite más estricto de
 *    peticiones por minuto de la API. Se hace **una vez** por canal y se cachea en
 *    `Setting` (`youtube-cache.ts`), porque el `channelId` no cambia.
 * 2. `search.list?channelId=…&eventType=live&type=video&maxResults=1` → si hay
 *    algún resultado, hay un directo. Cuesta una unidad y no tiene el límite
 *    estricto.
 *
 * ## Por qué `search.list` y no `liveBroadcasts.list`
 *
 * `liveBroadcasts.list` exige `mine=true` y la credencial OAuth de **ese** canal: es
 * para quien administer el canal, no para un tercero que quiere saber si alguien
 * emite. Para eso está `search.list` con `eventType=live`, que es la única vía
 * pública por handle.
 *
 * ## Sin `YOUTUBE_API_KEY` no se hace nada
 *
 * `isYoutubeConfigured()` es lo que decide, y el llamante no llega hasta aquí sin
 * comprobarlo: una petición sin clave saldría con un `403` en cada pasada y llenaría
 * el log de errores de algo que es esperable (ver el docblock de `env.ts`).
 */

/** Cuántos directos se piden. Con 1 basta: la pregunta es "¿hay alguno?", no cuál. */
const LIVE_SEARCH_MAX_RESULTS = 1;

/**
 * `channelId` de un handle, desde la caché cuando se puede.
 *
 * Devuelve `null` **con dos significado distintos** que el llamante no tiene que
 * distinguir porque los dos degradan igual: o YouTube no conoce el handle (y se
 * guarda el `null` para no volver a preguntar cada pasada), o la resolución vino mal
 * y se reintenta la próxima vez.
 */
async function resolveChannelId(
  handle: string,
  http: StreamsHttpClient,
  config: StreamsConfig,
  options: StreamsRequestOptions | undefined,
  now: Date,
): Promise<string | null> {
  const cached = await readYoutubeChannelResolution(handle, now);

  if (cached !== null) {
    return cached.channelId;
  }

  const url = new URL(`${config.youtubeApiBase}/channels`);

  url.searchParams.set("part", "id");
  url.searchParams.set("forHandle", `@${handle}`);
  url.searchParams.set("key", config.youtubeApiKey ?? "");

  const payload = await http.fetchJson(url, options);
  const channelId = readChannelId(payload);

  // Se guarda **también** el `null`: un handle mal escrito es lo más probable y
  // repetir la pregunta cada pasada sería la forma más rápida de vaciar la cuota.
  await writeYoutubeChannelResolution(handle, channelId, now);

  return channelId;
}

/**
 * `items[0].id` de `channels.list`, o `null`.
 *
 * Una respuesta vacía significa "no hay ningún canal con ese handle": la API lo
 * responde con `200` y `items: []`, no con un 404, así que es un caso normal y no un
 * error.
 */
function readChannelId(payload: unknown): string | null {
  if (!isRecord(payload) || !Array.isArray(payload.items)) {
    throw new StreamsError(
      "YouTube no devolvió la forma esperada en channels.list (falta `items`).",
      { retryable: true },
    );
  }

  const first = payload.items[0];

  if (!isRecord(first)) {
    return null;
  }

  return typeof first.id === "string" && first.id !== "" ? first.id : null;
}

/**
 * ¿Está **este canal** (`channelId` ya resuelto) emitiendo?
 *
 * Va separada de `isYoutubeChannelLive()` por un motivo concreto: resolver el handle
 * necesita la caché de `Setting`, así que la parte que decide si hay directo —que
 * es la que interpreta el payload— quedaría imposible de comprobar sin base de
 * datos. Con el `channelId` como parámetro, esa parte es una función que se puede
 * verificar entera contra un cliente HTTP falso, sin red y sin base.
 *
 * `liveBroadcastContent` del `snippet` es lo que distingue "está emitiendo" de
 * "emitió hace un rato": `eventType=live` devuelve también las emisiones ya
 * terminadas, que sin ese campo se pintarían como un directo que no existe. Cuando
 * el campo no está o no se entiende (un `snippet` que no trae el campo, una versión
 * de la API anterior a que existiera) se cae al criterio de la llamada —que hay
 * resultado, luego hay directo—, que es el que era antes de que el campo existiera.
 */
export async function isYoutubeStreamLive(
  channelId: string,
  http: StreamsHttpClient,
  config: StreamsConfig = getStreamsConfig(),
  options: StreamsRequestOptions = {},
): Promise<boolean> {
  const url = new URL(`${config.youtubeApiBase}/search`);

  url.searchParams.set("channelId", channelId);
  url.searchParams.set("eventType", "live");
  url.searchParams.set("type", "video");
  url.searchParams.set("part", "snippet");
  url.searchParams.set("maxResults", String(LIVE_SEARCH_MAX_RESULTS));
  url.searchParams.set("key", config.youtubeApiKey ?? "");

  const payload = await http.fetchJson(url, options);

  if (!isRecord(payload) || !Array.isArray(payload.items)) {
    throw new StreamsError(
      "YouTube no devolvió la forma esperada en search.list (falta `items`).",
      { retryable: true },
    );
  }

  if (payload.items.length === 0) {
    return false;
  }

  const first = payload.items[0];

  if (!isRecord(first) || !isRecord(first.snippet)) {
    return true;
  }

  const state = first.snippet.liveBroadcastContent;

  return typeof state === "string" ? state === "live" : true;
}

/**
 * ¿Está este canal de YouTube (`@handle`) emitiendo ahora mismo?
 *
 * `null` cuando no se ha podido saber, y el llamante **no** escribe nada en ese
 * caso: un `false` escrito por un fallo publicaría "no está en directo" cuando lo
 * cierto es "no lo sabemos", que es la afirmación que este módulo no puede hacer.
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

  const channelId = await resolveChannelId(handle, http, config, options, now);

  if (channelId === null) {
    // No es un fallo: YouTube conoce la API y ha dicho que ese handle no existe. Es
    // un `false` legítimo, y además la resolución ya quedó cacheada para no repetir
    // la pregunta cada cinco minutos.
    return false;
  }

  return isYoutubeStreamLive(channelId, http, config, options);
}