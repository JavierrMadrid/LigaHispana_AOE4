import "server-only";

import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { isRecord } from "@/lib/json";
import { parseRegistrationOpen, REGISTRATION_OPEN_KEY } from "@/lib/registration-open";

/**
 * Lectura y escritura de la tabla `Setting`.
 *
 * `Setting` es la configuración del torneo y también la memoria del worker: hasta
 * qué fecha se le pidió a la API por cada jugador. Se centraliza aquí porque F3
 * (ventana de clasificatorias, reglas) va a usar las mismas claves.
 *
 * Claves que introduce F2:
 * - `aoe4world.sync.player.<profileId>`: cursor de sincronización de un jugador.
 *
 * Clave que introduce F3:
 * - `scoring.lastRun`: rastro de la última pasada del motor de puntuación.
 *
 * Clave que introduce el arreglo del sync invisible:
 * - `sync.lastRun`: rastro de la última pasada del sincronizador, con sus fallos.
 *
 * Clave que introduce el cierre manual de inscripciones:
 * - `registration.open`: booleano; si falta o no es legible, el plazo está cerrado.
 */

/** Cuántos `gameId` de partidas abandonadas se guardan como rastro. */
export const ABANDONED_AUDIT_LIMIT = 20;

export const PLAYER_SYNC_KEY_PREFIX = "aoe4world.sync.player.";

/**
 * Rastro de la última pasada del motor (ver `docs/MODELO-DATOS.md`, "Claves de Setting").
 *
 * Es una fila que se sobrescribe, no un histórico: `ScoreSnapshot` sigue diferido
 * porque con una sola versión de reglas activa no hay delta que conservar, y lo que
 * hace falta para responder "¿cuándo se calculó esto y sobre cuántas partidas?" es
 * una línea. La hora la da la propia columna `Setting.updatedAt`, que se escribe en
 * la misma transacción que el recálculo.
 */
export const SCORING_LAST_RUN_KEY = "scoring.lastRun";

export function playerSyncKey(profileId: number): string {
  return `${PLAYER_SYNC_KEY_PREFIX}${profileId}`;
}

export type PlayerSyncState = {
  /** Último `started_at` visto menos el solape de seguridad; es lo que se manda como `since`. */
  since: string;
  /** Último `started_at` visto tal cual, sin restar el solape. */
  maxStartedAt: string;
  /** Cuándo se hizo esta sincronización. */
  lastSyncedAt: string;
  /** `true` si el tope de páginas cortó el histórico y quedan partidas por traer. */
  historyTruncated: boolean;
  /**
   * Rastro de la regla "una partida abandonada nunca cuenta": cuántas se han
   * descartado y cuáles, para que el borrado no sea silencioso. No puntúa
   * nada; solo deja constancia de lo que el worker eliminó y por qué.
   */
  abandonedCount: number;
  abandonedGameIds: string[];
  lastAbandonedAt: string | null;
};

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string");
}

function readPlayerSyncStateValue(value: unknown): PlayerSyncState | null {
  if (!isRecord(value)) {
    return null;
  }

  const { since, maxStartedAt, lastSyncedAt, historyTruncated } = value;

  if (typeof since !== "string" || typeof maxStartedAt !== "string") {
    return null;
  }

  const abandonedCount =
    typeof value.abandonedCount === "number" && Number.isInteger(value.abandonedCount)
      ? value.abandonedCount
      : 0;

  return {
    since,
    maxStartedAt,
    lastSyncedAt: typeof lastSyncedAt === "string" ? lastSyncedAt : since,
    historyTruncated: historyTruncated === true,
    abandonedCount: Math.max(abandonedCount, 0),
    abandonedGameIds: readStringArray(value.abandonedGameIds).slice(0, ABANDONED_AUDIT_LIMIT),
    lastAbandonedAt: typeof value.lastAbandonedAt === "string" ? value.lastAbandonedAt : null,
  };
}

