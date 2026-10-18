import "server-only";

import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import {
  getDiscordConfig,
  isDiscordAnnounceConfigured,
  type DiscordConfig,
} from "@/lib/discord/env";
import { createDiscordHttpClient, type DiscordHttpClient } from "@/lib/discord/http";
import { readEditionConfig } from "@/lib/edition";
import { formatTournamentWindow, formatUtcDay } from "@/lib/format";
import { isRecord } from "@/lib/json";
import { windowBounds, type ScoringWindow } from "@/lib/ranked-match";
import { readRuleset } from "@/lib/scoring";
import { readRegistrationState } from "@/lib/settings";

/**
 * Los avisos de la edición en Discord: comienzo, final, recordatorios y cierre de
 * inscripciones.
 *
 * ## Qué avisa, y cuándo
 *
 * El worker, en su pasada, mira la **ventana del torneo**
 * (`Setting["scoring.ruleset"].window`) y la **fecha de cierre de inscripciones**
 * (`Setting["registration.closesAt"]`) y manda un mensaje al canal cuando cruza cada
 * hito:
 *
 * | Hito | Cuándo |
 * |---|---|
 * | `start` / `end` | al cruzar `window.from` / `window.to` (los de siempre) |
 * | `start-7/3/1`, `end-7/3/1` | 7, 3 y 1 días antes de `from` / `to` |
 * | `registration-7/3/1` | 7, 3 y 1 días antes de la fecha de cierre |
 * | `registration-close` | cuando el plazo pasa a cerrado, si antes estaba abierto |
 *
 * Son unos pocos avisos en toda la vida de una edición, y por eso el trabajo del
 * worker casi siempre es una comparación de fechas y nada más: sin nada que anunciar
 * no se lee el nombre de la edición y no se toca la red.
 *
 * ## Un hito, un mensaje, y nada de ráfagas
 *
 * Cada hito sale **una sola vez** por edición, y la memoria lo garantiza. Un
 * recordatorio solo sale si `now` cae dentro de **su tramo**: entre su momento y el
 * del recordatorio siguiente más cercano (el de 7 días, entre «faltan 7» y «faltan
 * 3»; el de 1 día, entre «falta 1» y el propio cierre). Así, configurar el sistema a
 * mitad de edición **no** dispara de golpe los recordatorios cuyo tramo ya pasó —el
 * de comienzo, por ejemplo, si el torneo ya ha empezado—: solo sale el que
 * corresponde al tramo en el que estamos, y los siguientes cuando lleguen.
 *
 * ## La memoria, y cómo convive con la que ya había
 *
 * Vive en `Setting["edition.announcements"]`. Las dos marcas de siempre
 * (`startedAt`/`finishedAt`) **se conservan tal cual**: hay documentos escritos en
 * producción con esa forma y no se puede perder lo ya avisado ni volver a mandarlo.
 * Los hitos nuevos van en un mapa `sent` (clave de hito → instante), y hay una marca
 * más, `registrationWasOpen`, que dice si el plazo había estado abierto: es lo que
 * evita anunciar un cierre que nunca se abrió. El lector es tolerante, como manda la
 * casa: un valor que no se entiende se lee como "no se ha avisado", que como mucho
 * manda un aviso de más.
 *
 * ## Degradación
 *
 * Sin `DISCORD_BOT_TOKEN` o sin `DISCORD_ANNOUNCE_CHANNEL_ID` no se envía nada y la
 * pasada lo dice: el aviso queda **pendiente** (no se anota), así que configurar el
 * canal más tarde sigue dando el aviso que faltaba. Es el mismo criterio que la
 * detección de directos sin `YOUTUBE_API_KEY`. El motivo va al rastro en
 * `announceError`, que **no** mueve `lastSuccessAt`: no poder avisar no ha parado ni
 * una partida.
 *
 * ## La prueba del canal
 *
 * `sendTestAnnouncement()` es lo que el superadministrador usa para comprobar el canal
 * desde el panel. Manda el texto **real** del aviso que se pida, con el prefijo
 * `(Prueba)`, para que se vea cómo va a quedar y no solo que el token funciona. **No
 * toca la memoria**: una prueba no es el aviso del torneo y no puede impedir que el de
 * verdad salga.
 */

/** Clave de `Setting` donde vive la memoria de los avisos. */
export const EDITION_ANNOUNCEMENTS_KEY = "edition.announcements";

