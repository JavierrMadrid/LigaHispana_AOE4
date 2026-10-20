import "server-only";

import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { isRecord } from "@/lib/json";
import { readInstant, type ScoringWindow } from "@/lib/ranked-match";

/**
 * Los eventos puntuales de la edición: ventanas con multiplicador de puntos.
 *
 * ## Qué son
 *
 * Un **evento** es una franja de tiempo dentro de la edición durante la cual cada
 * victoria clasificatoria paga un extra: `pointsPerWin × (multiplier - 1)` puntos
 * adicionales por victoria. No toca las derrotas, los objetivos ni las partidas
 * que no cuentan, y **no altera `Match.points`**: el bono se guarda aparte en
 * `PlayerScore.breakdown.events` y se suma al total (ver `docs/PUNTUACION.md`).
 *
 * El bono es **permanente** a efectos de la clasificación: un evento no es una
 * competición que se decide al cierre, sino una ventana que se juega y se cobra.
 *
 * ## Dónde vive
 *
 * En `Setting`, como la configuración de la edición y el ruleset, y por la razón de
 * siempre: cambiar un evento no puede exigir un `db push` sobre producción. Son dos
 * documentos:
 *
 * - `Setting["edition.events"]`: los eventos (`EditionEventsConfig`).
 * - `Setting["edition.events.state"]`: el **snapshot de elegibilidad** de Discord por
 *   evento (`EditionEventsState`), que escribe otro proceso cuando el evento empieza.
 *
 * ## Cuándo se pueden tocar
 *
 * Solo **antes de que empiece la ventana del torneo** (`window.from`). A partir de
 * ahí los eventos quedan bloqueados: un evento que se pudiera crear o editar a mitad
 * de edición cambiaría puntos ya publicados. El bloqueo lo aplica la acción del panel
 * (`editionEventsLocked()`), no la lectura: leer un documento guardado nunca falla.
 *
 * ## Tolerancia
 *
 * `mergeEditionEvents()` es pura y **nunca lanza**: un evento que no se entiende se
 * descarta con un aviso y los demás se conservan, porque un documento a medias sigue
 * describiendo eventos publicables. La **versión sí invalida el documento entero**
 * (como en `edition.config`): otra estructura no se puede aplicar "a lo que se
 * parezca". La excepción es la descripción: si pasa del tope se queda sin
 * descripción, no se pierde el evento, porque el nombre y las fechas son lo que
 * reparte puntos.
 *
 * La comprobación de que los eventos caen **dentro de la ventana del torneo** y no
 * se solapan es `validateEditionEvents()`, aparte, porque necesita el ruleset. Este
 * módulo no lo lee: `scoring.ts` importa de aquí, y leer el ruleset desde aquí
 * cerraría el círculo.
 *
 * ## El snapshot de elegibilidad
 *
 * Si un evento exige pertenencia al servidor de Discord (`discordRequired`), quien
 * puede cobrar el bono se decide **al empezar el evento** y se congela en
 * `edition.events.state`. La comprobación real y su escritura son de otro proceso;
 * aquí solo están el tipo, el parser y la lectura/escritura. Sin snapshot **no hay
 * bono** para ese evento: no se inventa elegibilidad.
 */

/** Clave de `Setting` donde viven los eventos. */
export const EDITION_EVENTS_KEY = "edition.events";

/** Clave de `Setting` donde vive el snapshot de elegibilidad por evento. */
export const EDITION_EVENTS_STATE_KEY = "edition.events.state";

/**
 * Versión de la **forma** del documento de eventos. La fija el código: cambiar un
 * evento no requiere despliegue, cambiar la estructura sí.
 */
export const EDITION_EVENTS_VERSION = 1;

/** Versión de la forma del snapshot de elegibilidad. */
export const EDITION_EVENTS_STATE_VERSION = 1;

/**
 * Cuántos eventos admite una edición.
 *
 * Es un tope de cordura, no una regla del torneo: un documento con cientos de
 * eventos es un error de escritura y hace que el motor compare cada partida con
 * cientos de ventanas.
 */
export const EDITION_EVENTS_MAX = 20;

