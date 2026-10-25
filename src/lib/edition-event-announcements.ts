import "server-only";

import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { postChannelMessage } from "@/lib/discord/channel";
import { getDiscordConfig, isDiscordAnnounceConfigured, type DiscordConfig } from "@/lib/discord/env";
import { createDiscordHttpClient } from "@/lib/discord/http";
import { formatEventWindow } from "@/lib/format";
import { isRecord } from "@/lib/json";
import { readEditionEvents, type EditionEvent } from "@/lib/edition-events";

/**
 * Los avisos de los eventos puntuales de la edición (issues 60 y 144).
 *
 * ## Qué avisa, y cuándo
 *
 * El worker, en su pasada, mira la lista de eventos (`Setting["edition.events"]`) y
 * manda al canal cinco mensajes por evento: tres recordatorios antes de que empiece y
 * los dos avisos de su ciclo de vida, al empezar y al terminar.
 *
 * | Aviso | Cuándo (`now`) |
 * |---|---|
 * | `24h` | `[start − 24 h, start − 12 h)` |
 * | `12h` | `[start − 12 h, start − 1 h)` |
 * | `1h` | `[start − 1 h, start)` |
 * | `start` | `[start, end)` |
 * | `end` | `[end, ∞)` |
 *
 * Los recordatorios no han cambiado: si una pasada se salta un tramo entero (una
 * caída, un despliegue), ese aviso **no se manda atrasado**: solo sale el del tramo en
 * el que estamos, que es el mismo criterio que los recordatorios de la edición.
 *
 * Los dos avisos de ciclo de vida sí toleran la tardanza, porque la información sigue
 * siendo cierta cuando llegan: `start` sale en la primera pasada con
 * `start <= now < end` aunque el evento lleve horas en marcha —por eso el texto dice
 * «ya está en marcha» y no «empieza ahora»—, y `end` sale en la primera pasada con
 * `now >= end` aunque el cierre llegue tarde. Un evento que terminó antes de que
 * llegara la pasada **no** manda el inicio atrasado: con `now >= end` solo sale el
 * fin, porque anunciar un evento en curso cuando ya no lo está sería mentir.
 *
 * ## La memoria, aparte de la de la edición
 *
 * Vive en `Setting["edition.events.announcements"]`, con su propia clave y su propio
 * documento, para no mezclar dos ciclos de vida: la memoria de la edición se escribe
 * desde que se publica la ventana, y la de los eventos depende de una lista que se
 * puede crear y borrar antes del torneo. La forma es un mapa `sent` de
 * `${eventId}:${milestone}` → instante en que se mandó, con los cinco avisos en el
 * mismo mapa (`${eventId}:start`, `${eventId}:end` y los tres recordatorios); un
 * documento roto se lee como vacío, que como mucho repite un aviso.
 *
 * ## La mención
 *
 * Todos los avisos mencionan al rol de participante (`DISCORD_PARTICIPANT_ROLE_ID`)
 * con `<@&id>` y `allowed_mentions` restringido a ese rol: avisar de un evento no
 * puede acabar pingueando a todo el servidor. **Sin rol configurado no se manda
 * nada** y el aviso queda pendiente: una mención rota no es un aviso, y el rol ya está
 * configurado en producción.
 *
 * ## El aviso de comienzo del torneo
 *
 * `startAnnouncementMessages()` compone el texto del aviso de comienzo con el resumen
 * de los eventos (nombre, ventana, multiplicador y requisito de Discord). Si no cabe
 * en los 2000 caracteres de Discord, el aviso de inicio sale entero y el resumen va en
 * un segundo mensaje: partir el mensaje de inicio por la mitad dejaría la primera
 * frase del torneo cortada.
 *
 * ## Degradación
 *
 * Sin token o sin canal no se envía y no se anota: el aviso queda pendiente para
 * cuando se configure. El motivo va al rastro de la pasada (`announceError`), que no
 * mueve `lastSuccessAt`: no poder avisar de un evento no ha parado ni una partida.
 */

/** Clave de `Setting` donde vive la memoria de los avisos de eventos. */
export const EDITION_EVENTS_ANNOUNCEMENTS_KEY = "edition.events.announcements";

/** Versión de la forma del documento de memoria. */
export const EDITION_EVENTS_ANNOUNCEMENTS_VERSION = 1;

