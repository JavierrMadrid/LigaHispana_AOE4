import "server-only";

import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import {
  getDiscordConfig,
  isDiscordAnnounceConfigured,
  type DiscordConfig,
} from "@/lib/discord/env";
import { createDiscordHttpClient } from "@/lib/discord/http";
import { readEditionConfig } from "@/lib/edition";
// `postChannelMessage` es la misma petición que usan los avisos de la edición: el
// informe va al mismo canal y con la misma forma, así que la definición es una sola.
import { postChannelMessage } from "@/lib/edition-announcements";
import { isRecord } from "@/lib/json";
import { getStandings } from "@/lib/public";
import { readPublicOrigin } from "@/lib/site-url";

/**
 * El informe diario de clasificación del bot (issue 56, fase 3).
 *
 * ## Qué es
 *
 * Una vez al día, en la **primera pasada del worker a partir de las 21:00 de Madrid**,
 * el bot publica en el canal de avisos (`DISCORD_ANNOUNCE_CHANNEL_ID`) la clasificación
 * entera del torneo y un enlace a la web. La fuente es `getStandings()`, la misma que ve
 * la web: montar aquí otra consulta sería una segunda definición de la clasificación.
 *
 * El enlace apunta a la **portada** (`/`), que es donde vive la clasificación.
 *
 * ## Lo barato primero
 *
 * La mayoría de las ~288 pasadas diarias no tocan informe, así que el paso mira primero
 * el reloj de Madrid y la memoria y solo lee la clasificación y la edición cuando hoy
 * **puede** tocar (ver `reportMayRunToday()`). En una pasada normal el coste es una
 * lectura de `Setting` y una comparación.
 *
 * ## Por qué es un módulo propio
 *
 * Aunque comparta canal y `announceError` con `edition-announcements.ts`, su cadencia no
 * es la de la edición: aquellos avisos salen una vez por hito, y este sale **todos los
 * días**. Mezclar los dos estados en la misma memoria (o el mismo módulo) haría que un
 * documento que ya describe hitos de toda una edición cargase además el cursor diario de
 * un informe que se repite. Por eso la memoria vive en su propia clave de `Setting`
 * (`discord.standingsReport`, al lado de `discord.participantRole`) y el módulo tiene su
 * propia decisión pura y prueba.
 *
 * ## Una vez por día de Madrid, y nada de ráfagas
 *
 * El «día» es el día **natural de Madrid** (`Europe/Madrid`), y el informe toca en la
 * primera pasada con la hora de Madrid `>= 21`. No se calcula el instante exacto de las
 * 21:00: se lee la **hora local** de Madrid, que es equivalente para «¿ya son las 21:00
 * del día en curso?» y no arrastra cuentas de cambio de hora.
 *
 * Si la pasada de las 21:00 no ocurre —el worker caído, un despliegue—, al día siguiente
 * a las 00:30 la hora de Madrid es 0, así que **no** se manda un informe atrasado de un
 * día que ya pasó: se salta ese día y se informa del siguiente cuando llegue su hora.
 *
 * ## Troceado y reanudación
 *
 * Un mensaje de Discord son 2000 caracteres, y la clasificación entera puede no caber,
 * así que el informe se parte en varios mensajes **por líneas**, sin cortar ninguna por
 * la mitad (ver `buildStandingsReportMessages()`). El estado de envío va en la memoria:
 * `pendingDay` es el día cuyo informe está a medias, `sentChunks` cuántos trozos ya
 * salieron y `lastDay` el día del último informe **completo**. Si un trozo falla, lo que
 * queda se retoma en la pasada siguiente desde donde se quedó, sin repetir lo ya enviado;
 * cuando sale el último, `lastDay` se fija y ya no se vuelve a informar de ese día.
 *
 * ## Vacío y degradación
 *
 * Sin ninguna fila clasificada **no hay informe** (ni un mensaje diciendo que no hay
 * nada): no es un fallo. Si justo este día había un informe a medias y la clasificación se
 * ha vaciado del todo, el día se **cierra sin mandar nada** para no dejarlo colgado. Sin
 * token o canal no se envía nada y tampoco es un fallo —el aviso de configuración lo da
 * `announceEditionWindow()`, en el mismo canal, así que aquí no se repite—. Un fallo de
 * Discord o de la base sale en `error`, va al rastro `announceError` y **no** mueve
 * `lastSuccessAt`, como el resto de mensajes al canal.
 *
 * ## El enlace
 *
 * El dominio sale de `readPublicOrigin()`, la misma fuente que el layout
 * (`src/lib/site-url.ts`). Sin dominio configurado devuelve `null` y el informe sale
 * **sin enlace** en vez de con un `localhost` que no lleva a ninguna parte.
 */

