import "server-only";

import { Prisma } from "@/generated/prisma/client";
import { PlayerStatus } from "@/generated/prisma/enums";
import { db } from "@/lib/db";
import {
  getDiscordConfig,
  isDiscordRoleConfigured,
  type DiscordConfig,
} from "./env";
import { createDiscordHttpClient, DiscordError, type DiscordHttpClient } from "./http";
import { matchRosterUsername } from "./membership";
import {
  PARTICIPANT_ROLE_KEY,
  parseParticipantRoleMemory,
  planParticipantRoleSync,
  type ParticipantRoleMemory,
  type ParticipantRoleSyncResult,
} from "./participant-role";
import { readDiscordRosterCache } from "./roster-cache";

/**
 * El rol de participante del torneo en Discord, una vez por pasada del worker (issue
 * 56, fase 1).
 *
 * ## Qué hace
 *
 * Pone el rol configurado (`DISCORD_PARTICIPANT_ROLE_ID`) a los participantes
 * **aprobados** con cuenta de Discord resoluble, y se lo quita a quien haya dejado de
 * estar aprobado (rechazado o eliminado). La **fuente de verdad de quiénes son** es
 * `Player.status`; el rol no sustituye a nada, acompaña. `participant-role.ts` decide
 * qué toca hacer —es puro y se prueba sin base de datos— y aquí se ejecuta.
 *
 * ## La resolución de cuentas es la misma que la de la comprobación de pertenencia
 *
 * Un aprobado puede tener la cuenta por `discordUserId` (lo que firma el OAuth) o solo
 * por `@usuario` (el alta de admin). Para el segundo se busca en la **lista de miembros
 * del servidor** (`discord.roster`, cacheada), que es el único sitio donde ese
 * `@usuario` se puede convertir en un id con el que hablarle a Discord. Es la misma
 * resolución que hace `checkDiscordMembership()`, así que los dos pasos no pueden
 * discrepar en a quién consideran "con cuenta".
 *
 * ## A quién no se le pone el rol
 *
 * - A quien no tenga ni `discordUserId` ni un `@usuario` que el roster resuelva: no hay
 *   id con el que hacer la petición. Se cuenta en `withoutAccount`.
 * - A quien la comprobación de pertenencia haya dejado **fuera del servidor**
 *   (`discordInGuild === false`): no se puede poner un rol a quien no está en el
 *   servidor —Discord contestaría `404`—, y de paso se cae de la lista de "con el rol",
 *   así que cuando vuelva a entrar se le pone otra vez en la pasada siguiente.
 *
 * ## La memoria, y por qué es `Setting` y no una columna
 *
 * Para **quitar** el rol hace falta saber a quién se le puso, y una fila **borrada** ya
 * no dice nada. Por eso el bot anota en `Setting["discord.participantRole"]` los ids a
 * los que ha puesto el rol, y la resta la hace `planParticipantRoleSync()`. Se escribe
 * **solo si algo ha cambiado de verdad** (una operación que Discord ha confirmado), para
 * no tocar la base en las pasadas en las que no hay nada que hacer.
 *
 * ## Lo que falla aquí no tumba la pasada
 *
 * **Nunca lanza.** Un `403` (al bot le falta `MANAGE_ROLES`, o el rol está por encima
 * del suyo), un `404` o un timeout se resumen en `warnings` y el paso sigue con el
 * siguiente id; lo que se ha confirmado se anota y lo que no, se reintenta en la pasada
 * siguiente. Es el mismo tratamiento que `checkDiscordMembership()`: esto es un adorno
 * del torneo, no el torneo, y por eso su motivo va al rastro (`discordError`) sin mover
 * `lastSuccessAt`.
 *
 * **Sin configurar no se hace nada y no es un fallo**: sin token, sin servidor o sin rol
 * no se lee ni una fila de `Player` ni se crea el cliente HTTP, y el motivo queda en el
 * rastro. Es la degradación por defecto del resto de pasos de Discord.
 */

/** Una fila de `Player` tal y como la necesita este paso. */
type ParticipantRoleRow = {
  /** `Player.discordUserId`, o `null` si solo se conoce el `@usuario`. */
  discordUserId: string | null;
  /** `Player.discordUsername`, ya canónico y sin arroba. */
  discordUsername: string | null;
  /** `discordInGuild`: `false` es "comprobado y fuera", y entonces no se le pone el rol. */
  discordInGuild: boolean | null;
  /** Solo para el rastro: a quién se refiere un aviso. */
  name: string;
};

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : `Error desconocido: ${String(error)}`;
}

