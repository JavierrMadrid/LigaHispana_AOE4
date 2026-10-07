import { NextResponse, type NextRequest } from "next/server";

import {
  DISCORD_LINK_TTL_SECONDS,
  discordRedirectUri,
  getDiscordConfig,
  isDiscordOAuthConfigured,
} from "@/lib/discord/env";
import { DISCORD_LINK_COOKIE, DISCORD_STATE_COOKIE, signDiscordLink } from "@/lib/discord/link";
import { addMemberToGuild, exchangeCodeForToken, fetchCurrentUser } from "@/lib/discord/oauth";
import { canonicalDiscordUsername } from "@/lib/player-input";

/**
 * Callback del OAuth2 de Discord: donde la identidad firmada llega al formulario.
 *
 * Recibe el `code` de Discord, lo canjea por un token, pregunta quién es la persona,
 * intenta meterla en el servidor y escribe la cookie `discord_link` que
 * `registerPlayer` exige. Después redirige a `/participar`.
 *
 * ## El orden, y por qué el `state` se borra pase lo que pase
 *
 * 1. Se lee el `state` de la URL y se compara con el de la cookie, que **se borra
 *    en cuanto se lee y en todos los caminos**, incluido el de error: un `state` es de
 *    un solo uso, y dejarlo puesto dejaría que el mismo callback volviera a servir más
 *    tarde.
 * 2. Si la persona canceló en la pantalla de permisos, Discord manda
 *    `error=access_denied` y no hay `code`. Va a `?discord=cancel`, que no es un
 *    fallo: no ha pasado nada.
 * 3. Canje del `code` y `GET /users/@me`. Un fallo aquí **sí** es un error: sin
 *    identidad no hay cookie que escribir y no hay nada que guardar.
 * 4. Auto-unión con el bot. **Un fallo aquí no bloquea**: se marca `joined: false`, se
 *    escribe la cookie igualmente y se redirige a `?discord=ok`; el formulario
 *    enseñará la invitación de respaldo. La comprobación de las 12 h (entrega 2) lo
 *    detecta si sigue así.
 * 5. Cookie firmada y `?discord=ok`.
 *
 * ## El nombre se normaliza aquí, y es el único sitio donde se normaliza
 *
 * `GET /users/@me` devuelve el `username` **tal cual**, y ese valor puede venir en
 * mayúsculas (`Pepito`) o con el discriminador antiguo (`pepito#1234`). Lo que se
 * guarda —y lo que necesita el roster del servidor para encontrar esta cuenta— es la
 * forma canónica: **sin arroba y en minúsculas** (`canonicalDiscordUsername()`).
 *
 * Normalizar **aquí**, antes de firmar la cookie, es lo que deja la cookie, la página
 * del formulario y la fila de `Player` hablando del mismo dato con un solo punto de
 * normalización: si se normalizara más adelante, el mismo nombre tendría dos formas
 * según por dónde se mirara y la comparación del worker dejaría de ser una igualdad.
 * La interfaz **sí** pinta la arroba (`@pepito`) al Mostrarlo, porque es como se
 * escribe; eso es de quien la pinta, no de lo que se guarda.
 *
 * ## Por qué la URL solo lleva `discord=ok|cancel|error|no-config`
 *
 * **El motivo de un fallo va al log del servidor y nunca a la URL.** Una URL con el
 * detalle dentro acaba en el historial del navegador, en el `Referer` de la petición
 * siguiente y en cualquier proxy que la lea por el camino; y lo que hay que decir
 * ("el canje devolvió 401", "Discord no respondió") no le sirve de nada a quien solo
 * está intentando inscribirse. El formulario enseña un texto genérico y quien tenga
 * que diagnosticar mira `[discord]` en el log, como ya se hace con `[participar]` y
 * `[turnstile]`.
 *
 * ## El destino se compone sobre el host de la petición
 *
 * Igual que en `auth/confirm/route.ts`: se clona `request.nextUrl` y se sustituyen
 * ruta y query, de modo que el host lo pone siempre la petición. Aquí no hay un `next`
 * que filtrar, pero el criterio se mantiene porque es el mismo patrón.
 */

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** Cookie de `state`, con sus mismos atributos que en el arranque del OAuth. */
function borrarState(response: NextResponse): NextResponse {
  response.cookies.set(DISCORD_STATE_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/api/discord/oauth/callback",
    maxAge: 0,
  });

  return response;
}