/** Tope del nombre de un evento, en caracteres. */
export const EDITION_EVENT_NAME_MAX_LENGTH = 80;

/** Tope de las instrucciones de un evento, en caracteres. */
export const EDITION_EVENT_DESCRIPTION_MAX_LENGTH = 500;

/** Tope del id de un evento: el que genera el panel es un UUID. */
export const EDITION_EVENT_ID_MAX_LENGTH = 64;

/** Multiplicador mínimo de un evento. `1` sería "sin bono" y no es un evento. */
export const MIN_EVENT_MULTIPLIER = 2;

/**
 * Un evento puntual.
 *
 * Las fechas son instantes ISO-8601 UTC, como la ventana del torneo, y el intervalo
 * es **`[from, to)`**: una partida cuenta si **empezó** antes de `to`, con el mismo
 * criterio que el resto del motor (`Match.startedAt`).
 */
export type EditionEvent = {
  /** Id estable: el panel genera un UUID al crear y lo conserva al editar. */
  id: string;
  /** Nombre visible del evento. Nunca vacío. */
  name: string;
  /** Instrucciones para participantes, o `null` si no hay. */
  description: string | null;
  /** Instante inclusive de inicio, ISO-8601 UTC. */
  from: string;
  /** Instante **exclusivo** de fin, ISO-8601 UTC. Siempre posterior a `from`. */
  to: string;
  /** Entero `>= 2`: cuánto multiplica los puntos por victoria del ruleset. */
  multiplier: number;
  /** ¿Solo cobran el bono quienes estaban en el Discord al empezar el evento? */
  discordRequired: boolean;
};

/** El documento que vive en `Setting["edition.events"]`. */
export type EditionEventsConfig = {
  version: number;
  /** Los eventos, en el orden en que los guardó el panel. */
  events: EditionEvent[];
};

/** Los eventos con los que arranca una edición mientras nadie publique nada. */
export const DEFAULT_EDITION_EVENTS: EditionEventsConfig = {
  version: EDITION_EVENTS_VERSION,
  events: [],
};

/** Copia nueva del documento por defecto: quien la reciba puede escribir en ella. */
export function defaultEditionEvents(): EditionEventsConfig {
  return { version: EDITION_EVENTS_VERSION, events: [] };
}

/**
 * Quién podía cobrar el bono de un evento.
 *
 * `checkedPlayerIds` son los jugadores a los que se les miró el Discord y
 * `eligiblePlayerIds` los que estaban dentro, ambos `Player.id`. Se guardan los dos
 * para poder auditar una comprobación que descartó a alguien, no solo el resultado.
 */
export type EditionEventEligibility = {
  /** Instante de la comprobación, ISO-8601 UTC, o `null` si no se sabe. */
  checkedAt: string | null;
  /** Jugadores comprobados. */
  checkedPlayerIds: string[];
  /** Jugadores que cumplían el requisito y pueden cobrar el bono. */
  eligiblePlayerIds: string[];
};

/** El documento de `Setting["edition.events.state"]`: un snapshot por evento. */
export type EditionEventsState = {
  version: number;
  /** `EditionEvent.id` → elegibilidad congelada al empezar el evento. */
  events: Record<string, EditionEventEligibility>;
};

/** El estado con el que arranca una edición sin ninguna comprobación hecha. */
export const DEFAULT_EDITION_EVENTS_STATE: EditionEventsState = {
  version: EDITION_EVENTS_STATE_VERSION,
  events: {},
};

/** Copia nueva del estado vacío. */
export function defaultEditionEventsState(): EditionEventsState {
  return { version: EDITION_EVENTS_STATE_VERSION, events: {} };
}

/** Cliente con la única tabla que necesita este módulo (`db` o una `tx`). */
export type EditionEventsClient = Pick<Prisma.TransactionClient, "setting">;

export type EditionEventsMergeResult = {
  /** El documento efectivo, ya validado y normalizado. */
  config: EditionEventsConfig;
  /** Lo que no se ha podido aplicar; el documento sigue siendo publicable. */
  warnings: string[];
};

/* -------------------------------------------------------------------------- */
/* Validación campo a campo                                                    */
/* -------------------------------------------------------------------------- */

