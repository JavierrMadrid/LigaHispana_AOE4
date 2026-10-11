import "server-only";

import { AlertKind, AlertRule, PlayerStatus } from "@/generated/prisma/enums";
import { buildTriggeredAlert, SELF_SUBJECT, type TriggeredAlert } from "@/lib/alerts";
import { db } from "@/lib/db";
import { getDiscordConfig, isDiscordCheckConfigured, type DiscordConfig } from "./env";
import { createDiscordHttpClient, DiscordError, type DiscordHttpClient } from "./http";
import {
  DISCORD_MEMBER_STATUS,
  discordCheckIsDue,
  discordMembershipVerdictFromStatus,
  matchRosterUsername,
  rosterIsDue,
  type DiscordMembershipVerdict,
  type DiscordRosterMember,
} from "./membership";
import { fetchGuildRoster } from "./roster";
import { readDiscordRosterCache, writeDiscordRosterCache } from "./roster-cache";

/**
 * La pertenencia al servidor de Discord de cada participante, una vez por pasada del
 * sincronizador (F12).
 *
 * ## Qué es esta regla
 *
 * El vínculo por OAuth2 de la inscripción dice **quién** es la persona en Discord
 * (`Player.discordUserId`), pero no que esa cuenta siga en el servidor del torneo: se
 * puede salir en cualquier momento y desde entonces la organización no tiene por
 * dónde hablar con quien se inscribió. Así que el worker lo comprueba una vez cada
 * doce horas por jugador y, si la respuesta es que no está dentro, deja una alerta
 * `DISCORD_NOT_IN_GUILD` para que alguien mire.
 *
 * ## Dos caminos, y cuál manda
 *
 * | | Peticiones | Qué resuelve |
 * |---|---|---|
 * | **Roster** (`GET /guilds/{id}/members`, la lista de miembros) | `ceil(miembros / 1000)` por refresco, cacheadas 12 h | pertenencia de **todos** y además el `discordUserId` de quien solo tiene `@usuario` |
 * | **Por id** (`GET /guilds/{id}/members/{user_id}`) | una por jugador, y solo a quien le vence su caché | pertenencia de quien ya tiene la cuenta |
 *
 * Se usa el roster **si se ha podido leer**; si no, se cae al camino por id, que no
 * necesita el intent privilegiado `GUILD_MEMBERS`. Es el reparto que hace que el
 * roster sea una mejora y nunca un requisito: sin el intent activo el comportamiento
 * es exactamente el de antes de esta mejora.
 *
 * ## La regla que manda sobre las demás: no saber **no** es no estar
 *
 * Ni columnas ni alerta. Un timeout, un `5xx`, un `401` (el token del bot caducado),
 * un corte de red o **un roster vacío** —lo que pasa sin el intent `GUILD_MEMBERS`,
 * donde Discord contesta `200` con `[]`— **no** significan que la cuenta esté fuera del
 * servidor. Escribir un `false` por cualquiera de ellos avisaría de todos los
 * participantes a la vez en cuanto Discord tuviera un rato malo, y por eso de un
 * `unknown` no se escribe ni columna ni alerta: el jugador vuelve a la cola en la
 * siguiente pasada, porque su `discordCheckedAt` sigue viejo. Es el mismo criterio que
 * `checkPlayerHistory()`, y el mismo modelado que `fetchGuildRoster()`, cuyo
 * `unknown` es la razón por la que existe el camino de reserva.
 *
 * ## Las tres cosas que solo puede hacer el roster
 *
 * 1. **Comprobar a todos con una lectura**, sin una petición por jugador.
 * 2. **Resolver el `discordUserId` de quien solo tiene `@usuario`** (el alta de admin,
 *    donde la organización escribe el `@usuario` que le dan y no hay paso de OAuth).
 *    Solo si ese id **no está ya enlazado a otro participante**: escribirlo en otro
 *    saltaría el `P2002` de `Player.discordUserId`, y una cuenta no puede estar en dos
 *    jugadores.
 * 3. **Avisar de los que no aparecen por su `@usuario`**, que es un caso que la
 *    consulta por id no puede ni ver (no hay id con el que preguntar).
 *
 * Y las dos que **no** puede hacer, y son la parte incómoda: **no** puede afirmar que
 * alguien no está en el servidor cuando su lista está incompleta, y **no** puede
 * escribir un `discordInGuild` para quien no se ha podido identificar. Las dos cosas
 * salen como `unknown` o como alerta sin columnas, nunca como una afirmación.
 *
 * ## Idempotencia
 *
 * La regla se reevalúa cada pasada (con su caché de 12 h) y escribe con
 * `createMany({ skipDuplicates: true })` sobre `Alert.dedupeKey`. Para las reglas de
 * estado la clave **no lleva partida ni número** (ver `alertDedupeKey()`), así que
 * aquí no hay ni una alerta nueva por jugador cada doce horas: la segunda pasada
 * inserta 0 filas y la alerta sigue siendo la que se escribió la primera vez.
 *
 * **Y no hay resolución de alertas.** No existe un sitio donde "esta alerta ya está
 * resuelta": `Alert` es *append-only* como las demás y el estado de ahora se lee de
 * `Player.discordInGuild`. Que alguien vuelva a entrar al servidor cambia la columna
 * en la siguiente comprobación, no la fila del aviso.
 *
 * ## Lo que falla aquí no tumba la pasada
 *
 * Cada jugador va en su propio `try` (uno que falle no impide comprobar al
 * siguiente), un fallo de la base va a `warnings`, y las alertas se insertan al final
 * con su propio `try`: si escribirlas falla, las columnas ya están escritas y la
 * siguiente pasada lo reintenta con la misma clave. Es el mismo tratamiento que el
 * resto del sincronizador, y el motivo es que esto es un aviso para la organización,
 * no el torneo.
 */

