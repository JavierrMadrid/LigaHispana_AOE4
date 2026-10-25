import "server-only";

import { PlayerStatus } from "@/generated/prisma/enums";
import { db } from "@/lib/db";
import {
  eventContains,
  readEditionEvents,
  readEditionEventsState,
  writeEditionEventsState,
  type EditionEvent,
  type EditionEventEligibility,
  type EditionEventsState,
} from "@/lib/edition-events";
import { checkDiscordAccount } from "./check";
import { getDiscordConfig, isDiscordCheckConfigured, type DiscordConfig } from "./env";
import { createDiscordHttpClient } from "./http";
import {
  rosterMembershipClaim,
  type DiscordMembershipVerdict,
  type DiscordRosterMember,
} from "./membership";
import { fetchGuildRoster } from "./roster";
import { readDiscordRosterCache, writeDiscordRosterCache } from "./roster-cache";

/**
 * El **snapshot de elegibilidad** de los eventos puntuales que exigen pertenencia al
 * servidor de Discord (issue 60).
 *
 * ## Qué decide
 *
 * Un evento con `discordRequired` solo reparte el bono entre quienes estaban en el
 * servidor. `computeEventBonuses()` no lo deduce: lee el snapshot congelado de
 * `Setting["edition.events.state"]` y, si no hay snapshot, **no reparte bono**. Este
 * módulo es quien lo escribe, y lo hace **antes** del recálculo de la clasificación en
 * la misma pasada del sincronizador.
 *
 * ## Cuándo se comprueba, y qué se congela
 *
 * - **La primera pasada dentro de la ventana del evento** comprueba a **todos** los
 *   aprobados. Para eso fuerza la lectura del roster ignorando su caché de doce horas:
 *   el snapshot tiene que ser la foto del momento en que empieza, no una de antes de
 *   ayer.
 * - **Las pasadas siguientes** solo miran a los aprobados que **no** están en
 *   `checkedPlayerIds` (por ejemplo, alguien aprobado a mitad del evento). A quien ya
 *   se comprobó no se le vuelve a preguntar: la elegibilidad se congela.
 * - **Nunca se quita a nadie de `eligiblePlayerIds`.** Si alguien entra al servidor a
 *   mitad del evento, cobra desde su comprobación; si sale después, ya estaba dentro
 *   cuando el evento empezó y no se le quita.
 *
 * ## La regla de los veredictos, la misma del resto de Discord
 *
 * Solo `member` y `not-member` son concluyentes y solo esos marcan al jugador como
 * comprobado. Un `unknown` (timeout, `401`, `5xx`, un roster ilegible) **no se marca**:
 * se reintenta en la siguiente pasada. Es la misma regla que
 * `checkDiscordMembership()`: no saber no es "no está", y aquí además sería "no cobra".
 *
 * El roster sirve para afirmar **presencias** de golpe sin una petición por jugador:
 * quien aparece en la lista es `member` sin gastar red. Una ausencia de la lista **no**
 * se escribe tal cual —la lista es una foto y quien acaba de entrar no está en ella—,
 * así que se confirma con `GET /guilds/{id}/members/{user_id}`, que es la única ruta
 * que pregunta por el estado de ahora. Las ausencias confirmadas sí son `not-member`.
 *
 * ## El jugador sin `discordUserId`
 *
 * Se cuenta como comprobado y **no elegible**: es la decisión conservadora y la que
 * pide el torneo, porque sin cuenta enlazada no hay manera de probar que esa persona
 * sea la que está en el servidor. Un `@usuario` resuelto por el roster es un enlace que
 * escribe la comprobación de pertenencia (`check.ts`); este paso no lo inventa, solo
 * lee lo que ya está enlazado.
 *
 * ## El coste
 *
 * El roster es **una** lectura paginada compartida por todos los eventos. Lo que se
 * acota es lo que cuesta una petición por jugador: las confirmaciones por cuenta, con
 * el mismo tope por pasada que `DISCORD_CHECK_MAX_PER_RUN`. Lo que se queda fuera no
 * se escribe y se reintenta en la siguiente pasada, así que el snapshot crece hasta
 * estar completo sin gastar de golpe el presupuesto del Worker.
 *
 * ## Lo que no hace
 *
 * **No crea alertas** `DISCORD_NOT_IN_GUILD`: esas son de la comprobación de
 * pertenencia y avisan a la organización. Esto solo decide quién cobra, y un
 * participante que no está en el servidor ya tiene (o tendrá) su alerta por la otra
 * vía.
 *
 * **Nunca lanza.** Un fallo de la base o de Discord se resume en `error` y `warnings`,
 * que el sincronizador escribe en `discordError` sin mover `lastSuccessAt`.
 */

