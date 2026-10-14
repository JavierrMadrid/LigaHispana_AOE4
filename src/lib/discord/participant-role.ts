/**
 * El rol de participante del torneo en Discord (issue 56, fase 1): qué toca hacer con
 * él en cada pasada del worker.
 *
 * ## Qué decide este módulo, y por qué es puro
 *
 * El bot pone el rol configurado a los participantes **aprobados** que tengan cuenta de
 * Discord y se lo quita a quien haya dejado de estar aprobado. Eso son peticiones a la
 * API de Discord y escrituras en la base, y por eso quien las hace es el worker
 * (`src/lib/discord/role-sync.ts`, server-only). Pero **decidir** a quién hay que
 * añadir el rol, a quién quitárselo y a quién no tocar no necesita ni red ni base de
 * datos: es una resta de conjuntos, y es justo la parte que no se puede dejar suelta,
 * porque una resta al revés le pone el rol de participante a quien no lo es —o se lo
 * quita a quien sí— sin que Discord haya dicho nada.
 *
 * Por eso este módulo no lleva `import "server-only"`: no lee nada del servidor, no
 * importa nada de servidor y se puede comprobar entero con listas escritas a mano en
 * `tests/unit/lib/discord/participant-role.test.ts`. Es el mismo reparto que
 * `membership.ts` (la parte pura) y `check.ts` (la que sale a la red).
 *
 * ## La memoria vive en `Setting`, no en una columna
 *
 * La fuente de verdad de **quiénes son participantes** es `Player.status`, y el rol no
 * la sustituye: la acompaña. Pero para **quitar** el rol hace falta saber a quién se le
 * puso, y eso no se puede deducir de `Player` cuando la fila se ha **borrado** —una
 * baja deja de tener `discordUserId` con el que identificar la cuenta—. Por eso el
 * worker guarda en `Setting["discord.participantRole"]` los ids de Discord a los que el
 * bot ha puesto el rol: con esa lista, la pasada sabe qué hay que revisar aunque el
 * participante ya no exista en la base.
 *
 * La memoria es la del que **puso** el rol, no la del que lo tiene: si alguien se lo
 * quitó a mano desde Discord, la pasada no lo vuelve a poner (la cuenta sigue en la
 * lista), y si alguien se lo puso a mano, la pasada no se lo quita (no está en la
 * lista). Es el precio de no leer el rol de cada miembro del servidor, y está asumido:
 * lo que manda es el estado del torneo, no el del servidor.
 *
 * Los dos conjuntos que se comparan, entonces, son:
 *
 * - **Quiénes deberían tenerlo** (`desired`): los aprobados con cuenta de Discord
 *   resoluble que no constan fuera del servidor.
 * - **Quiénes lo tienen porque lo puso el bot** (`granted`): la memoria de `Setting`.
 *
 * Y la resta sale en tres: a los de `desired` que no están en `granted` se les añade; a
 * los de `granted` que no están en `desired` se les quita; el resto no se toca. Eso no
 * gasta ni una petición en las ~288 pasadas diarias en las que no cambia nada, que es
 * lo que hace que este paso no sea un coste fijo del sincronizador.
 */

import { isRecord } from "@/lib/json";

/* -------------------------------------------------------------------------- */
/* Memoria                                                                     */
/* -------------------------------------------------------------------------- */

/** Clave de `Setting` donde vive la memoria del rol de participante. */
export const PARTICIPANT_ROLE_KEY = "discord.participantRole";

/**
 * Los ids de Discord a los que el bot ha puesto el rol, y cuándo se sincronizó.
 *
 * `granted` es la lista de ids (`discordUserId`) con el rol puesto por el bot. Guardar
 * el id y no el `Player.id` es lo único que sobrevive a la baja de un participante, que
 * es el caso que obliga a tener memoria: sin ella, un rechazado o un eliminado seguiría
 * con el rol y no habría forma de saberlo.
 *
 * `syncedAt` es informativo (cuándo se pasó por aquí) y no decide nada: la decisión sale
 * de la lista.
 */
export type ParticipantRoleMemory = {
  /** `discordUserId` con el rol puesto por el bot, sin repetidos. */
  granted: string[];
  /** Instante de la última escritura, en ISO-8601, o `null` si nunca se ha anotado. */
  syncedAt: string | null;
};

/** La memoria de un despliegue que todavía no ha puesto ningún rol. */
export const EMPTY_PARTICIPANT_ROLE_MEMORY: ParticipantRoleMemory = {
  granted: [],
  syncedAt: null,
};

/**
 * La memoria guardada, leída **sin lanzar**.
 *
 * Un documento que no se entiende se lee como "no se ha puesto ningún rol": como mucho,
 * la pasada vuelve a poner un rol que ya estaba (un `PUT` idempotente, Discord contesta
 * `204` igual) y **no quita ninguno** hasta que la memoria se reconstruya. Es la
 * dirección segura: un valor raro no puede acabar sacándole el rol a un participante.
 */
export function parseParticipantRoleMemory(value: unknown): ParticipantRoleMemory {
  if (!isRecord(value) || !Array.isArray(value["granted"])) {
    return { ...EMPTY_PARTICIPANT_ROLE_MEMORY };
  }

  const granted: string[] = [];
  const vistos = new Set<string>();

  for (const id of value["granted"]) {
    if (typeof id !== "string" || id === "" || vistos.has(id)) {
      continue;
    }

    vistos.add(id);
    granted.push(id);
  }

  const syncedAt = value["syncedAt"];

  return {
    granted,
    syncedAt: typeof syncedAt === "string" && syncedAt !== "" ? syncedAt : null,
  };
}