/** Clave de `Setting` donde vive la memoria del informe diario. */
export const STANDINGS_REPORT_KEY = "discord.standingsReport";

/**
 * Hora de Madrid (0-23) a partir de la cual toca el informe del día: las 21:00.
 *
 * Es una hora local, no un instante: «ya son las 21:00 de hoy» es exactamente
 * `horaMadrid(now) >= 21`, que no necesita ninguna cuenta de zona horaria.
 */
export const STANDINGS_REPORT_HOUR = 21;

/**
 * Límite de caracteres de un mensaje de Discord.
 *
 * Discord rechaza con 400 los mensajes de más de 2000 caracteres, así que el troceado
 * usa el mismo número que impone el servicio y no uno propio.
 */
export const DISCORD_MESSAGE_LIMIT = 2000;

/**
 * La memoria del informe diario.
 *
 * - `lastDay`: el día de Madrid (`YYYY-MM-DD`) del último informe **completo**. Es lo
 *   que impide informar dos veces del mismo día.
 * - `pendingDay` / `sentChunks`: el día cuyo informe quedó a medias y cuántos trozos ya
 *   salieron. Es lo que permite reanudarlo sin repetir.
 */
export type StandingsReportMemory = {
  lastDay: string | null;
  pendingDay: string | null;
  sentChunks: number;
};

/** La memoria de un informe que nunca se ha enviado. */
export const EMPTY_STANDINGS_REPORT_MEMORY: StandingsReportMemory = {
  lastDay: null,
  pendingDay: null,
  sentChunks: 0,
};

/** Una fila del informe: lo mínimo para pintar la línea y nada más. */
export type StandingsReportRow = {
  rank: number;
  name: string;
  points: number;
};

/* -------------------------------------------------------------------------- */
/* Lo que se puede probar sin base de datos                                    */
/* -------------------------------------------------------------------------- */

/** Un día de Madrid como `YYYY-MM-DD`, o `null` si el texto no tiene esa forma. */
function readDay(value: unknown): string | null {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

/**
 * La memoria guardada, leída **sin lanzar**.
 *
 * Un documento que no se entiende se lee como «no se ha informado»: como mucho, se
 * manda un informe de más, que es preferible a callarse la clasificación de un día por
 * un documento con otra forma. Un `sentChunks` que no es un entero no negativo se lee
 * como 0, que es lo que hace que el informe se reintente desde el principio en vez de
 * saltarse trozos que no se sabe si salieron.
 */
export function parseStandingsReportMemory(value: unknown): StandingsReportMemory {
  if (!isRecord(value)) {
    return { ...EMPTY_STANDINGS_REPORT_MEMORY };
  }

  const sentChunks = value["sentChunks"];

  return {
    lastDay: readDay(value["lastDay"]),
    pendingDay: readDay(value["pendingDay"]),
    sentChunks:
      typeof sentChunks === "number" && Number.isInteger(sentChunks) && sentChunks > 0
        ? sentChunks
        : 0,
  };
}

const MADRID_CLOCK = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Madrid",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
});

/**
 * El reloj de Madrid tal y como lo necesita la decisión: el día y la hora.
 *
 * Se lee con `Intl` sobre `Europe/Madrid` y no con aritmética de zona horaria: el
 * resultado lleva el cambio de hora resuelto por el propio runtime, así que un día de
 * cambio de hora no puede desviar el «día» ni la hora. `now` entra por parámetro para
 * que la función sea pura y se pruebe sin temporizadores reales.
 */