/** Una fila de `Player` tal y como la necesita esta comprobación. */
type DiscordPlayerRow = {
  id: string;
  profileId: number;
  name: string;
  /** `Player.discordUserId`. `null` = solo se sabe el `@usuario` (alta de admin). */
  discordUserId: string | null;
  /** `Player.discordUsername`, ya en forma canónica y sin arroba. */
  discordUsername: string | null;
  /** `Player.discordCheckedAt`; `null` = nunca comprobado. */
  discordCheckedAt: Date | null;
};

/**
 * Qué se ha podido saber del roster en esta pasada.
 *
 * `memberCount === null` es el estado que no permite afirmar nada, y `error` dice por
 * qué. Los tres campos van al rastro porque es el único sitio donde se ve que el
 * roster se está leyendo, con cuántos miembros y si hace falta ir a activarle el
 * intent al bot.
 */
export type DiscordRosterStatus = {
  /** `true` si se ha traído de la API en esta pasada; `false` si salió de la caché. */
  refreshed: boolean;
  /** Miembros del servidor, o `null` si el roster no se ha podido comprobar. */
  memberCount: number | null;
  /** Por qué no se ha podido comprobar, o `null` si sí se ha podido. */
  error: string | null;
};

export type DiscordChecksResult = {
  /** Participantes aprobados leídos (con Discord o sin él). */
  players: number;
  /** De los anteriores, los que no tienen ni cuenta ni `@usuario`: no se pueden comprobar. */
  withoutDiscord: number;
  /** A quién le vencía la caché de 12 h (`DISCORD_CHECK_TTL_HOURS`). */
  dueForCheck: number;
  /**
   * Comprobaciones hechas de verdad, una por jugador.
   *
   * **No** es un recuento de peticiones: con la lista de miembros disponible cada
   * comprobación es una bùsqueda en un array y **cero** peticiones (la de la lista se
   * paga una vez cada doce horas), y sin lista es una petición por cuenta. Por eso
   * `checked` no es el número de veces que se ha salido a la red.
   */
  checked: number;
  /**
   * Veredictos: en el servidor, fuera y sin respuesta.
   *
   * **No suman `checked`**, y no es un descuido: a quien solo tiene `@usuario` y no se
   * ha podido identificar (no aparece en el roster, o aparece dos veces) no se le puede
   * decir que está ni que no está, así que no cuenta como veredicto. Va con su
   * propio contador, `notFoundByUsername`.
   */
  verdicts: DiscordVerdictCounts;
  /** Filas de `Player` escritas. */
  playersUpdated: number;
  /** Cuentas enlazadas por `@usuario` gracias al roster. */
  resolvedByUsername: number;
  /** `@usuario` que no aparece en el roster, o que aparece dos veces. Todos alertan. */
  notFoundByUsername: number;
  /**
   * `@usuario` cuya cuenta ya está enlazada a **otro** participante.
   *
   * Es un contador aparte porque no es ni un enlace ni una ausencia: la cuenta sí
   * estaba en el roster y es de otro. Agruparlo con los que no aparecen daría un
   * motivo equivocado a quien lo mirara, y no escribir nada (ni el id ni
   * `discordInGuild`) porque no se sabe de quién es esta fila.
   */
  takenByAnother: number;
  /** Cuántos quedaron sin comprobar por el tope de la pasada o por el plazo. */
  skippedByBudget: number;
  /** Con `@usuario` pero sin id, y sin roster: no hay con qué comprobar ni resolver. */
  skippedWithoutRoster: number;
  /** Lo que se ha podido leer del roster del servidor. */
  roster: DiscordRosterStatus;
  /** Filas nuevas de `Alert`. */
  alertsCreated: number;
  /** Lo que no se ha podido hacer, en texto legible para el rastro. */
  warnings: string[];
  durationMs: number;
};

