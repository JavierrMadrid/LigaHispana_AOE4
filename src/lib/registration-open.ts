/**
 * El plazo de inscripción del torneo: el interruptor manual y la fecha de cierre.
 *
 * Es un **contrato puro**: no importa `db` ni `server-only`, así que se puede
 * comprobar con Vitest sin base de datos ni red. Vive aparte de
 * `src/app/(public)/participar/actions.ts` porque ese archivo es `"use server"`,
 * y desde ahí Next solo deja exportar funciones async: el componente del
 * formulario, que necesita el mismo dato para pintar el botón y el aviso, no lo
 * podría leer. Es el mismo patrón que el contrato de Turnstile
 * (`src/lib/turnstile-contract.ts`): un módulo normal, con lo justo para que
 * servidor y cliente lean la misma cosa.
 *
 * ## La fuente de verdad es `Setting`, y ahora son **dos** claves
 *
 * El cierre no lo decide el código: vive en `Setting`, que la organización cambia
 * desde el panel sin desplegar. Son dos claves y cada una dice una cosa distinta:
 *
 * - `registration.open`: el **interruptor manual**. Si está apagado, las
 *   inscripciones están cerradas ya, aunque la fecha no haya llegado.
 * - `registration.closesAt`: la **fecha de cierre**, un instante ISO-8601 UTC o
 *   `null`. Si está puesta y ya ha pasado, las inscripciones se cierran solas.
 *
 * El **estado efectivo** es la conjunción: abiertas ⇔ interruptor abierto **y**
 * (sin fecha o `now < closesAt`). Así el interruptor sigue pudiendo cerrar antes,
 * y para reabrir después de la fecha el superadministrador quita o mueve la
 * fecha; sin fecha configurada todo funciona como antes de que existiera la
 * fecha. Quien lee y escribe las dos claves es `src/lib/settings.ts`
 * (`readRegistrationState` / `writeRegistrationOpen` / `writeRegistrationClosesAt`)
 * y lo aplica el servidor: `registerPlayer` y `createPlayer` lo comprueban en
 * cada envío real. El botón y el aviso del formulario son solo su cara visible.
 *
 * ## Por qué el valor por defecto es "cerrada"
 *
 * `DEFAULT_REGISTRATION_OPEN = false` conserva el comportamiento que tenía el
 * flag hardcodeado: mientras nadie haya publicado la clave, el plazo está
 * cerrado. Abrirlo es una decisión explícita de la organización, no el estado en
 * que queda el sistema si nadie dice nada.
 */

/** Clave de `Setting` donde vive el booleano del interruptor. */
export const REGISTRATION_OPEN_KEY = "registration.open";

/** Clave de `Setting` donde vive la fecha de cierre, o no existe si no hay fecha. */
export const REGISTRATION_CLOSES_AT_KEY = "registration.closesAt";

/** ¿Están abiertas las inscripciones si `Setting` no tiene la clave? No. */
export const DEFAULT_REGISTRATION_OPEN = false;

/**
 * Mensaje compartido del plazo cerrado por el **interruptor**.
 *
 * Lo usan los dos caminos que rechazan por cierre —`registerPlayer` en
 * `/participar` y `createPlayer` en `/admin`— para que el texto no pueda
 * divergir. Habla del plazo del torneo en curso y no de su oficialidad: lo que
 * la persona necesita saber es que ahora no se admiten solicitudes y que la
 * organización las abrirá, no un juicio sobre el torneo.
 */
export const REGISTRATION_CLOSED_MESSAGE =
  "Las inscripciones del torneo están cerradas. La organización las abrirá cuando corresponda.";

/**
 * Mensaje del plazo cerrado porque **la fecha ya ha pasado**.
 *
 * Es distinto del de arriba a propósito: aquí no hay "se abrirán" que valga, el
 * plazo terminó, y decirlo evita que alguien espere a que la organización pulse
 * un interruptor que ya no hace falta. Vive en el mismo módulo que su estado para
 * que quien rechaza un envío elija el texto sin tener que mirar por qué está
 * cerrado en otro sitio, y para que no pueda divergir del de arriba.
 */
export const REGISTRATION_DEADLINE_PASSED_MESSAGE =
  "El plazo de inscripción ha terminado. La organización abrirá una nueva convocatoria cuando corresponda.";

/**
 * Lee el booleano guardado. Devuelve el valor por defecto si no es legible.
 *
 * Acepta `unknown` porque lo que llega es la columna `Setting.value`, que es
 * `Json`: cualquier cosa pudo escribirse a mano en el panel. Un valor que no sea
 * un booleano se trata como "no hay dato" y cae al default, con el mismo criterio
 * de degradación que `mergeCountries()`.
 */
export function parseRegistrationOpen(value: unknown): boolean {
  return typeof value === "boolean" ? value : DEFAULT_REGISTRATION_OPEN;
}

