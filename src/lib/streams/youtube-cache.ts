import "server-only";

import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { isRecord } from "@/lib/json";

/**
 * Caché de la resolución de un canal de YouTube (`handle -> channelId` y playlist de
 * subidas), en `Setting`.
 *
 * ## Por qué hay que cachearlo
 *
 * El resto de la comprobación trabaja con datos que **no vienen del handle**: la
 * playlist de subidas (`playlistItems.list`) y los detalles de emisión
 * (`videos.list`) necesitan el `channelId` y el id de esa playlist, y los dos salen
 * de `channels.list?forHandle=@…`. Nada de eso cambia con el tiempo —el canal de un
 * handle no se muda de `channelId`, y su playlist de subidas es la misma siempre—,
 * así que resolverlo en cada pasada sería preguntar **lo mismo** 288 veces al día.
 *
 * El coste de resolverlo no es solo la unidad de cuota: `channels.list` es el
 * endpoint con el límite **por minuto** más estricto de la API, y ese es el motivo
 * por el que esta caché no es un lujo sino parte del diseño (el límite por minuto sí
 * muerde con una pasada cada diez minutos).
 *
 * Por eso se resuelve una vez y se guarda aquí, con la fecha, para que el rastro
 * diga cuándo se resolvió y no solo que hay algo guardado.
 *
 * ## Por qué una clave por canal y no una tabla
 *
 * Porque es la misma forma que usa el resto de la memoria del worker
 * (`aoe4world.sync.player.<profileId>`, `streams.youtube.channel.<handle>`): un
 * documento pequeño por clave que se sobrescribe, leído y escrito por el módulo que
 * lo usa. Una tabla exigiría un `db push` con RLS y GRANTs, y esto es una caché que
 * se puede perder entera sin que pase nada (se vuelve a resolver).
 *
 * ## Un canal que no existe, y los documentos de la versión anterior
 *
 * Se guarda también el `null` (con su fecha), porque un handle mal escrito es lo más
 * probable y volver a preguntarlo en cada pasada sería la forma más rápida de
 * vaciar la cuota. Se reintenta pasado `CHANNEL_ID_TTL_DAYS`, porque un canal
 * puede aparecer después.
 *
 * Un documento con el `channelId` pero **sin** la playlist de subidas es de cuando
 * esta caché solo guardaba el `channelId`: se trata como no resuelto y se vuelve a
 * preguntar, que cuesta una unidad **una sola vez** por canal.
 */

/** Prefijo de las claves de `Setting` que guardan la resolución de un canal de YouTube. */
export const YOUTUBE_CHANNEL_KEY_PREFIX = "streams.youtube.channel.";

/**
 * Días que se guarda una resolución antes de volver a preguntar.
 *
 * No es caducidad del dato —el `channelId` no cambia— sino una red de seguridad
 * para los dos casos en los que sí puede pasar algo: que el handle se escribiera
 * mal la primera vez y el canal se creara después, o que la caché se hubiera
 * llenado de una resolución equivocada. Un mes es de sobra para un torneo.
 */
export const CHANNEL_ID_TTL_DAYS = 30;

export type YouTubeChannelIds = {
  /** `UC…` del canal, o `null` si YouTube no conoce ese handle. */
  channelId: string | null;
  /** `UU…` de su playlist de subidas, o `null` si la respuesta no la traía. */
  uploadsPlaylistId: string | null;
};

export type YouTubeChannelResolution = YouTubeChannelIds & {
  /** Cuándo se resolvió, en ISO-8601. */
  resolvedAt: string;
};

export function youtubeChannelKey(handle: string): string {
  return `${YOUTUBE_CHANNEL_KEY_PREFIX}${handle}`;
}

function readId(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function readResolution(value: unknown): YouTubeChannelResolution | null {
  if (!isRecord(value)) {
    return null;
  }

  const { channelId, uploadsPlaylistId, resolvedAt } = value;

  if (typeof resolvedAt !== "string" || Date.parse(resolvedAt) === Number.NaN) {
    return null;
  }

  const channel = readId(channelId);
  const uploads = readId(uploadsPlaylistId);

  // Un canal conocido **sin** playlist de subidas es un documento de la versión
  // anterior de esta caché (o una respuesta a la que le faltaba el campo): sin la
  // playlist no se puede comprobar nada, así que se trata como no resuelto y se
  // vuelve a preguntar. El `null` de `channelId` sí es una respuesta completa: no hay
  // canal, no hay playlist que buscar.
  if (channel !== null && uploads === null) {
    return null;
  }

  return { channelId: channel, uploadsPlaylistId: uploads, resolvedAt };
}

/**
 * Resolución guardada de un handle, o `null` si no hay, no se entiende, le falta la
 * playlist de subidas o ha caducado.
 *
 * Un documento que no se entiende se descarta entero, con el mismo criterio que
 * `readRuleset()` y `readAlertsRuleset()`: una caché mal escrita no puede dejar la
 * detección de YouTube sin hacer, se vuelve a resolver.
 */
export async function readYoutubeChannelResolution(
  handle: string,
  now: Date = new Date(),
): Promise<YouTubeChannelResolution | null> {
  const setting = await db.setting.findUnique({ where: { key: youtubeChannelKey(handle) } });
  const resolution = setting === null ? null : readResolution(setting.value);

  if (resolution === null) {
    return null;
  }

  const age = now.getTime() - Date.parse(resolution.resolvedAt);

  return age <= CHANNEL_ID_TTL_DAYS * 24 * 60 * 60_000 ? resolution : null;
}

/**
 * Guarda la resolución. Un `upsert` como el resto de las escrituras de `Setting`.
 *
 * `value` va como `InputJsonObject` y no como el tipo del dominio porque la columna
 * es `Json`: se construye con un viaje por `JSON` en vez de con un `as`, el mismo
 * criterio que `alerts/settings.ts`, para que un `undefined` que se colara se viera
 * al serializar en lugar de guardarse como `null` sin que nadie se entere.
 */
export async function writeYoutubeChannelResolution(
  handle: string,
  ids: YouTubeChannelIds,
  now: Date = new Date(),
): Promise<void> {
  const key = youtubeChannelKey(handle);
  const value = JSON.parse(
    JSON.stringify({
      channelId: ids.channelId,
      uploadsPlaylistId: ids.uploadsPlaylistId,
      resolvedAt: now.toISOString(),
    }),
  ) as Prisma.InputJsonObject;

  await db.setting.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  });
}