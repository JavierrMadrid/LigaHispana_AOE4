/**
 * La pertenencia al servidor de Discord: cuándo toca comprobar y qué se puede
 * concluir de una respuesta (F12, entrega 2).
 *
 * ## Por qué este módulo existe y es **puro**
 *
 * La comprobación es una petición a la API de Discord y su escritura va a `Player`,
 * así que quien la hace es el worker del sincronizador (`src/lib/discord/check.ts`,
 * que es server-only y habla con la base de datos). Pero **decidir** qué se afirma
 * con lo que respondeu Discord no necesita ni red ni base de datos, y es
 * justamente la parte que no se puede dejar suelta: un `unknown` es la diferencia
 * entre "el jugador no está en el servidor" (una alerta) y "no se ha podido
 * comprobar" (nada), y leerlo mal convertiría un corte de red en una acusación.
 *
 * Por eso el módulo no lleva `import "server-only"` a propósito: no lee nada que
 * sea del servidor, no importa nada de servidor y se puede comprobar entero con
 * fechas y números escritos a mano en `tests/unit/lib/discord/membership.test.ts`.
 * Es el mismo reparto que en `src/lib/history-visibility.ts` (la parte pura) y
 * `src/lib/history-checks.ts` (la que sale a la red), y el mismo criterio que en
 * `probeHistoryVisibility()`: **solo un `404` afirma algo**.
 *
 * ## La regla que manda sobre las demás
 *
 * | Respuesta | Veredicto | Qué escribe quien llama |
 * |---|---|---|
 * | `200` | `member` | `discordInGuild = true` + `discordCheckedAt` |
 * | `404` | `not-member` | `discordInGuild = false` + `discordCheckedAt` + alerta |
 * | cualquier otra, un timeout, un error de red | `unknown` | **nada** |
 *
 * El caso que hay que tener delante es el último: un `5xx`, un `401` (el token del
 * bot caducado) o un corte de red **no** significan que la cuenta esté fuera del
 * servidor. Escribir un `false` por un `5xx` publicaría una afirmación que no se
 * sabe, y por eso de un `unknown` no se escribe ni columna ni alerta: el jugador
 * vuelve a la cola en la siguiente pasada, porque su `discordCheckedAt` sigue viejo.
 *
 * ## Y el roster, que decide lo mismo con otra lectura
 *
 * Con una lectura de la lista de miembros del servidor (`src/lib/discord/roster.ts`)
 * la misma pregunta se responde para **todos** los jugadores sin una petición por
 * jugador, así que hay un camino más. Con ese criterio ya resuelto, lo único que
 * queda por decidir aquí son las dos cosas puras de ese camino —cuándo hay que
 * refrescar la lista y cómo se busca en ella un `@usuario`—, y las dos tienen el
 * mismo cuidado: un `unknown` y un "no encontrado" **no son lo mismo**, y por eso el
 * segundo se devuelve con su propio valor en vez de como `false`.
 */

/* -------------------------------------------------------------------------- */
/* Constantes                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Cuánto se cachea el veredicto, en horas. **12 h**, la misma cifra que usa el sondeo
 * del historial de partidas y por el mismo motivo: el worker corre cada ~5 minutos,
 * así que comprobar en cada pasada sería una petición por jugador cada cinco minutos
 * para no aprender nada nuevo.
 *
 * Es caché y no "una comprobación por algo que haya pasado" porque el dato es
 * lento: a alguien le da por salir del servidor del torneo, y eso tarda días.
 */
export const DISCORD_CHECK_TTL_HOURS = 12;

/** El plazo de la caché en milisegundos, que es como se compara con un `Date`. */
export const DISCORD_CHECK_TTL_MS = DISCORD_CHECK_TTL_HOURS * 3_600_000;

/**
 * Estado con el que Discord confirma que la cuenta **es** miembro del servidor.
 *
 * Es el único `2xx` que devuelve `GET /guilds/{guild_id}/members/{user_id}`: la
 * respuesta es el objeto de miembro. El `204` del auto-unión es de otra ruta
 * (`PUT`) y no llega aquí.
 */
export const DISCORD_MEMBER_STATUS = 200;

/**
 * Estado con el que Discord dice que la cuenta **no** está en el servidor.
 *
 * Discord responde `404 Unknown Member` cuando la cuenta no es miembro del servidor
 * indicado, y también cuando el servidor no existe o el bot no está en él. Las tres
 * cosas **sí** son "no lo tengo", así que el `404` sigue siendo la única respuesta
 * que afirma algo: si el servidor se hubiera borrado o el bot se hubiera caído del
 * él, la alerta seguiría siendo cierta —nadie está en el servidor— y se corrige
 * desde el panel de Discord sin volver a desplegar nada.
 */