/**
 * Los tres veredictos, contados.
 *
 * Los nombres son de JavaScript (`notMember`) y los del veredicto no (`not-member`):
 * son dos cosas distintas y mezclarlas obligaría a escribir `result.verdicts
 * ["not-member"]` por todas partes. El puente es `CONTADOR_DE`.
 */
export type DiscordVerdictCounts = {
  /** La API o el roster han confirmado que la cuenta está en el servidor. */
  member: number;
  /** La API o el roster han dicho que no lo está. */
  notMember: number;
  /** No se ha podido comprobar, y no se ha escrito nada. */
  unknown: number;
};

/** De veredicto a contador, para no repetir el mismo `switch` en dos sitios. */
const CONTADOR_DE: Record<DiscordMembershipVerdict, keyof DiscordVerdictCounts> = {
  member: "member",
  "not-member": "notMember",
  unknown: "unknown",
};

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : `Error desconocido: ${String(error)}`;
}

/**
 * Participantes aprobados, con y sin Discord.
 *
 * **El filtro de `discordUserId` ha desaparecido**, y es deliberado: `discordUsername`
 * es tan válido como el id para decir "esta persona tiene Discord en el torneo", y
 * filtrar por el id dejaría fuera precisamente a quien el roster puede resolver. Por
 * eso se trae todo lo aprobado y se separa en memoria, lo que además da el contador de
 * los que no tienen Discord (filas anteriores a F12 y del torneo simulado): es
 * información que el rastro tiene que poder decir y que con el filtro no se sabría.
 *
 * **Sin índice nuevo, y a propósito.** `Player` tiene decenas de filas y ya se
 * recorre entera en el listado del panel sin ningún índice en `status`
 * (`docs/MODELO-DATOS.md`, "Índices"); los índices únicos de `discordUserId` y `discordUsername`
 * son **restricciones** para que una cuenta o un nombre no estén en dos participantes,
 * no índices de filtro, y un recorrido secuencial de esta tabla sale más barato que
 * un índice que casi no se usaría. Es el mismo criterio que la purga de
 * `RateLimitCounter`.
 */
function readCandidates(): Promise<DiscordPlayerRow[]> {
  return db.player.findMany({
    where: { status: PlayerStatus.APPROVED },
    select: {
      id: true,
      profileId: true,
      name: true,
      discordUserId: true,
      discordUsername: true,
      discordCheckedAt: true,
    },
    orderBy: { profileId: "asc" },
  });
}

/**
 * El roster que hay que usar en esta pasada: el de la caché si no ha vencido, o uno
 * recién leído. `null` = **no se ha podido comprobar** y hay que caer al camino por id.
 *
 * ## Por qué un roster viejo **no** se usa como reserva
 *
 * La tentación es "si falla la lectura, usa el de la caché aunque tenga trece horas".
 * Sería un error: el roster decide si alguien está en el servidor, y usar uno al que
 * le falta la mitad de los miembros afirmaría "no está" de cuentas que sí están. Un
 * roster viejo solo sirve para lo que sí puede afirmar —"este nombre estaba en el
 * servidor hace doce horas"—, y eso no es lo que se escribe en la columna. Ante un
 * `unknown` se vuelve al camino por id, que no depende del intent y sí es de fiar.
 *
 * ## Y por qué el `unknown` no se cachea
 *
 * Cachearlo fijaría "el roster está vacío" durante doce horas, y eso es exactamente
 * la afirmación que este módulo no puede hacer. La caché vieja se queda donde
 * estaba, y como ha vencido se volverá a intentar en la siguiente pasada.
 */