/** El aviso del comienzo y el del final, que ya existían. */
export type EditionAnnouncementKind = "start" | "end";

/**
 * Todos los hitos que pueden salir.
 *
 * Los recordatorios llevan la familia y el umbral (`start-7`), y el cierre de
 * inscripciones su propio valor. Es la clave con la que se anotan en la memoria, así
 * que el nombre de un hito y su marca no pueden divergir.
 */
export type AnnouncementMilestone =
  | EditionAnnouncementKind
  | "registration-close"
  | "registration-7"
  | "registration-3"
  | "registration-1"
  | "start-7"
  | "start-3"
  | "start-1"
  | "end-7"
  | "end-3"
  | "end-1";

/**
 * Qué avisos se han dado ya.
 *
 * `startedAt`/`finishedAt` son el instante en que se mandó el aviso de comienzo y el
 * de final, o `null`; no se guarda un booleano porque el instante permite responder
 * "¿cuándo se avisó?" sin cruzar el rastro de las pasadas —y porque ya estaba así—.
 *
 * `sent` guarda lo mismo para los hitos nuevos, y `registrationWasOpen` recuerda si
 * el plazo de inscripción llegó a estar abierto alguna vez: sin esa marca no se puede
 * distinguir "se cerró" de "nunca estuvo abierto", y un aviso de cierre de algo que
 * nunca abrió sería falso.
 */
export type EditionAnnouncementsMemory = {
  /** Instante del aviso de comienzo, o `null` si no se ha dado. */
  startedAt: string | null;
  /** Instante del aviso de final, o `null` si no se ha dado (o no toca: ventana abierta). */
  finishedAt: string | null;
  /** Hitos nuevos ya avisados: clave de hito → instante ISO-8601 en que se mandó. */
  sent: Record<string, string>;
  /** ¿El plazo de inscripción había estado abierto? */
  registrationWasOpen: boolean;
};

/** La memoria de una edición que no ha avisado nada todavía. */
export const EMPTY_ANNOUNCEMENTS: EditionAnnouncementsMemory = {
  startedAt: null,
  finishedAt: null,
  sent: {},
  registrationWasOpen: false,
};

/** Cliente con la única tabla que necesita la memoria (`db` o una `tx`). */
export type AnnouncementsClient = Pick<Prisma.TransactionClient, "setting">;

/* -------------------------------------------------------------------------- */
/* Lo que se puede probar sin base de datos                                    */
/* -------------------------------------------------------------------------- */

/** Un instante guardado, o `null`: cualquier otra cosa se descarta sin lanzar. */
function readInstantText(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Las marcas de los hitos nuevos, ya validadas.
 *
 * Cada entrada tiene que ser texto no vacío; lo que no lo sea se descarta sin tocar
 * las demás, porque una marca rota no dice nada de las otras.
 */
function readSentMarks(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }

  const marks: Record<string, string> = {};

  for (const [key, mark] of Object.entries(value)) {
    if (key !== "" && typeof mark === "string" && mark !== "") {
      marks[key] = mark;
    }
  }

  return marks;
}

/**
 * La memoria guardada, leída **sin lanzar**.
 *
 * Un valor que no se entiende se lee como "no se ha avisado": como mucho se manda un
 * aviso de más, que es preferible a callarse un aviso del torneo porque el documento
 * tenía otra forma. Es el mismo contrato que `mergeEditionConfig()`.
 */
export function parseAnnouncementsMemory(value: unknown): EditionAnnouncementsMemory {
  if (!isRecord(value)) {
    return { ...EMPTY_ANNOUNCEMENTS };
  }

  return {
    startedAt: readInstantText(value["startedAt"]),
    finishedAt: readInstantText(value["finishedAt"]),
    sent: readSentMarks(value["sent"]),
    registrationWasOpen: value["registrationWasOpen"] === true,
  };
}

/** Días de antelación de cada recordatorio, de más a menos. */
const REMINDER_DAYS = [7, 3, 1] as const;

const DAY_MS = 86_400_000;

/** ¿Ya se ha avisado este hito? Las dos marcas de siempre van aparte. */
function isAnnouncementSent(
  memory: EditionAnnouncementsMemory,
  milestone: AnnouncementMilestone,
): boolean {
  if (milestone === "start") {
    return memory.startedAt !== null;
  }

  if (milestone === "end") {
    return memory.finishedAt !== null;
  }

  return memory.sent[milestone] !== undefined;
}