/** Los tres recordatorios de cada evento, de más a menos antelación. */
export const EVENT_REMINDER_MILESTONES = ["24h", "12h", "1h"] as const;

/** Los avisos de ciclo de vida: el evento empieza y el evento termina. */
export const EVENT_LIFECYCLE_MILESTONES = ["start", "end"] as const;

/** Todos los avisos de un evento: los tres recordatorios y los dos del ciclo de vida. */
export const EVENT_ANNOUNCEMENT_MILESTONES = [
  ...EVENT_REMINDER_MILESTONES,
  ...EVENT_LIFECYCLE_MILESTONES,
] as const;

export type EventReminderMilestone = (typeof EVENT_REMINDER_MILESTONES)[number];

export type EventLifecycleMilestone = (typeof EVENT_LIFECYCLE_MILESTONES)[number];

export type EventAnnouncementMilestone = (typeof EVENT_ANNOUNCEMENT_MILESTONES)[number];

/**
 * Tope de caracteres de un mensaje de Discord.
 *
 * No es una preferencia de estilo: Discord rechaza con `400` un `content` de más de
 * 2000 caracteres, así que pasarse no degrada el mensaje, lo pierde.
 */
export const DISCORD_MESSAGE_MAX_LENGTH = 2_000;

const HOUR_MS = 3_600_000;

/**
 * Lo que se ha avisado ya.
 *
 * `sent` lleva una marca `ISO` por cada aviso, con la clave
 * `${eventId}:${milestone}`: los cinco comparten mapa. El id del evento es estable (el
 * panel lo conserva al editar), así que la clave sobrevive a un cambio de nombre o de
 * fechas: mover un evento no vuelve a mandar los avisos que ya salieron.
 */
export type EditionEventsAnnouncementsMemory = {
  version: number;
  sent: Record<string, string>;
};

/** La memoria de una edición que no ha avisado de ningún evento. */
export const EMPTY_EVENTS_ANNOUNCEMENTS: EditionEventsAnnouncementsMemory = {
  version: EDITION_EVENTS_ANNOUNCEMENTS_VERSION,
  sent: {},
};

/** Cliente con la única tabla que necesita la memoria (`db` o una `tx`). */
export type EventsAnnouncementsClient = Pick<Prisma.TransactionClient, "setting">;

/* -------------------------------------------------------------------------- */
/* Lo que se puede probar sin base de datos                                    */
/* -------------------------------------------------------------------------- */

/**
 * La memoria guardada, leída **sin lanzar**.
 *
 * Un documento que no se entiende devuelve la memoria vacía: como mucho se repite un
 * aviso, que es preferible a callarse los avisos porque la fila tenía otra forma. Es el
 * mismo contrato que `parseAnnouncementsMemory()`.
 */
export function parseEventsAnnouncementsMemory(
  value: unknown,
): EditionEventsAnnouncementsMemory {
  if (!isRecord(value) || value["version"] !== EDITION_EVENTS_ANNOUNCEMENTS_VERSION) {
    return { ...EMPTY_EVENTS_ANNOUNCEMENTS };
  }

  const sent: Record<string, string> = {};

  if (isRecord(value["sent"])) {
    for (const [key, mark] of Object.entries(value["sent"])) {
      if (key !== "" && typeof mark === "string" && mark !== "") {
        sent[key] = mark;
      }
    }
  }

  return { version: EDITION_EVENTS_ANNOUNCEMENTS_VERSION, sent };
}

/** La clave con la que se anota un aviso: el id del evento y el hito. */
export function eventAnnouncementKey(
  eventId: string,
  milestone: EventAnnouncementMilestone,
): string {
  return `${eventId}:${milestone}`;
}

/**
 * La memoria con un aviso anotado como enviado.
 *
 * Pura e idempotente: volver a anotar la misma clave devuelve una memoria equivalente,
 * para que quien llama no escriba la base por nada.
 */
export function markEventAnnouncementSent(
  memory: EditionEventsAnnouncementsMemory,
  key: string,
  sentAt: string,
): EditionEventsAnnouncementsMemory {
  return { ...memory, sent: { ...memory.sent, [key]: sentAt } };
}

/** Qué recordatorio corresponde a un tiempo restante hasta el inicio, o `null` si no hay. */
function milestoneFor(remainingMs: number): EventReminderMilestone | null {
  if (remainingMs > 12 * HOUR_MS && remainingMs <= 24 * HOUR_MS) {
    return "24h";
  }

  if (remainingMs > HOUR_MS && remainingMs <= 12 * HOUR_MS) {
    return "12h";
  }

  if (remainingMs > 0 && remainingMs <= HOUR_MS) {
    return "1h";
  }

  return null;
}

