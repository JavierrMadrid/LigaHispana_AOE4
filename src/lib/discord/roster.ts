import "server-only";

import { isRecord } from "@/lib/json";
import { getDiscordConfig, isDiscordCheckConfigured, type DiscordConfig } from "./env";
import { createDiscordHttpClient, DiscordError } from "./http";
import type { DiscordRosterMember } from "./membership";

/**
 * La lista de miembros del servidor de Discord, que es lo que convierte la
 * comprobación de pertenencia en una sola lectura por pasada (F12).
 *
 * ## Qué gana con esto
 *
 * `GET /guilds/{guild_id}/members/{user_id}` (lo que usa `check.ts` cuando no hay
 * roster) responde sobre **una** cuenta. Con treinta participantes son treinta
 * peticiones cada doce horas para aprender, de cada una, un sí o un no. La lista de
 * miembros dice lo mismo de los treinta en `ceil(miembros / 1000)` peticiones, y de
 * paso trae algo que la consulta por id **no** puede dar: el `userId` de una cuenta
 * de la que solo se conoce el `@usuario`, que es exactamente lo que deja el alta de
 * admin, donde la organización escribe el `@usuario` que le dicen y no hay paso de
 * OAuth.
 *
 * ## La regla que manda sobre las demás: una lista vacía no es "no hay nadie"
 *
 * `GET /guilds/{guild_id}/members` **exige el intent privilegiado
 * `GUILD_MEMBERS`**, que solo se activa a mano en el Developer Portal. Sin él
 * Discord **no da error**: contesta `200` con `[]`. Leer eso como "el servidor está
 * vacío" afirmaría que las treinta cuentas están fuera del servidor y llenaría la
 * pestaña de Alertas de una tacada, así que aquí la forma del resultado lo hace
 * imposible de confundir:
 *
 * | Lectura | Resultado | Qué puede afirmar quien lo recibe |
 * |---|---|---|
 * | Lista con al menos un miembro | `{ status: "roster", members }` | sí o no por cada cuenta |
 * * Lista vacía, ilegible o a medias | `{ status: "unknown", reason }` | **nada** |
 *
 * Es el mismo modelado que el `unknown` de `discordMembershipVerdictFromStatus()`:
 * "no lo tengo" y "está mal" son estados distintos y quien llama escribe para el
 * primero. Ante un `unknown` no se escribe ni columna ni alerta y se cae a la
 * comprobación por id, que no necesita el intent.
 *
 * Las tres razones de `unknown` que no son un fallo de red:
 *
 * 1. **La lista ha salido vacía.** El caso del intent, o un servidor recién creado.
 * 2. **La lista está incompleta.** Se ha llegado al tope de páginas sin haber visto
 *    una página corta, o se ha agotado el plazo de la pasada. Un roster al que le
 *    falta la mitad afirmaría "no está en el servidor" de cuentas que sí están.
 * 3. **La lista no se entiende.** Un miembro sin `user.id` o sin `user.username` hace
 *    que **el roster entero** se descarte, y no solo esa entrada: descartar una
 *    entrada concreta y seguir con las demás significaría poder afirmar que un
 *    miembro que no se pudo leer no está en el servidor, que es justo lo que este
 *    módulo existe para no hacer.
 *
 * ## El parseo es defensivo, y sin `as`
 *
 * Lo trae el cliente HTTP de `http.ts` sin leer (esa es su frontera) y aquí se
 * convierte de `unknown` a `DiscordRosterMember` **validando**, con el mismo criterio
 * que el resto de la frontera con APIs externas de este repositorio: nunca un
 * `as` sobre la respuesta de la red, y un payload raro no se guarda.
 *
 * ## El secreto no aparece en ningún mensaje
 *
 * Igual que en `http.ts`: lo único que sale en el motivo de un `unknown` es lo que
 * el `DiscordError` ya garantiza (host, ruta y estado) y lo que dice este módulo.
 * El token del bot va en la cabecera y nunca se imprime.
 */

/**
 * Miembros por página.
 *
 * Mil es el máximo que acepta `GET /guilds/{id}/members`, y con el tope de páginas
 * de `config.rosterMaxPages` eso da un techo de veinte mil miembros por refresco.
 */
export const DISCORD_ROSTER_PAGE_SIZE = 1000;

/**
 * Lo que ha salido de leer la lista de miembros.
 *
 * `status: "unknown"` es el estado que **no permite afirmar nada**, y su motivo es
 * solo para el rastro de la pasada. `pages` está para que el rastro diga cuántas
 * peticiones ha costado de verdad.
 */
export type GuildRosterResult =
  | { status: "roster"; members: DiscordRosterMember[]; pages: number }
  | { status: "unknown"; reason: string };

function describe(error: unknown): string {
  if (error instanceof DiscordError) {
    return `${error.name} (${error.status ?? "sin respuesta"}): ${error.message}`;
  }

  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();

  return trimmed === "" ? null : trimmed;
}

/**
 * Los miembros de **una** página, o por qué no se han podido leer.
 *
 * Un miembro necesita `user.id` y `user.username`: el id es lo que decide la
 * pertenencia de quien ya lo tiene, y el `username` es lo que empareja al que solo
 * tiene `@usuario`. El `username` de Discord es el **nombre global** desde 2023, y
 * llega ya en la forma que la API devuelve; lo que no se normaliza aquí es lo que
 * guardó el enlace por OAuth en su día, que puede llevar el `#0000` antiguo o
 * mayúsculas, y eso lo resuelve `matchRosterUsername()`.
 *
 * Cualquier entrada que no se entienda devuelve `null` para el **roster entero**,
 * no solo para esa entrada: ver el tercer punto del docblock del módulo.
 */