/**
 * Los recordatorios de una fecha, con el tramo de cada uno.
 *
 * Cada recordatorio tiene su **momento** (`target − N días`) y su **tramo**: desde su
 * momento hasta el del recordatorio siguiente más cercano, y el de 1 día hasta la
 * propia fecha. Un recordatorio solo sale si `now` cae dentro de su tramo, que es lo
 * que hace que configurar el sistema con el tramo ya pasado no lo dispare: el de 7
 * días no vuelve a salir cuando solo faltan 5, pero el de 3 sí cuando lleguen.
 *
 * El tramo del último recordatorio termina en la fecha objetivo, así que pasado el
 * objetivo no sale ningún recordatorio: para entonces ya sale el aviso del hecho (el
 * comienzo, el final o el cierre).
 */
function dueReminders(
  family: "start" | "end" | "registration",
  target: Date,
  memory: EditionAnnouncementsMemory,
  now: Date,
): AnnouncementMilestone[] {
  if (Number.isNaN(target.getTime())) {
    return [];
  }

  const targetMs = target.getTime();
  const due: AnnouncementMilestone[] = [];

  for (let index = 0; index < REMINDER_DAYS.length; index += 1) {
    const days = REMINDER_DAYS[index];
    const nextDays = REMINDER_DAYS[index + 1] ?? 0;
    const moment = targetMs - days * DAY_MS;
    const tramoEnd = targetMs - nextDays * DAY_MS;

    if (now.getTime() < moment || now.getTime() >= tramoEnd) {
      continue;
    }

    const milestone = `${family}-${days}` as AnnouncementMilestone;

    if (!isAnnouncementSent(memory, milestone)) {
      due.push(milestone);
    }
  }

  return due;
}

/** Todo lo que necesita saber la decisión: la ventana, la fecha de cierre y el ahora. */
export type DueAnnouncementsInput = {
  /** Ventana del ruleset (`from` y `to`, con `to` opcional). */
  window: ScoringWindow;
  /** Fecha de cierre de inscripciones (ISO UTC), o `null` si no hay. */
  closesAt: string | null;
  /** ¿Está el plazo de inscripción abierto ahora mismo? (interruptor **y** fecha) */
  registrationOpen: boolean;
  memory: EditionAnnouncementsMemory;
  now: Date;
};

/**
 * Qué avisos tocan en este momento, en orden.
 *
 * Pura: entra la ventana, la fecha de cierre, el estado del plazo, la memoria y el
 * ahora, y sale la lista de hitos por dar. Ordena los avisos de hecho antes que los
 * recordatorios, y dentro de cada familia de más a menos antelación, que es como se
 * leen.
 *
 * El aviso de final no existe con la **ventana abierta** (`to: null`): no hay un
 * momento que cruzar. Y el de **cierre de inscripciones** solo sale si el plazo había
 * estado abierto (`registrationWasOpen`) y ahora está cerrado: por la fecha o porque
 * el interruptor se apagó, da igual; lo que no puede es anunciar el cierre de algo que
 * nunca abrió.
 */
export function dueAnnouncements(input: DueAnnouncementsInput): AnnouncementMilestone[] {
  const { window, memory, now } = input;
  const bounds = windowBounds(window);
  const due: AnnouncementMilestone[] = [];

  // Los de siempre: el comienzo y el final, al cruzar cada extremo.
  if (memory.startedAt === null && now.getTime() >= bounds.from.getTime()) {
    due.push("start");
  }

  if (bounds.to !== null && memory.finishedAt === null && now.getTime() >= bounds.to.getTime()) {
    due.push("end");
  }

  // Los recordatorios del torneo: antes de empezar y antes de terminar.
  due.push(...dueReminders("start", bounds.from, memory, now));

  if (bounds.to !== null) {
    due.push(...dueReminders("end", bounds.to, memory, now));
  }

  // Los de inscripciones: recordatorios antes del cierre y el cierre en sí. Los
  // recordatorios solo con el plazo abierto (con el interruptor apagado no hay «faltan
  // N días» que valga) y con fecha; el cierre no necesita fecha: el interruptor también
  // cierra.
  const closesAt = input.closesAt === null ? null : new Date(input.closesAt);

  if (input.registrationOpen && closesAt !== null) {
    due.push(...dueReminders("registration", closesAt, memory, now));
  }

  if (
    !input.registrationOpen &&
    memory.registrationWasOpen &&
    !isAnnouncementSent(memory, "registration-close")
  ) {
    due.push("registration-close");
  }

  return due;
}