/** Un texto guardado, ya recortado, o `null` si no hay nada que guardar. */
function optionalText(value: unknown, max: number, field: string, warnings: string[]): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value !== "string") {
    warnings.push(`${field} no es un texto: ${JSON.stringify(value)}`);
    return null;
  }

  const text = value.trim();

  if (text === "") {
    return null;
  }

  if (text.length > max) {
    warnings.push(`${field} pasa de ${max} caracteres; se ignora`);
    return null;
  }

  return text;
}

/** Un id de evento: texto no vacío y acotado, sin imponer un formato concreto. */
function parseEventId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const id = value.trim();

  return id === "" || id.length > EDITION_EVENT_ID_MAX_LENGTH ? null : id;
}

/**
 * Un evento guardado, ya validado, o `null` si no se puede publicar.
 *
 * Se descarta entero cuando falla la identidad (id o nombre), las fechas o el
 * multiplicador: son los datos con los que se reparten puntos y no hay un valor por
 * defecto honesto para ninguno. La descripción es la excepción: si no vale, el
 * evento se queda sin instrucciones.
 */
function parseEvent(
  value: unknown,
  index: number,
  warnings: string[],
): EditionEvent | null {
  const position = `events[${index}]`;

  if (!isRecord(value)) {
    warnings.push(`${position} no es un objeto; se ignora`);
    return null;
  }

  const id = parseEventId(value.id);

  if (id === null) {
    warnings.push(`${position}.id no es un identificador válido; se ignora el evento`);
    return null;
  }

  const name = typeof value.name === "string" ? value.name.trim() : "";

  if (name === "") {
    warnings.push(`${position}.name está vacío o no es un texto; se ignora el evento`);
    return null;
  }

  if (name.length > EDITION_EVENT_NAME_MAX_LENGTH) {
    warnings.push(
      `${position}.name pasa de ${EDITION_EVENT_NAME_MAX_LENGTH} caracteres; se ignora el evento`,
    );
    return null;
  }

  const description = optionalText(
    value.description,
    EDITION_EVENT_DESCRIPTION_MAX_LENGTH,
    `${position}.description`,
    warnings,
  );

  const from = readInstant(value.from);
  const to = readInstant(value.to);

  if (from === null || to === null) {
    warnings.push(`${position} no tiene un par de fechas ISO-8601 con zona válido; se ignora`);
    return null;
  }

  if (to.getTime() <= from.getTime()) {
    warnings.push(`${position}.to no es posterior a ${position}.from; se ignora el evento`);
    return null;
  }

  const multiplier = value.multiplier;

  if (
    typeof multiplier !== "number" ||
    !Number.isInteger(multiplier) ||
    multiplier < MIN_EVENT_MULTIPLIER
  ) {
    warnings.push(
      `${position}.multiplier no es un entero mayor o igual que ${MIN_EVENT_MULTIPLIER}; se ignora el evento`,
    );
    return null;
  }

  if (value.discordRequired !== undefined && typeof value.discordRequired !== "boolean") {
    warnings.push(`${position}.discordRequired no es un booleano; se lee como false`);
  }

  return {
    id,
    name,
    description,
    from: from.toISOString(),
    to: to.toISOString(),
    multiplier,
    discordRequired: value.discordRequired === true,
  };
}

/**
 * Combina el documento guardado con los valores por defecto. **Nunca lanza.**
 *
 * Mismo contrato que `mergeEditionConfig()` —el documento efectivo más
 * `warnings`—: los eventos se validan uno a uno y un evento roto no se lleva por
 * delante a los demás. Lo que sí invalida el documento entero es la **versión**,
 * porque un documento de otra versión puede describir otra estructura.
 */
