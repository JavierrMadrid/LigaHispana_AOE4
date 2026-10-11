import { NextResponse, type NextRequest } from "next/server";

import {
  DISCORD_OAUTH_SCOPES,
  DISCORD_STATE_TTL_SECONDS,
  discordRedirectUri,
  getDiscordConfig,
  isDiscordOAuthConfigured,
} from "@/lib/discord/env";
import { DISCORD_STATE_COOKIE } from "@/lib/discord/link";

/**
 * Inicio del paso de Discord de la inscripción: donde manda al navegador a la
 * pantalla de permisos.
 *
 * Es un Route Handler y no un Server Action por una razón concreta: el destino es
 * **otro dominio** (discord.com), así que no hay ningún componente al que volver con
 * un resultado, y una redirección con `Set-Cookie` es justo lo que hace falta para
 * dejar el `state` preparado antes de salir.
 *
 * ## Lo que hace, en orden
 *
 * 1. Si el OAuth no está configurado, vuelve a `/participar?discord=no-config`. Es la
 *    degradación de F12: sin credenciales el paso no se exige, y pulsar un botón que
 *    lleva a una pantalla de error de Discord sería peor que no pintarlo. El aviso de
 *    configuración va al log del servidor, **nunca** a la URL: `?discord=no-config` no
 *    dice qué variable falta.
 * 2. Genera un `state` aleatorio, lo guarda en la cookie `discord_oauth_state` y lo
 *    manda en la URL de autorización. El callback lo compara y borra la cookie
 *    siempre (ver `callback/route.ts`): es lo que impide que un callback lanzado
 *    desde otra pestaña se enganche a esta inscripción.
 * 3. Redirige a `https://discord.com/oauth2/authorize` con los scopes
 *    `identify guilds.join`.
 *
 * ## `state` en cookie y no solo en la URL
 *
 * El `state` de OAuth es un valor aleatorio sin ningún dato dentro, y el callback lo
 * compara con el que hay en la cookie `discord_oauth_state`. Sin esa cookie, quien
 * quiera podría llamar a `/api/discord/oauth/callback?code=<uno>&state=<el que
 * quiera>` y el sitio no tendría cómo saber que ese viaje empezó en **este**
 * navegador y no en otro sitio.
 *
 * La cookie va con `httpOnly` y `sameSite: "lax"`: `lax` es lo que permite que la
 * vuelva una redirección que viene de otro dominio (una `strict` no la dejaría
 * pasar, que es justo el caso de OAuth), y `httpOnly` porque ningún script del sitio
 * lo necesita.
 *
 * ## Nada sensible sale en la URL
 *
 * El `state` es aleatorio y no lleva nada dentro; el `client_id` no es secreto (es
 * público en cualquier página de autorización); y el `client_secret` **no aparece en
 * este archivo**: se usa en `oauth.ts`, en el canje, dentro del cuerpo de un `POST` a
 * `discord.com`. La redirección se compone con `URLSearchParams`, que además se
 * encarga del `scope` con el espacio que Discord espera.
 */

/** A dónde vuelve el formulario cuando este paso no está configurado. */
const NO_CONFIG_DESTINO = "/participar?discord=no-config";

export async function GET(request: NextRequest) {
  const config = getDiscordConfig();

  if (!isDiscordOAuthConfigured(config)) {
    // El motivo no viaja en la URL: la respuesta es pública y no dice qué variable
    // falta. El log del servidor sí, que es donde se diagnostica.
    console.warn(
      "[discord] Se ha abierto el paso de OAuth sin credenciales completas: el paso no se exige. " +
        "Revisa DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_BOT_TOKEN y DISCORD_GUILD_ID.",
    );

    return NextResponse.redirect(new URL(NO_CONFIG_DESTINO, request.nextUrl.origin));
  }

  // El `crypto` global del runtime (workerd y Node 19+), no `node:crypto`: en un
  // Route Handler que se despliega en el Worker, lo que existe siempre es el global.
  const state = crypto.randomUUID();
  const redirectUri = discordRedirectUri(config, request.nextUrl.origin);

  const authorizeUrl = new URL("https://discord.com/oauth2/authorize");
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", config.clientId ?? "");
  authorizeUrl.searchParams.set("scope", DISCORD_OAUTH_SCOPES);
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);

  const response = NextResponse.redirect(authorizeUrl);

  // `secure` sigue al modo de ejecución, no al host: en producción el sitio se
  // sirve por HTTPS (el Custom Domain del Worker), y en desarrollo por HTTP, donde
  // una cookie `secure` no volvería nunca. Es el mismo criterio que usa `@supabase/ssr`
  // para las cookies de sesión.
  response.cookies.set(DISCORD_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/api/discord/oauth/callback",
    maxAge: DISCORD_STATE_TTL_SECONDS,
  });

  return response;
}