/** "Queda 1 día o menos" o "Quedan N días o menos": el plural no es cosa de estilo. */
function quedanDias(days: number): string {
  return days === 1 ? "Queda 1 día o menos" : `Quedan ${days} días o menos`;
}

/**
 * El texto de un aviso, en español.
 *
 * Pura, y con el nombre de la edición y las fechas que la organización haya
 * publicado: un mensaje con fechas escritas a mano en el código dejaría de ser cierto
 * en cuanto movieran la ventana, que es justo lo que se puede hacer sin desplegar.
 *
 * Los recordatorios dicen "o menos" a propósito: el aviso sale en el tramo del
 * umbral, que puede empezar unos minutos después del momento exacto, así que redondear
 * a la baja prometería días que ya no quedan. La fecha de cierre solo se dice en los
 * avisos de inscripciones, que son los únicos que hablan de ella.
 */
export function announcementText(
  milestone: AnnouncementMilestone,
  editionName: string,
  window: ScoringWindow,
  closesAt: string | null,
): string {
  const periodo = formatTournamentWindow(window);

  switch (milestone) {
    case "start":
      return `${editionName}: empieza el torneo. ${periodo}. ¡Suerte a todos los participantes!`;
    case "end":
      return `${editionName}: el torneo ha terminado. ${periodo}. ¡Gracias a todos por jugar!`;
    case "registration-close":
      return `${editionName}: las inscripciones están cerradas.`;
    default:
      break;
  }

  const [, family, daysText] = milestone.match(/^(start|end|registration)-(\d)$/) ?? [];
  const days = Number(daysText);

  if (family === "registration") {
    const cierre = closesAt === null ? "" : ` (cierre el ${formatUtcDay(new Date(closesAt))})`;

    return `${editionName}: las inscripciones cierran pronto. ${quedanDias(days)}${cierre}.`;
  }

  if (family === "end") {
    return `${editionName}: el torneo termina pronto. ${periodo}. ${quedanDias(days)}.`;
  }

  return `${editionName}: el torneo empieza pronto. ${periodo}. ${quedanDias(days)}.`;
}

/**
 * El nombre de un hito para el mensaje de error del log.
 *
 * "No se ha podido avisar" necesita decir **de qué**, y un `start-7` no se lee. Vive
 * aquí, junto a `announcementText()`, para que los dos sitios que nombran un hito no
 * puedan desalinearse.
 */
function announcementLabel(milestone: AnnouncementMilestone): string {
  switch (milestone) {
    case "start":
      return "del comienzo del torneo";
    case "end":
      return "del final del torneo";
    case "registration-close":
      return "del cierre de inscripciones";
    default: {
      const [, family, days] = milestone.match(/^(start|end|registration)-(\d)$/) ?? [];
      const tema =
        family === "registration"
          ? "inscripciones"
          : family === "start"
            ? "comienzo del torneo"
            : "final del torneo";

      return `del recordatorio de ${days} días de ${tema}`;
    }
  }
}

/**
 * La memoria con un hito anotado como dado.
 *
 * Pura. Las dos marcas de siempre se escriben en su campo y las nuevas en `sent`, así
 * que el documento sigue teniendo la forma que ya tenía más los hitos nuevos.
 */
export function markAnnouncementSent(
  memory: EditionAnnouncementsMemory,
  milestone: AnnouncementMilestone,
  sentAt: string,
): EditionAnnouncementsMemory {
  if (milestone === "start") {
    return { ...memory, startedAt: sentAt };
  }

  if (milestone === "end") {
    return { ...memory, finishedAt: sentAt };
  }

  return { ...memory, sent: { ...memory.sent, [milestone]: sentAt } };
}

/**
 * Marca el plazo de inscripción como "estuvo abierto".
 *
 * Pura, e idempotente: si ya estaba marcado devuelve la misma memoria, para que quien
 * llama pueda comparar y no escribir la base por nada. Es lo que hace que
 * `dueAnnouncements()` pueda anunciar el cierre sin anunciar un cierre que nunca abrió.
 */
export function markRegistrationWasOpen(
  memory: EditionAnnouncementsMemory,
): EditionAnnouncementsMemory {
  return memory.registrationWasOpen ? memory : { ...memory, registrationWasOpen: true };
}

