import "server-only";

import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { isRecord } from "@/lib/json";
import type { DiscordRosterMember } from "./membership";

/**
 * Caché del roster del servidor de Discord, en `Setting["discord.roster"]`.
 *
 * Es un módulo aparte del que sale a la red (`roster.ts`) por el mismo motivo que en
 * los directos: uno habla con la API y el otro con la base de datos, y mezclarlos
 * obligaría a `roster.ts` a importar `db` para algo que no es suyo.
 *
 * ## Por qué hay que cachearlo
 *
 * La lista de miembros es **el** dato que hace que la comprobación de pertenencia
 * deje de ser una petición por jugador, y a cambio es la única lectura de esta fase
 * que no se puede pedir "solo para un jugador": es de todo el servidor. Sin caché, el
 * worker la pediría cada cinco minutos (`ceil(miembros / 1000)` peticiones cada vez)
 * para aprender lo mismo: quién entra y sale de un servidor de torneo tarda días.
 *
 * ## Por qué una clave de `Setting` y no una tabla
 *
 * Porque es la misma forma que usa el resto de la memoria del worker
 * (`aoe4world.sync.player.<profileId>`, `streams.youtube.channel.<handle>`): un
 * documento pequeño que se sobrescribe, leído y escrito por quien lo usa. Una tabla
 * exigiría un `db push` con RLS y GRANTs para una caché que se puede perder entera
 * sin que pase nada —se vuelve a leer.
 *
 * ## Lo que se guarda
 *
 * ```json
 * { "fetchedAt": "2026-10-06T12:00:00.000Z", "members": [{ "id": "…", "username": "…" }] }
 * ```
 *
 * El `username` es el **nombre global tal y como lo devuelve Discord**, sin
 * normalizar: es la API la que manda en el roster, y el guardado se normaliza en su
 * propio sitio (el callback del OAuth, con `canonicalDiscordUsername()`). Quien
 * compara usa `matchRosterUsername()`, que pone los dos lados en minúsculas.
 *
 * ## Una caché que no se entiende se descarta **entera**
 *
 * Un documento con una entrada inválida devuelve `null`, y una lista vacía también.
 * No es prudencia de forma: si de una lista a la que le falta una entrada se
 * concluyese que un jugador no está en el servidor, la caché estaría afirmando algo
 * falso, y doce horas de ese "algo falso" son doce horas de alertas. Perder la caché
 * solo cuesta una lectura más.
 */

export const DISCORD_ROSTER_KEY = "discord.roster";

export type DiscordRosterCache = {
  /** Instante de la lectura, en ISO-8601 UTC. Es el plazo de la caché. */
  fetchedAt: string;
  /** Miembros tal y como salieron de la API. */
  members: DiscordRosterMember[];
};

/**
 * El documento guardado, si se entiende entero.
 *
 * Valida **todos** los miembros antes de devolver nada, y por eso devuelve `null` en
 * cuanto uno falla: ver el docblock del módulo. La fecha se exige parseable porque es
 * lo que decide si toca refrescar, y una fecha ilegible haría que se refrescara
 * siempre (o que se creyera al día un roster que no lo está).
 */
function readRosterCache(value: unknown): DiscordRosterCache | null {
  if (!isRecord(value)) {
    return null;
  }

  const { fetchedAt, members } = value;

  if (typeof fetchedAt !== "string" || Date.parse(fetchedAt) === Number.NaN) {
    return null;
  }

  if (!Array.isArray(members) || members.length === 0) {
    return null;
  }

  const leidos: DiscordRosterMember[] = [];

  for (const miembro of members) {
    if (!isRecord(miembro)) {
      return null;
    }

    const id = miembro["id"];
    const username = miembro["username"];

    if (typeof id !== "string" || id === "" || typeof username !== "string" || username === "") {
      return null;
    }

    leidos.push({ id, username });
  }

  return { fetchedAt, members: leidos };
}

/** El roster guardado, o `null` si no hay, no se entiende o está vacío. */
export async function readDiscordRosterCache(): Promise<DiscordRosterCache | null> {
  const setting = await db.setting.findUnique({ where: { key: DISCORD_ROSTER_KEY } });

  return setting === null ? null : readRosterCache(setting.value);
}

/**
 * Guarda el roster recién leído, con la hora de la lectura.
 *
 * `value` va como `InputJsonObject` y no como el tipo del dominio porque la columna
 * es `Json`: se construye con un viaje por `JSON` en vez de con un `as`, el mismo
 * criterio que `youtube-cache.ts`, para que un `undefined` que se colara se viera al
 * serializar en lugar de guardarse como `null` sin que nadie se entere.
 *
 * **Solo se guarda una lista que se ha podido leer entera.** Un `unknown` de
 * `fetchGuildRoster()` no llega aquí: guardar "no hay nadie" fijaría esa afirmación
 * doce horas.
 */
export async function writeDiscordRosterCache(
  members: DiscordRosterMember[],
  now: Date = new Date(),
): Promise<void> {
  const value = JSON.parse(
    JSON.stringify({ fetchedAt: now.toISOString(), members }),
  ) as Prisma.InputJsonObject;

  await db.setting.upsert({
    where: { key: DISCORD_ROSTER_KEY },
    create: { key: DISCORD_ROSTER_KEY, value },
    update: { value },
  });
}