export function mergeEditionEvents(stored: unknown): EditionEventsMergeResult {
  const warnings: string[] = [];
  const config = defaultEditionEvents();

  if (!isRecord(stored)) {
    warnings.push("el valor no es un objeto; se usa la lista de eventos vacía");
    return { config, warnings };
  }

  if (stored.version !== EDITION_EVENTS_VERSION) {
    warnings.push(
      `la versión guardada (${String(stored.version)}) no es ${EDITION_EVENTS_VERSION}; se usa la lista de eventos vacía`,
    );
    return { config, warnings };
  }

  if (stored.events === undefined) {
    warnings.push("events no viene; se usa la lista de eventos vacía");
    return { config, warnings };
  }

  if (!Array.isArray(stored.events)) {
    warnings.push("events no es una lista; se usa la lista de eventos vacía");
    return { config, warnings };
  }

  const ids = new Set<string>();

  for (const [index, raw] of stored.events.entries()) {
    if (config.events.length >= EDITION_EVENTS_MAX) {
      warnings.push(
        `hay más de ${EDITION_EVENTS_MAX} eventos; se conservan los ${EDITION_EVENTS_MAX} primeros`,
      );
      break;
    }

    const event = parseEvent(raw, index, warnings);

    if (event === null) {
      continue;
    }

    if (ids.has(event.id)) {
      warnings.push(`el id de evento "${event.id}" está repetido; se ignora el segundo`);
      continue;
    }

    ids.add(event.id);
    config.events.push(event);
  }

  return { config, warnings };
}

/* -------------------------------------------------------------------------- */
/* Ventana del torneo y solapes                                               */
/* -------------------------------------------------------------------------- */

export type EditionEventsValidation = {
  /** Los eventos válidos, ordenados por `from` ascendente. */
  events: EditionEvent[];
  /** Lo que impide publicar el documento; vacío si todo encaja. */
  warnings: string[];
};

/**
 * Valida los eventos contra la ventana del torneo y entre ellos.
 *
 * Recibe eventos **ya fusionados** por `mergeEditionEvents()`: aquí no se
 * revalidan los campos, solo las dos reglas que necesitan la ventana del ruleset:
 *
 * - **Dentro de la ventana**: `from >= window.from` y, si la ventana tiene fin,
 *   `to <= window.to`. Un evento fuera del torneo no podría repartir nada (sus
 *   partidas no son clasificatorias), así que publicarlo sería prometer un bono
 *   que el motor nunca daría.
 * - **Sin solapes**: los intervalos son `[from, to)` y dos eventos no pueden
 *   compartir ningún instante. Se comprueba sobre la lista ordenada por `from`, que
 *   es también el orden en que se devuelve.
 *
 * Los avisos están escritos para enseñarse tal cual en el panel.
 */
export function validateEditionEvents(
  events: readonly EditionEvent[],
  window: ScoringWindow,
): EditionEventsValidation {
  const warnings: string[] = [];
  const fromWindow = new Date(window.from).getTime();
  const toWindow = window.to === null ? null : new Date(window.to).getTime();
  const ordenados = [...events].sort((a, b) => {
    return new Date(a.from).getTime() - new Date(b.from).getTime();
  });

  let anterior: EditionEvent | null = null;

  for (const event of ordenados) {
    const from = new Date(event.from).getTime();
    const to = new Date(event.to).getTime();

    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
      warnings.push(`el evento "${event.name}" no tiene un intervalo de fechas válido`);
      continue;
    }

    if (Number.isFinite(fromWindow) && from < fromWindow) {
      warnings.push(
        `el evento "${event.name}" empieza antes de la ventana del torneo (${window.from})`,
      );
    }

    if (toWindow !== null && Number.isFinite(toWindow) && to > toWindow) {
      warnings.push(
        `el evento "${event.name}" termina después de la ventana del torneo (${window.to ?? ""})`,
      );
    }

    const anteriorTo = anterior === null ? null : new Date(anterior.to).getTime();

    if (anterior !== null && anteriorTo !== null && anteriorTo > from) {
      warnings.push(
        `el evento "${event.name}" se solapa con "${anterior.name}"; los eventos no pueden compartir fechas`,
      );
    }

    anterior = event;
  }

  return { events: ordenados, warnings };
}

/* -------------------------------------------------------------------------- */
/* Consultas de ventana                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Los límites de un evento como `Date`, para comparar en memoria.
 *
 * `to` es **exclusivo**, igual que `windowBounds()` para la ventana del torneo: una
 * partida que empieza justo en `to` ya es del siguiente tramo.
 */
