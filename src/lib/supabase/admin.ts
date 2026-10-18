import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { normalizeAdminEmail } from "@/lib/admin-access";
import { readRuntimeEnv } from "@/lib/runtime-env";
import { getSupabaseEnv } from "./env";
import { createAuthFetch } from "./session";

/**
 * Cliente de **administración** de Supabase Auth (Admin API).
 *
 * Es el único sitio del proyecto que usa la clave `service_role`. Se necesita
 * porque invitar por correo, buscar una cuenta y banearla son operaciones que la
 * clave publicable no puede hacer: son las que administrar la lista de admins
 * requiere, y no hay forma de hacerlas con el usuario de la sesión.
 *
 * ## Por qué su propia clave y no la de la sesión
 *
 * La `service_role` **se salta RLS** y puede leer y escribir cualquier fila de
 * `auth.users`. Por eso este módulo es `server-only`, no expone ninguna función que
 * devuelva la clave, y **no la registra nunca**: los errores se anotan con su
 * nombre y su mensaje, y `GoTrueClient` no mete la clave en ellos (viaja en la
 * cabecera `apikey`, que no se refleja en el error).
 *
 * ## Degradación, no excepción
 *
 * Sin `SUPABASE_SERVICE_ROLE_KEY` **la app arranca igual**: el cliente no existe y
 * cada función devuelve `{ status: "not-configured" }`. Invitar entonces no se
 * puede —hace falta Auth—, pero dar de baja y reactivar a un admin sí, porque la
 * decisión real de acceso es la fila de `Admin`, que se escribe con el cliente de
 * siempre. Es el mismo criterio degradante del captcha o de la detección de
 * directos: lo que falta desactiva una función, no la web.
 *
 * ## Un cliente por isolate, y por qué aquí sí se puede cachear
 *
 * `@supabase/supabase-js` habla por `fetch` y no guarda ningún socket: no tiene el
 * problema de `pg` en Workers (un socket que muere con la invocación), así que
 * construir el cliente una vez por isolate es seguro y evita rehacerlo en cada
 * petición. Con `persistSession: false` y `autoRefreshToken: false` no toca las
 * cookies de nadie: esto no es la sesión de una persona.
 */

/** Tope por petición de la Admin API. Invitar manda un correo, así que es holgado. */
const ADMIN_TIMEOUT_MS = 10_000;

/** Cuántos usuarios pide cada página de `listUsers` (el máximo cómodo de GoTrue). */
const USERS_PER_PAGE = 200;

/**
 * Tope de páginas al buscar una cuenta por correo.
 *
 * `listUsers` de esta versión **no filtra por correo**, así que hay que recorrer
 * las páginas. El tope evita que un proyecto con muchísimas cuentas convierta la
 * búsqueda en un bucle sin fin; con el panel de este torneo no se llega ni a la
 * primera página entera, así que solo actúa como red de seguridad.
 */
const MAX_USER_PAGES = 50;

/** Ban de la baja: 100 años, que es como se dice "hasta que se le levante". */
const BAN_DURATION = "876000h";

/** La cuenta de Auth con la que se vincula una fila de `Admin`. */
export type AuthAdminUser = {
  id: string;
  email: string | null;
};

/**
 * Resultado de una llamada a la Admin API.
 *
 * `not-configured` es un estado propio y no un `error` con un texto: quien llama
 * tiene que poder distinguir "falta configurarlo" (degradación conocida) de "ha
 * fallado" (algo se ha roto), porque el mensaje que se le enseña al superadmin es
 * distinto.
 */
export type AuthAdminResult<T> =
  | { status: "ok"; data: T }
  | { status: "error"; message: string }
  | { status: "not-configured" };

/** La clave de servicio, o `null` si no está configurada. Nunca se exporta. */
function serviceRoleKey(): string | null {
  const key = readRuntimeEnv("SUPABASE_SERVICE_ROLE_KEY");

  return key !== undefined && key !== "" ? key : null;
}

/** El cliente, cacheado por isolate. `undefined` = aún sin resolver. */
let cachedClient: SupabaseClient | null | undefined;

/**
 * El cliente de administración, o `null` si no hay clave de servicio.
 *
 * Perezoso: no se construye al importar el módulo. Importar `src/lib/admin-users.ts`
 * no debe leer la clave ni exigirla, o el build y el arranque dependerían de un
 * secreto que solo hace falta en el momento de invitar.
 */
function adminClient(): SupabaseClient | null {
  if (cachedClient !== undefined) {
    return cachedClient;
  }

  const key = serviceRoleKey();

  if (key === null) {
    cachedClient = null;

    return null;
  }

  const { url } = getSupabaseEnv();

  cachedClient = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: createAuthFetch(ADMIN_TIMEOUT_MS) },
  });

  return cachedClient;
}