export function madridReportClock(now: Date): { day: string; hour: number } {
  const parts = MADRID_CLOCK.formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";

  return { day: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) };
}

/** La decisión del informe: mandar desde un trozo, cerrar el día sin mandar, o nada. */
export type DailyReportPlan =
  | { kind: "send"; day: string; startChunk: number }
  | { kind: "finalize"; day: string };

/**
 * ¿Puede tocar el informe **hoy**? La criba barata, antes de leer la clasificación.
 *
 * Es lo primero que mira el paso del worker, y no necesita nada de la base salvo la
 * memoria: si devuelve `false`, la pasada termina sin leer la clasificación, la edición
 * ni crear ningún cliente HTTP. Es lo que hace que las ~288 pasadas diarias que no tocan
 * informe cuesten una lectura de `Setting` y una comparación.
 *
 * Es **conservadora**: devuelve `true` siempre que `dailyReportPlan()` pudiera devolver
 * algo, para no saltarse nunca un envío. En concreto:
 *
 * - Un informe de hoy a medias (`pendingDay` = hoy) siempre puede tocar: hay que
 *   reanudarlo o cerrarlo, sea la hora que sea.
 * - Si hoy ya está completo (`lastDay` = hoy), no toca.
 * - Si no, solo a partir de las 21:00 de Madrid.
 *
 * El `false` de un día ya informado gana al `pendingDay` solo porque no pueden
 * convivir: cerrar el día deja `pendingDay` a `null`.
 */
export function reportMayRunToday(
  clock: { day: string; hour: number },
  memory: StandingsReportMemory,
): boolean {
  if (memory.pendingDay === clock.day) {
    return true;
  }

  if (memory.lastDay === clock.day) {
    return false;
  }

  return clock.hour >= STANDINGS_REPORT_HOUR;
}

/**
 * Qué hacer con el informe en esta pasada.
 *
 * | Estado | Decisión |
 * |---|---|
 * | El informe de hoy quedó a medias (`pendingDay` = hoy) y faltan trozos | `send`, desde `sentChunks` |
 * | El informe de hoy quedó a medias y ya no faltan trozos (la clasificación se vació) | `finalize` |
 * | Hoy ya se informó (`lastDay` = hoy) | `null` |
 * | No quedan filas | `null` (sin informe, y no es un fallo) |
 * | Aún no son las 21:00 de Madrid | `null` |
 * | Cualquier otro caso, a partir de las 21:00 | `send`, desde el trozo 0 |
 *
 * Es la decisión **completa**: se le llama solo cuando `reportMayRunToday()` ya ha dicho
 * que hoy puede tocar, y por eso necesita el número de trozos (que sale de la
 * clasificación). Un `pendingDay` de **otro** día se ignora: un informe a medias de ayer
 * no se retoma hoy (sería un informe atrasado), y arrancar el de hoy lo sobrescribe.
 */
export function dailyReportPlan(input: {
  now: Date;
  memory: StandingsReportMemory;
  chunkCount: number;
}): DailyReportPlan | null {
  const { day, hour } = madridReportClock(input.now);

  if (input.memory.pendingDay === day) {
    if (input.chunkCount > 0 && input.memory.sentChunks < input.chunkCount) {
      return { kind: "send", day, startChunk: input.memory.sentChunks };
    }

    return { kind: "finalize", day };
  }

  if (input.memory.lastDay === day || input.chunkCount === 0 || hour < STANDINGS_REPORT_HOUR) {
    return null;
  }

  return { kind: "send", day, startChunk: 0 };
}