async function resolveRoster(
  config: DiscordConfig,
  now: Date,
  signal: AbortSignal | undefined,
  result: DiscordChecksResult,
  warnings: string[],
): Promise<DiscordRosterMember[] | null> {
  let cache: Awaited<ReturnType<typeof readDiscordRosterCache>> = null;

  try {
    cache = await readDiscordRosterCache();
  } catch (error) {
    // Una caché ilegible no es motivo para no comprobar: se sigue con la lectura.
    warnings.push(
      `No se ha podido leer la caché del roster de Discord: ${toErrorMessage(error)}`,
    );
  }

  const fetchedAt = cache === null ? null : new Date(cache.fetchedAt);

  if (!rosterIsDue(fetchedAt, now, config.rosterTtlHours * 3_600_000)) {
    result.roster = {
      refreshed: false,
      memberCount: cache === null ? null : cache.members.length,
      error: null,
    };

    return cache === null ? null : cache.members;
  }

  const leido = await fetchGuildRoster({ config, signal });

  if (leido.status === "unknown") {
    result.roster = { refreshed: false, memberCount: null, error: leido.reason };
    warnings.push(
      `No se ha podido leer la lista de miembros del servidor de Discord: ${leido.reason} ` +
        "Se sigue con la comprobación por cuenta, que no necesita el intent privilegiado.",
    );

    return null;
  }

  result.roster = { refreshed: true, memberCount: leido.members.length, error: null };

  try {
    await writeDiscordRosterCache(leido.members, now);
  } catch (error) {
    // El roster ya está leído y se va a usar igual: perder la caché cuesta una
    // lectura más en la próxima pasada, nada más.
    warnings.push(
      `No se ha podido guardar la caché del roster de Discord: ${toErrorMessage(error)}`,
    );
  }

  return leido.members;
}

/**
 * Una comprobación por cuenta, de principio a fin: la llamada y su veredicto.
 *
 * **Nunca lanza.** El `DiscordError` del cliente es lo que distingue el `404` (el
 * único que afirma algo) del resto, así que se lee su `status` en lugar de dejar que
 * el error suba: con `null` (no hubo respuesta) y con cualquier otro estado, el
 * veredicto es `unknown` y quien llama no escribe nada.
 *
 * `reason` es solo para el rastro y nunca va al `details` de la alerta, porque de un
 * `unknown` no se escribe alerta. El mensaje del `DiscordError` ya lleva el estado y
 * la ruta —y nunca el token—, así que no hace falta volver a componer aquí.
 *
 * Solo se llama cuando **no** hay roster: con la lista de miembros, la pregunta ya
 * está respondida y una petición por jugador sería tirar presupuesto.
 */
async function checkOne(
  discordUserId: string,
  config: DiscordConfig,
  client: DiscordHttpClient,
): Promise<{
  verdict: DiscordMembershipVerdict;
  status: number | null;
  reason: string | null;
}> {
  try {
    // El cliente solo resuelve con `2xx`, y esta ruta solo devuelve `200` con el
    // objeto de miembro: un `2xx` distinto no existe aquí, y si apareciera, el
    // veredicto tendría que salir de `membership.ts`, no de esta suposición.
    await client.request("GET", `/guilds/${config.guildId}/members/${discordUserId}`, {
      authorization: `Bot ${config.botToken}`,
    });

    return {
      verdict: discordMembershipVerdictFromStatus(DISCORD_MEMBER_STATUS),
      status: DISCORD_MEMBER_STATUS,
      reason: null,
    };
  } catch (error) {
    const status = error instanceof DiscordError ? error.status : null;
    const verdict = discordMembershipVerdictFromStatus(status);
    // Un `404` no es un problema: es la respuesta que significa "no está en el
    // servidor", que es justo lo que se venía a comprobar. Solo los demás fallos
    // dejan motivo, y van al rastro de la pasada.
    const reason = verdict === "unknown" ? toErrorMessage(error) : null;

    return { verdict, status, reason };
  }
}

/** Una alerta `DISCORD_NOT_IN_GUILD`, con la evidencia de **cómo** se comprobó. */
function notInGuildAlert(input: {
  player: DiscordPlayerRow;
  checkedAt: Date;
  resolvedBy: "discordUserId" | "username";
  httpStatus: number | null;
  rosterMembers: number | null;
}): TriggeredAlert {
  return buildTriggeredAlert({
    rule: AlertRule.DISCORD_NOT_IN_GUILD,
    kind: AlertKind.STATE_DETECTED,
    playerId: input.player.id,
    playerProfileId: input.player.profileId,
    subject: SELF_SUBJECT,
    // Una comprobación y su veredicto: no hay magnitud que cruzar ni umbral que
    // comparar, así que el par es 1/1 y el informe puede mostrarlo sin tener que saber
    // nada de la regla. Vale igual para los dos caminos (cuenta o `@usuario`), porque
    // los dos son un estado comprobado y no una secuencia.
    count: 1,
    threshold: 1,
    anchorGameId: null,
    anchorStartedAt: null,
    // Sin ventana: esta comprobación no mira ninguna partida, y escribir la del
    // torneo afirmaría un alcance que no tiene (ver `alertDetails()`).
    detail: {
      // Cómo se resolvió que no está: por la cuenta que ya tenía o por el `@usuario`.
      // Es lo que separa los dos casos sin necesidad de una segunda regla, porque la
      // frase es la misma y la evidencia no.
      resolvedBy: input.resolvedBy,
      ...(input.player.discordUserId === null ? {} : { discordUserId: input.player.discordUserId }),
      ...(input.player.discordUsername === null
        ? {}
        : { discordUsername: input.player.discordUsername }),
      discordCheckedAt: input.checkedAt.toISOString(),
      discordHttpStatus: input.httpStatus,
      ...(input.rosterMembers === null ? {} : { discordRosterMembers: input.rosterMembers }),
    },
  });
}