/** Un aprobado, con lo que hace falta para decidir su elegibilidad. */
export type EligibilityCandidate = {
  /** `Player.id`: es lo que se guarda en el snapshot. */
  id: string;
  /** Solo para el rastro: a quién se refiere un aviso. */
  name: string;
  /** `Player.discordUserId`; `null` = sin cuenta enlazada, no elegible. */
  discordUserId: string | null;
};

/** Lo que ha dicho Discord de un jugador. */
export type EligibilityVerdict = {
  playerId: string;
  membership: DiscordMembershipVerdict;
};

/** Qué ha pasado con el snapshot en una pasada. */
export type EditionEventEligibilityResult = {
  /** Eventos activos que exigen Discord. */
  events: number;
  /** Aprobados leídos. */
  candidates: number;
  /** Jugadores con veredicto concluyente en esta pasada. */
  checked: number;
  /** Elegibles **nuevos** en esta pasada (los que ya lo eran no se cuentan). */
  eligible: number;
  /** Jugadores del plan que se quedan para la siguiente pasada. */
  pending: number;
  /** Confirmaciones por cuenta hechas (las presencias del roster no cuestan petición). */
  requests: number;
  /** Miembros del roster usado, o `null` si no se ha podido leer. */
  rosterMembers: number | null;
  /** `true` si el roster se ha traído de la API en esta pasada. */
  rosterRefreshed: boolean;
  /** Por qué no se ha podido hacer el paso, o `null`. */
  error: string | null;
  /** Lo que no ha salido como se esperaba, en texto legible para el rastro. */
  warnings: string[];
  durationMs: number;
};

/* -------------------------------------------------------------------------- */
/* Lo que se puede probar sin base de datos                                    */
/* -------------------------------------------------------------------------- */

/**
 * A quién hay que preguntarle en esta pasada.
 *
 * Pura: son los aprobados que **no** están en `checkedPlayerIds`. Un snapshot que no
 * existe equivale a "no se ha comprobado a nadie", así que la primera pasada los
 * devuelve todos.
 */
export function planEligibilityChecks(
  candidates: readonly EligibilityCandidate[],
  eligibility: EditionEventEligibility | null,
): EligibilityCandidate[] {
  const checked = new Set(eligibility?.checkedPlayerIds ?? []);

  return candidates.filter((candidate) => !checked.has(candidate.id));
}

/**
 * El snapshot con los veredictos de esta pasada.
 *
 * Pura, y con dos invariantes que no se negocian:
 *
 * - Un `unknown` **no se marca como comprobado**: se reintenta en la siguiente pasada.
 * - **Nada sale de las listas.** `eligiblePlayerIds` es la unión de lo que ya había y
 *   los nuevos `member`; un `not-member` posterior no expulsa a nadie.
 *
 * `checkedAt` se pone al instante de la comprobación, que es lo que permite auditar
 * cuándo se congeló el snapshot.
 */
export function applyEligibilityVerdicts(
  eligibility: EditionEventEligibility | null,
  verdicts: readonly EligibilityVerdict[],
  checkedAt: string,
): EditionEventEligibility {
  const checked = new Set(eligibility?.checkedPlayerIds ?? []);
  const eligible = new Set(eligibility?.eligiblePlayerIds ?? []);

  for (const verdict of verdicts) {
    if (verdict.membership === "unknown") {
      continue;
    }

    checked.add(verdict.playerId);

    if (verdict.membership === "member") {
      eligible.add(verdict.playerId);
    }
  }

  return {
    checkedAt,
    checkedPlayerIds: [...checked],
    eligiblePlayerIds: [...eligible],
  };
}

/**
 * ¿El snapshot ha crecido con jugadores nuevos?
 *
 * Pura, y es lo que decide si merece la pena escribir la fila de `Setting`: como
 * `applyEligibilityVerdicts()` nunca quita a nadie, basta con mirar si
 * `checkedPlayerIds` tiene algún id que antes no estaba. Un cambio que solo mueva
 * `checkedAt` no se escribe.
 */
export function eligibilityGrew(
  before: EditionEventEligibility | null,
  after: EditionEventEligibility,
): boolean {
  const checkedBefore = new Set(before?.checkedPlayerIds ?? []);

  return after.checkedPlayerIds.some((id) => !checkedBefore.has(id));
}

/* -------------------------------------------------------------------------- */
/* Implementación                                                              */
/* -------------------------------------------------------------------------- */

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : `Error desconocido: ${String(error)}`;
}