const REPORT_DAY = new Intl.DateTimeFormat("es-ES", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

/**
 * La fecha del informe en español: «14 de octubre de 2026».
 *
 * `day` es un `YYYY-MM-DD` de Madrid, así que se interpreta a mediodía UTC y se formatea
 * en UTC: así el día no se desplaza por la zona del proceso, y la fecha que se lee es la
 * del informe.
 */
export function standingsReportDateLabel(day: string): string {
  return REPORT_DAY.format(new Date(`${day}T12:00:00.000Z`));
}

/**
 * El informe partido en mensajes de Discord.
 *
 * Una línea por fila, con `puesto. nombre — N pts`, y la cabecera y el enlace como
 * líneas propias. El troceado es **codicioso y por líneas**: se van acumulando hasta
 * que añadir la siguiente pasaría del límite, y entonces se cierra el mensaje y se
 * empieza otro. Nunca se parte una línea por la mitad, así que una línea
 * patológicamente larga (un nombre enorme) sale sola en su mensaje en vez de troceada —
 * Discord la rechazará igual, pero el problema es del nombre, no de este módulo.
 *
 * Sin filas **no hay mensaje**: devuelve `[]`, y quien llama no envía nada (ni un
 * «no hay nadie» que no es lo que se pidió). El resultado es determinista para unas
 * filas dadas, que es lo que hace que la reanudación por índice (`sentChunks`) apunte al
 * mismo trozo entre pasadas.
 */
export function buildStandingsReportMessages(input: {
  editionName: string;
  day: string;
  rows: readonly StandingsReportRow[];
  url: string | null;
  limit?: number;
}): string[] {
  if (input.rows.length === 0) {
    return [];
  }

  const limit = input.limit ?? DISCORD_MESSAGE_LIMIT;
  const lines = [
    `${input.editionName}: clasificación del ${standingsReportDateLabel(input.day)}.`,
    ...input.rows.map((row) => `${row.rank}. ${row.name} — ${row.points} pts`),
    ...(input.url === null ? [] : [`Clasificación completa en la web: ${input.url}`]),
  ];

  const messages: string[] = [];
  let current = "";

  for (const line of lines) {
    const candidate = current === "" ? line : `${current}\n${line}`;

    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }

    if (current !== "") {
      messages.push(current);
    }

    current = line;
  }

  if (current !== "") {
    messages.push(current);
  }

  return messages;
}

/* -------------------------------------------------------------------------- */
/* Memoria                                                                     */
/* -------------------------------------------------------------------------- */

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : `Error desconocido: ${String(error)}`;
}

/** La memoria guardada, o la vacía si no hay fila. */
async function readMemory(): Promise<StandingsReportMemory> {
  const setting = await db.setting.findUnique({ where: { key: STANDINGS_REPORT_KEY } });

  return setting === null
    ? { ...EMPTY_STANDINGS_REPORT_MEMORY }
    : parseStandingsReportMemory(setting.value);
}

/** Guarda la memoria. (`upsert` para que la primera edición no necesite crear la fila.) */
async function writeMemory(memory: StandingsReportMemory): Promise<void> {
  const value = JSON.parse(JSON.stringify(memory)) as Prisma.InputJsonObject;

  await db.setting.upsert({
    where: { key: STANDINGS_REPORT_KEY },
    create: { key: STANDINGS_REPORT_KEY, value },
    update: { value },
  });
}

/* -------------------------------------------------------------------------- */
/* El paso del worker                                                          */
/* -------------------------------------------------------------------------- */

/** Lo que ha pasado con el informe en una pasada del worker. */
export type StandingsReportRunResult = {
  /** Mensajes enviados en esta pasada. `0` también cuando no tocaba o no había filas. */
  sent: number;
  /**
   * Por qué no se ha podido enviar, o `null`. Va al rastro `announceError` y **no** mueve
   * `lastSuccessAt`, como el resto de mensajes al canal.
   */
  error: string | null;
};

/**
 * El paso del worker: manda el informe diario de clasificación si toca.
 *
 * **Nunca lanza.** Un fallo de la base al leer la clasificación o de Discord al enviar se
 * resume en `error` y lo demás sigue; el progreso de los trozos ya enviados queda
 * anotado para retomarlo en la siguiente pasada.
 *
 * ## El orden: primero lo barato
 *
 * La mayoría de las ~288 pasadas diarias no tocan informe, así que antes de leer nada
 * caro se miran el reloj de Madrid y la memoria, y `reportMayRunToday()` decide si hoy
 * puede tocar. Solo entonces se leen la clasificación (`getStandings()`) y la edición, se
 * trocea y se llama a `dailyReportPlan()` para la decisión fina. En una pasada normal el
 * coste es una lectura de `Setting` y una comparación, sin crear ningún cliente HTTP.
 *
 * Sin configurar, fuera de la hora o con el día ya informado, devuelve `{ sent: 0, error:
 * null }`. Sin filas clasificadas tampoco hay informe, y no es un fallo. Cuando ya tocaba
 * y todo salió, deja el día anotado como completo.
 */
