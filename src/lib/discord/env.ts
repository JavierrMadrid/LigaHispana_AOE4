import "server-only";

import { readRuntimeEnv } from "@/lib/runtime-env";

/**
 * Configuración del vínculo con Discord (F12) y de la pertenencia al servidor.
 *
 * Es un módulo propio y no una ampliación de `aoe4world/env.ts` ni de
 * `streams/env.ts`, y por las dos mismas razones que ya explican esos docblocks:
 * son **servicios distintos con credenciales distintas** (el bot de Discord no
 * puede ser la clave de la Data API de YouTube ni al revés, y un error de
 * configuración tiene que poder decir qué variable falta y en qué servicio), y sus
 * presupuestos no tienen por qué ir unidos. Aquí además hay un tercero que los
 * otros dos no tienen: **un secreto propio para firmar la cookie** del vínculo, que
 * no es una credencial de Discord sino del sitio.
 *
 * Todas las lecturas van por `readRuntimeEnv` (bindings de Cloudflare primero y
 * `process.env` como reserva), nunca con `process.env` directo: en el Worker el
 * binding es lo único fiable (ver `src/lib/runtime-env.ts`).
 *
 * ## La degradación por defecto
 *
 * **Sin credenciales, el paso de Discord no se exige y no se pinta** (es el mismo
 * espíritu que el captcha, `src/lib/turnstile.ts`): el proyecto tiene que arrancar y
 * funcionar sin configurar nada nuevo, y una funcionalidad que depende de una
 * credencial se apaga sola en vez de romper lo que ya funciona. Las dos
 * preguntas que lo deciden son `isDiscordOAuthConfigured()` —lo que hace falta para
 * **inscribirse**— e `isDiscordCheckConfigured()` —lo que hace falta para
 * **comprobar** la pertenencia al servidor— porque no es lo mismo: sin credenciales
 * de OAuth la inscripción sigue sin Discord, y sin token de bot no hay nada que
 * comprobar aunque el vínculo exista.
 *
 * **En producción las dos son obligatorias** (ver `docs/OPERACION.md`), y el secreto
 * de firma es parte de la primera: sin él el vínculo no se puede habilitar, porque una
 * cookie firmada con una clave que esté en el repositorio no es una identidad, es una
 * pista.
 */

const DEFAULT_API_BASE = "https://discord.com/api/v10";
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_USER_AGENT = "LigaHispanaAOE4/0.1 (inscripción Discord)";

/**
 * Vida de la cookie `discord_link`, en segundos (20 minutos).
 *
 * Corta a propósito: la cookie lleva una **identidad** y solo tiene que sobrevivir
 * al tiempo que alguien tarda en rellenar el formulario, no al tiempo que tarda un
 * torneo. Con 20 minutos hay de sobra para leer el formulario y escribirlo, y tras
 * eso la puerta se cierra sola aunque la pestaña siga abierta.
 */
export const DISCORD_LINK_TTL_SECONDS = 20 * 60;

/**
 * Vida de la cookie de `state` (`discord_oauth_state`), en segundos (10 minutos).
 *
 * Es el equivalente del `state` de OAuth: un valor de un solo uso que guarda el
 * valor mientras la persona está en la pantalla de permisos de Discord y se borra
 * en el callback. Diez minutos es suficiente para decidir "sí" y muy corto para
 * que el valor sirva de algo más tarde.
 */
export const DISCORD_STATE_TTL_SECONDS = 10 * 60;

/**
 * Scopes que se piden a Discord.
 *
 * - `identify`: el mínimo para saber **quién** es la persona (id y nombre de
 *   usuario). Sin esto no hay `discordUserId` y el vínculo no prueba nada.
 * - `guilds.join`: lo que autoriza al bot a meter a alguien en el servidor sin
 *   que tenga que usar una invitación a mano. Sin este scope el paso de OAuth
 *   funciona pero el auto-unión falla siempre, así que se piden los dos juntos.
 *
 * Deliberadamente no se pide `guilds`: leer los servidores de la persona no lo
 * necesita nadie aquí y es un permiso más del que hay que justificar.
 */
export const DISCORD_OAUTH_SCOPES = "identify guilds.join";

/** Ruta del callback, tal y como se registra en el portal de Discord. */
export const DISCORD_CALLBACK_PATH = "/api/discord/oauth/callback";