/**
 * La pertenencia al servidor de cada participante, una vez por pasada del
 * sincronizador.
 *
 * **Nunca lanza.** Cada paso va en su propio `try` y lo que falla sale en `warnings`,
 * que el sincronizador escribe en `discordError`. Es el mismo tratamiento que
 * `checkPlayerHistory()`, y el motivo es el mismo: esto es un aviso para la
 * organización sobre si puede hablar con sus participantes, no el torneo.
 *
 * ## El orden
 *
 * 1. **El roster**, si le ha vencido su caché: una lectura que decide sobre todos.
 *    Si no se puede leer, aviso y `null` (el camino por id de abajo).
 * 2. La lista de candidatos, entera, con el TTL filtrado **en memoria** con
 *    `discordCheckIsDue()`: traer solo los vencidos en la consulta obligaría a
 *    traducir el plazo a SQL, y el criterio de caché es de un módulo puro que se
 *    prueba sin base de datos.
 * 3. Uno a uno, con el tope por delante.
 *
 * ## El presupuesto
 *
 * `config.maxChecksPerRun` es el tope duro por pasada, y los que se quedan fuera salen
 * como `skippedByBudget` y se dirán en la siguiente. El plazo global de la pasada
 * (`signal`) corta la lista por el mismo sitio y por el mismo motivo: lo que queda sin
 * mirar sale como omitido y no como fallo.
 *
 * **Sin candidatos no se crea el cliente HTTP.** La lista de candidatos entra vacía y
 * el paso termina sin una sola petición, que es lo que hace que no cueste nada en un
 * despliegue donde la inscripción de Discord todavía no se ha usado (y en la
 * simulación del torneo, cuyos participantes no tienen Discord). Y cuando sí hay
 * roster, el cliente ni siquiera se crea: la lista decide sin red.
 *
 * `signal` no se pasa a la petición, y es a propósito: el cliente de Discord pone su
 * propio `AbortSignal.timeout(config.timeoutMs)` porque una comprobación nunca debe
 * quedar esperando al plazo global de una pasada que ya está haciendo otras cosas. El
 * `signal` se respeta **entre** jugadores (y entre páginas del roster), que es donde
 * importa.
 *
 * ## Lo que se escribe, y cuándo
 *
 * Solo con un veredicto que afirme algo. Con roster, un jugador **con cuenta** tiene
 * su veredicto en la lista; uno **sin cuenta** se resuelve por su `@usuario` y, si
 * aparece, se le escribe el `discordUserId` que el roster acaba de resolver. Un
 * `member` escribe `discordInGuild = true`, un `not-member` escribe `false` **y**
 * deja la alerta, y un `unknown` no toca nada: ni columnas ni alerta.
 *
 * ## El caso raro: el `@usuario` que sí aparece pero es de otro
 *
 * Si el roster resuelve un id que ya está enlazado a otro participante, **no se
 * escribe nada de esa fila** (ni el id, que saltaría el `P2002`, ni
 * `discordInGuild`, que no sabemos de quién es) y sale como `takenByAnother` con un
 * aviso en el rastro. Es un dato que alguien tiene que mirar a mano, no una
 * conclusión que se pueda tomar solo.
 */
