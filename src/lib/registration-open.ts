/**
 * Interruptor del plazo de inscripción de `/participar`.
 *
 * Vive en un módulo aparte de `src/app/(public)/participar/actions.ts` porque ese
 * archivo es `"use server"`, y desde ahí Next solo deja exportar funciones async:
 * el componente del formulario, que necesita el mismo dato para pintar el botón y
 * el aviso, no lo podría leer. Es el mismo patrón que el contrato de Turnstile
 * (`src/lib/turnstile-contract.ts`): un módulo normal, sin `server-only`, con lo
 * justo para que servidor y cliente lean la misma cosa.
 *
 * El torneo aún no es oficial y la organización no quiere recibir solicitudes, así
 * que el envío real se rechaza **en el servidor** (ver `registerPlayer`): con este
 * valor a `true` no se llega a gastar un intento de una IP real, ni a canjear un
 * captcha, ni a comprobar nada. Es la única fuente de la verdad: el botón y el
 * aviso del formulario son solo la cara visible de este flag.
 *
 * El tipo es `boolean` y no el literal del valor a propósito: así los dos caminos
 * se siguen comprobando aunque el flag esté cerrado, y abrir el plazo no puede
 * dejar código sin verificar.
 *
 * **Para abrir las inscripciones basta con ponerlo a `false`**: no hay que tocar
 * ni la condición ni ningún otro camino.
 */
export const REGISTRATION_IS_CLOSED: boolean = true;