export async function readPlayerSyncState(profileId: number): Promise<PlayerSyncState | null> {
  const setting = await db.setting.findUnique({ where: { key: playerSyncKey(profileId) } });

  return setting === null ? null : readPlayerSyncStateValue(setting.value);
}

/** Rastro de abandonos, del más reciente al más antiguo y acotado. */
export function mergeAbandonedAudit(
  previous: PlayerSyncState | null,
  addedGameIds: string[],
  nowIso: string,
): Pick<PlayerSyncState, "abandonedCount" | "abandonedGameIds" | "lastAbandonedAt"> {
  if (addedGameIds.length === 0) {
    return {
      abandonedCount: previous?.abandonedCount ?? 0,
      abandonedGameIds: previous?.abandonedGameIds ?? [],
      lastAbandonedAt: previous?.lastAbandonedAt ?? null,
    };
  }

  return {
    abandonedCount: (previous?.abandonedCount ?? 0) + addedGameIds.length,
    abandonedGameIds: [...addedGameIds, ...(previous?.abandonedGameIds ?? [])].slice(
      0,
      ABANDONED_AUDIT_LIMIT,
    ),
    lastAbandonedAt: nowIso,
  };
}

export async function writePlayerSyncState(
  profileId: number,
  state: PlayerSyncState,
): Promise<void> {
  const key = playerSyncKey(profileId);

  await db.setting.upsert({
    where: { key },
    create: { key, value: state },
    update: { value: state },
  });
}

/** Cliente con la única tabla que necesita escribir (`db` o una `tx`). */
export type SettingWriter = Pick<Prisma.TransactionClient, "setting">;

/**
 * Escribe el rastro de la última pasada del motor.
 *
 * Acepta el cliente porque el motor lo llama **dentro** de su transacción: así el
 * rastro se confirma a la vez que la clasificación, y nunca queda describiendo un
 * recálculo que se ha escrito a medias o que ha abortado.
 */
export async function writeScoringLastRun(
  value: Prisma.InputJsonObject,
  client: SettingWriter = db,
): Promise<void> {
  await client.setting.upsert({
    where: { key: SCORING_LAST_RUN_KEY },
    create: { key: SCORING_LAST_RUN_KEY, value },
    update: { value },
  });
}

/* -------------------------------------------------------------------------- */
/* Rastro del sincronizador                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Cuándo se espera una pasada del sincronizador para poder llamarla "al día".
 *
 * El cron de Supabase dispara cada 5 minutos y una pasada tarda unos segundos, así
 * que 20 minutos es holgura de sobra para un turno lento o un par de disparos
 * perdidos. Medir en contra también: si dos pasadas seguidas se paran a los 5
 * minutos por un 429 de AoE4World, la última de las dos está "al día" y por eso
 * hace falta además `lastSuccessAt`, que sí detecta esa racha.
 */
export const SYNC_STALE_MINUTES = 20;

/** Cuántos fallos por jugador se guardan. El resto va en el conteo. */
export const SYNC_FAILURES_LIMIT = 20;

/**
 * Rastro de la última pasada del sincronizador.
 *
 * Es lo que convierte un fallo silencioso en algo visible. Antes, el error de un
 * jugador solo llegaba a `console.error` —los logs del Worker—, y como el cron
 * dispara por HTTP y descarta la respuesta, nadie se enteraba: la web seguía
 * sirviendo la clasificación vieja y parecía que todo iba bien. Con esta fila el
 * panel puede decir qué pasó y cuándo fue la última vez que salió bien.
 *
 * Es una fila que se sobrescribe, no un histórico, igual que `scoring.lastRun`: para
 * diagnosticar «¿está roto ahora?» basta la última pasada y suplural de fallos. Si
 * algún día hace falta la serie, es un `ScoreSnapshot`/log de pasadas, no un
 * `Setting` más grande.
 */