export async function checkDiscordMembership(
  options: { signal?: AbortSignal; config?: DiscordConfig } = {},
): Promise<DiscordChecksResult> {
  const startedAtMs = Date.now();
  const config = options.config ?? getDiscordConfig();
  const now = new Date();
  const warnings: string[] = [];
  const alerts: TriggeredAlert[] = [];

  const result: DiscordChecksResult = {
    players: 0,
    withoutDiscord: 0,
    dueForCheck: 0,
    checked: 0,
    verdicts: { member: 0, notMember: 0, unknown: 0 },
    playersUpdated: 0,
    resolvedByUsername: 0,
    notFoundByUsername: 0,
    takenByAnother: 0,
    skippedByBudget: 0,
    skippedWithoutRoster: 0,
    roster: { refreshed: false, memberCount: null, error: null },
    alertsCreated: 0,
    warnings,
    durationMs: 0,
  };

  try {
    // Degradación, y **antes de tocar nada**: sin token de bot o sin id de servidor no
    // hay contra quién preguntar, así que no se lee ni una fila de `Player` ni se crea
    // el cliente HTTP. Es el mismo patrón que la falta de `YOUTUBE_API_KEY` en los
    // directos, y por el mismo motivo el aviso es permanente: si no sale en el rastro
    // no hay ningún sitio donde se vea que la comprobación lleva apagada.
    if (!isDiscordCheckConfigured(config)) {
      warnings.push(
        "Sin DISCORD_BOT_TOKEN o DISCORD_GUILD_ID no se comprueba si las cuentas de Discord están en el servidor: se deja como está (null).",
      );
    } else {
      const players = await readCandidates();

      result.players = players.length;

      const candidatos = players.filter(
        (player) => player.discordUserId !== null || player.discordUsername !== null,
      );

      result.withoutDiscord = players.length - candidatos.length;

      // El presupuesto se gasta con los que le vencía la caché, y eso se decide con
      // las columnas de `Player` sin llamar a nadie: al revés habría que gastar una
      // petición por jugador para acabar descartando a todos menos uno.
      const vencidos = candidatos.filter((player) =>
        discordCheckIsDue(player.discordCheckedAt, now),
      );

      result.dueForCheck = vencidos.length;

      // **Nadie al que comprobar no cuesta ni una petición**: no se lee la lista de
      // miembros, no se crea el cliente HTTP y no se lee ni una fila más. Es el caso de
      // las 287 pasadas diarias de un torneo donde a nadie le toca, y el que hace que
      // este paso no sea un coste fijo del sincronizador.
      if (vencidos.length === 0) {
        result.durationMs = Date.now() - startedAtMs;

        return result;
      }

      // El roster se lee **después** de saber a quién hay que mirar, y solo si su
      // caché ha vencido: es lo que decide sobre todos ellos de golpe.
      const roster = await resolveRoster(config, now, options.signal, result, warnings);
      const rosterIds = roster === null ? null : new Set(roster.map((miembro) => miembro.id));

      // Crear el cliente no sale a la red (es solo un cierre sobre `fetch`), así que
      // se crea aquí y se usa únicamente en el camino por id. Lo que cuesta son las
      // peticiones, y de esas solo se hacen cuando hay roster y ningún jugador.
      const client = createDiscordHttpClient(config);

      for (const player of vencidos) {
        if (result.checked >= config.maxChecksPerRun) {
          result.skippedByBudget += 1;

          continue;
        }

        if (options.signal?.aborted === true) {
          // Lo que queda sin mirar sale como omitido y se dirá en la siguiente
          // pasada: el jugador no está comprobado, pero tampoco está mal comprobado,
          // porque no se escribe nada.
          result.skippedByBudget += 1;

          break;
        }

        try {
          if (roster !== null && rosterIds !== null) {
            await checkAgainstRoster({ player, roster, rosterIds, now, result, alerts, warnings });
          } else if (player.discordUserId !== null) {
            const { verdict, status, reason } = await checkOne(
              player.discordUserId,
              config,
              client,
            );

            result.checked += 1;
            result.verdicts[CONTADOR_DE[verdict]] += 1;

            if (reason !== null) {
              warnings.push(`${player.name}: ${reason}`);
            }

            // Un `unknown` no escribe nada. Ni columnas ni alerta: no se ha podido
            // comprobar, y publicar "no está en el servidor" por un corte de red sería
            // una afirmación que no se sabe. El jugador vuelve a la cola en la
            // siguiente pasada, porque su `discordCheckedAt` sigue viejo.
            if (verdict === "unknown") {
              continue;
            }

            await db.player.update({
              where: { id: player.id },
              data: {
                discordInGuild: verdict === "member",
                discordCheckedAt: now,
              },
            });

            result.playersUpdated += 1;

            if (verdict === "not-member") {
              alerts.push(
                notInGuildAlert({
                  player,
                  checkedAt: now,
                  resolvedBy: "discordUserId",
                  httpStatus: status,
                  rosterMembers: null,
                }),
              );
            }

            continue;
          } else {
            // Solo tiene `@usuario` y no hay roster con el que resolverlo. No es un
            // fallo: es un dato que falta, y el jugador sale como omitido.
            result.skippedWithoutRoster += 1;

            continue;
          }
        } catch (error) {
          // Un fallo al leer o al escribir este jugador es un aviso más, no una razón
          // para dejar de comprobar a los demás: el siguiente puede funcionar.
          warnings.push(
            `${player.name}: no se ha podido comprobar su Discord (${toErrorMessage(error)})`,
          );
          result.verdicts.unknown += 1;
        }
      }
    }
  } catch (error) {
    // Aquí solo llega un fallo de la base, que es el paso sin `try` propio. Lo que ya
    // se había comprobado no se pierde —sus columnas están escritas— y el motivo va
    // al rastro de la pasada.
    warnings.push(
      `No se ha podido comprobar la pertenencia a Discord: ${toErrorMessage(error)}`,
    );
  }

  /* ------------------------------------------------------------------ */
  /* Las alertas de golpe y solo si no están ya                          */
  /* ------------------------------------------------------------------ */

  if (alerts.length > 0) {
    try {
      // `skipDuplicates` sobre `dedupeKey`: la idempotencia de las reglas de estado sale
      // de que su clave no lleve ni partida ni número (ver `alertDedupeKey()`), así que
      // volver a comprobar cada doce horas inserta 0 filas.
      const written = await db.alert.createMany({
        data: alerts.map((alert) => ({
          rule: alert.rule,
          kind: alert.kind,
          playerId: alert.playerId,
          subjectProfileId: alert.subjectProfileId,
          subjectName: alert.subjectName,
          count: alert.count,
          threshold: alert.threshold,
          anchorGameId: alert.anchorGameId,
          dedupeKey: alert.dedupeKey,
          summary: alert.summary,
          details: alert.details,
        })),
        skipDuplicates: true,
      });

      result.alertsCreated = written.count;
    } catch (error) {
      // Las columnas ya están escritas y el aviso es un derivado: un fallo aquí se
      // registra y la siguiente pasada lo reintenta con la misma clave.
      warnings.push(`No se han podido escribir las alertas de Discord: ${toErrorMessage(error)}`);
    }
  }

  result.durationMs = Date.now() - startedAtMs;

  return result;
}

