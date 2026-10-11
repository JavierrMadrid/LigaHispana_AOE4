/**
 * Interruptor del plazo de inscripción del torneo.
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
 * ## La fuente de verdad es `Setting`
 *
 * El cierre no lo decide el código: vive en `Setting["registration.open"]`, un
 * booleano que la organización cambia desde el panel sin desplegar, igual que la
 * lista de países o el ruleset. Quien lo lee y lo escribe es `src/lib/settings.ts`
 * (`readRegistrationOpen` / `writeRegistrationOpen`) y lo aplica el servidor:
 * `registerPlayer` lo comprueba en cada envío real y `createPlayer` bloquea
 * también el alta de admin. El botón y el aviso del formulario son solo su cara
 * visible.
 *
 * ## Por qué el valor por defecto es "cerrada"
 *
 * `DEFAULT_REGISTRATION_OPEN = false` conserva el comportamiento que tenía el
 * flag hardcodeado: mientras nadie haya publicado la clave, el plazo está
 * cerrado. Abrirlo es una decisión explícita de la organización, no el estado en
 * que queda el sistema si nadie dice nada.
 */

/** Clave de `Setting` donde vive el booleano del plazo. */
export const REGISTRATION_OPEN_KEY = "registration.open";

/** ¿Están abiertas las inscripciones si `Setting` no tiene la clave? No. */
export const DEFAULT_REGISTRATION_OPEN = false;

/**
 * Mensaje compartido del plazo cerrado.
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