/**
 * Los aprobados con cuenta de Discord **o** `@usuario`, igual que `readCandidates()` en
 * `check.ts` y por el mismo motivo: filtrar por el id dejaría fuera precisamente a quien
 * solo tiene `@usuario` y el roster puede resolver.
 */
function readApprovedPlayers(): Promise<ParticipantRoleRow[]> {
  return db.player.findMany({
    where: { status: PlayerStatus.APPROVED },
    select: {
      discordUserId: true,
      discordUsername: true,
      discordInGuild: true,
      name: true,
    },
    orderBy: { profileId: "asc" },
  });
}

/** La memoria guardada, o la vacía si no hay. Un valor que no se entiende se descarta. */
async function readMemory(): Promise<ParticipantRoleMemory> {
  const setting = await db.setting.findUnique({ where: { key: PARTICIPANT_ROLE_KEY } });

  return setting === null
    ? { granted: [], syncedAt: null }
    : parseParticipantRoleMemory(setting.value);
}

/**
 * Guarda la memoria.
 *
 * `value` va como `InputJsonObject` y no con un `as`, el mismo criterio que
 * `writeDiscordRosterCache()`: un `undefined` que se colara se vería al serializar en
 * vez de guardarse como `null`.
 */
async function writeMemory(memory: ParticipantRoleMemory): Promise<void> {
  const value = JSON.parse(JSON.stringify(memory)) as Prisma.InputJsonObject;

  await db.setting.upsert({
    where: { key: PARTICIPANT_ROLE_KEY },
    create: { key: PARTICIPANT_ROLE_KEY, value },
    update: { value },
  });
}

/**
 * Los ids de Discord de los aprobados a los que **se les debería** poner el rol.
 *
 * La cuenta sale del `discordUserId` si lo hay; si no, del `@usuario` buscado en el
 * roster. Un `@usuario` que no aparece o que aparece dos veces no se puede resolver y
 * sale por `withoutAccount`. Y a quien ya conste fuera del servidor no se le cuenta: no
 * se le puede poner el rol, y excluirle es lo que hace que vuelva a la lista cuando
 * regrese.
 */
function desiredAccounts(
  players: readonly ParticipantRoleRow[],
  roster: readonly { id: string; username: string }[] | null,
  result: ParticipantRoleSyncResult,
  warnings: string[],
): { ids: string[]; names: Map<string, string> } {
  const ids: string[] = [];
  const names = new Map<string, string>();

  for (const player of players) {
    if (player.discordInGuild === false) {
      continue;
    }

    if (player.discordUserId !== null) {
      ids.push(player.discordUserId);
      names.set(player.discordUserId, player.name);
      continue;
    }

    if (player.discordUsername === null || roster === null) {
      result.withoutAccount += 1;

      if (player.discordUsername !== null) {
        warnings.push(
          `${player.name}: solo tiene @${player.discordUsername} y no hay lista de miembros con la que resolver su cuenta.`,
        );
      }

      continue;
    }

    const encontrado = matchRosterUsername(player.discordUsername, roster);

    if (typeof encontrado !== "object") {
      result.withoutAccount += 1;
      warnings.push(
        `${player.name}: su @usuario @${player.discordUsername} no cuadra con el roster, así que no se le puede poner el rol.`,
      );

      continue;
    }

    ids.push(encontrado.id);
    names.set(encontrado.id, player.name);
  }

  return { ids, names };
}

/**
 * Ejecuta una operación con el rol y dice si ha quedado **confirmada**.
 *
 * Devuelve `true` cuando el id puede darse por resuelto: un `2xx` (Discord contesta
 * `204`), y también un `404` al **quitar** el rol —la cuenta ya no está en el servidor,
 * así que no hay rol que quitar, y dejarla en la memoria solo haría reintentarlo para
 * siempre—. Cualquier otra cosa es un fallo: se resume en `warnings`, devuelve `false`
 * (no se anota) y se reintenta en la siguiente pasada. **Nunca lanza.**
 */
async function applyRole(
  client: DiscordHttpClient,
  config: DiscordConfig & { botToken: string; guildId: string; participantRoleId: string },
  id: string,
  method: "PUT" | "DELETE",
  name: string | undefined,
  warnings: string[],
): Promise<boolean> {
  try {
    await client.request(
      method,
      `/guilds/${config.guildId}/members/${id}/roles/${config.participantRoleId}`,
      { authorization: `Bot ${config.botToken}` },
    );

    return true;
  } catch (error) {
    const status = error instanceof DiscordError ? error.status : null;

    if (method === "DELETE" && status === 404) {
      return true;
    }

    const quien = name === undefined ? id : `${name} (${id})`;
    const accion = method === "PUT" ? "poner" : "quitar";

    if (status === 403) {
      warnings.push(
        `${quien}: no se le ha podido ${accion} el rol de participante — Discord respondió 403. ` +
          "Comprueba que el bot tiene el permiso MANAGE_ROLES y que su rol está por encima del que toca.",
      );
    } else {
      warnings.push(
        `${quien}: no se le ha podido ${accion} el rol de participante (${toErrorMessage(error)}).`,
      );
    }

    return false;
  }
}