/**
 * Un jugador comprobado **contra el roster**, que es el camino que no sale a la red.
 *
 * Son tres ramas y se distinguen por lo que tiene la fila, no por lo que devuelve
 * Discord:
 *
 * 1. **Con `discordUserId`**: decide si el id está en la lista. Es una presencia en un
 *    `Set`, y escribe `discordInGuild` + `discordCheckedAt`; si no está, alerta con
 *    `resolvedBy: "discordUserId"`.
 * 2. **Solo con `@usuario` y aparece**: se resuelve el `discordUserId` y se escribe.
 *    Solo si ese id no está enlazado a otro participante.
 * 3. **Solo con `@usuario` y no aparece (o aparece dos veces)**: alerta con
 *    `resolvedBy: "username"` y **sin escribir el id**.
 *
 * ## Lo que NO se escribe en la rama 3, y por qué
 *
 * Ni el `discordUserId` (no se sabe cuál es) ni el `discordInGuild` (no se ha
 * identificado ninguna cuenta, así que un `false` afirmaría algo de una cuenta que
 * nadie ha visto). Lo que sí se escribe es `discordCheckedAt`, y es lo único que
 * parece una excepción: **registra que la comprobación se ha hecho**, que es cierto, y
 * es lo que mantiene el ritmo de la pasada (doce horas como el resto) sin dejar a estos
 * jugadores reevaluándose en cada una de las 288 pasadas diarias. `discordInGuild` se
 * queda en `null`, que es exactamente "sin comprobar" y nunca "no está".
 *
 * Es además el dato que se le da a la interfaz: con `discordInGuild === null` y
 * `discordUsername !== null` se puede distinguir "nunca comprobado" de "comprobado y
 * no se ha podido identificar", que es lo que hace falta para no acusar a nadie de
 * algo que no se sabe.
 */
