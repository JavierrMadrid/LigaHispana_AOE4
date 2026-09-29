import type { SupabaseClient, User } from "@supabase/supabase-js";

/**
 * Cómo leer la sesión de Supabase Auth sin que una llamada a la red pueda tumbar
 * la web.
 *
 * ## Por qué existe
 *
 * `auth.getUser()` va contra `*.supabase.co` y, en `@supabase/auth-js`
 * 2.117.2, su firma es `getUser(jwt?: string)` (`GoTrueClient.d.ts`): **no
 * acepta opciones ni una `AbortSignal`**. Tampoco la plumbing interna ayuda:
 * `_request` acepta un `signal`, pero `_getUser` le pasa `{}` como parámetros, así
 * que no hay por dónde inyectarla. El punto de extensión que sí ofrece la
 * librería es `SupabaseClientOptions.global.fetch`, que `createServerClient`
 * respeta (`@supabase/ssr/src/createServerClient.ts` reenvía `options.global` a
 * `createClient`, y `SupabaseClient.ts` se lo pasa a `GoTrueClient`). Por eso el
 * corte de red va por un `fetch` propio en lugar de por la llamada.
 *
 * Y no basta con un `AbortSignal.timeout`: cuando el access token está
 * caducado, `getUser()` dispara antes un refresco, y ese refresco se reintenta
 * con espera exponencial hasta que pasan 30 s (`AUTO_REFRESH_TICK_DURATION_MS`
 * en `@supabase/auth-js/dist/module/lib/constants.js`). Acotar cada intento
 * acota el intento, no la llamada, así que hay un segundo reloj para el total.
 *
 * ## Por qué un fallo se traduce a "sin sesión"
 *
 * Degradar a `null` **no** abre `/admin`: en `src/proxy.ts` una `user` nula
 * redirige a `/login`, y en `requireAdmin()` (`src/lib/auth.ts`) también. Los dos
 * caminos cierran la puerta cuando la sesión no se puede comprobar, así que el
 * peor caso de un corte de Auth es que un admin legítimo acabe en la pantalla de
 * login. Lo contrario —dejar pasar la comprobación que falló— sí sería un agujero.
 *
 * El error solo se registra con nombre y mensaje. No lleva la clave del
 * proyecto: esa viaja en la cabecera `apikey`, que `GoTrueClient` no mete en los
 * errores que devuelve.
 */

/**
 * Tope de cada petición HTTP del cliente de Supabase (leer el usuario, refrescar
 * el token). Es generoso para una llamada a Auth, que normalmente tarda menos de
 * un segundo, y corta antes de que Cloudflare mate la invocación con el error
 * 1101 por una promesa que nunca resuelve.
 */
const AUTH_TIMEOUT_MS = 3_000;

/**
 * Tope de la llamada completa a `auth.getUser()`, reintentos del refresco
 * incluidos. Tiene que ser mayor que {@link AUTH_TIMEOUT_MS}: en un corte de Auth
 * se llega al segundo intento antes de agotarlo.
 */
const AUTH_DEADLINE_MS = 5_000;

/**
 * `fetch` para el cliente de Supabase con un tope por petición.
 *
 * Se compone con la señal que ya venga en `init` en vez de pisarla: quien llama
 * con su propio `AbortSignal` (una navegación que se cancela, un `waitUntil`) debe
 * seguir mandando, y el tope es un límite adicional, no una sustitución.
 */
export function createAuthFetch(timeoutMs = AUTH_TIMEOUT_MS) {
  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;

    return fetch(input, { ...init, signal });
  };
}

/** Registra un fallo al leer la sesión. El prefijo `[auth]` lo distingue en el log. */
function logAuthFailure(scope: string, error: unknown) {
  if (error instanceof Error) {
    console.error(`[auth] ${scope}: ${error.name}: ${error.message}`);

    return;
  }

  console.error(`[auth] ${scope}: ${typeof error}: ${String(error)}`);
}

/**
 * Devuelve el usuario de la sesión, o `null` si no hay o no se ha podido saber.
 *
 * El `try`/`catch` cubre lo que la librería **lanza** (fallo de red, aborted,
 * cookie corrupta); el `error` del resultado cubre lo que **devuelve** (401,
 * token inválido). Los dos casos degradan a `null` por lo que dice el comentario
 * de este módulo.
 *
 * Cuando gana el reloj del plazo, la promesa de `getUser()` sigue viva: el
 * `AbortSignal` de su `fetch` la aborta en cuanto, y su `setAll` —si llegara a
 * escribir cookies— lo haría sobre una respuesta ya devuelta, que es el caso que
 * la propia `@supabase/ssr` documenta como lost update. No es algo que se pueda
 * evitar sin dejar de usar la librería, y solo ocurre con Auth caído.
 */
export async function readAuthUser(
  scope: string,
  supabase: SupabaseClient,
): Promise<User | null> {
  let deadline: ReturnType<typeof setTimeout> | undefined;

  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      deadline = setTimeout(
        () => reject(new Error(`Supabase Auth no ha respondido en ${AUTH_DEADLINE_MS} ms`)),
        AUTH_DEADLINE_MS,
      );
    });

    const { data, error } = await Promise.race([supabase.auth.getUser(), timeout]);

    if (error) {
      logAuthFailure(scope, error);

      return null;
    }

    return data.user;
  } catch (error) {
    logAuthFailure(scope, error);

    return null;
  } finally {
    clearTimeout(deadline);
  }
}