/** Los aprobados, con la cuenta que tengan enlazada. */
function readCandidates(): Promise<EligibilityCandidate[]> {
  return db.player.findMany({
    where: { status: PlayerStatus.APPROVED },
    select: { id: true, name: true, discordUserId: true },
    orderBy: { profileId: "asc" },
  });
}

/**
 * El roster que hay que usar en esta pasada.
 *
 * `force` ignora la caché y trae la lista de la API: es lo que hace que el snapshot
 * del primer momento sea el de ahora y no el de hace doce horas. Sin `force` se usa la
 * caché si existe y, si no, se lee una vez (el roster se comparte entre eventos).
 *
 * Un `unknown` devuelve `null` y deja el motivo en `warnings`: quien llama cae a la
 * comprobación por cuenta, que es el camino que no necesita el intent privilegiado.
 */
async function resolveRoster(
  input: {
    force: boolean;
    config: DiscordConfig & { botToken: string; guildId: string };
    now: Date;
    signal: AbortSignal | undefined;
    result: EditionEventEligibilityResult;
    warnings: string[];
  },
): Promise<DiscordRosterMember[] | null> {
  const { force, config, now, signal, result, warnings } = input;

  if (!force) {
    try {
      const cache = await readDiscordRosterCache();

      if (cache !== null) {
        result.rosterMembers = cache.members.length;

        return cache.members;
      }
    } catch (error) {
      // Una caché ilegible no impide leer el roster: se sigue como si no hubiera.
      warnings.push(`No se ha podido leer la caché del roster de Discord: ${toErrorMessage(error)}`);
    }
  }

  const leido = await fetchGuildRoster({ config, signal });

  if (leido.status === "unknown") {
    result.rosterMembers = null;
    warnings.push(
      `No se ha podido leer la lista de miembros del servidor de Discord: ${leido.reason} ` +
        "Se sigue con la comprobación por cuenta, que no necesita el intent privilegiado.",
    );

    return null;
  }

  result.rosterMembers = leido.members.length;
  result.rosterRefreshed = true;

  try {
    await writeDiscordRosterCache(leido.members, now);
  } catch (error) {
    // El roster ya está leído y se va a usar igual: perder la caché cuesta una lectura
    // más en la próxima pasada, nada más.
    warnings.push(`No se ha podido guardar la caché del roster de Discord: ${toErrorMessage(error)}`);
  }

  return leido.members;
}

/**
 * El paso del worker: completa el snapshot de elegibilidad de los eventos activos.
 *
 * **Nunca lanza.** Sin credenciales no escribe nada y devuelve un error legible: el
 * motor, al no haber snapshot, no repartirá bono para ese evento. Un fallo de la base
 * o de la red se resume igual, porque esto no puede tumbar la sincronización.
 */