/** Un aviso que toca en esta pasada. */
export type DueEventAnnouncement = {
  event: EditionEvent;
  milestone: EventAnnouncementMilestone;
  /** La clave con la que se anota en la memoria. */
  key: string;
};

/**
 * Qué avisos tocan ahora, ordenados por el inicio del evento.
 *
 * Pura: entran los eventos, la memoria y el ahora, y sale la lista de avisos por dar.
 * Hay **como mucho un aviso por evento y pasada**, porque los cinco tramos no se
 * solapan: los tres recordatorios cubren `[start − 24 h, start)` y los del ciclo de
 * vida, `[start, end)` y `[end, ∞)`. Un evento terminado nunca genera su aviso de
 * inicio atrasado, y uno ya anunciado no se repite.
 */
export function dueEventAnnouncements(
  events: readonly EditionEvent[],
  memory: EditionEventsAnnouncementsMemory,
  now: Date,
): DueEventAnnouncement[] {
  const nowMs = now.getTime();
  const due: DueEventAnnouncement[] = [];
  const ordenados = [...events].sort(
    (a, b) => new Date(a.from).getTime() - new Date(b.from).getTime(),
  );

  for (const event of ordenados) {
    const startMs = new Date(event.from).getTime();
    const endMs = new Date(event.to).getTime();

    if (!Number.isFinite(startMs)) {
      continue;
    }

    // El cierre manda sobre todo lo demás: si el evento ya terminó, solo sale el fin.
    // Anunciar «ya está en marcha» cuando ya no lo está sería mentir, así que el
    // inicio atrasado de un evento perdido no se manda nunca.
    if (Number.isFinite(endMs) && nowMs >= endMs) {
      const key = eventAnnouncementKey(event.id, "end");

      if (memory.sent[key] === undefined) {
        due.push({ event, milestone: "end", key });
      }

      continue;
    }

    // En curso: el aviso de inicio no depende de ningún tramo, así que una pasada
    // tardía lo manda igual. El texto («ya está en marcha») sigue siendo cierto.
    if (nowMs >= startMs) {
      const key = eventAnnouncementKey(event.id, "start");

      if (memory.sent[key] === undefined) {
        due.push({ event, milestone: "start", key });
      }

      continue;
    }

    const milestone = milestoneFor(startMs - nowMs);

    if (milestone === null) {
      continue;
    }

    const key = eventAnnouncementKey(event.id, milestone);

    if (memory.sent[key] !== undefined) {
      continue;
    }

    due.push({ event, milestone, key });
  }

  return due;
}

/** El multiplicador en la forma en que se lee en el canal: `x2`, `x3`. */
function multiplierText(multiplier: number): string {
  return `x${multiplier}`;
}

/** La ventana del evento, o una forma de respaldo si las fechas no se leen. */
function eventWindowText(event: EditionEvent): string {
  return formatEventWindow(event) ?? `del ${event.from} al ${event.to}`;
}

/** El requisito de Discord, o `null` si el evento no lo pide. */
function discordRequirementText(event: EditionEvent): string | null {
  return event.discordRequired
    ? "Solo cobran el bono quienes estén en el servidor de Discord."
    : null;
}

/**
 * El texto de un aviso, en español y **puro**.
 *
 * Los recordatorios y el inicio llevan el nombre, la ventana en hora de Madrid
 * (`formatEventWindow()`), el multiplicador y, si el evento lo pide, el requisito de
 * Discord. La descripción, si la hay, va tal cual: es lo que la organización escribió
 * para los participantes. El inicio dice «ya está en marcha» y no «empieza ahora»
 * porque puede salir en una pasada tardía, con el evento ya empezado.
 *
 * El fin cierra el evento con lo justo: el nombre y la ventana. Lo que ya no se puede
 * jugar no necesita repetir el multiplicador ni el requisito.
 */