export function eventWindowBounds(event: Pick<EditionEvent, "from" | "to">): {
  from: Date;
  to: Date;
} {
  return { from: new Date(event.from), to: new Date(event.to) };
}

/**
 * ¿Cae este instante dentro del evento?
 *
 * Un límite que no se puede leer hace que la comparación sea `false`: el fallo cae
 * hacia "no hay bono", que es la dirección segura. Se acepta `Date` o milisegundos
 * porque el motor compara los `startedAtMs` que trae del SQL.
 */
export function eventContains(
  event: Pick<EditionEvent, "from" | "to">,
  instant: Date | number,
): boolean {
  const at = instant instanceof Date ? instant.getTime() : instant;
  const { from, to } = eventWindowBounds(event);

  return at >= from.getTime() && at < to.getTime();
}

/** El evento que contiene `now`, o `null` si no hay ninguno en curso. */
export function activeEditionEvent(
  events: readonly EditionEvent[],
  now: Date,
): EditionEvent | null {
  return events.find((event) => eventContains(event, now)) ?? null;
}

/**
 * ¿Están los eventos bloqueados?
 *
 * Lo están desde el instante en que empieza la ventana del torneo. Antes, la
 * organización puede crear y editar; después, cambiar una ventana movería puntos que
 * ya están publicados. Una fecha de inicio ilegible **no** bloquea: se prefiere
 * dejar arreglar la configuración a encerrar el panel por un documento roto, y la
 * validación del ruleset ya garantiza una ventana legible.
 */
export function editionEventsLocked(window: ScoringWindow, now: Date): boolean {
  const from = new Date(window.from).getTime();

  return Number.isFinite(from) && now.getTime() >= from;
}

/* -------------------------------------------------------------------------- */
/* Snapshot de elegibilidad                                                   */
/* -------------------------------------------------------------------------- */

/** Una lista de ids de jugador guardada, sin repetidos y sin valores raros. */
function readPlayerIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const ids = new Set<string>();

  for (const id of value) {
    if (typeof id === "string" && id !== "") {
      ids.add(id);
    }
  }

  return [...ids];
}

/** Una entrada de elegibilidad guardada, o `null` si no se puede leer. */
function parseEligibility(value: unknown): EditionEventEligibility | null {
  if (!isRecord(value)) {
    return null;
  }

  return {
    checkedAt: typeof value.checkedAt === "string" && value.checkedAt !== "" ? value.checkedAt : null,
    checkedPlayerIds: readPlayerIds(value.checkedPlayerIds),
    eligiblePlayerIds: readPlayerIds(value.eligiblePlayerIds),
  };
}

/**
 * El snapshot de elegibilidad, leído **sin lanzar**.
 *
 * Un documento roto se lee como **vacío** (sin snapshots), que es la degradación
 * segura: un evento que exige Discord y no tiene snapshot no reparte bono. Es
 * preferible a deducir la elegibilidad de un documento a medias, que repartiría
 * puntos a quien no toca.
 */
export function parseEditionEventsState(value: unknown): EditionEventsState {
  const state = defaultEditionEventsState();

  if (!isRecord(value) || value.version !== EDITION_EVENTS_STATE_VERSION) {
    return state;
  }

  if (!isRecord(value.events)) {
    return state;
  }

  for (const [eventId, raw] of Object.entries(value.events)) {
    const eligibility = parseEligibility(raw);

    if (eventId !== "" && eligibility !== null) {
      state.events[eventId] = eligibility;
    }
  }

  return state;
}

/** La elegibilidad congelada de un evento, o `null` si no hay snapshot. */
export function readEditionEventEligibility(
  state: EditionEventsState,
  eventId: string,
): EditionEventEligibility | null {
  return state.events[eventId] ?? null;
}

/**
 * El estado sin la entrada de un evento, o `null` si no había nada que borrar.
 *
 * Devuelve `null` y no una copia idéntica para que quien llama sepa si merece la
 * pena escribir: borrar un evento sin snapshot no tiene que tocar la fila de
 * `Setting` ni dejar un rastro que no cambió nada.
 */
export function removeEditionEventState(
  state: EditionEventsState,
  eventId: string,
): EditionEventsState | null {
  if (!(eventId in state.events)) {
    return null;
  }

  const events = { ...state.events };
  delete events[eventId];

  return { version: state.version, events };
}