export const DISCORD_MISSING_STATUS = 404;

/* -------------------------------------------------------------------------- */
/* Veredicto                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Lo que se ha podido concluir sobre una cuenta de Discord.
 *
 * - `member`: la API ha confirmado que está en el servidor.
 * - `not-member`: la API ha dicho que no lo está (un `404`). Es un hecho.
 * - `unknown`: **no se ha podido comprobar**. Nunca es una acusación: quien recibe
 *   esto no escribe nada y lo vuelve a mirar en la siguiente pasada.
 */
export type DiscordMembershipVerdict = "member" | "not-member" | "unknown";

/**
 * Traduce el estado HTTP de la llamada al veredicto, y solo al veredicto.
 *
 * | Estado | Veredicto |
 * |---|---|
 * | `200` | `member` |
 * | `404` | `not-member` |
 * | `401`, `403`, `429`, `5xx`, un `3xx`, `null` (no hubo respuesta) | `unknown` |
 *
 * **`null` es `unknown`, no `not-member`.** Es el caso que más importa: un timeout
 * o un corte de red dejan `Player.discordInGuild` como estaba y no generan alerta,
 * mientras que un `5xx` leído como "no está" avisaría de todos los participantes a
 * la vez en cuanto Discord tuviera un rato malo.
 *
 * Un `2xx` que no sea `200` tampoco afirma nada: no son ni "lo tengo" ni "no lo
 * tengo", así que no se pueden convertir en un veredicto. Y por eso esta función
 * recibe **solo** el estado: si además leyera el cuerpo de la respuesta, un payload
 * raro podría acabar decidiendo por un jugador.
 */
export function discordMembershipVerdictFromStatus(
  status: number | null,
): DiscordMembershipVerdict {
  if (status === DISCORD_MEMBER_STATUS) {
    return "member";
  }

  if (status === DISCORD_MISSING_STATUS) {
    return "not-member";
  }

  return "unknown";
}

/* -------------------------------------------------------------------------- */
/* Cuándo hay que comprobar                                                    */
/* -------------------------------------------------------------------------- */

/**
 * ¿Ha vencido la caché de este jugador?
 *
 * `null` = nunca comprobado, y entonces toca. Es **el mismo criterio** que
 * `historyCheckIsDue()` en `src/lib/history-visibility.ts`, incluido el `>=` del
 * borde: comprobar exactamente a las doce horas cuenta como vencido, que es lo que
 * hace que dos comprobaciones nunca se solapen por un redondeo.
 *
 * Va suelto y no solo dentro de quien decide, por el mismo motivo que allí: quien
 * tiene que decidir **a quién** preguntar es el worker, y para eso necesita la
 * respuesta sin leer nada más. Preselecciona con esto y luego llama a la
 * comprobación, que usa **esta misma función**, así que las dos no pueden
 * desincronizarse.
 *
 * El plazo se puede acortar por parámetro, que es lo que le serviría a quien
 * quisiera reintentar antes de que se cumpliesen las doce horas.
 */
export function discordCheckIsDue(
  discordCheckedAt: Date | null,
  now: Date,
  ttlMs: number = DISCORD_CHECK_TTL_MS,
): boolean {
  return discordCheckedAt === null || now.getTime() - discordCheckedAt.getTime() >= ttlMs;
}

/* -------------------------------------------------------------------------- */
/* El roster del servidor                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Cuánto se cachea la lista de miembros del servidor, en horas. **12 h**, la misma
 * cifra que la del veredicto por jugador y por el mismo motivo: quien entra o sale
 * del servidor tarda **días**, y la lista entera es una petición por cada mil
 * miembros, así que refrescarla en cada pasada (288 al día) sería gastar una
 * petición más para no aprender nada.
 *
 * El valor por defecto sale de `DiscordConfig.rosterTtlHours` (variable
 * `DISCORD_ROSTER_TTL_HOURS`) y aquí está como respaldo, para que quien llame sin
 * configuración y los tests compartan una sola cifra.
 */
export const DISCORD_ROSTER_TTL_HOURS = 12;

/** El plazo de la caché del roster en milisegundos, que es como se compara. */
export const DISCORD_ROSTER_TTL_MS = DISCORD_ROSTER_TTL_HOURS * 3_600_000;