export function eventAnnouncementText(
  event: EditionEvent,
  milestone: EventAnnouncementMilestone,
): string {
  if (milestone === "end") {
    return `Evento puntual «${event.name}»: ha terminado. Su ventana fue: ${eventWindowText(event)}.`;
  }

  const cuando =
    milestone === "start"
      ? "ya está en marcha."
      : milestone === "24h"
        ? "Empieza en 24 horas o menos."
        : milestone === "12h"
          ? "Empieza en 12 horas o menos."
          : "Empieza en 1 hora o menos.";

  const partes = [
    `Evento puntual «${event.name}»: ${cuando}`,
    `${eventWindowText(event)}.`,
    `Cada victoria del evento multiplica sus puntos por ${event.multiplier} (${multiplierText(event.multiplier)}).`,
    discordRequirementText(event),
    event.description,
  ].filter((parte): parte is string => parte !== null && parte !== "");

  return partes.join(" ");
}

/**
 * El resumen de los eventos para el aviso de comienzo del torneo, o `null` si no hay
 * ninguno.
 *
 * Es una línea por evento, con lo que hace falta para decidir si jugarlo: cuándo,
 * cuánto multiplica y si exige estar en Discord. Va aparte de
 * `eventAnnouncementText()` porque no es un recordatorio: no habla de cuánto queda.
 */
export function eventAnnouncementsSummary(events: readonly EditionEvent[]): string | null {
  if (events.length === 0) {
    return null;
  }

  const ordenados = [...events].sort(
    (a, b) => new Date(a.from).getTime() - new Date(b.from).getTime(),
  );

  const lineas = ordenados.map((event) => {
    const requisito = event.discordRequired ? " Solo para participantes en Discord." : "";

    return `«${event.name}»: ${eventWindowText(event)}, puntos por victoria ${multiplierText(event.multiplier)}.${requisito}`;
  });

  return ["Eventos puntuales del torneo:", ...lineas].join("\n");
}

/**
 * Parte un texto en trozos que Discord acepte, **por líneas**.
 *
 * Solo se parte cuando de verdad no cabe (el resumen de veinte eventos puede pasarse).
 * Una línea que por sí sola pase del tope se parte a lo bruto, porque el límite no se
 * negocia y dejarla entera perdería el mensaje entero.
 */
function splitMessage(text: string): string[] {
  const trozos: string[] = [];
  let actual = "";

  const empujar = (linea: string): void => {
    if (linea.length <= DISCORD_MESSAGE_MAX_LENGTH) {
      trozos.push(linea);

      return;
    }

    for (let inicio = 0; inicio < linea.length; inicio += DISCORD_MESSAGE_MAX_LENGTH) {
      trozos.push(linea.slice(inicio, inicio + DISCORD_MESSAGE_MAX_LENGTH));
    }
  };

  for (const linea of text.split("\n")) {
    const candidata = actual === "" ? linea : `${actual}\n${linea}`;

    if (candidata.length <= DISCORD_MESSAGE_MAX_LENGTH) {
      actual = candidata;
      continue;
    }

    if (actual !== "") {
      trozos.push(actual);
    }

    actual = linea;
  }

  if (actual !== "") {
    empujar(actual);
  }

  return trozos;
}

/**
 * Los mensajes del aviso de comienzo: uno solo, o el inicio y el resumen aparte.
 *
 * El aviso de inicio **nunca se parte**: si el texto combinado no cabe, se manda
 * entero y el resumen va detrás. Sin eventos devuelve el mensaje de siempre, así que
 * el aviso de una edición sin eventos no cambia ni una coma.
 */
export function startAnnouncementMessages(
  startText: string,
  events: readonly EditionEvent[],
): string[] {
  const summary = eventAnnouncementsSummary(events);

  if (summary === null) {
    return [startText];
  }

  const combined = `${startText}\n\n${summary}`;

  if (combined.length <= DISCORD_MESSAGE_MAX_LENGTH) {
    return [combined];
  }

  return [startText, ...splitMessage(summary)];
}

/* -------------------------------------------------------------------------- */
/* Memoria                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * La memoria de los avisos de eventos.
 *
 * Sin fila devuelve la memoria vacía **sin escribir nada**. Un fallo de la base **sí se
 * propaga**: "no se ha avisado de nada" tiene su valor por defecto y "no se ha podido
 * leer" no.
 */
export async function readEventsAnnouncementsMemory(
  client: EventsAnnouncementsClient = db,
): Promise<EditionEventsAnnouncementsMemory> {
  const setting = await client.setting.findUnique({
    where: { key: EDITION_EVENTS_ANNOUNCEMENTS_KEY },
  });

  return setting === null
    ? { ...EMPTY_EVENTS_ANNOUNCEMENTS }
    : parseEventsAnnouncementsMemory(setting.value);
}