/* -------------------------------------------------------------------------- */
/* Lectura y escritura                                                        */
/* -------------------------------------------------------------------------- */

function reportWarnings(warnings: readonly string[]): void {
  for (const warning of warnings) {
    console.warn(`[edition] ${EDITION_EVENTS_KEY}: ${warning}`);
  }
}

/**
 * Los eventos de la edición.
 *
 * Si nadie ha publicado `edition.events`, devuelve la lista vacía **sin escribir
 * nada**: leer no debería modificar la base. Un documento que no se entiende se
 * descarta con un aviso en el log y se usan los eventos que se hayan podido leer. Un
 * **fallo de la base de datos sí se propaga**: "no hay eventos" y "no se han podido
 * leer" no son lo mismo.
 */
export async function readEditionEvents(
  client: EditionEventsClient = db,
): Promise<EditionEventsConfig> {
  const setting = await client.setting.findUnique({ where: { key: EDITION_EVENTS_KEY } });

  if (setting === null) {
    return defaultEditionEvents();
  }

  const merged = mergeEditionEvents(setting.value);
  reportWarnings(merged.warnings);

  return merged.config;
}

/**
 * Publica los eventos.
 *
 * **Valida antes de escribir**, como `writeEditionConfig()`: si el documento que se
 * le pasa no volviera a salir de `readEditionEvents()`, se estaría guardando algo
 * que el sistema va a descartar con un aviso, y el síntoma aparecería en la
 * clasificación, no en el panel. La validación contra la ventana y los solapes es de
 * quien llama (`validateEditionEvents`), que es quien tiene el ruleset delante.
 */
export async function writeEditionEvents(
  config: EditionEventsConfig,
  client: EditionEventsClient = db,
): Promise<void> {
  const merged = mergeEditionEvents(config);

  if (merged.warnings.length > 0) {
    throw new Error(
      `${EDITION_EVENTS_KEY}: documento no válido, no se publica (${merged.warnings.join("; ")})`,
    );
  }

  const value = toInputJson(merged.config);

  await client.setting.upsert({
    where: { key: EDITION_EVENTS_KEY },
    create: { key: EDITION_EVENTS_KEY, value },
    update: { value },
  });
}

/**
 * El snapshot de elegibilidad guardado.
 *
 * Un documento roto se lee como vacío, que es lo que hace que sus eventos no
 * repartan bono (ver `parseEditionEventsState`). Un fallo de la base se propaga.
 */
export async function readEditionEventsState(
  client: EditionEventsClient = db,
): Promise<EditionEventsState> {
  const setting = await client.setting.findUnique({ where: { key: EDITION_EVENTS_STATE_KEY } });

  return setting === null ? defaultEditionEventsState() : parseEditionEventsState(setting.value);
}

/**
 * Publica el snapshot de elegibilidad.
 *
 * Normaliza con el parser antes de escribir, para que la fila de `Setting` no
 * contenga listas con valores que el lector va a descartar: lo que se escribe es
 * exactamente lo que se va a volver a leer.
 */
export async function writeEditionEventsState(
  state: EditionEventsState,
  client: EditionEventsClient = db,
): Promise<void> {
  const normalized = parseEditionEventsState({
    version: EDITION_EVENTS_STATE_VERSION,
    events: state.events,
  });
  const value = toInputJson(normalized);

  await client.setting.upsert({
    where: { key: EDITION_EVENTS_STATE_KEY },
    create: { key: EDITION_EVENTS_STATE_KEY, value },
    update: { value },
  });
}

/**
 * El documento a JSON de entrada, **sin castear a ciegas**.
 *
 * Por el mismo motivo que `toInputJson()` en `edition.ts`: el viaje por `JSON` falla
 * ruidosamente si algún día se cuela un `undefined` o una función, en vez de
 * guardarlos como `null` sin que nadie se entere.
 */
function toInputJson(config: EditionEventsConfig | EditionEventsState): Prisma.InputJsonObject {
  return JSON.parse(JSON.stringify(config)) as Prisma.InputJsonObject;
}