/**
 * El paso del worker: sincroniza el rol de participante y anota lo que ha cambiado.
 *
 * **Nunca lanza.** Un fallo de la base o de Discord se resume en `warnings` (o en
 * `error`) y sale en el rastro de la pasada sin mover `lastSuccessAt`. Sin configurar,
 * sale antes de leer nada.
 */
export async function syncParticipantRole(
  options: { signal?: AbortSignal; config?: DiscordConfig } = {},
): Promise<ParticipantRoleSyncResult> {
  const startedAtMs = Date.now();
  const config = options.config ?? getDiscordConfig();
  const now = new Date();
  const warnings: string[] = [];

  const result: ParticipantRoleSyncResult = {
    participants: 0,
    withAccount: 0,
    withoutAccount: 0,
    granted: 0,
    added: 0,
    removed: 0,
    skippedByBudget: 0,
    failed: 0,
    error: null,
    warnings,
    durationMs: 0,
  };

  try {
    if (!isDiscordRoleConfigured(config)) {
      result.error =
        "Sin DISCORD_BOT_TOKEN, DISCORD_GUILD_ID o DISCORD_PARTICIPANT_ROLE_ID no se sincroniza el rol de participante en Discord.";

      result.durationMs = Date.now() - startedAtMs;

      return result;
    }

    const players = await readApprovedPlayers();

    result.participants = players.length;

    // Sin aprobados no se corta aquí: la memoria puede tener ids a los que quitar el rol
    // (un torneo donde ya no queda nadie aprobado), y la resta de más abajo es la que decide.
    //
    // La lista de miembros puede no estar: sin el intent `GUILD_MEMBERS` o sin caché no
    // hay con qué resolver a quien solo tiene `@usuario`. No es un fallo, es un dato que
    // falta, y `desiredAccounts()` lo cuenta.
    let roster: { id: string; username: string }[] | null = null;

    try {
      const cached = await readDiscordRosterCache();

      roster = cached === null ? null : cached.members;
    } catch (error) {
      warnings.push(
        `No se ha podido leer la caché del roster de Discord para resolver los @usuario: ${toErrorMessage(error)}`,
      );
    }

    const { ids, names } = desiredAccounts(players, roster, result, warnings);

    result.withAccount = ids.length;

    const memory = await readMemory();

    result.granted = memory.granted.length;

    const plan = planParticipantRoleSync(ids, memory.granted, {
      maxPerRun: config.roleMaxPerRun,
    });

    result.skippedByBudget = plan.skipped;

    if (plan.toAdd.length === 0 && plan.toRemove.length === 0) {
      result.durationMs = Date.now() - startedAtMs;

      return result;
    }

    const client = createDiscordHttpClient(config);
    const granted = new Set(memory.granted);
    let changed = false;

    // Las quitas, antes que las puestas: es el orden que decidió `planParticipantRoleSync()`
    // y aquí se respeta para que el tope no deje a un rechazado con el rol una pasada más
    // por haber gastado el presupuesto poniendo roles.
    for (const id of plan.toRemove) {
      if (options.signal?.aborted === true) {
        result.skippedByBudget += 1;

        continue;
      }

      if (await applyRole(client, config, id, "DELETE", names.get(id), warnings)) {
        granted.delete(id);
        result.removed += 1;
        changed = true;
      } else {
        result.failed += 1;
      }
    }

    for (const id of plan.toAdd) {
      if (options.signal?.aborted === true) {
        result.skippedByBudget += 1;

        continue;
      }

      if (await applyRole(client, config, id, "PUT", names.get(id), warnings)) {
        granted.add(id);
        result.added += 1;
        changed = true;
      } else {
        result.failed += 1;
      }
    }

    if (changed) {
      await writeMemory({ granted: [...granted].sort(), syncedAt: now.toISOString() });
    }
  } catch (error) {
    warnings.push(
      `No se ha podido sincronizar el rol de participante en Discord: ${toErrorMessage(error)}`,
    );
  }

  result.durationMs = Date.now() - startedAtMs;

  return result;
}