export async function announceDailyStandings(
  options: { config?: DiscordConfig; now?: Date } = {},
): Promise<StandingsReportRunResult> {
  const config = options.config ?? getDiscordConfig();
  const now = options.now ?? new Date();

  // Sin canal ni token no hay informe, y no es un fallo: el aviso de configuración lo da
  // `announceEditionWindow()`, que manda al mismo canal, así que aquí no se repite.
  if (!isDiscordAnnounceConfigured(config)) {
    return { sent: 0, error: null };
  }

  // **Lo barato primero**: el reloj de Madrid y la memoria son una comparación y una
  // lectura de `Setting`. Si hoy no puede tocar el informe, la pasada termina aquí sin
  // leer la clasificación, la edición ni crear el cliente HTTP.
  const clock = madridReportClock(now);
  const memory = await readMemory();

  if (!reportMayRunToday(clock, memory)) {
    return { sent: 0, error: null };
  }

  let standings: Awaited<ReturnType<typeof getStandings>>;

  try {
    standings = await getStandings();
  } catch (error) {
    // `getStandings()` ya degrada los fallos de base, pero por si acaso se protege igual:
    // el informe no puede tumbar la pasada.
    return {
      sent: 0,
      error: `No se ha podido leer la clasificación para el informe diario de Discord: ${toErrorMessage(error)}`,
    };
  }

  if (standings.status !== "ok") {
    return {
      sent: 0,
      error: "No se ha podido leer la clasificación para el informe diario de Discord.",
    };
  }

  const rows = standings.data.rows;

  // Sin filas no hay informe: ni un mensaje, ni un fallo. Pero si hoy había un informe a
  // medias (la clasificación se ha vaciado del todo entre pasadas), se cierra el día sin
  // mandar nada, con la misma marca que el `finalize` de abajo.
  if (rows.length === 0) {
    if (memory.pendingDay === clock.day) {
      await writeMemory({ lastDay: clock.day, pendingDay: null, sentChunks: 0 });
    }

    return { sent: 0, error: null };
  }

  const edition = await readEditionConfig();
  const origin = readPublicOrigin();
  const messages = buildStandingsReportMessages({
    editionName: edition.name,
    day: clock.day,
    rows: rows.map((row) => ({ rank: row.rank, name: row.name, points: row.points })),
    // La clasificación es la portada, así que el enlace es la raíz del sitio.
    url: origin === null ? null : `${origin}/`,
  });

  const plan = dailyReportPlan({ now, memory, chunkCount: messages.length });

  if (plan === null) {
    return { sent: 0, error: null };
  }

  // El informe de hoy quedó a medias y la clasificación **encogió** entre pasadas: ahora
  // salen menos trozos de los que ya se enviaron, así que no queda nada por mandar y el
  // día se cierra igual. (El caso de cero filas se resolvió antes, sin llegar hasta aquí.)
  if (plan.kind === "finalize") {
    await writeMemory({ lastDay: plan.day, pendingDay: null, sentChunks: 0 });

    return { sent: 0, error: null };
  }

  const client = createDiscordHttpClient(config);
  let sent = 0;

  for (let index = plan.startChunk; index < messages.length; index += 1) {
    try {
      await postChannelMessage(client, config, messages[index]);
    } catch (error) {
      // Lo que ya salió está anotado (se guarda tras cada envío), así que la siguiente
      // pasada retoma desde aquí sin repetirlo.
      return {
        sent,
        error: `No se ha podido enviar el informe diario de la clasificación: ${toErrorMessage(error)}`,
      };
    }

    sent += 1;

    await writeMemory({ lastDay: memory.lastDay, pendingDay: plan.day, sentChunks: index + 1 });
  }

  // Último trozo fuera: el día queda cerrado y no se vuelve a informar de él.
  await writeMemory({ lastDay: plan.day, pendingDay: null, sentChunks: 0 });

  return { sent, error: null };
}