function readRosterPage(
  payload: unknown,
): { members: DiscordRosterMember[] } | { reason: string } {
  if (!Array.isArray(payload)) {
    return { reason: `la respuesta no es una lista de miembros (${typeof payload}).` };
  }

  const members: DiscordRosterMember[] = [];
  const vistos = new Set<string>();

  for (const entrada of payload) {
    if (!isRecord(entrada)) {
      return { reason: "un miembro de la lista no es un objeto." };
    }

    const user = isRecord(entrada["user"]) ? entrada["user"] : null;
    const id = user === null ? null : readString(user["id"]);
    const username = user === null ? null : readString(user["username"]);

    if (id === null || username === null) {
      return { reason: "un miembro de la lista viene sin `user.id` o sin `user.username`." };
    }

    // Un mismo id dos veces no aporta nada y sí podría hacer que `matchRosterUsername()`
    // viera "ambiguo" donde en realidad es la misma cuenta.
    if (vistos.has(id)) {
      continue;
    }

    vistos.add(id);
    members.push({ id, username });
  }

  return { members };
}

/**
 * Lee la lista de miembros del servidor, paginada.
 *
 * ## La paginación
 *
 * `after` es un *snowflake*: Discord devuelve los miembros con id **mayor** que el
 * dado, así que el cursor es el id del último de la página. El bucle termina al ver
 * una página **corta** —la última, por definición— y solo para entonces se da por
 * buena la lista. Un id repetido en la misma página se salta, porque `after` no
 * avanzaría y el bucle no saldría.
 *
 * ## El tope de páginas es una condición de corrección, no de rendimiento
 *
 * `config.rosterMaxPages` no solo acota peticiones: llegar al tope **sin** haber visto
 * la última página significa que la lista tiene un hueco, y una lista con un hueco no
 * puede afirmar que alguien no está en el servidor. Por eso eso sale como `unknown` y
 * no como roster, aunque se hayan leído treinta mil miembros que sí son ciertos.
 *
 * ## El `signal` va entre páginas, no en la petición
 *
 * Igual que en `check.ts`: el cliente pone su propio `AbortSignal.timeout`, porque
 * una lectura del roster nunca debe quedar esperando al plazo global de una pasada
 * que está haciendo otras cosas. El `signal` se respeta **entre** páginas, que es
 * donde importa, y cortarlo ahí deja la lista incompleta —y por tanto `unknown`— en
 * vez de una lista a medias.
 */
export async function fetchGuildRoster(
  options: { config?: DiscordConfig; signal?: AbortSignal } = {},
): Promise<GuildRosterResult> {
  const config = options.config ?? getDiscordConfig();

  // Sin token o sin servidor no hay contra qué listar. Es el mismo aviso que deja
  // `checkDiscordMembership()` antes de llegar aquí, y no se duplica: quien llama ya
  // ha comprobado `isDiscordCheckConfigured()`.
  if (!isDiscordCheckConfigured(config)) {
    return {
      status: "unknown",
      reason: "sin DISCORD_BOT_TOKEN o DISCORD_GUILD_ID no se puede listar el servidor",
    };
  }

  const client = createDiscordHttpClient(config);
  const members: DiscordRosterMember[] = [];
  let after: string | undefined;
  let paginas = 0;
  /** `true` en cuanto se ve una página corta: es lo que prueba que se acabó la lista. */
  let listaCompleta = false;

  while (paginas < config.rosterMaxPages) {
    if (options.signal?.aborted === true) {
      break;
    }

    const query = new URLSearchParams({ limit: String(DISCORD_ROSTER_PAGE_SIZE) });

    if (after !== undefined) {
      query.set("after", after);
    }

    let payload: unknown;

    try {
      payload = await client.request(
        "GET",
        `/guilds/${config.guildId}/members?${query.toString()}`,
        { authorization: `Bot ${config.botToken}` },
      );
    } catch (error) {
      return { status: "unknown", reason: describe(error) };
    }

    const pagina = readRosterPage(payload);

    if ("reason" in pagina) {
      return { status: "unknown", reason: pagina.reason };
    }

    paginas += 1;
    members.push(...pagina.members);

    // Página corta = última. También cubre la lista vacía, que es el caso del intent
    // privilegiado ausente: se comprueba después, con su motivo propio.
    if (pagina.members.length < DISCORD_ROSTER_PAGE_SIZE) {
      listaCompleta = true;

      break;
    }

    const ultimo = pagina.members[pagina.members.length - 1];

    // Con el tope de `readRosterPage()` y esta comprobación no hay forma de llegar
    // aquí sin un último, pero el cursor no se inventa: si faltara, la lista se queda
    // incompleta y sale como `unknown`.
    if (ultimo === undefined) {
      break;
    }

    after = ultimo.id;
  }

  // La lista vacía se comprueba **antes** que la completitud porque es el caso que
  // de verdad se va a dar (el intent sin activar) y su motivo dice lo que hay que
  // hacer; la lista a medias con miembros ya leídos es el caso raro.
  if (members.length === 0) {
    return {
      status: "unknown",
      reason:
        "Discord ha devuelto la lista de miembros vacía. Suele ser el intent privilegiado " +
        "GUILD_MEMBERS sin activar en el Developer Portal, o que el bot no esté en el servidor.",
    };
  }

  if (!listaCompleta) {
    return {
      status: "unknown",
      reason:
        `la lista de miembros ha salido incompleta (${members.length} leídos en ` +
        `${paginas} ${paginas === 1 ? "página" : "páginas"}, tope DISCORD_ROSTER_MAX_PAGES=${config.rosterMaxPages}` +
        `${options.signal?.aborted === true ? ", plazo de la pasada agotado" : ""}).`,
    };
  }

  return { status: "roster", members, pages: paginas };
}
