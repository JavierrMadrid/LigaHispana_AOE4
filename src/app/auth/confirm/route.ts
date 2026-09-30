import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Destino por defecto de un enlace verificado: la pantalla donde el invitado fija
 * su contraseña. Viene en el propio enlace (`&next=...`) y esta constante es lo
 * que se usa cuando no viene o no vale.
 */
const DEFAULT_NEXT = "/login/establecer-contrasena";

/** Clave de error de `/login` (ver README, "Alta de admins por invitación"). */
const ERROR_LINK = "enlace";

/**
 * Tipos de token que acepta la librería para un enlace de correo
 * (`EmailOtpType`), menos los de SMS, que no viajan con `token_hash`.
 *
 * El tipo llega en la URL, así que no se confía en él: se contrasta contra esta
 * lista antes de llamar a `verifyOtp`. La lista cubre la invitación y la
 * recuperación, de modo que el mismo mecanismo sirve para el "he olvidado la
 * contraseña"; el resto se admiten porque son los que documenta la librería.
 */
const ALLOWED_OTP_TYPES: ReadonlySet<string> = new Set([
  "invite",
  "recovery",
  "magiclink",
  "email",
  "signup",
  "email_change",
]);

/** Caracteres de control, que en una cabecera o en una URL no tienen sentido. */
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

/**
 * El destino del enlace solo puede ser una ruta de este sitio.
 *
 * `next` viene del correo, o sea de fuera, así que se filtra antes de usarse en
 * una redirección: tiene que empezar por una sola `/`. Con eso se descartan las
 * URL absolutas (`https://otro-sitio`) y las protocolo-relativas (`//otro-sitio`,
 * que el navegador lee como otro host); la barra invertida se descarta porque
 * algunos navegadores la normalizan a `/` y `/\otro-sitio` acabaría siendo
 * protocolo-relativa igual.
 */
function safeNext(raw: string | null): string {
  if (raw === null || raw === "") {
    return DEFAULT_NEXT;
  }

  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) {
    return DEFAULT_NEXT;
  }

  if (CONTROL_CHARS.test(raw)) {
    return DEFAULT_NEXT;
  }

  return raw;
}

/**
 * Redirección construida sobre la URL de la petición: el destino aporta ruta y
 * query, el host lo pone siempre `request.nextUrl`. Es lo que hace que un
 * `next` manipulado no pueda sacar a nadie del sitio.
 *
 * Reutilizar `request.nextUrl.clone()` no pierde la sesión que acaba de escribir
 * el cliente de Supabase: en un Route Handler `cookies()` sí es escribible
 * (`createRequestStoreForAPI` deja la fase en `action`) y Next fusiona sus
 * `Set-Cookie` con la respuesta devuelta, redirección incluida
 * (`appendMutableCookies`, en `route-modules/app-route/module.js`). Es la
 * diferencia con un Server Component, donde ese mismo `set` se traga.
 */
function redirectTo(request: NextRequest, path: string, error?: string): NextResponse {
  // El base solo sirve para partir la ruta en sus trozos; el host no sale de aquí.
  const target = new URL(path, "http://localhost");
  const url = request.nextUrl.clone();

  // Se sustituye la query entera, no se añaden parámetros: así el `token_hash`
  // no viaja al destino.
  url.pathname = target.pathname;
  url.search = target.search;

  if (error !== undefined) {
    url.searchParams.set("error", error);
  }

  return NextResponse.redirect(url);
}

/**
 * Verificación en servidor del enlace de correo (invitación, recuperación o
 * confirmación) y canje por una sesión de Supabase Auth.
 *
 * El enlace por defecto de Supabase deja la sesión en el **fragmento**, que el
 * navegador nunca envía al servidor: sin una ruta que la consuma, la web no
 * sabía quién acababa de entrar. Aquí la sesión se verifica contra Auth, se
 * guarda en cookies con `@supabase/ssr` y solo entonces se redirige.
 *
 * Los fallos (token caducado, ya usado, tipo no admitido o enlace sin
 * `token_hash`) van todos a `/login?error=enlace`: el login enseña un mensaje
 * genérico y quien llega desde el correo puede reintentar, sin que la ruta
 * llegue a decir por qué falló el token.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const tokenHash = searchParams.get("token_hash");
  const rawType = searchParams.get("type");

  if (tokenHash === null || tokenHash === "" || rawType === null || !ALLOWED_OTP_TYPES.has(rawType)) {
    console.warn("[auth] confirm: enlace sin token_hash o con tipo no admitido.");

    return redirectTo(request, "/login", ERROR_LINK);
  }

  const supabase = await createSupabaseServerClient();

  const { error } = await supabase.auth.verifyOtp({
    type: rawType as EmailOtpType,
    token_hash: tokenHash,
  });

  if (error) {
    // Un enlace caducado o ya usado es el caso normal de quien se lo pasa tarde,
    // no un fallo de la web: entra al log como aviso y no como error.
    console.warn(`[auth] confirm: ${error.name}: ${error.message}`);

    return redirectTo(request, "/login", ERROR_LINK);
  }

  return redirectTo(request, safeNext(searchParams.get("next")));
}