export async function syncEditionEventEligibility(
  options: {
    config?: DiscordConfig;
    now?: Date;
    signal?: AbortSignal;
    /** Tope de confirmaciones por cuenta en esta pasada; por defecto, el del worker. */
    maxChecks?: number;
  } = {},
): Promise<EditionEventEligibilityResult> {
  const startedAtMs = Date.now();
  const config = options.config ?? getDiscordConfig();
  const now = options.now ?? new Date();
  const warnings: string[] = [];

  const result: EditionEventEligibilityResult = {
    events: 0,
    candidates: 0,
    checked: 0,
    eligible: 0,
    pending: 0,
    requests: 0,
    rosterMembers: null,
    rosterRefreshed: false,
    error: null,
    warnings,
    durationMs: 0,
  };

  try {
    const { events } = await readEditionEvents();
    const activos: EditionEvent[] = events.filter(
      (event) => event.discordRequired && eventContains(event, now),
    );

    result.events = activos.length;

    // Sin eventos activos que exijan Discord no se escribe nada y no se deja rastro: es
    // el caso de las ~288 pasadas diarias de una edición sin eventos, y no tiene que
    // parecer que Discord está apagado.
    if (activos.length === 0) {
      result.durationMs = Date.now() - startedAtMs;

      return result;
    }

    if (!isDiscordCheckConfigured(config)) {
      result.error =
        "Sin DISCORD_BOT_TOKEN o DISCORD_GUILD_ID no se comprueba la elegibilidad de los eventos en Discord: los eventos que exigen Discord no repartirán bono.";
      result.durationMs = Date.now() - startedAtMs;

      return result;
    }

    const state: EditionEventsState = await readEditionEventsState();
    const candidates = await readCandidates();

    result.candidates = candidates.length;

    const planes = activos.map((event) => {
      const snapshot = state.events[event.id] ?? null;

      return {
        event,
        snapshot,
        pendientes: planEligibilityChecks(candidates, snapshot),
      };
    });

    // Nadie nuevo que comprobar: no se lee el roster ni se crea el cliente HTTP. Es el
    // caso de todas las pasadas normales de un evento que ya está congelado.
    if (planes.every((plan) => plan.pendientes.length === 0)) {
      result.durationMs = Date.now() - startedAtMs;

      return result;
    }

    // La primera pasada de un evento es la que tiene que fotografiar el servidor, así
    // que se lee el roster aunque su caché no haya vencido.
    const roster = await resolveRoster({
      force: planes.some((plan) => plan.snapshot === null),
      config,
      now,
      signal: options.signal,
      result,
      warnings,
    });
    const rosterIds = roster === null ? null : new Set(roster.map((miembro) => miembro.id));
    const maxChecks = options.maxChecks ?? config.maxChecksPerRun;
    let dirty = false;

    // El cliente no sale a la red al crearse; solo se usa para las confirmaciones por
    // cuenta, que es lo que el tope acota.
    const client = createDiscordHttpClient(config);

    for (const plan of planes) {
      const verdicts: EligibilityVerdict[] = [];
      let pending = 0;

      for (const candidate of plan.pendientes) {
        // Sin cuenta enlazada no hay nada que preguntar: comprobado y no elegible.
        if (candidate.discordUserId === null) {
          verdicts.push({ playerId: candidate.id, membership: "not-member" });

          continue;
        }

        // Una presencia en el roster es un hecho y no cuesta ninguna petición.
        if (
          roster !== null &&
          rosterIds !== null &&
          rosterMembershipClaim(rosterIds.has(candidate.discordUserId)) === "member"
        ) {
          verdicts.push({ playerId: candidate.id, membership: "member" });

          continue;
        }

        if (result.requests >= maxChecks || options.signal?.aborted === true) {
          pending += 1;

          continue;
        }

        result.requests += 1;

        const comprobacion = await checkDiscordAccount(candidate.discordUserId, config, client);

        if (comprobacion.verdict === "unknown") {
          // Ni se marca ni se concluye: se reintenta en la siguiente pasada.
          pending += 1;

          if (comprobacion.reason !== null) {
            warnings.push(`${candidate.name}: ${comprobacion.reason}`);
          }

          continue;
        }

        verdicts.push({ playerId: candidate.id, membership: comprobacion.verdict });
      }

      result.pending += pending;

      const merged = applyEligibilityVerdicts(plan.snapshot, verdicts, now.toISOString());

      if (!eligibilityGrew(plan.snapshot, merged)) {
        continue;
      }

      state.events[plan.event.id] = merged;
      dirty = true;
      result.checked += verdicts.length;
      result.eligible +=
        merged.eligiblePlayerIds.length - (plan.snapshot?.eligiblePlayerIds.length ?? 0);
    }

    if (!dirty) {
      result.durationMs = Date.now() - startedAtMs;

      return result;
    }

    try {
      await writeEditionEventsState(state);
    } catch (error) {
      result.error = `No se ha podido guardar el snapshot de elegibilidad de los eventos: ${toErrorMessage(error)}`;
    }
  } catch (error) {
    result.error = `No se ha podido comprobar la elegibilidad de los eventos en Discord: ${toErrorMessage(error)}`;
  }

  result.durationMs = Date.now() - startedAtMs;

  return result;
}

/**
 * La línea que va al rastro de la pasada (`discordError`), o `null` si no hay nada que
 * decir.
 *
 * Con eventos activos se escribe el recuento aunque no haya fallo, porque es donde se
 * ve que el snapshot está creciendo y cuántos quedan para la siguiente pasada. Sin
 * eventos no se escribe nada: en las ~288 pasadas diarias de una edición sin eventos
 * este paso no tiene que dejar rastro.
 */
export function describeEditionEventEligibility(
  result: EditionEventEligibilityResult,
): string | null {
  if (result.events === 0) {
    return result.error;
  }

  const partes = [
    result.checked > 0 ? `${result.checked} comprobados` : null,
    result.eligible > 0 ? `${result.eligible} elegibles nuevos` : null,
    result.pending > 0 ? `${result.pending} para la siguiente pasada` : null,
    result.rosterMembers === null
      ? null
      : `roster de ${result.rosterMembers} miembros${result.rosterRefreshed ? ", recién leída" : ""}`,
  ].filter((parte): parte is string => parte !== null);

  const resumen =
    partes.length === 0 ? null : `Eventos con Discord: ${partes.join(", ")}.`;
  const lineas = [result.error, resumen, ...result.warnings].filter(
    (linea): linea is string => linea !== null,
  );

  return lineas.length === 0 ? null : lineas.join(" ");
}