export type SyncRunTrace = {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  playersTotal: number;
  playersOk: number;
  playersFailed: number;
  playersCancelled: number;
  newMatches: number;
  updatedMatches: number;
  resolvedByRefetch: number;
  abandonedMatches: number;
  skippedGames: number;
  liveMatches: number;
  apiRequests: number;
  apiRetries: number;
  rateLimitResponses: number;
  rateLimitPausesMs: number;
  /** Fallo del snapshot de ladder; no tumba la pasada, pero deja el elo viejo. */
  ladderError: string | null;
  /** Por qué no se pudo recalcular la clasificación, si no se pudo. */
  scoringError: string | null;
  /**
   * Por qué no se pudieron evaluar las alertas de comportamiento, si no se pudo.
   *
   * Va en el rastro pero **no** cuenta para `lastSuccessAt`: las alertas son
   * información sobre un comportamiento a vigilar, no salud del sincronizador. Que
   * el motor de alertas falle no significa que las partidas no se estén trayendo,
   * y un rastro que mezclara las dos cosas daría "el torneo lleva roto desde las
   * 10:00" por un fallo que no ha parado nada.
   */
  alertsError: string | null;
  /**
   * Por qué no se pudo comprobar el historial de partidas en el juego, o qué hubo que
   * avisar aunque no fuera un fallo.
   *
   * Va en el rastro pero **no** cuenta para `lastSuccessAt`, por el mismo motivo que
   * `alertsError`: que no se sepa si un participante tiene el historial de partidas
   * abierto **no ha parado ni una partida**. Las que sí se han sincronizado están
   * guardadas y la clasificación está recalculada; lo que falta es poder decir que ese
   * jugador podría tener el historial cerrado, que es un aviso para la organización, no
   * salud del sincronizador.
   *
   * Y con el texto aunque no haya fallo, porque es el único sitio donde se ve que el
   * sondeo está corriendo (y cuántos players quedaron para la siguiente pasada por el
   * tope), igual que el aviso de `YOUTUBE_API_KEY` en `streamsError`.
   */
  historyError: string | null;
  /**
   * Por qué no se pudo comprobar la pertenencia al servidor de Discord de los
   * participantes, o qué hubo que avisar aunque no fuera un fallo.
   *
   * Va en el rastro pero **no** cuenta para `lastSuccessAt`, por el mismo motivo que
   * `alertsError`: que no se sepa si alguien sigue en el servidor de Discord **no ha
   * parado ni una partida**. Lo que falta es poder avisar a la organización de que
   * una cuenta se ha ido del servidor, que es un aviso para ella, no salud del
   * sincronizador.
   *
   * Y con el texto aunque no haya fallo, porque es el único sitio donde se ve que la
   * comprobación está corriendo, cuántos participantes quedaron para la siguiente pasada
   * por el tope, **con cuántos miembros salió la lista de miembros del servidor** —y si
   * se ha podido leer o no— y, si faltan las credenciales, que la comprobación **no se
   * está haciendo**, igual que el aviso de `YOUTUBE_API_KEY` en `streamsError`.
   */
  discordError: string | null;
  /**
   * Por qué no se pudo comprobar el estado de directo de YouTube o de Kick, si no se
   * pudo.
   *
   * Va en el rastro pero **no** cuenta para `lastSuccessAt`, y por la misma razón que
   * `alertsError`: no saber si alguien está emitiendo **no ha parado ni una
   * partida**. Las partidas están sincronizadas, la clasificación está recalculada y
   * el cron va bien; lo único que falta es un icono. Un rastro que mezclara las dos
   * cosas diría "el torneo lleva roto desde las 10:00" por un 429 de una API de
   * terceros, que es justo la confusión que `lastSuccessAt` existe para evitar.
   *
   * Es también el sitio donde se ve que **no hay `YOUTUBE_API_KEY`**: en ese caso
   * hay texto de aviso aunque no haya fallo, y sigue sin mover el marcador.
   */
  streamsError: string | null;
  /** Jugadores que no se pudieron sincronizar, con su motivo. */
  failures: SyncRunFailure[];
  /**
   * `finishedAt` de la última pasada que salió **entera**: sin jugadores fallidos,
   * sin ladder roto y sin error de puntuación. Se arrastra desde la anterior, así
   * que una racha de pasadas rotas no borra el dato de cuándo things iban bien.
   */
  lastSuccessAt: string | null;
};