/**
 * Tope de cuentas comprobadas por pasada, y su valor por defecto.
 *
 * Existe por el **despliegue**, no por el diseño, y es el mismo motivo que el de
 * `HISTORY_CHECK_MAX_PER_RUN`: al poner esto en marcha **todas** las filas con
 * `discordUserId` tienen `discordCheckedAt = null`, así que la primera pasada tendría
 * al torneo entero venciendo la caché a la vez. Con diez por pasada, treinta
 * participantes se escalonan en tres pasadas (unos quince minutos con el cron de
 * cinco minutos) y a partir de ahí el ritmo es de una comprobación por jugador cada
 * doce horas.
 *
 * Diez y no seis, porque **una** comprobación es **una** petición: la del historial
 * de partidas son hasta tres `HEAD` por jugador, así que allí el tope acota
 * peticiones y aquí acota comprobaciones. Y diez peticiones seguidas, una detrás de
 * otra, están muy por debajo del cubo documentado de la API de Discord (50 por
 * segundo y por ruta), así que el tope no está ahí por el servicio sino por el
 * presupuesto de CPU del Worker del plan Free, que es lo que manda en este
 * despliegue.
 *
 * Con el cron de cinco minutos, diez por pasada dan 2 880 comprobaciones al día, que
 * mantienen el ritmo de dos por jugador al día hasta unos 1 440 participantes. Si
 * algún día el torneo fuera más grande, esto es lo primero que habría que tocar, y
 * se toca con la variable de entorno.
 */
export const DISCORD_CHECK_MAX_PER_RUN = 10;

/**
 * Tope de páginas del roster, y su valor por defecto.
 *
 * Cada página trae hasta mil miembros, así que veinte páginas son **veinte mil
 * miembros**, muy por encima de un servidor de torneo. Es un tope de seguridad, no
 * de presupuesto: existe para que un servidor enorme (o un `after` que no advanced,
 * si Discord cambiara el orden) no convierta una pasada del worker en veinte
 * peticionesfollowed de una lista que no va a usarse nunca.
 *
 * Y el tope es también el que hace que una lista **incompleta no se pueda tomar por
 * buena**: si se llega al tope sin haber visto la última página, el resultado es
 * "no se ha podido comprobar" y no un roster con un hueco (ver `roster.ts`).
 */
export const DISCORD_ROSTER_MAX_PAGES = 20;

/**
 * Horas que se cachea la lista de miembros del servidor, por defecto.
 *
 * Es el mismo número que `DISCORD_CHECK_TTL_HOURS` y por el mismo motivo —quien
 * entra o sale del servidor tarda días—, pero son **dos relojes distintos**: este es
 * el del dato compartido por todos los jugadores y aquel el del veredicto de cada
 * fila. Se ajustan por separado porque el que de verdad cuesta es este: la lista
 * entera son `ceil(miembros / 1000)` peticiones, mientras que un veredicto es una
 * por jugador.
 */
export const DISCORD_ROSTER_TTL_HOURS = 12;