/**
 * ¿Hay que volver a traer la lista de miembros del servidor?
 *
 * `null` = nunca se ha traído, y entonces toca. El criterio es **el mismo** que
 * `discordCheckIsDue()` y con el mismo `>=` en el borde, por el mismo motivo: dos
 * comprobaciones no se solapan nunca por un redondeo, y el plazo se puede acortar
 * por parámetro.
 *
 * No es la caché del veredicto de cada jugador (esa vive en `Player.discordCheckedAt`)
 * sino la del **dato compartido**: el roster alimenta a todos, así que su plazo es
 * independiente del de cada fila.
 */
export function rosterIsDue(
  fetchedAt: Date | null,
  now: Date,
  ttlMs: number = DISCORD_ROSTER_TTL_MS,
): boolean {
  return fetchedAt === null || now.getTime() - fetchedAt.getTime() >= ttlMs;
}

/**
 * Un miembro del roster, tal y como lo guarda y lo compara quien lo lee.
 *
 * `username` es el **nombre global** ya en forma canónica (sin arroba, en
 * minúsculas), porque quien lo trae es `roster.ts` y ese es el único sitio donde se
 * normaliza. `id` es el *snowflake*, y es lo único inequívoco: un nombre se puede
 * cambiar y dos nombres iguales solo pueden convivir si el roster está incompleto.
 */
export type DiscordRosterMember = {
  id: string;
  username: string;
};

/**
 * Qué se ha podido resolver de un `@usuario` dentro del roster.
 *
 * Los tres casos son distintos y ninguno es "no está en el servidor":
 *
 * - `{ id }`: hay **una** coincidencia exacta y su cuenta. Es un hecho, y quien
 *   llama puede escribir el `discordUserId`.
 * - `"ambiguo"`: **más de una** coincidencia exacta. Es lo único que puede pasar si
 *   la lista está incompleta o si Discord admitió nombres repetidos; con la unicidad
 *   de `Player.discordUsername` no puede ser un problema de la base, así que quien
 *   llama **no escribe nada** y avisa.
 * - `"no-encontrado"`: no hay ninguna coincidencia. Es un hecho sobre el `@usuario`,
 *   no sobre una cuenta concreta: puede que la persona no se haya unido al servidor.
 */
export type DiscordRosterMatch = { id: string } | "ambiguo" | "no-encontrado";

/**
 * Busca en el roster la cuenta cuyo `@usuario` es exactamente el guardado.
 *
 * ## Por qué es una igualdad y no un "parecido"
 *
 * Porque los dos lados llegan ya en **forma canónica** (`canonicalDiscordUsername()`
 * en quien trae cada uno) y solo hay que ponerse de acuerdo en las mayúsculas. No
 * hay que quitar arrobas ni discriminadores de nada: lo que se guarda es el nombre
 * pelado, y lo que trae el roster también. Un "empieza por" o un `includes` convertirían
 * a `pepito` en un acierto dentro del servidor, que es exactamente la cuenta que
 * este módulo tiene que distinguir.
 *
 * ## Por qué devuelve `ambiguo` en vez de quedarse con la primera
 *
 * Porque con más de una coincidencia exacta **no se puede elegir**, y elegir una
 * sería escribir un `discordUserId` que podría ser el de otra persona. Es un caso
 * que en teoría no ocurre (Discord no admite dos nombres iguales), así que está
 * para que un roster raro no acabe con una identidad inventada. Dos filas con el
 * **mismo id** no cuentan como dos: son la misma cuenta.
 */
export function matchRosterUsername(
  guardado: string,
  roster: readonly DiscordRosterMember[],
): DiscordRosterMatch {
  const buscado = guardado.trim().toLowerCase();

  let encontrado: string | null = null;

  for (const miembro of roster) {
    if (miembro.username.trim().toLowerCase() !== buscado) {
      continue;
    }

    // La misma cuenta puede aparecer dos veces en la lista que se le pase —una caché
    // escrita a mano, una página repetida— y eso no son dos coincidencias: es una.
    if (encontrado === miembro.id) {
      continue;
    }

    // Dos coincidencias exactas de cuentas distintas: no se puede saber cuál es la
    // buena, y quedarse con la primera sería afirmar algo que el roster no afirma.
    if (encontrado !== null) {
      return "ambiguo";
    }

    encontrado = miembro.id;
  }

  return encontrado === null ? "no-encontrado" : { id: encontrado };
}