async function checkAgainstRoster(input: {
  player: DiscordPlayerRow;
  roster: DiscordRosterMember[];
  rosterIds: Set<string>;
  now: Date;
  result: DiscordChecksResult;
  alerts: TriggeredAlert[];
  warnings: string[];
}): Promise<void> {
  const { player, roster, rosterIds, now, result, alerts, warnings } = input;

  result.checked += 1;

  if (player.discordUserId !== null) {
    const dentro = rosterIds.has(player.discordUserId);

    result.verdicts[dentro ? "member" : "notMember"] += 1;

    await db.player.update({
      where: { id: player.id },
      data: { discordInGuild: dentro, discordCheckedAt: now },
    });

    result.playersUpdated += 1;

    if (!dentro) {
      alerts.push(
        notInGuildAlert({
          player,
          checkedAt: now,
          resolvedBy: "discordUserId",
          httpStatus: null,
          rosterMembers: roster.length,
        }),
      );
    }

    return;
  }

  // Solo `@usuario`: se busca en la lista y se resuelve el id.
  const encontrado = matchRosterUsername(player.discordUsername ?? "", roster);

  if (typeof encontrado !== "object") {
    result.notFoundByUsername += 1;

    alerts.push(
      notInGuildAlert({
        player,
        checkedAt: now,
        resolvedBy: "username",
        httpStatus: null,
        rosterMembers: roster.length,
      }),
    );

    await db.player.update({ where: { id: player.id }, data: { discordCheckedAt: now } });

    result.playersUpdated += 1;

    return;
  }

  // La cuenta existe en el roster, pero puede que ya sea la de otro participante: en
  // ese caso no se escribe nada de esta fila. Es una lectura más por jugador y solo
  // para quien no tenía id, que son las altas de admin: quien lo resolvió por OAuth no
  // pasa por aquí nunca.
  const ocupado = await db.player.findUnique({
    where: { discordUserId: encontrado.id },
    select: { id: true, name: true },
  });

  if (ocupado !== null && ocupado.id !== player.id) {
    result.takenByAnother += 1;
    warnings.push(
      `${player.name}: el @usuario @${player.discordUsername} es la cuenta de ${ocupado.name}, ` +
        "así que no se ha vinculado.",
    );

    await db.player.update({ where: { id: player.id }, data: { discordCheckedAt: now } });

    result.playersUpdated += 1;

    return;
  }

  await db.player.update({
    where: { id: player.id },
    data: {
      discordUserId: encontrado.id,
      discordInGuild: true,
      discordCheckedAt: now,
    },
  });

  result.resolvedByUsername += 1;
  result.verdicts.member += 1;
  result.playersUpdated += 1;
}

/**
 * La línea que va al rastro de la pasada (`discordError`), o `null` si no hay nada que
 * decir.
 *
 * **No** mueve `lastSuccessAt`, igual que `historyError` y `streamsError`: que no se
 * haya podido comprobar si alguien está en el servidor de Discord **no ha parado ni
 * una partida** de las que sí se han sincronizado. Mezclarlo daría "el torneo lleva
 * roto desde las 10:00" por un 429 de la API de Discord, que es justo la confusión
 * que ese marcador existe para evitar.
 *
 * Los recuentos se escriben aunque no haya fallo, porque es donde se ve que la
 * comprobación está funcionando. Y con los omitidos por el tope también hay línea: es
 * el aviso de que el despliegue se está escalonando, no de que algo falle.
 *
 * Cuando no hay nada que contar solo quedan los avisos, que es el caso de la
 * degradación (sin credenciales no hay ni una cuenta que mirar): callarse ahí sería
 * no tener ningún sitio donde se vea que la comprobación lleva apagada.
 */
export function describeDiscordChecks(result: DiscordChecksResult): string | null {
  // `memberCount === null` **y** sin error es el caso en el que no se ha intentado
  // nada (sin credenciales, o con nadie a quien comprobar): entonces el roster no
  // dice nada y no se inventa una línea sobre él. El aviso permanente de la
  // degradación es el que explica ese caso.
  const roster =
    result.roster.error !== null
      ? `sin lista de miembros (${result.roster.error})`
      : result.roster.memberCount === null
        ? null
        : `roster de ${result.roster.memberCount} miembros${result.roster.refreshed ? ", recién leída" : ""}`;

  const partes = [
    roster,
    result.dueForCheck === 0 ? null : `${result.dueForCheck} por comprobar`,
    result.checked > 0 ? `${result.checked} comprobados` : null,
    result.verdicts.notMember > 0 ? `${result.verdicts.notMember} fuera del servidor` : null,
    result.resolvedByUsername > 0
      ? `${result.resolvedByUsername} enlazados por @usuario`
      : null,
    result.notFoundByUsername > 0
      ? `${result.notFoundByUsername} sin aparecer por su @usuario`
      : null,
    result.takenByAnother > 0
      ? `${result.takenByAnother} con el @usuario de otro participante`
      : null,
    result.withoutDiscord > 0 ? `${result.withoutDiscord} sin Discord` : null,
    result.skippedWithoutRoster > 0
      ? `${result.skippedWithoutRoster} sin comprobar por no haber lista de miembros`
      : null,
    result.verdicts.unknown > 0 ? `${result.verdicts.unknown} sin comprobar` : null,
    result.skippedByBudget > 0 ? `${result.skippedByBudget} para la siguiente pasada` : null,
  ].filter((parte): parte is string => parte !== null);

  if (partes.length === 0) {
    return result.warnings.length === 0 ? null : result.warnings.join(" ");
  }

  return [`Discord: ${partes.join(", ")}.`, ...result.warnings].join(" ");
}