/* -------------------------------------------------------------------------- */
/* Memoria                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * La memoria de los avisos.
 *
 * Si nadie ha escrito la clave devuelve la memoria vacía **sin escribir nada**: leer no
 * debería modificar la base. Un fallo de la base **sí se propaga**, como en
 * `readEditionConfig()`: "no se ha avisado de nada" tiene su valor por defecto y "no se
 * ha podido leer" no.
 */
export async function readAnnouncementsMemory(
  client: AnnouncementsClient = db,
): Promise<EditionAnnouncementsMemory> {
  const setting = await client.setting.findUnique({
    where: { key: EDITION_ANNOUNCEMENTS_KEY },
  });

  return setting === null ? { ...EMPTY_ANNOUNCEMENTS } : parseAnnouncementsMemory(setting.value);
}

/**
 * Anota el estado de la memoria.
 *
 * Se escribe **después** de que el mensaje haya salido (o al marcar que el plazo
 * estuvo abierto), y por eso una marca puesta significa de verdad que el aviso se
 * mandó. `upsert` para que la primera edición no necesite que nadie cree la fila.
 */
export async function writeAnnouncementsMemory(
  memory: EditionAnnouncementsMemory,
  client: AnnouncementsClient = db,
): Promise<void> {
  const value: Prisma.InputJsonObject = {
    startedAt: memory.startedAt,
    finishedAt: memory.finishedAt,
    sent: memory.sent,
    registrationWasOpen: memory.registrationWasOpen,
  };

  await client.setting.upsert({
    where: { key: EDITION_ANNOUNCEMENTS_KEY },
    create: { key: EDITION_ANNOUNCEMENTS_KEY, value },
    update: { value },
  });
}

/* -------------------------------------------------------------------------- */
/* Envío                                                                       */
/* -------------------------------------------------------------------------- */

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : `Error desconocido: ${String(error)}`;
}

/**
 * Manda un mensaje al canal de avisos.
 *
 * Es la única llamada de este módulo, y por eso no hay un cliente propio: reutiliza el
 * de `discord/http.ts`, que ya sabe de la base de la API, del `User-Agent` y del
 * timeout, y que **no reintenta** —una pasada del worker cada cinco minutos es un
 * reintento mucho mejor que tres seguidos dentro de la misma invocación—.
 *
 * El `content` va como JSON y nunca lleva el token: el cliente ya deja el token en la
 * cabecera y no lo escribe en ningún mensaje de error.
 *
 * Es **exportada** porque el informe diario de clasificación
 * (`src/lib/standings-report.ts`) manda al mismo canal y con la misma forma: tener la
 * petición definida una vez evita que un cambio en una de las dos se olvide en la otra.
 */
export async function postChannelMessage(
  client: DiscordHttpClient,
  config: DiscordConfig & { botToken: string; announceChannelId: string },
  content: string,
): Promise<void> {
  await client.request("POST", `/channels/${config.announceChannelId}/messages`, {
    authorization: `Bot ${config.botToken}`,
    json: { content },
  });
}

/** Lo que ha pasado con los avisos en una pasada del worker. */
export type AnnounceRunResult = {
  /** Avisos enviados, en orden. Vacío cuando no tocaba ninguno o no se pudo enviar. */
  sent: AnnouncementMilestone[];
  /**
   * Por qué no se ha podido avisar, o `null`. Va al rastro de la pasada
   * (`announceError`) y **no** mueve `lastSuccessAt`, como `discordError`.
   */
  error: string | null;
};

/**
 * El paso del worker: manda los avisos que toquen y anota los que hayan salido.
 *
 * **Nunca lanza por Discord.** Un fallo del envío sale en `error` con los avisos que sí
 * se mandaron ya anotados, y el que falló queda pendiente para la siguiente pasada. Un
 * fallo de la **base** sí se propaga: quien llama (el sincronizador) lo recoge y lo
 * deja en el rastro, porque sin poder leer la ventana no hay nada que decidir.
 *
 * Sin nada que anunciar sale antes de leer el nombre de la edición y sin crear ningún
 * cliente HTTP: en las ~288 pasadas diarias este paso es la ventana, la fecha de
 * cierre, la memoria y una comparación de fechas. Cuando lo único que cambia es que el
 * plazo ha estado abierto (para poder anunciar su cierre más tarde), se anota la marca
 * y se sale sin mensaje.
 */