/**
 * Anota la memoria. Se escribe **después** de que el mensaje haya salido, así que una
 * marca puesta significa de verdad que el aviso se mandó. `upsert` para que la primera
 * edición no necesite que nadie cree la fila.
 */
export async function writeEventsAnnouncementsMemory(
  memory: EditionEventsAnnouncementsMemory,
  client: EventsAnnouncementsClient = db,
): Promise<void> {
  const value: Prisma.InputJsonObject = {
    version: EDITION_EVENTS_ANNOUNCEMENTS_VERSION,
    sent: memory.sent,
  };

  await client.setting.upsert({
    where: { key: EDITION_EVENTS_ANNOUNCEMENTS_KEY },
    create: { key: EDITION_EVENTS_ANNOUNCEMENTS_KEY, value },
    update: { value },
  });
}

/* -------------------------------------------------------------------------- */
/* El paso del worker                                                          */
/* -------------------------------------------------------------------------- */

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : `Error desconocido: ${String(error)}`;
}

/** Lo que ha pasado con los avisos de eventos en una pasada. */
export type EventsAnnounceRunResult = {
  /** Claves `${eventId}:${milestone}` de los avisos enviados, en orden. */
  sent: string[];
  /**
   * Por qué no se ha podido avisar, o `null`. Va al rastro de la pasada
   * (`announceError`) y **no** mueve `lastSuccessAt`.
   */
  error: string | null;
};

/**
 * El paso del worker: manda los avisos que toquen y anota los que hayan salido.
 *
 * **Nunca lanza por Discord.** Un fallo del envío sale en `error` con los avisos que sí
 * se mandaron ya anotados, y el que falló queda pendiente para la siguiente pasada. Un
 * fallo de la **base** sí se propaga, como en `announceEditionWindow()`: quien llama
 * (el sincronizador) lo recoge y lo deja en el rastro.
 *
 * Sin eventos, o sin ninguno con un aviso pendiente, sale antes de leer la
 * configuración de Discord y sin crear ningún cliente HTTP.
 */
export async function announceEditionEvents(
  options: { config?: DiscordConfig; now?: Date } = {},
): Promise<EventsAnnounceRunResult> {
  const config = options.config ?? getDiscordConfig();
  const now = options.now ?? new Date();

  const { events } = await readEditionEvents();

  if (events.length === 0) {
    return { sent: [], error: null };
  }

  let memory = await readEventsAnnouncementsMemory();
  const due = dueEventAnnouncements(events, memory, now);

  if (due.length === 0) {
    return { sent: [], error: null };
  }

  if (!isDiscordAnnounceConfigured(config)) {
    return {
      sent: [],
      error:
        "Sin DISCORD_BOT_TOKEN o DISCORD_ANNOUNCE_CHANNEL_ID no se avisa de los eventos en Discord.",
    };
  }

  // La mención no es opcional: un aviso de evento sin ping al rol de participantes no
  // avisa a quien tiene que enterarse. Sin rol, el aviso queda pendiente en vez de
  // salir roto.
  if (config.participantRoleId === null) {
    return {
      sent: [],
      error:
        "Sin DISCORD_PARTICIPANT_ROLE_ID no se puede mencionar a los participantes: los avisos de eventos quedan pendientes.",
    };
  }

  const participantRoleId = config.participantRoleId;
  const client = createDiscordHttpClient(config);
  const sent: string[] = [];

  for (const aviso of due) {
    const content = `<@&${participantRoleId}> ${eventAnnouncementText(aviso.event, aviso.milestone)}`;

    try {
      await postChannelMessage(client, config, content, {
        mentionRoleIds: [participantRoleId],
      });
    } catch (error) {
      return {
        sent,
        error: `No se ha podido avisar del evento «${aviso.event.name}» (${aviso.milestone}): ${toErrorMessage(error)}`,
      };
    }

    // Se anota **cada uno** en cuanto sale: si el siguiente falla, los que ya salieron
    // no pueden volver a salir en la pasada siguiente.
    memory = markEventAnnouncementSent(memory, aviso.key, now.toISOString());
    await writeEventsAnnouncementsMemory(memory);
    sent.push(aviso.key);
  }

  return { sent, error: null };
}