/**
 * La forma aceptada de una fecha de cierre: un instante ISO-8601 **con zona**.
 *
 * `datetime-local` del navegador no manda zona, y sin zona el instante quedaría
 * a merced de la zona del proceso que lo lea —el Worker corre en UTC y el panel
 * en la del navegador—, así que se exige explícitamente y se rechaza lo que no
 * la traiga. Los segundos y los milisegundos son opcionales.
 */
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Normaliza una fecha **guardada** a ISO-8601 UTC, o `null` si no es válida.
 *
 * Es la puerta de **lectura**: `parseRegistrationClosesAt()` la aplica a lo que hay en
 * `Setting`, que siempre está ya en UTC con `Z`. Por eso exige la zona explícitamente
 * (`ISO_UTC`): un valor sin zona escrita a mano no es un instante que esta lectura
 * pueda situar, y se descarta como "sin fecha". Lo que se guarda siempre sale en la
 * misma forma, así que dos fechas del mismo instante no se ven distintas al comparar.
 *
 * **La puerta de escritura del panel no es esta**: `setRegistrationClosesAt()` acepta
 * además una fecha de `<input type="datetime-local">` sin zona y la interpreta en
 * `Europe/Madrid` con `parseMadridLocalInstant()` (la misma función que la ventana del
 * ruleset); de ahí sale ya en UTC y es lo que acaba en esta forma. Aquí no se puede
 * hacer esa interpretación porque `ranked-match.ts` es `server-only` y este módulo lo
 * importa también el formulario público.
 *
 * Un texto que no encaje con `ISO_UTC`, o que no sea una fecha parseable, devuelve
 * `null`: no es una fecha, y quien llame decide si eso es "sin fecha" o un error.
 */
export function normalizeRegistrationClosesAt(raw: string): string | null {
  const trimmed = raw.trim();

  if (trimmed === "" || !ISO_UTC.test(trimmed)) {
    return null;
  }

  const ms = Date.parse(trimmed);

  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/**
 * Lee la fecha guardada. Devuelve `null` si no hay, no es texto o no se entiende.
 *
 * Acepta `unknown` por el mismo motivo que `parseRegistrationOpen`: la columna es
 * `Json`. Una fecha ilegible se lee como "sin fecha", que es la dirección segura:
 * como mucho, las inscripciones siguen gobernadas por el interruptor, que es el
 * comportamiento que ya había.
 */
export function parseRegistrationClosesAt(value: unknown): string | null {
  return typeof value === "string" ? normalizeRegistrationClosesAt(value) : null;
}

/** Por qué está el plazo como está. */
export type RegistrationClosureReason =
  /** Abiertas: el interruptor está encendido y (no hay fecha o no ha llegado). */
  | "open"
  /** Cerradas por el interruptor manual, con o sin fecha. */
  | "switch"
  /** Cerradas porque la fecha de cierre ya ha pasado. */
  | "deadline";

/**
 * El estado efectivo del plazo, con el motivo de por qué está cerrado.
 *
 * Es la conjunción del interruptor y la fecha, y la pieza que comparten la acción
 * pública, el alta de admin y el bot: si cada uno decidiera "abierta o cerrada"
 * por su cuenta, una fecha mal comparada en un sitio rechazaría envíos que el
 * otro aceptaría. El motivo viaja con el estado porque los dos cierres no dicen
 * lo mismo a quien se inscribe (ver `registrationClosedMessage()`).
 *
 * `now` entra por parámetro para que la función sea pura y se pruebe sin
 * temporizadores reales. La fecha se compara con `>=`: en el instante exacto del
 * cierre ya está cerrado, igual que el borde de `discordCheckIsDue()`.
 */
export function resolveRegistrationState(input: {
  open: boolean;
  closesAt: string | null;
  now: Date;
}): RegistrationState {
  if (!input.open) {
    return { open: false, switchOpen: false, closesAt: input.closesAt, reason: "switch" };
  }

  if (input.closesAt !== null && input.now.getTime() >= Date.parse(input.closesAt)) {
    return { open: false, switchOpen: true, closesAt: input.closesAt, reason: "deadline" };
  }

  return { open: true, switchOpen: true, closesAt: input.closesAt, reason: "open" };
}

/** El estado efectivo del plazo, ya resuelto. */
export type RegistrationState = {
  /** ¿Se puede inscribir ahora mismo? */
  open: boolean;
  /**
   * El **interruptor manual** tal cual, sin aplicar la fecha.
   *
   * Va aparte de `open` porque el interruptor del panel compara este valor para
   * decidir si escribir: si comparase el efectivo, con la fecha ya pasada creería que
   * el interruptor sigue apagado y reescribiría un cambio que nadie ha hecho.
   */
  switchOpen: boolean;
  /** La fecha de cierre normalizada (ISO-8601 UTC), o `null` si no hay. */
  closesAt: string | null;
  /** Por qué está abierta o cerrada. */
  reason: RegistrationClosureReason;
};

/**
 * El texto que se le da a quien intenta inscribirse con el plazo cerrado.
 *
 * Elige entre los dos mensajes según el motivo, para que quien se topa con la
 * fecha pasada no lea "la organización las abrirá" —que es lo que sí aplica al
 * interruptor—. Con el plazo abierto no hay nada que decir y devuelve el mensaje
 * genérico, que es el estado seguro si alguien llama sin comprobar antes.
 */
export function registrationClosedMessage(state: RegistrationState): string {
  return state.reason === "deadline"
    ? REGISTRATION_DEADLINE_PASSED_MESSAGE
    : REGISTRATION_CLOSED_MESSAGE;
}