export async function announceEditionWindow(
  options: { config?: DiscordConfig; now?: Date } = {},
): Promise<AnnounceRunResult> {
  const config = options.config ?? getDiscordConfig();
  const now = options.now ?? new Date();

  if (!isDiscordAnnounceConfigured(config)) {
    return {
      sent: [],
      error:
        "Sin DISCORD_BOT_TOKEN o DISCORD_ANNOUNCE_CHANNEL_ID no se avisa de la edición en Discord.",
    };
  }

  let memory = await readAnnouncementsMemory();
  const { window } = await readRuleset();
  const registration = await readRegistrationState();

  // Si el plazo está abierto, se anota que lo estuvo. Es lo que permitirá anunciar su
  // cierre más tarde sin anunciar un cierre que nunca se abrió. Se hace aquí, antes de
  // decidir, y se escribe aunque no toque ningún aviso: es memoria, no un mensaje.
  const conMarca = registration.open ? markRegistrationWasOpen(memory) : memory;
  const marcaCambia = conMarca !== memory;
  memory = conMarca;

  const due = dueAnnouncements({
    window,
    closesAt: registration.closesAt,
    registrationOpen: registration.open,
    memory,
    now,
  });

  if (due.length === 0) {
    if (marcaCambia) {
      await writeAnnouncementsMemory(memory);
    }

    return { sent: [], error: null };
  }

  const edition = await readEditionConfig();
  const client = createDiscordHttpClient(config);
  const sent: AnnouncementMilestone[] = [];

  for (const milestone of due) {
    try {
      await postChannelMessage(
        client,
        config,
        announcementText(milestone, edition.name, window, registration.closesAt),
      );
    } catch (error) {
      // La marca del plazo abierto ya se ha decidido y se guarda aunque el envío falle:
      // no es el resultado de un mensaje, es el estado del plazo, y perderla sería no
      // poder anunciar el cierre después.
      if (marcaCambia) {
        await writeAnnouncementsMemory(memory);
      }

      return {
        sent,
        error: `No se ha podido avisar ${announcementLabel(milestone)}: ${toErrorMessage(error)}`,
      };
    }

    // Se anota **cada uno** en cuanto sale, y no todos al final: si el siguiente falla,
    // los que ya salieron están dichos y no pueden volver a salir en la siguiente pasada.
    memory = markAnnouncementSent(memory, milestone, now.toISOString());

    await writeAnnouncementsMemory(memory);
    sent.push(milestone);
  }

  return { sent, error: null };
}

/* -------------------------------------------------------------------------- */
/* Prueba desde el panel                                                       */
/* -------------------------------------------------------------------------- */

export type TestAnnouncementResult =
  | { status: "success"; message: string }
  | { status: "error"; message: string };

/**
 * Manda un aviso de prueba al canal, para comprobarlo desde el panel.
 *
 * Manda el texto real del aviso pedido con el prefijo `(Prueba)`: así lo que se ve en
 * el canal es cómo va a quedar el mensaje de verdad, con el nombre y las fechas de la
 * edición, y no un "hola" que solo prueba que el token vale. **No anota nada** en la
 * memoria: una prueba no es el aviso del torneo y no puede impedir que el de verdad
 * salga.
 *
 * El motivo del fallo se queda en el log del servidor y a quien lo pulsó solo le llega
 * que no se ha podido: es el mismo reparto que el resto del panel.
 */
export async function sendTestAnnouncement(
  kind: EditionAnnouncementKind,
  options: { config?: DiscordConfig } = {},
): Promise<TestAnnouncementResult> {
  const config = options.config ?? getDiscordConfig();

  if (!isDiscordAnnounceConfigured(config)) {
    return {
      status: "error",
      message:
        "No se puede enviar: falta DISCORD_BOT_TOKEN o DISCORD_ANNOUNCE_CHANNEL_ID en la configuración del despliegue.",
    };
  }

  const { window } = await readRuleset();
  const edition = await readEditionConfig();
  const registration = await readRegistrationState();

  try {
    await postChannelMessage(
      createDiscordHttpClient(config),
      config,
      `(Prueba) ${announcementText(kind, edition.name, window, registration.closesAt)}`,
    );
  } catch (error) {
    console.error(
      `[discord] No se ha podido enviar el aviso de prueba: ${toErrorMessage(error)}`,
    );

    return {
      status: "error",
      message: "No se ha podido enviar el aviso. El motivo está en el log del servidor.",
    };
  }

  return {
    status: "success",
    message: `Aviso de ${kind === "start" ? "comienzo" : "final"} enviado al canal. No se ha anotado como enviado: es una prueba.`,
  };
}
