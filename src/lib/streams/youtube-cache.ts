import "server-only";

import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { isRecord } from "@/lib/json";

/**
 * Caché de `handle -> channelId` de YouTube, en `Setting`.
 *
 * ## Por qué hay que cachearlo
 *
 * `search.list` es el endpoint barato (1 unidad de cuota) pero **exige un
 * `channelId`**, no un handle; el `channelId` sale de `channels.list?forHandle=@…`,
 * que cuesta 1 unidad y además tiene un límite mucho más estricto de llamadas por
 * minuto. Si se resolviera el handle en cada pasada, con 288 pasadas al día y N
 * participantes se gastarían dos unidades por participante y por pasada para
 * aprender **lo mismo** todas las veces: el `channelId` de un canal **no cambia**.
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
 * ## Un canal que no existe
 *
 * Se guarda también el `null` (con su fecha), porque un handle mal escrito es lo más
 * probable y volver a preguntarlo en cada pasada sería la forma más rápida de
 * vaciar la cuota. Se reintenta pasado `CHANNEL_ID_TTL_DAYS`, porque un canal
 * puede aparecer después.
 */

/** Prefijo de las claves de `Setting` que guardan un `channelId` de YouTube. */
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

export type YouTubeChannelResolution = {
  /** `UC…` del canal, o `null` si YouTube no conoce ese handle. */
  channelId: string | null;
  /** Cuándo se resolvió, en ISO-8601. */
  resolvedAt: string;
};

export function youtubeChannelKey(handle: string): string {
  return `${YOUTUBE_CHANNEL_KEY_PREFIX}${handle}`;
}

function readResolution(value: unknown): YouTubeChannelResolution | null {
  if (!isRecord(value)) {
    return null;
  }

  const { channelId, resolvedAt } = value;

  if (typeof resolvedAt !== "string" || Date.parse(resolvedAt) === Number.NaN) {
    return null;
  }

  return {
    channelId: typeof channelId === "string" && channelId !== "" ? channelId : null,
    resolvedAt,
  };
}

/**
 * Resolución guardada de un handle, o `null` si no hay, no se entiende o ha
 * caducado.
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
  channelId: string | null,
  now: Date = new Date(),
): Promise<void> {
  const key = youtubeChannelKey(handle);
  const value = JSON.parse(
    JSON.stringify({ channelId, resolvedAt: now.toISOString() }),
  ) as Prisma.InputJsonObject;

  await db.setting.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  });
}