/** Registra un fallo de la Admin API. Prefijo `[auth-admin]` para distinguirlo. */
function logAdminFailure(scope: string, error: unknown): void {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);

  console.error(`[auth-admin] ${scope}: ${detail}`);
}

/**
 * Busca una cuenta de Auth por su correo, o `null` si no existe.
 *
 * Recorre las páginas de `listUsers` porque la librería no ofrece un "por correo" y
 * no conviene tocar la API a pelo. La comparación es sobre la forma canónica del
 * correo, la misma que usa todo lo demás, para que no dependa de cómo lo guardó
 * Auth.
 */
export async function findAuthUserByEmail(
  email: string,
): Promise<AuthAdminResult<AuthAdminUser | null>> {
  const supabase = adminClient();

  if (supabase === null) {
    return { status: "not-configured" };
  }

  const objetivo = normalizeAdminEmail(email);

  try {
    for (let page = 1; page <= MAX_USER_PAGES; page += 1) {
      const { data, error } = await supabase.auth.admin.listUsers({
        page,
        perPage: USERS_PER_PAGE,
      });

      if (error) {
        logAdminFailure("buscar-usuario", error);

        return { status: "error", message: "No se ha podido buscar la cuenta." };
      }

      const users = data.users;
      const encontrado = users.find(
        (user) => normalizeAdminEmail(user.email ?? "") === objetivo,
      );

      if (encontrado !== undefined) {
        return {
          status: "ok",
          data: { id: encontrado.id, email: encontrado.email ?? null },
        };
      }

      // Una página corta es la última: no hay más cuentas que mirar.
      if (users.length < USERS_PER_PAGE) {
        break;
      }
    }

    return { status: "ok", data: null };
  } catch (error) {
    logAdminFailure("buscar-usuario", error);

    return { status: "error", message: "No se ha podido buscar la cuenta." };
  }
}

/**
 * Crea una cuenta por invitación y le manda el correo para fijar la contraseña.
 *
 * El destino del enlace lo decide el proyecto de Supabase (su *Site URL* y la
 * plantilla de la invitación), que ya apunta a `/auth/confirm`: esa ruta verifica el
 * `token_hash` y deja a la persona en `/login/establecer-contrasena`, que es donde
 * escribe su contraseña. Por eso no se pasa un `redirectTo`: el que ya está
 * configurado es el que hace falta.
 *
 * Si el correo **ya tiene cuenta**, GoTrue responde un error en vez de crearla; eso
 * lo interpreta quien llama (que antes ha buscado la cuenta) como "hay que
 * vincularla, no invitarla".
 */
export async function inviteAuthUser(email: string): Promise<AuthAdminResult<AuthAdminUser>> {
  const supabase = adminClient();

  if (supabase === null) {
    return { status: "not-configured" };
  }

  try {
    const { data, error } = await supabase.auth.admin.inviteUserByEmail(email);

    if (error || data.user === null) {
      logAdminFailure("invitar", error ?? "Respuesta sin usuario");

      return { status: "error", message: "No se ha podido enviar la invitación." };
    }

    return {
      status: "ok",
      data: { id: data.user.id, email: data.user.email ?? null },
    };
  } catch (error) {
    logAdminFailure("invitar", error);

    return { status: "error", message: "No se ha podido enviar la invitación." };
  }
}

/**
 * Banea (o desbanea) una cuenta de Auth.
 *
 * Es **best-effort**: sirve para cortar la sesión viva de alguien a quien se acaba
 * de dar de baja, pero la comprobación de verdad es la fila de `Admin`, que se lee
 * en cada petición. Por eso quien llama no aborta si esto falla: avisa de que la
 * sesión abierta no se ha cerrado y sigue.
 */
async function setBanned(userId: string, banned: boolean): Promise<AuthAdminResult<null>> {
  const supabase = adminClient();

  if (supabase === null) {
    return { status: "not-configured" };
  }

  try {
    const { error } = await supabase.auth.admin.updateUserById(userId, {
      ban_duration: banned ? BAN_DURATION : "none",
    });

    if (error) {
      logAdminFailure(banned ? "banear" : "desbanear", error);

      return { status: "error", message: "No se ha podido cambiar el estado de la cuenta." };
    }

    return { status: "ok", data: null };
  } catch (error) {
    logAdminFailure(banned ? "banear" : "desbanear", error);

    return { status: "error", message: "No se ha podido cambiar el estado de la cuenta." };
  }
}

/** Corta la sesión de una cuenta dada de baja (best-effort). */
export async function banAuthUser(userId: string): Promise<AuthAdminResult<null>> {
  return setBanned(userId, true);
}

/** Devuelve el acceso a una cuenta reactivada (best-effort). */
export async function unbanAuthUser(userId: string): Promise<AuthAdminResult<null>> {
  return setBanned(userId, false);
}
