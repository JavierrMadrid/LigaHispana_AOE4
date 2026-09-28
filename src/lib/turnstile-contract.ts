/**
 * Contrato compartido entre el widget de Cloudflare Turnstile y el servidor que
 * lo verifica.
 *
 * Vive en un módulo aparte de `src/lib/turnstile.ts` **a propósito**: ese es
 * `server-only` (guarda el secret key y habla con la API de Cloudflare), y este
 * no tiene nada secreto, así que el componente cliente puede importar de aquí
 * los dos nombres que tienen que coincidir con el servidor o el formulario deja
 * de funcionar sin ningún error visible:
 *
 * - el nombre del campo que el widget manda, que es el que la Server Action lee;
 * - el nombre de la variable de entorno con la site key.
 *
 * Los dos los fija Cloudflare, no el proyecto: si se cambian, se cambian los dos
 * sitios y no hay forma de que uno se quede atrás sin romper en silencio.
 */

/**
 * Campo oculto que el widget inyecta en el formulario con el token de la
 * respuesta. La Server Action lo lee por este nombre (`registerPlayer`).
 */
export const TURNSTILE_RESPONSE_FIELD = "cf-turnstile-response";

/**
 * Variable de entorno con la **site key** (la pública, la que va en el HTML).
 * Sin ella el widget no se puede inicializar, así que el componente cliente
 * trata el valor vacío como "no hay captcha" y no lo pinta.
 *
 * El par del servidor es `TURNSTILE_SECRET_KEY`, y está en `src/lib/turnstile.ts`
 * porque ese es el que no puede salir del servidor.
 */
export const TURNSTILE_SITE_KEY_ENV = "NEXT_PUBLIC_TURNSTILE_SITE_KEY";