export async function GET(request: NextRequest) {
  const config = getDiscordConfig();

  // Redirigir al formulario con un estado, borrando la cookie de `state` siempre.
  const volver = (estado: string) => {
    const url = request.nextUrl.clone();

    url.pathname = "/participar";
    url.search = "";
    url.searchParams.set("discord", estado);

    return borrarState(NextResponse.redirect(url));
  };

  // Sin configuración no hay nada que canjear, y el `state` tampoco se creó: se avisa
  // en el log y se vuelve al formulario sin cookie. El `linkSecret` se comprueba en la
  // misma guarda porque es el único campo de la configuración que se puede leer como
  // `null` **y** del que depende la firma, y `isDiscordOAuthConfigured()` ya lo exige.
  if (!isDiscordOAuthConfigured(config) || config.linkSecret === null) {
    console.warn(
      "[discord] Callback de OAuth sin credenciales completas: no hay vínculo que hacer.",
    );

    return volver("no-config");
  }

  const params = request.nextUrl.searchParams;
  const code = params.get("code");
  const state = params.get("state");
  const cookieState = request.cookies.get(DISCORD_STATE_COOKIE)?.value;

  // Cancelación: la persona dijo que no en la pantalla de permisos. No es un fallo y
  // no se registra como tal.
  if (params.get("error") !== null) {
    return volver("cancel");
  }

  // La comparación es un `===` y no un `timingSafeEqual`, a diferencia de la firma de
  // la cookie: aquí no hay un secreto que reconstruir, el `state` es un UUID al azar
  // que viene del servidor. Lo que protege esta comparación es que el `state` tenga
  // que estar **en la cookie de este navegador**, no que la comparación tarde poco.
  if (
    state === null ||
    code === null ||
    cookieState === undefined ||
    cookieState === "" ||
    state !== cookieState
  ) {
    console.warn("[discord] Callback con `state` ausente o distinto del de la cookie.");

    return volver("error");
  }

  let accessToken: string;
  let userId: string;
  let username: string;

  try {
    accessToken = await exchangeCodeForToken(
      config,
      code,
      discordRedirectUri(config, request.nextUrl.origin),
    );

    const user = await fetchCurrentUser(accessToken);

    userId = user.id;
    // Un solo punto de normalización en todo el camino: a partir de aquí el nombre
    // es el pelado y en minúsculas, que es la forma en que se guarda y en que el
    // roster del servidor lo trae. Ver el docblock de la ruta.
    username = canonicalDiscordUsername(user.username);
  } catch (error) {
    // El motivo literal se queda aquí. `DiscordError` ya garantiza que su mensaje no
    // lleva el `client_secret` ni el token de nadie.
    console.error("[discord] No se ha podido resolver la identidad:", describe(error));

    return volver("error");
  }

  // El auto-unión va **después** de tener la identidad y **no bloquea** (ver
  // `addMemberToGuild()`): la inscripción se acepta igual y la invitación queda como
  // respaldo en el formulario.
  const join = await addMemberToGuild(userId, accessToken);

  if (!join.joined) {
    console.warn(
      `[discord] El bot no ha podido unir a ${userId} al servidor: ${join.reason ?? "sin motivo"}. ` +
        "Se sigue con la inscripción y se engancha la invitación de respaldo.",
    );
  }

  const respuesta = volver("ok");

  respuesta.cookies.set(
    DISCORD_LINK_COOKIE,
    signDiscordLink({ userId, username, joined: join.joined }, config.linkSecret),
    {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      // El `path` es `/participar` y no `/`: la cookie solo la necesitan la página del
      // formulario y la Server Action que vive bajo ella, y estrecha el alcance de un
      // identificador que no tiene por qué viajar a `/` ni a `/api`.
      path: "/participar",
      maxAge: DISCORD_LINK_TTL_SECONDS,
    },
  );

  return respuesta;
}