export type DiscordConfig = {
  /** Token del bot (`Authorization: Bot …`). `null` = sin bot, no se puede comprobar nada. */
  botToken: string | null;
  /** Id del servidor del torneo. `null` = sin servidor, no se puede auto-unir ni comprobar. */
  guildId: string | null;
  /** Client ID de la aplicación OAuth2. */
  clientId: string | null;
  /** Client secret de la aplicación OAuth2. Nunca sale del servidor. */
  clientSecret: string | null;
  /**
   * URI de redirección ya montada, o `null` si no se ha definido
   * `DISCORD_REDIRECT_URI`. Cuando es `null` se deriva del origen de la petición
   * más `DISCORD_CALLBACK_PATH` (ver `discordRedirectUri()`).
   */
  redirectUri: string | null;
  /** Invitación al servidor, solo como respaldo cuando el auto-unión falla. */
  inviteUrl: string | null;
  /**
   * Secreto con el que se firma la cookie `discord_link`, o `null` si no hay ninguno.
   *
   * Es el único campo que se lee **sin lanzar**, y es deliberado: leer la
   * configuración no puede ser la razón de que un envío público salga con un 500. Un
   * `null` aquí significa que el vínculo está apagado —`isDiscordOAuthConfigured()`
   * es `false` y ni el formulario lo pinta ni la acción lo exige—, no que haya algo
   * roto. Los dos caminos que sí necesitan firmar (el callback y la verificación)
   * comprueban antes que no sea `null`, o devuelven el fallo sin llegar a firmar.
   */
  linkSecret: string | null;
  /** Base de la API, sin barra final. */
  apiBase: string;
  /** Timeout por petición, en milisegundos. */
  timeoutMs: number;
  userAgent: string;
  /**
   * Tope de cuentas comprobadas por pasada, una por jugador (F12, entrega 2).
   *
   * Es el presupuesto duro del worker, y está aquí por lo mismo que
   * `maxChecksPerRun` en `streams/env.ts`: el plan Free de Cloudflare paga igual por
   * la petición que se hace que por la que no, y un torneo grande convertiría la
   * comprobación de pertenencia en la parte cara de la pasada. El valor por defecto
   * está en `DISCORD_CHECK_MAX_PER_RUN` y se ajusta por entorno sin desplegar.
   */
  maxChecksPerRun: number;
  /**
   * Tope de páginas de `GET /guilds/{id}/members` por refresco del roster.
   *
   * Es un tope de seguridad, no de presupuesto: veinte páginas son veinte mil
   * miembros, y un tope más alto solo serviría para alargar una pasada que no
   * debería ocurrir. Además marca el límite de lo que se puede dar por bueno: sin
   * haber visto la última página, la lista no sirve para afirmar que alguien **no**
   * está en el servidor (ver `roster.ts`).
   */
  rosterMaxPages: number;
  /**
   * Horas que se cachea el roster, en horas enteras.
   *
   * El valor por defecto está en `DISCORD_ROSTER_TTL_HOURS` (12) y es
   * independiente de `DISCORD_CHECK_TTL_HOURS`, que es el plazo del veredicto de
   * cada jugador: son dos relojes distintos porque el roster es un dato compartido
   * y el veredicto, uno por fila.
   */
  rosterTtlHours: number;
};

function readString(name: string): string | null {
  const raw = readRuntimeEnv(name)?.trim();

  return raw === undefined || raw === "" ? null : raw;
}

/**
 * Un entero de configuración, o el valor por defecto.
 *
 * **Avisa y usa el valor por defecto** en lugar de lanzar, a diferencia de
 * `aoe4world/env.ts`: allí la configuración se lee al renderizar una página pública
 * (`readDiscordStep()`) y en un endpoint público (`registerPlayer`), y un
 * `DISCORD_TIMEOUT_MS` mal escrito no puede ser la razón de que `/participar` devuelva un 500.
 * Es el mismo criterio que `readPositiveIntEnv()` en `src/lib/rate-limit.ts`: el valor
 * por defecto es el que protege y el aviso dice qué variable hay que corregir.
 */
function readPositiveInt(name: string, fallback: number): number {
  const raw = readRuntimeEnv(name)?.trim() ?? "";

  if (raw === "") {
    return fallback;
  }

  const value = Number(raw);

  if (!Number.isFinite(value) || value <= 0) {
    console.warn(
      `[discord] ${name} no es un número positivo (valor recibido: "${raw}"): se usa ${fallback}.`,
    );

    return fallback;
  }

  return Math.floor(value);
}

/**
 * Secreto con el que se firma la cookie del vínculo.
 *
 * `DISCORD_OAUTH_SECRET` es lo propio de este módulo; `CRON_SECRET` se acepta como
 * alternativa, igual que hace `readSalt()` en `src/lib/rate-limit.ts`, para no
 * obligar a tener tres secretos en el panel.
 *
 * A diferencia de la sal de reserva del rate limit, **aquí no hay valor de respaldo
 * en el código**: la cookie de este módulo lleva una identidad, y una firma hecha
 * con una clave pública del repositorio no impide falsificarla, solo la hace más
 * cómoda. Sin secreto se devuelve `null` y el vínculo queda apagado (y
 * `isDiscordOAuthConfigured()` es `false`), en vez de firmar con una clave conocida
 * o de hacer que leer la configuración reviente el formulario público.
 */
function readLinkSecret(): string | null {
  return readString("DISCORD_OAUTH_SECRET") ?? readString("CRON_SECRET");
}

