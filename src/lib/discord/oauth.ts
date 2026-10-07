import "server-only";

import { isRecord } from "@/lib/json";
import { getDiscordConfig, type DiscordConfig } from "./env";
import { createDiscordHttpClient, DiscordError, type DiscordHttpClient } from "./http";

/**
 * Las tres llamadas de OAuth2 y de pertenencia al servidor, ya tipadas.
 *
 * Son tres, y las tres están aquí porque son **un solo paso** para quien lo vive:
 * el botón "Conectar con Discord" de `/participar` va a la pantalla de permisos,
 * vuelve al callback y, sin que la persona haga nada más, sale una cookie firmada
 * con su identidad y ya está en el servidor del torneo. Que el canje del código y la
 * lectura de `GET /users/@me` estuvieran en módulos distintos no pondría ninguna
 * barrera entre ellos: no hay nada que comprobar entre una cosa y otra.
 *
 * ## Los scopes y el orden
 *
 * `identify guilds.join` (ver `DISCORD_OAUTH_SCOPES`). El **auto-unión va después**
 * de leer la identidad y no antes, por una razón que no es de orden: sin el
 * `access_token` del usuario no hay nada que mandar en el `PUT`, y con la identidad
 * ya conocida el log de un fallo puede nombrar al usuario sin exponer el token.
 *
 * ## El auto-unión no bloquea la inscripción
 *
 * `addMemberToGuild()` **no lanza** cuando Discord rechaza la unión: devuelve
 * `{ joined: false, reason }` y quien llama sigue. Es una decisión de producto ya
 * cerrada con el cliente (F12): si al bot le falta el permiso `CREATE_INSTANT_INVITE`
 * o la persona ya estaba dentro de un servidor en el que el bot no está, la
 * inscripción **se acepta igual**, se marca `joined = false` y el formulario enseña
 * la invitación como respaldo. Bloquear ahí dejaría fuera a alguien que sí cumple,
 * por un problema de configuración nuestro —el mismo criterio que ya se aplica en
 * `findCountryIsoConflict()` y en `probeHistoryVisibility()`.
 *
 * Lo que sí bloquea es un fallo de **identidad**: sin `GET /users/@me` no hay
 * `discordUserId`, y sin eso la cookie no identifica a nadie. Eso sí sale como
 * `?discord=error`.
 */

/** Identidad de Discord de una persona, tal y como la devuelve `GET /users/@me`. */
export type DiscordUser = {
  /** Id de la cuenta. Es un *snowflake* de Discord y va como `String`. */
  id: string;
  /** Nombre de usuario global (`nombre`, `nombre#1234` o el nuevo sin discriminante). */
  username: string;
};

/** Resultado de intentar meter a alguien en el servidor del torneo. */
export type GuildJoinResult = {
  /** `true` solo si Discord ha confirmado con un `2xx`. */
  joined: boolean;
  /** Motivo del fallo, solo para el log del servidor. `null` si se unió. */
  reason: string | null;
};

export type DiscordOAuthOptions = {
  /** Cliente alternativo, para verificar sin salir a la red. */
  client?: DiscordHttpClient;
  config?: DiscordConfig;
};

function readString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();

  return trimmed === "" ? null : trimmed;
}

function describe(error: unknown): string {
  if (error instanceof DiscordError) {
    return `${error.name} (${error.status ?? "sin respuesta"}): ${error.message}`;
  }

  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * Canjea el `code` del callback por un `access_token` de la persona.
 *
 * Es un `POST /oauth2/token` con `grant_type=authorization_code`: el cuerpo lleva el
 * `client_secret`, así que **es la única petición de este módulo que no puede
 * reintentarse sin consecuencias** —Discord invalida el `code` en el primer canje—, y
 * por eso el cliente HTTP no reintenta nada (ver el docblock de `http.ts`).
 */
export async function exchangeCodeForToken(
  config: DiscordConfig,
  code: string,
  redirectUri: string,
  options: DiscordOAuthOptions = {},
): Promise<string> {
  const client = options.client ?? createDiscordHttpClient(config);

  const payload = await client.request("POST", "/oauth2/token", {
    form: new URLSearchParams({
      client_id: config.clientId ?? "",
      client_secret: config.clientSecret ?? "",
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
  });

  const token = isRecord(payload) ? readString(payload.access_token) : null;

  if (token === null) {
    throw new DiscordError(
      "El canje del código de Discord devolvió una respuesta sin `access_token`.",
      null,
    );
  }

  return token;
}

/**
 * `GET /users/@me`: la identidad de la persona que acaba de autorizar.
 *
 * Nunca devuelve `null`: si el payload no tiene `id` o `username` es que no se
 * entiende, y en ese caso **no hay identidad que comprobar**, así que se lanza y el
 * callback devuelve el formulario con un error en vez de escribir una cookie con
 * medio contenido.
 */
export async function fetchCurrentUser(
  accessToken: string,
  options: DiscordOAuthOptions = {},
): Promise<DiscordUser> {
  const config = options.config ?? getDiscordConfig();
  const client = options.client ?? createDiscordHttpClient(config);

  const payload = await client.request("GET", "/users/@me", {
    authorization: `Bearer ${accessToken}`,
  });

  const id = isRecord(payload) ? readString(payload.id) : null;
  const username = isRecord(payload) ? readString(payload.username) : null;

  if (id === null || username === null) {
    throw new DiscordError(
      "La respuesta de `GET /users/@me` de Discord no trae `id` y `username`.",
      null,
    );
  }

  return { id, username };
}

/**
 * `PUT /guilds/{guild_id}/members/{user_id}`: mete a la persona en el servidor.
 *
 * El `access_token` de la persona va en el **cuerpo**, y la autorización es el bot
 * (`Bot <token>`), que es la forma que define Discord para el auto-unión: el bot
 * necesita el permiso `CREATE_INSTANT_INVITE` y el usuario necesita el scope
 * `guilds.join`. Discord responde `201` si lo ha unido y `204` si ya estaba dentro,
 * así que los dos `2xx` valen.
 *
 * **Nunca lanza**: devuelve `{ joined: false, reason }` con el motivo, que es lo que
 * permite que la inscripción no se bloquee por un problema de configuración del bot
 * (ver el docblock del módulo).
 */
export async function addMemberToGuild(
  userId: string,
  accessToken: string,
  options: DiscordOAuthOptions = {},
): Promise<GuildJoinResult> {
  const config = options.config ?? getDiscordConfig();

  if (config.botToken === null || config.guildId === null) {
    return {
      joined: false,
      reason: "sin DISCORD_BOT_TOKEN o DISCORD_GUILD_ID no se puede auto-unir",
    };
  }

  const client = options.client ?? createDiscordHttpClient(config);

  try {
    await client.request("PUT", `/guilds/${config.guildId}/members/${userId}`, {
      authorization: `Bot ${config.botToken}`,
      json: { access_token: accessToken },
    });

    return { joined: true, reason: null };
  } catch (error) {
    // El token del bot no va al log, y `DiscordError` ya lo garantiza: su mensaje
    // solo lleva la ruta y el estado.
    return { joined: false, reason: describe(error) };
  }
}
