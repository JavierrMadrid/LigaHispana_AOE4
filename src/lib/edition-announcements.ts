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
import { formatTournamentWindow } from "@/lib/format";
import { isRecord } from "@/lib/json";
import { windowBounds, type ScoringWindow } from "@/lib/ranked-match";
import { readRuleset } from "@/lib/scoring";

/**
 * Los avisos del torneo en Discord: el comienzo y el final.
 *
 * ## Qué avisa, y cuándo
 *
 * El worker, en su pasada, mira la **ventana del torneo**
 * (`Setting["scoring.ruleset"].window`) y manda un mensaje a un canal cuando cruza cada
 * extremo: uno al empezar (`window.from`) y otro al terminar (`window.to`, si la
 * ventana tiene fin). Son dos avisos en toda la vida de una edición, y por eso el
 * trabajo del worker casi siempre es una comparación de fechas y nada más: sin nada que
 * anunciar no se lee el nombre de la edición y no se toca la red.
 *
 * ## Nunca repite
 *
 * La memoria vive en `Setting["edition.announcements"]`: dos marcas, una por aviso, con
 * el instante en que se mandó. Una marca puesta **no se quita nunca**, ni aunque la
 * ventana se mueva: si la organización alarga el torneo o cambia las fechas, el aviso
 * de comienzo ya se dio y volver a darlo sería mentir dos veces. Por eso la memoria es
 * monotónica y el lector es tolerante: un valor que no se entiende se lee como "no se
 * ha avisado", que es la dirección segura —como mucho, un aviso de más—.
 *
 * Lo que **no** se anota es lo que no se ha podido enviar: sin token o sin canal el
 * aviso queda pendiente (y el rastro de la pasada lo dice en `announceError`), y un
 * fallo de la API tampoco marca nada. Así, configurar el canal más tarde sigue dando el
 * aviso que faltaba.
 *
 * ## Degradación
 *
 * Sin `DISCORD_BOT_TOKEN` o sin `DISCORD_ANNOUNCE_CHANNEL_ID` no se envía nada y la
 * pasada lo dice: es el mismo criterio que la detección de directos sin
 * `YOUTUBE_API_KEY`, y por el mismo motivo —el proyecto tiene que arrancar y funcionar
 * sin configurar nada nuevo—. El motivo va al rastro en `announceError`, que **no**
 * mueve `lastSuccessAt`: no poder avisar no ha parado ni una partida.
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

/** Los dos avisos que existen. */
export type EditionAnnouncementKind = "start" | "end";

/**
 * Qué avisos se han dado ya.
 *
 * Cada marca es el instante en que se mandó, o `null` si todavía no. No se guarda un
 * booleano porque el instante es lo que permite responder "¿cuándo se avisó?" sin
 * cruzar el rastro de las pasadas.
 */
export type EditionAnnouncementsMemory = {
  /** Instante del aviso de comienzo, o `null` si no se ha dado. */
  startedAt: string | null;
  /** Instante del aviso de final, o `null` si no se ha dado (o no toca: ventana abierta). */
  finishedAt: string | null;
};

/** La memoria de una edición que no ha avisado nada todavía. */
export const EMPTY_ANNOUNCEMENTS: EditionAnnouncementsMemory = {
  startedAt: null,
  finishedAt: null,
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
  };
}

/**
 * Qué avisos tocan en este momento.
 *
 * Pura: entra la ventana, la memoria y el ahora, y sale la lista de avisos por dar, en
 * orden. Un aviso toca cuando su instante ya ha pasado (`>=`, porque los dos extremos
 * de la ventana son instantes y el de inicio es inclusivo) y su marca sigue vacía.
 *
 * Con la ventana **abierta** (`to: null`) el aviso de final no existe: no hay un
 * momento que cruzar. Y si los dos extremos han quedado atrás —una edición configurada
 * con fechas ya pasadas— tocan los dos, en orden; es lo que dice la ventana, y la
 * memoria evita que vuelvan a salir.
 */
export function dueAnnouncements(
  window: ScoringWindow,
  memory: EditionAnnouncementsMemory,
  now: Date,
): EditionAnnouncementKind[] {
  const bounds = windowBounds(window);
  const due: EditionAnnouncementKind[] = [];

  if (memory.startedAt === null && now.getTime() >= bounds.from.getTime()) {
    due.push("start");
  }

  if (bounds.to !== null && memory.finishedAt === null && now.getTime() >= bounds.to.getTime()) {
    due.push("end");
  }

  return due;
}

/**
 * El texto del aviso, en español.
 *
 * Pura, y con el nombre de la edición y las fechas que la organización haya publicado:
 * un mensaje con fechas escritas a mano en el código dejaría de ser cierto en cuanto
 * movieran la ventana, que es justo lo que se puede hacer sin desplegar.
 */
export function announcementText(
  kind: EditionAnnouncementKind,
  editionName: string,
  window: ScoringWindow,
): string {
  const periodo = formatTournamentWindow(window);

  return kind === "start"
    ? `${editionName}: empieza el torneo. ${periodo}. ¡Suerte a todos los participantes!`
    : `${editionName}: el torneo ha terminado. ${periodo}. ¡Gracias a todos por jugar!`;
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
 * Anota un aviso como dado.
 *
 * Se escribe **después** de que el mensaje haya salido, y por eso una marca puesta
 * significa de verdad que el aviso se mandó. `upsert` para que la primera edición no
 * necesite que nadie cree la fila.
 */
export async function writeAnnouncementsMemory(
  memory: EditionAnnouncementsMemory,
  client: AnnouncementsClient = db,
): Promise<void> {
  const value: Prisma.InputJsonObject = {
    startedAt: memory.startedAt,
    finishedAt: memory.finishedAt,
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
 */
async function postAnnouncement(
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
  sent: EditionAnnouncementKind[];
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
 * cliente HTTP: en las ~288 pasadas diarias este paso es la ventana, la memoria y una
 * comparación de fechas.
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
        "Sin DISCORD_BOT_TOKEN o DISCORD_ANNOUNCE_CHANNEL_ID no se avisa del comienzo y el final del torneo en Discord.",
    };
  }

  let memory = await readAnnouncementsMemory();
  const { window } = await readRuleset();
  const due = dueAnnouncements(window, memory, now);

  if (due.length === 0) {
    return { sent: [], error: null };
  }

  const edition = await readEditionConfig();
  const client = createDiscordHttpClient(config);
  const sent: EditionAnnouncementKind[] = [];

  for (const kind of due) {
    try {
      await postAnnouncement(client, config, announcementText(kind, edition.name, window));
    } catch (error) {
      return {
        sent,
        error: `No se ha podido avisar del ${kind === "start" ? "comienzo" : "final"} del torneo: ${toErrorMessage(error)}`,
      };
    }

    // Se anota **cada uno** en cuanto sale, y no los dos al final: si el segundo falla,
    // el primero ya está dicho y no puede volver a salir en la siguiente pasada.
    memory =
      kind === "start"
        ? { ...memory, startedAt: now.toISOString() }
        : { ...memory, finishedAt: now.toISOString() };

    await writeAnnouncementsMemory(memory);
    sent.push(kind);
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
 * Manda el texto real del aviso pedido con el prefijo `(Prueba)`: así lo que se ve en el
 * canal es cómo va a quedar el mensaje de verdad, con el nombre y las fechas de la
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

  try {
    await postAnnouncement(
      createDiscordHttpClient(config),
      config,
      `(Prueba) ${announcementText(kind, edition.name, window)}`,
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