/* -------------------------------------------------------------------------- */
/* La decisión                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Lo que hay que hacer con el rol en esta pasada.
 *
 * `toAdd` y `toRemove` son ids de Discord, y las listas van ordenadas para que el
 * rastro y las pruebas sean deterministas. `skipped` es lo que el tope de la pasada ha
 * dejado fuera y se dirá en la siguiente.
 */
export type ParticipantRoleActions = {
  /** Ids a los que hay que **poner** el rol. */
  toAdd: string[];
  /** Ids a los que hay que **quitar** el rol. */
  toRemove: string[];
  /** Operaciones que quedan para la siguiente pasada por el tope. */
  skipped: number;
};

/**
 * La resta: qué añadir, qué quitar y qué dejar como está.
 *
 * `desired` son los ids que **deberían** tener el rol (aprobados y resolubles) y
 * `granted` los que lo tienen puesto por el bot. Un id en los dos no se toca; uno que
 * falte en `granted` se añade; uno que sobre se quita. Es idempotente por definición:
 * repetirla con los mismos conjuntos no produce ninguna operación.
 *
 * ## El tope, y por qué las bajas van primero
 *
 * `maxPerRun` acota el trabajo por pasada, por el mismo motivo que
 * `DISCORD_CHECK_MAX_PER_RUN`: al configurar el rol todo el torneo tiene que ponérselo
 * a la vez, y repartirlo en varias pasadas es mejor que una ráfaga. El tope es
 * **compartido** entre añadir y quitar, y las **quitas se hacen antes**: quitarle el rol
 * a quien ya no participa es lo que no puede quedarse a medias —alguien rechazado que
 * siga con el rol de participante es un error visible—, mientras que un rol que tarda
 * una pasada más en ponerse no molesta a nadie.
 *
 * Con `maxPerRun <= 0` no se hace nada y todo va a `skipped`, que es la lectura segura
 * de un tope mal configurado.
 */
export function planParticipantRoleSync(
  desired: readonly string[],
  granted: readonly string[],
  options: { maxPerRun: number },
): ParticipantRoleActions {
  const shouldHave = [...new Set(desired)].sort();
  const have = new Set(granted);

  const toRemoveTodos = [...have].filter((id) => !shouldHave.includes(id)).sort();
  const toAddTodos = shouldHave.filter((id) => !have.has(id));

  const budget = Number.isFinite(options.maxPerRun) ? Math.max(0, Math.floor(options.maxPerRun)) : 0;
  const toRemove = toRemoveTodos.slice(0, budget);
  const toAdd = toAddTodos.slice(0, Math.max(0, budget - toRemove.length));

  return {
    toAdd,
    toRemove,
    skipped: toRemoveTodos.length - toRemove.length + (toAddTodos.length - toAdd.length),
  };
}

/* -------------------------------------------------------------------------- */
/* El rastro                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Lo que ha pasado con el rol en una pasada del worker.
 *
 * `error` **no** significa que la pasada se haya roto: es el motivo por el que el paso
 * no ha hecho nada (sin configurar, o un fallo de la base), y va al mismo sitio que el
 * resto de la información de Discord (`discordError`), **sin** mover `lastSuccessAt`.
 * `failed` cuenta las operaciones que Discord rechazó y se reintentarán en la siguiente
 * pasada; un `403` o un timeout **no** tumbarán la pasada, solo salen en `warnings`.
 */
export type ParticipantRoleSyncResult = {
  /** Participantes aprobados leídos, con cuenta de Discord o sin ella. */
  participants: number;
  /** De los anteriores, los que tienen cuenta de Discord resoluble y no constan fuera. */
  withAccount: number;
  /** De los anteriores, los que no tienen cuenta resoluble: no se les puede poner el rol. */
  withoutAccount: number;
  /** Ids con el rol puesto por el bot antes de esta pasada (memoria). */
  granted: number;
  /** Roles puestos en esta pasada. */
  added: number;
  /** Roles quitados en esta pasada. */
  removed: number;
  /** Operaciones que quedan para la siguiente pasada por el tope. */
  skippedByBudget: number;
  /** Operaciones que Discord ha rechazado y se reintentarán. */
  failed: number;
  /** Por qué el paso no ha hecho nada, o `null` si sí ha hecho. */
  error: string | null;
  /** Lo que hay que saber y no es un éxito limpio, en texto legible para el rastro. */
  warnings: string[];
  durationMs: number;
};

/**
 * La línea que va al rastro de la pasada, o `null` si no hay nada que decir.
 *
 * **`null` solo cuando no hay ni una operación pendiente de contar y no hay avisos.** Con
 * el rol configurado y sin cambios, la línea sigue saliendo con el recuento —es donde se
 * ve que el paso está funcionando—, igual que `describeDiscordChecks()`; callarse no
 * dejaría ningún sitio donde mirar si el bot dejó de sincronizarlo.
 */
export function describeParticipantRoleSync(result: ParticipantRoleSyncResult): string | null {
  const partes = [
    result.withAccount === 0 ? null : `${result.withAccount} con cuenta`,
    result.added > 0 ? `${result.added} con el rol puesto` : null,
    result.removed > 0 ? `${result.removed} con el rol quitado` : null,
    result.withoutAccount > 0 ? `${result.withoutAccount} sin cuenta que resolver` : null,
    result.skippedByBudget > 0 ? `${result.skippedByBudget} para la siguiente pasada` : null,
    result.failed > 0 ? `${result.failed} con error` : null,
    result.error,
  ].filter((parte): parte is string => parte !== null);

  if (partes.length === 0) {
    return result.warnings.length === 0 ? null : result.warnings.join(" ");
  }

  return [`Rol de participante: ${partes.join(", ")}.`, ...result.warnings].join(" ");
}