export function getDiscordConfig(): DiscordConfig {
  return {
    botToken: readString("DISCORD_BOT_TOKEN"),
    guildId: readString("DISCORD_GUILD_ID"),
    clientId: readString("DISCORD_CLIENT_ID"),
    clientSecret: readString("DISCORD_CLIENT_SECRET"),
    redirectUri: readString("DISCORD_REDIRECT_URI"),
    inviteUrl: readString("DISCORD_INVITE_URL"),
    linkSecret: readLinkSecret(),
    apiBase: readString("DISCORD_API_BASE") ?? DEFAULT_API_BASE,
    timeoutMs: readPositiveInt("DISCORD_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
    userAgent: readString("DISCORD_USER_AGENT") ?? DEFAULT_USER_AGENT,
    maxChecksPerRun: readPositiveInt(
      "DISCORD_CHECK_MAX_PER_RUN",
      DISCORD_CHECK_MAX_PER_RUN,
    ),
    rosterMaxPages: readPositiveInt("DISCORD_ROSTER_MAX_PAGES", DISCORD_ROSTER_MAX_PAGES),
    rosterTtlHours: readPositiveInt("DISCORD_ROSTER_TTL_HOURS", DISCORD_ROSTER_TTL_HOURS),
  };
}

/**
 * ¿Está configurado el paso de Discord de la inscripción?
 *
 * Es lo que decide **tres** cosas a la vez, y por eso conviene que la respuesta
 * venga de un solo sitio: si el formulario pinta el botón, `registerPlayer` exige
 * la cookie y el callback del OAuth está activo. Que uno de los tres se aparte de
 * los otros dos es exactamente el fallo que hace que alguien rellene el formulario
 * entero y no pueda enviarlo.
 *
 * Exige las cinco cosas: `clientId` y `clientSecret` (el canje del código), el
 * token del bot y el id del servidor (el auto-unión, que es parte del mismo paso)
 * y el secreto de firma (sin él la cookie no valdría nada).
 */
export function isDiscordOAuthConfigured(config: DiscordConfig = getDiscordConfig()): boolean {
  return (
    config.clientId !== null &&
    config.clientSecret !== null &&
    config.botToken !== null &&
    config.guildId !== null &&
    config.linkSecret !== null
  );
}

/**
 * ¿Se puede comprobar si una cuenta está en el servidor?
 *
 * Solo hacen falta el token del bot y el id del servidor: es la comprobación de la
 * entrega 2 (`GET /guilds/{guild_id}/members/{user_id}`), que no depende del OAuth
 * y por eso puede estar puesta aunque el paso de inscripción todavía no lo esté.
 *
 * Es un **guard de tipo**, no un `boolean`: con `true` además queda estrecho que
 * `config.botToken` y `config.guildId` son cadenas, y quien llama (`check.ts`) los
 * necesita para componer la ruta y la cabecera sin repetir la condición ni escribir
 * un valor de relleno que ya no sería cierto.
 *
 * **Que sea `true` no significa que el roster se pueda leer.** `GET
 * /guilds/{id}/members` exige el intent privilegiado `GUILD_MEMBERS`, que se activa
 * en el Developer Portal y no se puede pedir por API; sin él Discord contesta `200`
 * con la lista vacía. Por eso la comprobación por `id` (que no necesita el intent)
 * es el camino de reserva, y el roster vacío es "no se ha podido comprobar" y no
 * "no hay nadie dentro" (ver `roster.ts` y `docs/OPERACION.md`).
 */
export function isDiscordCheckConfigured(
  config: DiscordConfig = getDiscordConfig(),
): config is DiscordConfig & { botToken: string; guildId: string } {
  return config.botToken !== null && config.guildId !== null;
}

/**
 * URI de redirección que se manda a Discord y en la que se registra el callback.
 *
 * `DISCORD_REDIRECT_URI` manda si está definida: es lo que hay que registrar en el
 * portal de Discord y conviene que sea **explícito**, porque un valor derivado del
 * origen de la petición cambia con el host (`localhost` en desarrollo, un
 * `*.workers.dev` en un Preview, el dominio en producción) y Discord solo acepta
 * los que están registrados. Cuando no está definida se deriva del origen, que es
 * lo que hace que funcione en desarrollo sin configurar nada.
 */
export function discordRedirectUri(config: DiscordConfig, origin: string): string {
  if (config.redirectUri !== null) {
    return config.redirectUri;
  }

  return `${origin.replace(/\/+$/, "")}${DISCORD_CALLBACK_PATH}`;
}