/** Un jugador que la pasada no pudo sincronizar. */
export type SyncRunFailure = {
  profileId: number;
  name: string;
  status: string;
  error: string;
};

export const SYNC_LAST_RUN_KEY = "sync.lastRun";

function readCount(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) ? Math.max(value, 0) : 0;
}

function readText(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function readFailures(value: unknown): SyncRunFailure[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(isRecord)
    .filter(
      (item): item is SyncRunFailure =>
        typeof item["profileId"] === "number" && typeof item["error"] === "string",
    )
    .map((item) => ({
      profileId: item["profileId"],
      name: typeof item["name"] === "string" ? item["name"] : `#${item["profileId"]}`,
      status: typeof item["status"] === "string" ? item["status"] : "failed",
      error: item["error"],
    }))
    .slice(0, SYNC_FAILURES_LIMIT);
}

function readSyncRunTraceValue(value: unknown): SyncRunTrace | null {
  if (!isRecord(value)) {
    return null;
  }

  const startedAt = readText(value["startedAt"]);
  const finishedAt = readText(value["finishedAt"]);

  // Sin esas dos no hay nada que decir: el rastro sirve para saber *cuándo* pasó.
  if (startedAt === null || finishedAt === null) {
    return null;
  }

  return {
    startedAt,
    finishedAt,
    durationMs: readCount(value["durationMs"]),
    playersTotal: readCount(value["playersTotal"]),
    playersOk: readCount(value["playersOk"]),
    playersFailed: readCount(value["playersFailed"]),
    playersCancelled: readCount(value["playersCancelled"]),
    newMatches: readCount(value["newMatches"]),
    updatedMatches: readCount(value["updatedMatches"]),
    resolvedByRefetch: readCount(value["resolvedByRefetch"]),
    abandonedMatches: readCount(value["abandonedMatches"]),
    skippedGames: readCount(value["skippedGames"]),
    liveMatches: readCount(value["liveMatches"]),
    apiRequests: readCount(value["apiRequests"]),
    apiRetries: readCount(value["apiRetries"]),
    rateLimitResponses: readCount(value["rateLimitResponses"]),
    rateLimitPausesMs: readCount(value["rateLimitPausesMs"]),
    ladderError: readText(value["ladderError"]),
    scoringError: readText(value["scoringError"]),
    alertsError: readText(value["alertsError"]),
    historyError: readText(value["historyError"]),
    discordError: readText(value["discordError"]),
    streamsError: readText(value["streamsError"]),
    failures: readFailures(value["failures"]),
    lastSuccessAt: readText(value["lastSuccessAt"]),
  };
}

export async function readSyncRunTrace(): Promise<SyncRunTrace | null> {
  const setting = await db.setting.findUnique({ where: { key: SYNC_LAST_RUN_KEY } });

  return setting === null ? null : readSyncRunTraceValue(setting.value);
}

/**
 * Escribe el rastro de la pasada que acaba de terminar.
 *
 * **Nunca lanza.** Escribir el rastro no puede tumbar la sincronización: sería
 * absurdo que un fallo al guardar el diagnóstico dejara el torneo sin
 * sincronizar. Quien llama lo envuelve igualmente, pero la garantía está aquí
 * porque este módulo es el que conoce el tipo.
 *
 * `previous` solo se usa para arrastrar `lastSuccessAt`: si esta pasada sale bien,
 * el marcador se actualiza a su `finishedAt`; si sale mal, se conserva el de la
 * última vez que salió bien, que es justo el dato que dice cuánto lleva roto.
 */
export async function writeSyncRunTrace(
  trace: Omit<SyncRunTrace, "lastSuccessAt">,
  previous: SyncRunTrace | null = null,
): Promise<void> {
  const salioBien =
    trace.playersFailed === 0 &&
    trace.playersCancelled === 0 &&
    trace.ladderError === null &&
    trace.scoringError === null;
  // `alertsError` no se mira aquí a propósito: el marcador de "cuándo funcionó por
  // última vez" responde a «¿desde cuándo está roto el sincronizador?», y un fallo
  // del motor de alertas no ha parado ni una partida. Meterlo haría que el panel
  // dijera que el torneo lleva horas roto cuando lo que se ha caído es un informe.
  // Lo mismo con `streamsError`: no saber si un canal está emitiendo tampoco para
  // nada del torneo, y con `historyError`: no saber si un participante tiene el
  // historial de partidas abierto tampoco. Y con `discordError`: no saber si la cuenta
  // de alguien sigue en el servidor de Discord tampoco, y además la falta de
  // `DISCORD_BOT_TOKEN` o `DISCORD_GUILD_ID` es permanente, así que si contara un
  // torneo entero con la comprobación apagada se publicaría como sincronizador roto.

  const value = {
    ...trace,
    failures: trace.failures.slice(0, SYNC_FAILURES_LIMIT),
    lastSuccessAt: salioBien ? trace.finishedAt : (previous?.lastSuccessAt ?? null),
  } as Prisma.InputJsonObject;

  await db.setting.upsert({
    where: { key: SYNC_LAST_RUN_KEY },
    create: { key: SYNC_LAST_RUN_KEY, value },
    update: { value },
  });
}

/**
 * ¿La última pasada es tan vieja que ya no cuenta como «al día»?
 *
 * `null` cuando no hay rastro ninguno, que es un caso aparte: no es una pasada
 * vieja, es que nunca se ha escrito una, y quien llama lo dice con sus palabras.
 */
export function isSyncTraceStale(trace: SyncRunTrace | null, now: Date = new Date()): boolean {
  if (trace === null) {
    return false;
  }

  const finished = Date.parse(trace.finishedAt);

  if (Number.isNaN(finished)) {
    return true;
  }

  return now.getTime() - finished > SYNC_STALE_MINUTES * 60_000;
}

/* -------------------------------------------------------------------------- */
/* Plazo de inscripción                                                        */
/* -------------------------------------------------------------------------- */

/**
 * ¿Están abiertas las inscripciones ahora mismo?
 *
 * Lee `Setting["registration.open"]` y aplica el parser puro de
 * `src/lib/registration-open.ts`, que cae al valor por defecto (cerrada) cuando
 * la clave no existe o el valor no es un booleano. Un **fallo de la base sí se
 * propaga**, como en `readCountries()`: "no hay nada publicado" tiene su valor
 * por defecto y "no se ha podido leer" no, y quien comprueba un envío tiene que
 * poder distinguir la segunda para no validar contra un estado inventado.
 */
export async function readRegistrationOpen(): Promise<boolean> {
  const setting = await db.setting.findUnique({ where: { key: REGISTRATION_OPEN_KEY } });

  return parseRegistrationOpen(setting?.value);
}

/**
 * Publica el plazo. La usa el interruptor de `/admin`.
 *
 * El `upsert` la hace idempotente: repetir el mismo valor no cambia nada salvo
 * `Setting.updatedAt`, que es justo el rastro que deja el cambio.
 */
export async function writeRegistrationOpen(open: boolean): Promise<void> {
  await db.setting.upsert({
    where: { key: REGISTRATION_OPEN_KEY },
    create: { key: REGISTRATION_OPEN_KEY, value: open },
    update: { value: open },
  });
}
