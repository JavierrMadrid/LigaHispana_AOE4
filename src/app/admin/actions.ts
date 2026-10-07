"use server";

import type { User } from "@supabase/supabase-js";
import type { SyncSummary } from "@/lib/aoe4world/sync";
import type { ManualSyncLock } from "@/lib/manual-sync";
import { revalidatePath } from "next/cache";
import { Prisma } from "@/generated/prisma/client";
import { AdminActionType, MatchResult, PlayerStatus } from "@/generated/prisma/enums";
import type { CampoEditado } from "@/lib/admin-actions";
import { puntos, recordAdminAction } from "@/lib/admin-actions";
import { reevaluatePlayerAlerts } from "@/lib/alerts/evaluate";
import { syncApprovedPlayers } from "@/lib/aoe4world/sync";
import { requireAdmin } from "@/lib/auth";
import { readCountries } from "@/lib/countries";
import { db } from "@/lib/db";
import { logDatabaseFailure, uniqueViolationOn } from "@/lib/db-errors";
import { consumeManualSyncLock, MANUAL_SYNC_COOLDOWN_SECONDS } from "@/lib/manual-sync";
import {
  isLegacyYoutubeUrl,
  parseCountry,
  parseDiscordUsername,
  parseKickChannel,
  parseName,
  parseProfileId,
  parseTwitchChannel,
  parseYoutubeChannel,
} from "@/lib/player-input";
import { countsAsRanked } from "@/lib/ranked-match";
import { REGISTRATION_CLOSED_MESSAGE } from "@/lib/registration-open";
import { readRuleset, recomputeScores } from "@/lib/scoring";
import { readRegistrationOpen, writeRegistrationOpen } from "@/lib/settings";

/**
 * Server Actions del panel de administración.
 *
 * Todas viven bajo `src/app/admin/**` a propósito, y todas empiezan por
 * `requireAdmin()`. Las dos cosas son la misma defensa:
 *
 * - El `matcher` del Proxy (`src/proxy.ts`) cubre `/admin/:path*`, y **excluir una
 *   ruta del `matcher` excluye también sus Server Functions**. Una acción fuera de
 *   `/admin` no se saltaría solo la comprobación optimista de la cookie: en el Proxy
 *   no se ejecutaría, así que su `requireAdmin()` ni siquiera llegaría a comprobar
 *   nada.
 * - El Proxy solo mira cookies. La comprobación real es esta: una Server Action es
 *   un endpoint público y se puede llamar directamente con su id, sin pasar por
 *   ninguna página.
 *
 * El patrón de cada una es el que ya traía `/admin/jugadores/actions.ts` (cuyo
 * contenido vive aquí): **validar fuera del `try`**, dejar el `try` únicamente para
 * la base de datos, registrar el fallo con `logDatabaseFailure` y devolver al
 * formulario un mensaje que no enseña ni el error ni la traza.
 */

/* -------------------------------------------------------------------------- */
/* Estados                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Estado de una acción que necesita poder **informar del resultado**.
 *
 * Es lo que permite que un diálogo de confirmación diga "no se ha podido borrar" en
 * vez de cerrarse en silencio. Sin estado de vuelta, un borrado que fallara con la
 * base caída sería indistinguible de uno que funcionó: el formulario desaparecería
 * igual y quien lo pulsó se quedaría creyendo lo contrario.
 *
 * - `idle`: todavía no se ha enviado nada.
 * - `success`: se hizo, y `message` dice qué pasó.
 * - `error`: no se hizo, y `message` dice por qué o qué se ha deshacido.
 */
export type AdminActionResult = {
  status: "idle" | "success" | "error";
  message: string | null;
};

/**
 * Estado de los formularios de jugador del panel, que solo distinguen "hay error" de
 * "no hay error".
 *
 * Lo comparten `createPlayer` y `updatePlayer` porque son el mismo formulario con
 * campos distintos: el alta empieza una fila y la edición reescribe seis campos de
 * una que ya existe. Los dos necesitan el mismo par de mensajes, y con el mismo
 * reparto: el `error` es lo que hay que corregir y se pinta en `role="alert"`
 * **sin perder lo escrito**, y el `message` es el aviso de que sí se ha hecho —el
 * alta ya está, la clasificación todavía no— y va en `role="status"`, porque no
 * avisa de un fallo.
 *
 * No lleva errores por campo: es un único mensaje, como el alta.
 */
export type PlayerFormState = {
  error: string | null;
  /**
   * Lo que pasó **después** del alta, cuando el alta sí se hizo.
   *
   * No es un error: el jugador está dado de alta sí o sí. Es para que el panel
   * diga si ya sale en la clasificación, y sobre todo para el caso que más
   * confunde: un jugador aprobado **sin ninguna partida clasificatoria** no tiene
   * fila en `PlayerScore` y por tanto no aparece (P-02 del modelo de datos). Sin
   * este aviso, el `—` de la columna de puntos parece un fallo.
   */
  message: string | null;
};

/* -------------------------------------------------------------------------- */
/* Utilidades                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Trae las partidas de un jugador recién aprobado y lo deja ranked al momento.
 *
 * Sin esto, dar de alta a alguien no lo mete en la clasificación: la web lee
 * `PlayerScore`, y esa tabla solo la rellena el sincronizador, que pasa cada 5
 * minutos. Un jugador recién añadido se quedaba hasta la siguiente pasada sin
 * aparecer, y con el sincronizador caído **no aparecía nunca**: el `—` de la
 * columna de puntos no distingue "todavía no le ha tocado" de "no le va a tocar".
 *
 * Recalcular **solo** no arregla nada, y es la parte que no es obvia: sin partidas
 * importadas el `groupBy` de `recomputeScores()` no ve al jugador, así que no le
 * crea fila. Hay que traer primero sus partidas de AoE4World, y el recálculo va
 * dentro de la misma pasada (`syncApprovedPlayers` lo llama al final).
 *
 * La pasada es solo de este jugador (`profileIds`), no de todo el torneo.
 *
 * Devuelve `""` cuando todo fue bien y un aviso cuando no. **Nunca lanza**: el
 * alta ya está escrita y desheacerla dejaría al jugador sin alta por un problema
 * puntual de la API externa, que es peor que un alta que tarda unos minutos más
 * en verse. Es el mismo criterio que `avisoDeRecalculo()` en el borrado.
 */
async function llevarAClasificacion(
  scope: string,
  player: { id: string; profileId: number; name: string },
): Promise<string> {
  const altaHecha = `Se ha dado de alta a ${player.name}.`;

  try {
    const summary = await syncApprovedPlayers({ profileIds: [player.profileId] });
    const jugados = summary.players[0];

    if (summary.scoringError !== null) {
      return frase(
        altaHecha,
        `No se ha podido recalcular la clasificación (${summary.scoringError}).`,
        "Aparecerá en cuanto el sincronizador lo consiga.",
      );
    }

    // `!== "ok"` y no `=== "failed"`: una pasada cancelada por plazo
    // (`status: "cancelled"`) tampoco ha traído nada, y si no se distingue
    // acabaría diciendo "no tiene partidas clasificatorias", que es mentira.
    if (jugados === undefined || jugados.status !== "ok") {
      return frase(
        altaHecha,
        `No se han podido traer sus partidas de AoE4World: ${
          jugados?.error ?? "la pasada se quedó sin tiempo."
        }`,
        "Aparecerá en cuanto el sincronizador lo consiga.",
      );
    }

    // La condición de aparecer en la clasificación es exactamente tener fila en
    // `PlayerScore`, así que se pregunta a esa tabla y no se reimplementa la regla.
    const fila = await db.playerScore.findFirst({
      where: { playerId: player.id },
      select: { rank: true, total: true },
    });

    if (fila === null) {
      return frase(
        altaHecha,
        "Todavía no tiene ninguna partida clasificatoria, así que aún no sale en la clasificación.",
        "En cuanto cierre su primera aparecería con su puesto y sus puntos.",
      );
    }

    return frase(
      altaHecha,
      `Ya está en la clasificación: puesto ${fila.rank} con ${fila.total} ${
        fila.total === 1 ? "punto" : "puntos"
      }.`,
    );
  } catch (error) {
    logDatabaseFailure(`${scope}/sync`, error);

    return frase(
      altaHecha,
      "No se han podido traer sus partidas.",
      "Aparecerá en la clasificación en cuanto el sincronizador lo consiga.",
    );
  }
}

/**
 * Campo de texto de un formulario, ya recortado.
 *
 * `FormData.get` devuelve `FormDataEntryValue`, que también puede ser un `File`: sin
 * este filtro, `String(file)` produciría `"[object File]"` y esa cadena acabaría en
 * un `where` de Prisma.
 */
function readField(formData: FormData, name: string): string {
  const value = formData.get(name);

  return typeof value === "string" ? value.trim() : "";
}

/** Fallo de base de datos al guardar. El motivo se queda en el log del servidor. */
const SAVE_FAILED_MESSAGE = "No se ha podido guardar. Inténtalo de nuevo en unos minutos.";

/**
 * Fallo al leer la lista de países admitidos.
 *
 * No es un `SAVE_FAILED_MESSAGE`: en ese punto no se ha intentado guardar nada, y
 * decir "no se ha podido guardar" haría pensar que el alta se intentó. Es el mismo
 * matiz que distingue en `/participar` el "no hemos podido registrar" del "no
 * hemos podido guardar", y por el mismo motivo: validar el país contra
 * `DEFAULT_COUNTRIES` en silencio escribiría el país de una lista que la
 * organización puede haber cambiado.
 */
const COUNTRIES_UNAVAILABLE_MESSAGE =
  "No se ha podido leer la lista de países admitidos. Inténtalo de nuevo en unos minutos.";

/**
 * Fallo al leer el estado del plazo de inscripción.
 *
 * Igual que `COUNTRIES_UNAVAILABLE_MESSAGE`: en ese punto no se ha intentado
 * guardar nada, así que no es un `SAVE_FAILED_MESSAGE`. Se falla **cerrando** —no
 * se da de alta— porque el interruptor existe justo para bloquear el alta y un
 * fallo de lectura no es una razón para saltárselo.
 */
const REGISTRATION_UNAVAILABLE_MESSAGE =
  "No se ha podido leer el estado de las inscripciones. Inténtalo de nuevo en unos minutos.";

const COUNTRY_UNKNOWN_ERROR =
  "Ese país no está en la lista de los que admite el torneo. Elígelo en el desplegable o déjalo vacío.";

/**
 * Los tres canales de directo se validan con la misma regla: un valor escrito que no
 * se puede guardar es un error, no algo que se ignore en silencio y se guarde como
 * `null`. Guardarlo como `null` diría "no tiene canal" cuando lo que pasó es que lo
 * que escribió no era un canal, y esas dos cosas son distintas para quien después
 * busca a un participante para enlazarlo. Vacío sí es `null`, que es lo que la columna
 * significa.
 *
 * El texto es el que ya usa la inscripción pública, y no uno propio: los tres
 * formularios admiten el mismo conjunto de formas y un canal que uno enseña a escribir
 * y otro acepta en silencio sería un formulario que enseña algo falso. `createPlayer`
 * y `updatePlayer` comparten, además, la misma constante: el alta y la edición del
 * mismo panel no pueden validar el campo de una manera y la otra de otra.
 */
const TWITCH_INVALID_ERROR =
  "El canal de Twitch solo admite letras, números y guion bajo, de 3 a 25 caracteres.";

const YOUTUBE_INVALID_ERROR =
  "Ese canal de YouTube no vale. Se puede escribir el @nombre del canal (3 a 30 letras, números, punto, guion o guion bajo) o la dirección del canal.";

const YOUTUBE_LEGACY_URL_ERROR =
  "Esa dirección no lleva el @nombre del canal. Las URLs /c/ y /user/ no lo tienen, así que escribe el @nombre, que es lo que aparece en youtube.com/@nombre.";

const KICK_INVALID_ERROR =
  "Ese canal de Kick no vale. Se puede escribir el nombre del canal o la dirección kick.com/nombre.";

/**
 * El usuario de Discord es obligatorio, y se escribe **con la arroba**.
 *
 * Los tres mensajes del `@usuario` los comparten el alta y la edición, por el mismo
 * motivo que los de los canales: los dos formularios del panel validan el mismo campo
 * con las mismas reglas, y uno que enseñara a escribirlo de una manera y el otro
 * aceptara otra sería un panel que enseña algo falso.
 *
 * ## Por qué la arroba es obligatoria
 *
 * Porque en un servidor de Discord hay muchas cuentas con el mismo nombre y **el
 * `@usuario` es lo único único en todo el servicio**. Sin la arroba, lo que se
 * guardaría sería un nombre de display —algo que alguien se ha puesto dentro del
 * servidor y que no prueba nada—, y con él el worker no podría encontrar la cuenta ni
 * el alta podría chocar con otra por un nombre repetido. El parser
 * (`parseDiscordUsername()`) es el que lo exige, y lo que sale de ahí es el nombre
 * **sin** arroba, que es la forma en que se guarda.
 */
const DISCORD_USERNAME_REQUIRED_ERROR =
  "El usuario de Discord es obligatorio: se escribe con su arroba, como @pepito.";

const DISCORD_USERNAME_INVALID_ERROR =
  "Ese usuario de Discord no vale. Se escribe con la arroba y después de 2 a 32 letras, números, puntos o guiones bajos, como @pepito.";

/**
 * Ese `@usuario` ya está en la liga.
 *
 * `Player.discordUsername` es única, así que dos participantes no pueden tener el
 * mismo `@usuario`: si lo tuvieran, serían la misma cuenta escrita de dos maneras —
 * el alta de admin con lo que le dicen a la organización y la inscripción pública con
 * lo que resolvió Discord— y la organización no sabría a cuál de las dos filas
 * hablarle. En el alta y en la edición el mensaje lo pone quien mira la fila y, si lo
 * sabe, **nombra a quien lo tiene**: aquí corregir es inmediato.
 */
const DISCORD_USERNAME_TAKEN_ERROR =
  "Ese usuario de Discord ya está en la liga. No puede haber dos participantes con el mismo @usuario.";

/** Junta frases sin que aparezca ni un espacio de más ni un doble espacio. */
function frase(...partes: string[]): string {
  return partes
    .map((parte) => parte.trim())
    .filter((parte) => parte !== "")
    .join(" ");
}

/**
 * Quién está actuando, para la columna `AdminAction.actorEmail`.
 *
 * En el tipo de Supabase `User.email` es **opcional** (una cuenta creada solo con
 * teléfono no lo tiene) y `actorEmail` no admite nulos. Las cuentas de este panel se
 * crean a mano con correo y contraseña, así que la ausencia sería una anomalía real,
 * no algo routine: en vez de dejar un hueco se guarda el id del usuario con un
 * prefijo que lo hace evidente en el historial y que sigue siendo rastreable.
 */
function actorEmail(user: User): string {
  return user.email ?? `sin-correo:${user.id}`;
}

/* -------------------------------------------------------------------------- */
/* Alta de jugador                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Da de alta un jugador desde el panel.
 *
 * Mantiene el comportamiento de siempre (mismo `try` solo alrededor de la base,
 * mismo mensaje de fallo, mismos campos) y añade el registro de la acción, que se
 * escribe **en la misma transacción** que el alta: o hay jugador y rastro, o no hay
 * ninguno de los dos.
 *
 * ## El usuario de Discord es obligatorio y se escribe con arroba
 *
 * El alta de admin **exige** el `@usuario` global de la persona (es el dato que hace
 * que la organización la pueda encontrar en el servidor), mientras que la inscripción
 * pública lo resuelve sola por el paso de OAuth. Aquí lo escribe un humano, así que el
 * parser exige que empiece por `@` y devuelve `null` si no —un nombre de display no
 * es una identidad— y lo que se guarda es el nombre **sin** arroba, que es la forma
 * canónica y la única que el roster del servidor trae.
 *
 * Lo que se guarda no es una identidad comprobada: es un dato que la organización le
 * pide a alguien. Lo que lo convierte en identidad es el worker, que lo busca en la
 * lista de miembros del servidor y guarda el `discordUserId` que encuentre. Por eso
 * `updatePlayer` no toca el `discordUserId`.
 *
 * Y como `discordUsername` es única, el alta comprueba contra la base si el `@usuario`
 * ya está en la liga **y** captura el `P2002` de esa columna para el caso de que dos
 * admins den de alta a la vez. El `P2002` de `discordUserId` no puede saltar aquí —el
 * alta no escribe id— pero el de `profileId` sí, y son dos mensajes distintos.
 *
 * ## El país es opcional aquí y obligatorio en `/participar`
 *
 * El campo `country` lo **exige** el formulario público (es de los datos con los
 * que la organización organiza el torneo) y **admite** el alta de admin, que es el
 * mismo criterio que ya lleva el correo: se puede dar de alta a alguien sin
 * necesitar su país, y por eso la columna es nullable en el schema.
 *
 * Lo que no se admite en ningún caso es un país **mal escrito**: un valor que no
 * está en la lista vigente es un error, no algo que se ignore en silencio y se
 * guarde como `null`. Si se guardara, la fila diría "no lo sabemos" cuando en
 * realidad lo que pasó es que alguien escribió un país que no existe, y esas dos
 * cosas son distintas. Vacío sí es `null`, que es lo que la columna significa.
 *
 * ## Qué se escribe y en qué orden
 *
 * Si el jugador queda **aprobado**, después del alta se le traen sus partidas y se
 * recalcula la clasificación, para que salga en la tabla en cuanto se pulse el
 * botón y no en la siguiente pasada del sincronizador. Va fuera de la transacción
 * a propósito: traer las partidas es una llamada a AoE4World de varios segundos, y
 * meterla dentro dejaría la fila bloqueada todo ese rato.
 *
 * Los tres canales de directo —Twitch, YouTube y Kick— se validan con **el mismo
 * criterio y los mismos mensajes** que la edición (`updatePlayer`): opcionales, y
 * un valor escrito que no se puede guardar es un error en lugar de un `null`
 * silencioso (ver los mensajes al principio de esta acción). Que no haya respaldo
 * desde el perfil de AoE4World es justamente lo que hace que un canal mal escrito no
 * se pueda arreglar solo en la siguiente pasada.
 *
 * La lista de países se lee **fuera** de la transacción y solo si lo obligatorio ya
 * vale, por lo mismo que los validadores: es una lectura de `Setting` y no tiene
 * sentido pagarla en un envío que ya está descartado.
 */
export async function createPlayer(
  _prevState: PlayerFormState,
  formData: FormData,
): Promise<PlayerFormState> {
  const admin = await requireAdmin();

  // El cierre de inscripciones bloquea también el alta de admin, no solo el
  // formulario público: es el mismo interruptor (`Setting["registration.open"]`) y
  // se comprueba en servidor aunque la acción se llame a mano. Va lo primero,
  // antes de validar nada, porque con el plazo cerrado no se va a escribir: no
  // tiene sentido pagar validaciones ni lecturas para un alta descartada.
  //
  // Aprobar y rechazar solicitudes **no** pasan por aquí y siguen funcionando
  // siempre: el interruptor cierra el alta, no la gestión de lo ya recibido.
  let registrationOpen: boolean;

  try {
    registrationOpen = await readRegistrationOpen();
  } catch (error) {
    logDatabaseFailure("admin/createPlayer/plazo", error);

    return { error: REGISTRATION_UNAVAILABLE_MESSAGE, message: null };
  }

  if (!registrationOpen) {
    return { error: REGISTRATION_CLOSED_MESSAGE, message: null };
  }

  // `readField` en todos, como en la edición: `formData.get` también puede
  // devolver un `File`, y el parser recibiría `"[object File]"`, que es un valor
  // escrito mal con otra forma. En el nombre eso además pasaba la validación.
  const profileId = parseProfileId(readField(formData, "profileId"));
  const name = parseName(readField(formData, "name"));
  const twitchRaw = readField(formData, "twitchChannel");
  const twitchChannel = parseTwitchChannel(twitchRaw);
  const youtubeRaw = readField(formData, "youtubeChannel");
  const youtubeChannel = parseYoutubeChannel(youtubeRaw);
  const kickRaw = readField(formData, "kickChannel");
  const kickChannel = parseKickChannel(kickRaw);
  const discordRaw = readField(formData, "discordUsername");
  const discordUsername = parseDiscordUsername(discordRaw);
  const countryRaw = readField(formData, "country");
  const statusRaw = readField(formData, "status") || "APPROVED";
  const status =
    statusRaw === "PENDING" || statusRaw === "REJECTED" ? statusRaw : "APPROVED";

  if (!profileId) {
    return { error: "El profile ID de AoE4World debe ser un número.", message: null };
  }

  if (!name) {
    return { error: "El nombre es obligatorio (máx. 64 caracteres).", message: null };
  }

  // El `@usuario` es obligatorio en el alta —es el único dato de Discord que la
  // organización da de alta a mano— y el parser distingue los dos fallos con el valor
  // crudo: un vacío es "falta", y algo que no vale es "está mal escrito".
  if (discordUsername === null) {
    return {
      error: discordRaw === "" ? DISCORD_USERNAME_REQUIRED_ERROR : DISCORD_USERNAME_INVALID_ERROR,
      message: null,
    };
  }

  // Los tres canales, con el mismo criterio y en el mismo orden que la edición: un
  // vacío es `null` y un valor escrito que no se puede guardar es un error de su
  // campo, no un `null` silencioso. Se comprueban antes de leer la lista de países
  // porque son validaciones gratis.
  if (twitchChannel === null && twitchRaw !== "") {
    return { error: TWITCH_INVALID_ERROR, message: null };
  }

  if (youtubeChannel === null && youtubeRaw !== "") {
    return {
      error: isLegacyYoutubeUrl(youtubeRaw) ? YOUTUBE_LEGACY_URL_ERROR : YOUTUBE_INVALID_ERROR,
      message: null,
    };
  }

  if (kickChannel === null && kickRaw !== "") {
    return { error: KICK_INVALID_ERROR, message: null };
  }

  // La lista se lee solo si el resto de lo obligatorio ya vale: es una lectura de
  // `Setting` y no tiene sentido pagarla en un envío que ya está descartado (ver el
  // docblock de la acción).
  let countries: string[];

  try {
    countries = await readCountries();
  } catch (error) {
    logDatabaseFailure("admin/createPlayer/paises", error);

    return { error: COUNTRIES_UNAVAILABLE_MESSAGE, message: null };
  }

  const country = parseCountry(countryRaw, countries);

  // Vacío es `null` (el campo es opcional aquí); un valor que no está en la lista
  // es un error, no algo que se guarde como si no se hubiera escrito.
  if (country === null && countryRaw !== "") {
    return { error: COUNTRY_UNKNOWN_ERROR, message: null };
  }

  // El `try` cubre **solo** la base de datos. Un fallo de validación tiene que
  // seguir siendo un error de aplicación, y por eso el bloque va aquí y no
  // alrededor de la acción entera.
  let nuevo: { id: string; profileId: number; name: string } | null = null;

  try {
    const existing = await db.player.findUnique({ where: { profileId } });

    if (existing) {
      return {
        error: `El perfil ${profileId} ya está registrado (${existing.name}).`,
        message: null,
      };
    }

    // Unicidad del `@usuario`, contra la base y **antes** de escribir. Es una
    // comprobación barata (un índice único) y da un mensaje que nombra a quien lo
    // tiene, que un `P2002` no puede dar porque solo sabe que se saltó. La carrera
    // entre dos altas simultáneas la cubre igualmente el `P2002` de más abajo.
    const discordOcupado = await db.player.findUnique({
      where: { discordUsername },
      select: { name: true },
    });

    if (discordOcupado !== null) {
      return {
        error: frase(
          DISCORD_USERNAME_TAKEN_ERROR,
          `Ya lo usa ${discordOcupado.name}.`,
        ),
        message: null,
      };
    }

    await db.$transaction(async (tx) => {
      const created = await tx.player.create({
        data: {
          profileId,
          name,
          twitchChannel,
          youtubeChannel,
          kickChannel,
          country,
          discordUsername,
          // Cuándo lo da de alta la organización, que es lo mismo que cuando se
          // habría inscrito si lo hubiera hecho por el formulario: el motor no le
          // cuenta a un alta posterior las partidas que jugó antes de entrar. No es
          // `createdAt` porque una reinscripción de un `REJECTED` reutiliza la fila
          // y ese se queda en el primer envío.
          registeredAt: new Date(),
          status: status as PlayerStatus,
        },
        select: { id: true },
      });

      nuevo = { id: created.id, profileId, name };

      await recordAdminAction(tx, {
        type: AdminActionType.PLAYER_CREATED,
        actorEmail: actorEmail(admin),
        targetId: created.id,
        name,
        profileId,
        status,
      });
    });
  } catch (error) {
    // Dos admins que den de alta a la vez el mismo `@usuario` (o el mismo perfil) no
    // los ve la comprobación anterior, y los para la unicidad. El mensaje es el
    // mismo que ya habría salido de la comprobación, porque es el mismo problema: sin
    // esta captura saldría "no se ha podido guardar", que no dice que el conflicto es
    // el `@usuario` ni se puede corregir desde el formulario.
    if (uniqueViolationOn(error, "discordUsername")) {
      return { error: DISCORD_USERNAME_TAKEN_ERROR, message: null };
    }

    logDatabaseFailure("admin/createPlayer", error);

    return { error: SAVE_FAILED_MESSAGE, message: null };
  }

  revalidatePath("/admin");

  // Solo si queda aprobado: un pendiente o un rechazado no debe traer partidas ni
  // recalcular, porque `recomputeScores()` los deja fuera de la clasificación igual.
  if (status !== PlayerStatus.APPROVED || nuevo === null) {
    return {
      error: null,
      message:
        status === PlayerStatus.PENDING
          ? `Se ha dado de alta a ${name} como pendiente. Al aprobarlo se traerán sus partidas y aparecerá en la clasificación.`
          : null,
    };
  }

  const message = await llevarAClasificacion("admin/createPlayer", nuevo);

  // Otra vez, y no por descuido: el panel saca los puntos de `PlayerScore`, y esa
  // tabla no cambia hasta que la pasada de arriba ha recalculado. Revalidar solo
  // antes dejaría la fila con `—` aunque el jugador ya esté en la clasificación.
  revalidatePath("/admin");

  return { error: null, message };
}

/* -------------------------------------------------------------------------- */
/* Edición de jugador                                                          */
/* -------------------------------------------------------------------------- */

/** Los seis campos que la edición puede cambiar, tal y como están en la fila. */
type CamposEditables = {
  name: string;
  twitchChannel: string | null;
  youtubeChannel: string | null;
  kickChannel: string | null;
  country: string | null;
  /**
   * `@usuario` de Discord en su forma canónica (**sin arroba**).
   *
   * Nunca `null`: a diferencia de los canales y del país, aquí no hay un campo
   * opcional, porque una fila sin `@usuario` no se puede comprobar ni buscar en el
   * servidor. Las filas anteriores a F12 sí lo tienen a `null`, y ese `null` no es
   * editable: es un dato que no se sabe, y esta acción no inventa datos. Para esas
   * filas hay que dar de alta a la persona en Discord otra vez, que es lo que hace
   * quien pulse el botón.
   */
  discordUsername: string | null;
};

/**
 * Qué campo editable ha cambiado de valor, con su rótulo y sus dos valores.
 *
 * Va en el mensaje de vuelta porque "se han guardado los cambios" no dice **qué** se
 * ha cambiado, y en una fila con seis campos editables la diferencia entre "ha
 * guardado" y "no había nada que guardar" es justo lo que no se ve. Además decide
 * si hace falta escribir: si la lista sale vacía, los valores ya eran estos y no hay
 * nada que hacer.
 *
 * Devuelve el campo de la columna además del rótulo porque el rastro de
 * `AdminAction` los necesita los dos: la frase lleva el rótulo y el `details` lleva
 * el nombre de la columna con el valor de antes y el de después.
 */
function camposQueCambian(antes: CamposEditables, despues: CamposEditables): CampoEditado[] {
  const cambios: CampoEditado[] = [
    ...campoSiCambia(antes.name, despues.name, "name", "nombre"),
    ...campoSiCambia(
      antes.twitchChannel,
      despues.twitchChannel,
      "twitchChannel",
      "canal de Twitch",
    ),
    ...campoSiCambia(
      antes.youtubeChannel,
      despues.youtubeChannel,
      "youtubeChannel",
      "canal de YouTube",
    ),
    ...campoSiCambia(antes.kickChannel, despues.kickChannel, "kickChannel", "canal de Kick"),
    ...campoSiCambia(antes.country, despues.country, "country", "país"),
    // El `@usuario` va al final porque es el campo que más se toca por una regla (dar
    // de alta, corregir un nombre mal escrito) y el mensaje tiene que leerlo en ese
    // orden: primero lo que es el jugador y después su identidad en Discord.
    ...campoSiCambia(
      antes.discordUsername,
      despues.discordUsername,
      "discordUsername",
      "usuario de Discord",
    ),
  ];

  return cambios;
}

/**
 * Un cambio, o nada.
 *
 * Va en un array porque el orden de la comparación es el del formulario y no el
 * alfabético: es el orden en el que se leen los campos en el mensaje y en la frase
 * del historial.
 */
function campoSiCambia(
  antes: string | null,
  despues: string | null,
  campo: string,
  etiqueta: string,
): CampoEditado[] {
  return antes === despues ? [] : [{ campo, etiqueta, antes, despues }];
}

/**
 * ¿El fallo es que la fila ya no está?
 *
 * Es la carrera real de esta acción: entre que se lee la fila y se escribe, otro
 * admin puede haberla borrado, y el `update` falla con `P2025` —"registro no
 * encontrado"— en vez de con un fallo de la base. Sin distinguirlo, borrar a alguien
 * saldría como "no se ha podido guardar", que no dice qué ha pasado ni que la lista
 * de la pantalla ya no es la de antes.
 */
function filaInexistente(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025";
}

/**
 * Corrige los datos de un participante que ya está en el panel.
 *
 * ## Qué escribe y qué no
 *
 * Escribe **seis** campos —`name`, `twitchChannel`, `youtubeChannel`,
 * `kickChannel`, `country` y `discordUsername`— y nada más. Se quedan fuera a
 * propósito:
 *
 * - **El estado**, que ya tiene su aprobar/rechazar/eliminar y cuya decisión tiene
 *   su propio recorrido en la cola de revisión.
 * - **`profileId`**, que es la identidad del jugador en AoE4World y además único:
 *   cambiarlo sería cambiar de persona, y todas sus partidas vienen colgadas de él.
 * - **`aoe4WorldName`, el avatar y todo lo que escribe el worker** (elo, división,
 *   racha, `*IsLive`): son datos de la API, y quien los trae es el sincronizador.
 * - **`discordUserId`**, que sigue siendo **intocable**: es la prueba de que esa
 *   persona es quien dice ser, y solo Discord la firma. De Discord lo único editable
 *   es el `@usuario`, que es un dato de contacto con el servidor y no una identidad.
 *   Corregir una cuenta mal vinculada se hace rehaciendo el paso por Discord.
 * - **Puntos y ranking**, que ni se leen.
 *
 * ## Por eso no recalcula ni trae partidas
 *
 * Al revés que el alta, que sí trae las partidas de un jugador recién aprobado.
 * Ninguno de los seis campos entra en el motor de puntos ni en el de alertas —
 * `PlayerScore` y `Alert` hablan de partidas y de lo que se ha comprobado fuera del
 * juego, no de cómo se llama alguien—, así que no hay nada derivado que se quede
 * viejo y ninguna llamada a AoE4World que hacer. Revalida solo `/admin`, donde vive la
 * lista; la web pública es `force-dynamic` y relee en cada visita.
 *
 * ## El formulario es una foto completa de la fila
 *
 * Los seis campos se **reescriben** con lo que venga y un vacío es `null`: es el
 * mismo criterio del alta, donde un canal vacío significa "no tiene canal" y un
 * país vacío "no lo sabemos". Aquí **no hay un "no tocado"**, y es deliberado: si
 * faltara el campo en el `FormData` contaría como vacío, igual que en el alta.
 *
 * **El `@usuario` es la excepción: es obligatorio y un vacío es un error**, porque en
 * su caso `null` no significa "no lo sabemos" sino "esta fila no se puede buscar en
 * el servidor ni comprobar". El coste es que una fila anterior a F12 —que no tiene
 * `@usuario`— no se puede editar sin escribirlo, y es el precio de que el formulario
 * sea una foto de la fila: quien edita tiene que saber el `@usuario` de ese
 * participante. La unicidad se comprueba **excluyendo la fila que se está
 * editando**, porque si no, guardar sin tocar nada se rechazaría a sí mismo.
 *
 * La alternativa —escribir solo los campos que vinieran— daría dos contratos para
 * los mismos campos en el mismo panel, y el segundo tendría una trampolínea: un
 * formulario que por un descuido no mande el campo le borraría el canal sin que
 * nadie lo pidiera. Aquí no puede pasar: quien llama es un admin (lo comprueba
 * `requireAdmin`) y el formulario se pinta con los valores que ya trae la fila, así
 * que un vacío es siempre una decisión de quien edita.
 *
 * ## Validación
 *
 * Los mismos parsers y los mismos textos del alta (`createPlayer`), con el país
 * **opcional**: vacío es `null` y un valor fuera de la lista admitida es un error,
 * no un `null` en silencio. Ni el país ni los canales de YouTube y Kick tienen
 * respaldo en el perfil de AoE4World, así que un valor guardado a escondidas no lo
 * arregla nadie en la siguiente pasada; del de Twitch hay `Player.twitchUrl` como
 * plan B, pero sale de la ladder y no de la columna que escribe el panel. Del
 * `@usuario` no hay plan B en ningún sitio, y por eso tampoco se admite escrito mal.
 *
 * Los **tres** canales, incluido el de Twitch, se rechazan aquí y en el alta con el
 * mismo criterio y la misma constante. La asimetría que hubo —el alta guardaba el
 * canal de Twitch inválido como `null` en silencio— era una incoherencia dentro del
 * mismo panel: dos formularios para el mismo campo con dos reglas, y el que peor
 * salía era el alta, que es donde el valor se escribe la primera vez y donde guardarlo
 * mal no lo vuelve a corregir nadie.
 *
 * ## Concurrencia
 *
 * **Aprobar, rechazar y editar no se pisan**, y no hace falta ninguna
 * coordinación: cada acción escribe un **conjunto de columnas disjunto** —el
 * estado por un lado, los seis campos por otro— así que el `UPDATE` de una no
 * puede deshacer lo que escribió la otra. Es justo lo contrario del caso que sí
 * necesita cuidado, la reinscripción de `/participar`, donde el estado **cambia** y
 * por eso su `UPDATE` filtra por él para no pisar una aprobación.
 *
 * Sobre `Player.updatedAt` no se hace control de versión, y es una decisión: el
 * worker escribe la fila de **cada** jugador aprobado en **cada** pasada
 * (`ladder.ts`), así que ese campo se mueve solo cada cinco minutos y compararlo
 * daría conflictos falsos que no significarían nada.
 *
 * Lo que sí queda es lo normal de cualquier formulario de edición: si dos admins
 * editan la misma fila a la vez, gana el último `UPDATE`. El valor que se acaba
 * guardando es el que se ve en la fila, y por eso el mensaje dice qué campos han
 * cambiado.
 *
 * ## Qué deja en el rastro
 *
 * Una fila de `AdminAction` (`PLAYER_EDITED`), escrita **en la misma transacción**
 * que el `UPDATE`: o se ven los dos o no se ve ninguno. Encaja en el criterio del
 * enum —cambia datos que alguien más ve— porque el nombre y los canales salen en la
 * clasificación y en `/partidas`, así que una edición no es una nota privada del
 * panel. La frase la redacta `admin-actions.ts` (que es donde se redactan todas, para
 * que el historial y la pantalla no puedan divergir) y lleva **qué campos** han
 * cambiado, que es lo que se viene a mirar cuando alguien pregunta por qué un
 * participante aparece con otro nombre.
 *
 * Solo cuando hay cambios de verdad: abrir el formulario y cerrarlo sin tocar nada no
 * escribe ni el `UPDATE` ni la fila.
 */
export async function updatePlayer(
  _prevState: PlayerFormState,
  formData: FormData,
): Promise<PlayerFormState> {
  // Lo primero y por el motivo de siempre: esta acción es un endpoint público y el
  // `playerId` viene del `FormData`, o sea de quien la llama. El usuario se guarda
  // porque el rastro necesita quién editó, que es la columna `actorEmail`.
  const admin = await requireAdmin();

  const playerId = readField(formData, "playerId");

  if (!playerId) {
    return { error: "No se ha podido saber qué jugador hay que editar.", message: null };
  }

  // `readField` en todos: `FormData.get` también puede devolver un `File`, y el
  // parser recibiría `"[object File]"`, que es un valor escrito mal con otra forma.
  const name = parseName(readField(formData, "name"));
  const twitchRaw = readField(formData, "twitchChannel");
  const twitchChannel = parseTwitchChannel(twitchRaw);
  const youtubeRaw = readField(formData, "youtubeChannel");
  const youtubeChannel = parseYoutubeChannel(youtubeRaw);
  const kickRaw = readField(formData, "kickChannel");
  const kickChannel = parseKickChannel(kickRaw);
  const discordRaw = readField(formData, "discordUsername");
  const discordUsername = parseDiscordUsername(discordRaw);
  const countryRaw = readField(formData, "country");

  if (!name) {
    return { error: "El nombre es obligatorio (máx. 64 caracteres).", message: null };
  }

  // El `@usuario` es obligatorio y a diferencia de los canales y del país **un vacío
  // es un error**, no un `null`: `null` aquí significaría una fila que no se puede
  // buscar en el servidor. Ver el docblock de la acción.
  if (discordUsername === null) {
    return {
      error: discordRaw === "" ? DISCORD_USERNAME_REQUIRED_ERROR : DISCORD_USERNAME_INVALID_ERROR,
      message: null,
    };
  }

  // Los tres canales, con el criterio del alta: vacíos son `null` y un valor escrito
  // que no se puede guardar es un error de su campo. Se comprueban antes de leer la
  // lista de países porque son validaciones gratis.
  if (twitchChannel === null && twitchRaw !== "") {
    return { error: TWITCH_INVALID_ERROR, message: null };
  }

  if (youtubeChannel === null && youtubeRaw !== "") {
    return {
      error: isLegacyYoutubeUrl(youtubeRaw) ? YOUTUBE_LEGACY_URL_ERROR : YOUTUBE_INVALID_ERROR,
      message: null,
    };
  }

  if (kickChannel === null && kickRaw !== "") {
    return { error: KICK_INVALID_ERROR, message: null };
  }

  /**
   * El país, que es el único campo cuya validación necesita **leer** algo.
   *
   * Solo se lee `Setting` cuando el envío trae un país, y es a propósito: vacío es
   * `null` sin tocar nada, así que un corte al leer la lista no debe impedir
   * corregir el nombre o un canal. Igual que en el alta, si la lectura falla no se
   * valida en silencio contra `DEFAULT_COUNTRIES` —esa lista la cambia la
   * organización— sino que se pide reintentar.
   */
  let country: string | null = null;

  if (countryRaw !== "") {
    let countries: string[];

    try {
      countries = await readCountries();
    } catch (error) {
      logDatabaseFailure("admin/updatePlayer/paises", error);

      return { error: COUNTRIES_UNAVAILABLE_MESSAGE, message: null };
    }

    country = parseCountry(countryRaw, countries);

    if (country === null) {
      return { error: COUNTRY_UNKNOWN_ERROR, message: null };
    }
  }

  let actual: ({ id: string; profileId: number } & CamposEditables) | null;

  try {
    actual = await db.player.findUnique({
      where: { id: playerId },
      select: {
        id: true,
        name: true,
        profileId: true,
        twitchChannel: true,
        youtubeChannel: true,
        kickChannel: true,
        country: true,
        discordUsername: true,
      },
    });
  } catch (error) {
    logDatabaseFailure("admin/updatePlayer", error);

    return { error: SAVE_FAILED_MESSAGE, message: null };
  }

  // La fila se lee antes de escribir por dos cosas: para poder decir qué campos han
  // cambiado (y no escribir nada si no cambia ninguno) y para que un jugador que ya
  // no está salga con su propio mensaje en vez de con el de un fallo de guardado.
  if (actual === null) {
    return { error: "Ese jugador ya no está en el panel.", message: null };
  }

  // `const` a propósito: se usa en el mensaje y en la comparación, y TypeScript solo
  // estrecha un `let` si no puede haber sido reasignado entre medias.
  const player = actual;

  /**
   * Unicidad del `@usuario`, **excluyendo la fila que se está editando**.
   *
   * Sin la exclusión, guardar el formulario sin tocar nada se rechazaría a sí mismo
   * por tener su propio `@usuario`, que es el caso más normal que hay. Solo se
   * pregunta cuando el valor **cambia**, que es cuando puede aparecer el conflicto:
   * sin cambio no hay nada que comprobar y no se gasta una lectura.
   *
   * La carrera con otro admin que guarde el mismo `@usuario` a la vez la cubre el
   * `P2002` del `UPDATE`, mapeado al mismo mensaje.
   */
  if (discordUsername !== player.discordUsername) {
    let ocupado: { name: string } | null = null;

    try {
      ocupado = await db.player.findUnique({
        where: { discordUsername },
        select: { name: true },
      });
    } catch (error) {
      logDatabaseFailure("admin/updatePlayer/discord", error);

      return { error: SAVE_FAILED_MESSAGE, message: null };
    }

    // `findUnique` por `discordUsername` solo puede devolver **otra** fila: si fuera
    // esta misma, `discordUsername` ya sería igual a `player.discordUsername` y no
    // estaríamos aquí. Por eso no hace falta el `NOT: { id }` de la consulta.
    if (ocupado !== null) {
      return {
        error: frase(DISCORD_USERNAME_TAKEN_ERROR, `Ya lo usa ${ocupado.name}.`),
        message: null,
      };
    }
  }

  const despues: CamposEditables = {
    name,
    twitchChannel,
    youtubeChannel,
    kickChannel,
    country,
    discordUsername,
  };

  const cambios = camposQueCambian(player, despues);

  // Abrir el formulario y cerrarlo sin tocar nada es lo más normal del mundo —el
  // país se elige de una lista y los canales vienen ya en su forma canónica, así que
  // casi siempre se vuelve a enviar lo mismo—, así que sale como lo que es, un
  // acierto, y sin escribir una fila que ya tenía esos valores. El rastro va atado a
  // esta salida: una edición sin cambios tampoco es una fila de `AdminAction`.
  if (cambios.length === 0) {
    return {
      error: null,
      message: `No había ningún cambio que guardar en ${player.name} (AoE4World ${player.profileId}).`,
    };
  }

  try {
    // El `UPDATE` y el rastro van en la **misma transacción**, como en `createPlayer`
    // y en las demás acciones: o se ven los dos o no se ve ninguno. Un historial que
    // dice "Edición de X" sin cambio, o un cambio sin su línea, serían los dos estados
    // que el rastro no puede describir.
    await db.$transaction(async (tx) => {
      // Solo los seis campos, nunca el resto del `data` de un `Player`: lo que no se
      // nombra aquí no lo toca esta acción. En particular, `discordUserId` no se
      // escribe nunca desde aquí.
      await tx.player.update({ where: { id: playerId }, data: despues });

      await recordAdminAction(tx, {
        type: AdminActionType.PLAYER_EDITED,
        actorEmail: actorEmail(admin),
        targetId: playerId,
        name: despues.name,
        profileId: player.profileId,
        cambios,
      });
    });
  } catch (error) {
    if (filaInexistente(error)) {
      return { error: "Ese jugador ya no está en el panel.", message: null };
    }

    // La carrera con otro admin que haya guardado el mismo `@usuario` entre la
    // comprobación y esta escritura. Es el mismo problema que ya habría salido
    // antes, así que es el mismo mensaje.
    if (uniqueViolationOn(error, "discordUsername")) {
      return { error: DISCORD_USERNAME_TAKEN_ERROR, message: null };
    }

    logDatabaseFailure("admin/updatePlayer", error);

    return { error: SAVE_FAILED_MESSAGE, message: null };
  }

  revalidatePath("/admin");

  return {
    error: null,
    message: frase(
      `Se han guardado los cambios de ${player.name} (AoE4World ${player.profileId}).`,
      `Campos: ${cambios.map((cambio) => cambio.etiqueta).join(", ")}.`,
    ),
  };
}

/* -------------------------------------------------------------------------- */
/* Aprobar y rechazar                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Aprueba o rechaza una solicitud.
 *
 * Estas dos **no** registran acción en `AdminAction` y por eso mantienen la firma
 * simple de un solo `FormData`: son botones que cambian una fila que solo mira el
 * panel. Cuando la pestaña de acciones quiera mostrarlas hay que añadir su tipo al
 * enum, su frase en `admin-actions.ts` y pasar estas dos a `AdminActionResult`.
 *
 * Aprobar **sí** tiene efecto en lo que ve el público, y por eso es la única de las
 * dos que hace trabajo de más: al pasar a `APPROVED` el jugador entra en el
 * sincronizador, así que se le traen sus partidas y se recalcula la clasificación.
 * Sin eso, aprobar una solicitud de `/participar` lo dejaría invisible hasta la
 * siguiente pasada. No hay estado de vuelta que informar —el botón no lleva
 * diálogo— así que un fallo solo se registra, y el alta ya está escrita.
 */
async function setPlayerStatus(playerId: string, status: PlayerStatus) {
  await requireAdmin();

  if (!playerId) {
    return;
  }

  let jugador: { id: string; profileId: number; name: string } | null = null;

  try {
    const row = await db.player.update({
      where: { id: playerId },
      data: { status },
      select: { id: true, profileId: true, name: true },
    });

    jugador = row;
  } catch (error) {
    // Sin estado de vuelta, un fallo aquí solo puede registrarse: la acción termina
    // sin cambiar nada y no hay superficie en la que informar a quien la pulsó.
    logDatabaseFailure(`admin/${status}`, error);

    return;
  }

  if (status === PlayerStatus.APPROVED && jugador !== null) {
    const aviso = await llevarAClasificacion("admin/approvePlayer", jugador);

    if (aviso !== "") {
      console.warn(`[admin/approvePlayer] ${aviso}`);
    }
  }

  // Al final, no antes: aprobar también recalcula, y los puntos del panel salen de
  // la tabla que esa pasada acaba de reescribir.
  revalidatePath("/admin");
}

export async function approvePlayer(formData: FormData) {
  await setPlayerStatus(readField(formData, "playerId"), PlayerStatus.APPROVED);
}

export async function rejectPlayer(formData: FormData) {
  await setPlayerStatus(readField(formData, "playerId"), PlayerStatus.REJECTED);
}

/* -------------------------------------------------------------------------- */
/* Plazo de inscripción                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Abre o cierra las inscripciones del torneo.
 *
 * Es el interruptor manual del plazo: escribe `Setting["registration.open"]`, que
 * es lo que comprueban `registerPlayer` (formulario público) y `createPlayer`
 * (alta de admin). **No** se registra en `AdminAction` —igual que los cambios de
 * `scoring.ruleset`—: la fila de `Setting` ya lleva su `updatedAt` como rastro, y
 * el enum de acciones es corto a propósito.
 *
 * Lee el valor deseado de un campo `open` con `"true"`/`"false"`. Cualquier otra
 * cosa —incluido el campo ausente— se interpreta como `false`, que es el estado
 * seguro: un `FormData` hecho a mano no puede abrir el plazo por accidente.
 *
 * No devuelve estado: es un interruptor. Si la escritura falla, el motivo queda
 * en el log y el panel relee el valor real en el siguiente render, que es donde
 * se ve que no ha cambiado.
 */
export async function setRegistrationOpen(formData: FormData): Promise<void> {
  await requireAdmin();

  const open = readField(formData, "open") === "true";

  try {
    await writeRegistrationOpen(open);
  } catch (error) {
    logDatabaseFailure("admin/setRegistrationOpen", error);

    return;
  }

  // Las dos caras del interruptor: el panel donde se cambia y el formulario
  // público donde se nota.
  revalidatePath("/admin");
  revalidatePath("/participar");
}

/* -------------------------------------------------------------------------- */
/* Baja de jugador                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Borra un jugador con todo lo suyo y deja la clasificación coherente.
 *
 * El borrado de `Player` arrastra en cascada sus partidas y sus filas de
 * clasificación, así que la web deja de listarlo de inmediato. Aun así se recalcula:
 * es lo que garantiza que la pasada que se escriba a continuación describa la
 * clasificación que realmente queda, en vez de dejarlo para que lo arregle el cron.
 *
 * **A diferencia del revert, aquí un fallo del recálculo no se compensa**, y es a
 * propósito: el jugador ya está borrado y no se puede deshacer un borrado sin
 * inventar un "deshacer" que nadie pidió. Pero tampoco queda nada incoherente: los
 * puntos de cada jugador son de sus propias partidas, así que quitar a un jugador no
 * cambia los totales de los demás, y su fila de `PlayerScore` ya no existe. Lo único
 * pendiente es el rastro de `scoring.lastRun`, que se rellena en la siguiente
 * pasada. Por eso el estado devuelto es de **éxito con un aviso**: el borrado sí ha
 * pasado, y callarlo sería peor que decirlo.
 */
export async function deletePlayer(
  _prevState: AdminActionResult,
  formData: FormData,
): Promise<AdminActionResult> {
  const admin = await requireAdmin();
  const playerId = readField(formData, "playerId");

  if (!playerId) {
    return { status: "error", message: "No se ha podido saber qué jugador hay que borrar." };
  }

  let encontrado: {
    id: string;
    name: string;
    profileId: number;
    matchCount: number;
  } | null;

  try {
    const row = await db.player.findUnique({
      where: { id: playerId },
      select: {
        id: true,
        name: true,
        profileId: true,
        _count: { select: { matches: true } },
      },
    });

    encontrado =
      row === null
        ? null
        : {
            id: row.id,
            name: row.name,
            profileId: row.profileId,
            matchCount: row._count.matches,
          };
  } catch (error) {
    logDatabaseFailure("admin/deletePlayer", error);

    return { status: "error", message: SAVE_FAILED_MESSAGE };
  }

  if (encontrado === null) {
    return { status: "error", message: "Ese jugador ya no está en el panel." };
  }

  // `const` a propósito: se usa dentro de un cierre (la transacción) y TypeScript
  // solo estrecha un `let` si no puede haber sido reasignado entre medias.
  const player = encontrado;

  try {
    await db.$transaction(async (tx) => {
      await tx.player.delete({ where: { id: player.id } });

      await recordAdminAction(tx, {
        type: AdminActionType.PLAYER_REMOVED,
        actorEmail: actorEmail(admin),
        targetId: player.id,
        name: player.name,
        profileId: player.profileId,
        matchCount: player.matchCount,
      });
    });
  } catch (error) {
    logDatabaseFailure("admin/deletePlayer", error);

    return { status: "error", message: SAVE_FAILED_MESSAGE };
  }

  revalidatePath("/admin");

  const partidas =
    player.matchCount === 0
      ? "No tenía partidas guardadas."
      : `Sus ${player.matchCount} ${player.matchCount === 1 ? "partida" : "partidas"} se han borrado con ella.`;

  return {
    status: "success",
    message: frase(
      `Se ha eliminado a ${player.name} (AoE4World ${player.profileId}).`,
      partidas,
      await avisoDeRecalculo("admin/deletePlayer"),
    ),
  };
}

/* -------------------------------------------------------------------------- */
/* Puntos de una partida                                                       */
/* -------------------------------------------------------------------------- */

/** La partida tal y como la necesitan estas dos acciones. */
type MatchForScoring = {
  id: string;
  gameId: string;
  points: number;
  revertedAt: Date | null;
  /** `Player.id` de la fila afectada: las alertas se reevalúan por id, no por `profileId`. */
  playerId: string;
  /** Lo que `countsAsRanked()` necesita para decidir si la partida cuenta. */
  mode: string | null;
  result: MatchResult | null;
  startedAt: Date;
  finishedAt: Date | null;
  /**
   * `Player.registeredAt` del dueño, o `null` si no lo tiene: es la otra mitad del
   * corte de la regla. Sin él, una partida anterior a la inscripción parecería
   * clasificatoria y se podría marcar para siempre.
   */
  registeredAt: Date | null;
  playerName: string;
  playerProfileId: number;
};

/**
 * Recalcula la clasificación y devuelve el aviso si no lo ha conseguido.
 *
 * No lanza, porque en `deletePlayer` el cambio **ya está escrito** y propagar el
 * error dejaría a quien lo pidió creyendo que no se aplicó nada cuando sí. El texto
 * va vacío cuando todo fue bien.
 */
async function avisoDeRecalculo(scope: string): Promise<string> {
  try {
    await recomputeScores();

    return "";
  } catch (error) {
    logDatabaseFailure(`${scope}/recompute`, error);

    return "La clasificación se recalculará sola en la próxima pasada del sincronizador.";
  }
}

/**
 * Vuelve a dejar la partida como estaba y borra la fila de `AdminAction` que esta
 * misma acción acaba de escribir.
 *
 * Es la compensación del revert, y va en **una** transacción para que el estado
 * final sea coherente: o la partida vuelve a puntuar y no queda rastro del intento,
 * o no se toca nada.
 *
 * Devuelve si se pudo. Un `false` significa que la base está en mal estado, y eso hay
 * que decirlo: es el único caso en el que el sistema queda en un estado que nadie
 * puede ver —una partida marcada cuya clasificación todavía la cuenta— y por eso el
 * mensaje de la acción lo dice en voz alta en vez de fingir que no ha pasado nada.
 */
async function deshacerMarcaDePartida(
  matchId: string,
  revertedAt: Date | null,
  actionId: string,
): Promise<boolean> {
  try {
    await db.$transaction(async (tx) => {
      await tx.match.update({ where: { id: matchId }, data: { revertedAt } });
      await tx.adminAction.delete({ where: { id: actionId } });
    });

    return true;
  } catch (error) {
    logDatabaseFailure("admin/deshacerMarca", error);

    return false;
  }
}

/**
 * Marca una partida como revertida (o quita la marca) y recalcula la clasificación.
 *
 * ## Por qué la marca y el recálculo no van en la misma transacción
 *
 * `recomputeScores()` es el motor entero: ruleset, `UPDATE` de `Match.points`,
 * objetivos, agregado y `PlayerScore`, con su cerrojo `pg_advisory_xact_lock` y su
 * plazo de 60 s. Meterlo en la transacción de la acción obligaría a mantener ese
 * cerrojo durante una escritura que no lo necesita (un `UPDATE` de una sola fila) y a
 * que el panel quedara detrás del cron cada vez que coincidieran. Se hacen seguidas,
 * y el estado intermedio dura lo que tarda el motor.
 *
 * ## Por qué un fallo del recálculo se compensa en vez de propagarse
 *
 * Porque `recomputeScores()` es **atómico**: si falla, su transacción ha deshecho todo
 * lo que escribía (`Match.points`, `PlayerScore`, `scoring.lastRun`), de modo que la
 * base está exactamente como estaba. Lo único que queda fuera de esa transacción es
 * la marca que se acaba de poner, y por eso la compensación deshace **esa** y borra
 * **su** fila de `AdminAction`: el estado final es el de antes del clic.
 *
 * La alternativa —propagar el error y dejar la partida marcada— dejaría el torneo en
 * un estado que nadie puede ver desde ningún sitio: el historial de acciones diría
 * "revertidos 10 puntos", la pestaña de partidas la mostraría marcada y la
 * clasificación pública seguiría contando esos 10 puntos. Y no durarían mucho: el
 * cron lo arreglaría en su siguiente pasada, pero mientras dure es una clasificación
 * que no cuadra con los datos que el propio panel enseña.
 *
 * Si la compensación **tampoco** sale (base caída de verdad) no hay más remedio que
 * decirlo, y el mensaje lo dice: la acción devuelve error y avisa de que la marca ha
 * quedado puesta y hay que revisarla a mano.
 */
async function setMatchReverted(
  formData: FormData,
  revert: boolean,
): Promise<AdminActionResult> {
  const admin = await requireAdmin();
  const scope = revert ? "admin/revertMatchPoints" : "admin/restoreMatchPoints";
  const matchId = readField(formData, "matchId");

  if (!matchId) {
    return { status: "error", message: "No se ha podido saber qué partida hay que cambiar." };
  }

  let encontrada: MatchForScoring | null;

  try {
    const row = await db.match.findUnique({
      where: { id: matchId },
      select: {
        id: true,
        gameId: true,
        points: true,
        revertedAt: true,
        playerId: true,
        mode: true,
        result: true,
        startedAt: true,
        finishedAt: true,
        player: { select: { name: true, profileId: true, registeredAt: true } },
      },
    });

    encontrada =
      row === null
        ? null
        : {
            id: row.id,
            gameId: row.gameId,
            points: row.points,
            revertedAt: row.revertedAt,
            playerId: row.playerId,
            mode: row.mode,
            result: row.result,
            startedAt: row.startedAt,
            finishedAt: row.finishedAt,
            // Sale en la fila plana, no como `player.registeredAt`, porque
            // `countsAsRanked()` lo toma como un dato más de la partida y no como
            // una relación.
            registeredAt: row.player.registeredAt,
            playerName: row.player.name,
            playerProfileId: row.player.profileId,
          };
  } catch (error) {
    logDatabaseFailure(scope, error);

    return { status: "error", message: SAVE_FAILED_MESSAGE };
  }

  if (encontrada === null) {
    return { status: "error", message: "Esa partida ya no existe." };
  }

  if (revert && encontrada.revertedAt !== null) {
    return { status: "error", message: "La partida ya estaba revertida." };
  }

  if (!revert && encontrada.revertedAt === null) {
    return { status: "error", message: "La partida no estaba revertida." };
  }

  // `const` a propósito: se usa dentro de un cierre (la transacción) y TypeScript
  // solo estrecha un `let` si no puede haber sido reasignado entre medias.
  const match = encontrada;

  /**
   * La misma pregunta que se hace el motor, con la misma función, y **la misma
   * respuesta en los dos sentidos**: solo tiene sentido tocar una partida que cuenta.
   * Al revertir, porque es lo que se le quita; al restaurar, porque es lo que vuelve.
   * Se pregunta siempre con `revertedAt: null`, que es lo que deja la decisión en las
   * otras cuatro condiciones de la regla.
   *
   * Sin esta guarda, un `FormData` hecho a mano podría dejar marcada para siempre una
   * partida que nunca llegó a puntuar, y el admin vería "revertida" en el histórico de
   * algo que en realidad nunca contó. Y al revés: una partida anterior al alta del
   * jugador tiene `points = 0` porque no llegó a contar, así que marcarla sería
   * inventar un estado que el torneo nunca tuvo.
   *
   * Que el criterio sea el mismo en ambos sentidos es deliberado. Con la guarda
   * invertida al restaurar, ninguna partida clasificatoria se podía devolver: se
   * exigía que no contara. El revert quedaba sin vuelta desde el panel.
   */
  const ruleset = await readRuleset();
  const contariaSinMarca = countsAsRanked(
    { ...match, revertedAt: null },
    ruleset.window,
    match.registeredAt,
  );

  if (!contariaSinMarca) {
    return {
      status: "error",
      message: revert
        ? "Esa partida no es clasificatoria con las reglas actuales, así que no puntúa y no hay nada que revertir."
        : "Esa partida no era clasificatoria con las reglas actuales, así que restaurar sus puntos no cambia la clasificación.",
    };
  }

  /**
   * Los puntos que la partida tiene o recupera, según la dirección del cambio.
   *
   * En el `revert` es `Match.points`, que es justo lo que se está quitando. En el
   * `restore` **no** se puede leer de ahí, porque el motor puso esa fila a `0` al
   * revertirla: lo que vuelve a contar es lo que le corresponde según el ruleset
   * activo, que es la misma fórmula que escribe `recomputeScores()`. Con un ruleset
   * retocado entre medias, además, es el valor que de verdad va a aparecer.
   *
   * Va en el mismo valor para el rastro (`summary` y `details`) y para el mensaje que
   * ve quien lo pulsa, porque son la misma cifra contada desde dos sitios: si se
   * calcularan por separado, el historial y el mensaje acabarían discrepando.
   */
  const puntosDeLaPartida =
    revert ? match.points : match.result === MatchResult.WIN ? ruleset.pointsPerWin : 0;

  const marca = revert ? new Date() : null;
  let actionId: string;

  try {
    actionId = await db.$transaction(async (tx) => {
      await tx.match.update({ where: { id: match.id }, data: { revertedAt: marca } });

      return recordAdminAction(tx, {
        type: revert
          ? AdminActionType.MATCH_POINTS_REVERTED
          : AdminActionType.MATCH_POINTS_RESTORED,
        actorEmail: actorEmail(admin),
        targetId: match.id,
        playerName: match.playerName,
        profileId: match.playerProfileId,
        gameId: match.gameId,
        points: puntosDeLaPartida,
      });
    });
  } catch (error) {
    logDatabaseFailure(scope, error);

    return { status: "error", message: SAVE_FAILED_MESSAGE };
  }

  try {
    await recomputeScores();
  } catch (error) {
    logDatabaseFailure(`${scope}/recompute`, error);

    const compensado = await deshacerMarcaDePartida(match.id, match.revertedAt, actionId);

    return {
      status: "error",
      message: compensado
        ? "No se ha podido recalcular la clasificación, así que el cambio se ha deshecho: la partida sigue como estaba."
        : "No se ha podido recalcular la clasificación ni deshacer el cambio: la partida ha quedado marcada y hay que revisarla a mano. El motivo está en el log del servidor.",
    };
  }

  // La partida ya no cuenta (o vuelve a contar) y eso cambia el conjunto de
  // clasificatorias del jugador, así que sus rachas y sus acumulados también
  // cambian. Va **después** del recálculo y fuera de su compensación a propósito:
  // las alertas son un informe derivado y append-only, y un fallo suyo no deja
  // nada a medias —lo que no habría pasado si se evaluaran antes de confirmar el
  // cambio—. Si falla, la siguiente pasada del sincronizador lo arregla, y lo
  // dice `reevaluatePlayerAlerts` en el log.
  await reevaluatePlayerAlerts(match.playerId);

  revalidatePath("/admin");

  return {
    status: "success",
    message: revert
      ? frase(
          `Se han revertido ${puntos(puntosDeLaPartida)} de la partida ${match.gameId} de ${match.playerName}.`,
          "La partida sigue en el histórico y se pueden volver a poner.",
        )
      : `Se han restaurado ${puntos(puntosDeLaPartida)} de la partida ${match.gameId} de ${match.playerName}.`,
  };
}

/**
 * Deja de puntuar una partida sin borrarla.
 *
 * La fila se queda en el histórico marcada con `revertedAt`, el motor la excluye de
 * los puntos, del agregado y de los objetivos, y el worker de sincronización no la
 * toca: una partida borrada volvería a aparecer en su siguiente pasada. Es reversible
 * con `restoreMatchPoints`.
 */
export async function revertMatchPoints(
  _prevState: AdminActionResult,
  formData: FormData,
): Promise<AdminActionResult> {
  return setMatchReverted(formData, true);
}

/** Quita la marca de `revertMatchPoints` y devuelve los puntos al torneo. */
export async function restoreMatchPoints(
  _prevState: AdminActionResult,
  formData: FormData,
): Promise<AdminActionResult> {
  return setMatchReverted(formData, false);
}

/* -------------------------------------------------------------------------- */
/* Sincronización a mano                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Estado de `syncNow`.
 *
 * No reutiliza `AdminActionResult` porque esta necesita un tercer estado: el candado
 * puede responder "ahora no" sin que sea un fallo —la pasada se hizo hace nada—, y
 * quien lo lee tiene que distinguir "no he podido sincronizar" de "no hacía falta".
 */
export type SyncNowState = {
  status: "idle" | "success" | "cooldown" | "error";
  message: string | null;
};

/**
 * Minutos que dice el mensaje de cooldown.
 *
 * Salen de la constante del candado y no de un número escrito a mano, para que el texto
 * no pueda mentir si algún día cambia la ventana. Ver `src/lib/manual-sync.ts`.
 */
const MINUTOS_DE_CANDADO = MANUAL_SYNC_COOLDOWN_SECONDS / 60;

/**
 * Lanza una pasada del sincronizador a mano, para cuando el cron no llega.
 *
 * Es la **única** vía manual que queda: el botón de `/partidas` se retiró y la llamada
 * pasó aquí, detrás de `requireAdmin()`. Eso no es una comodidad —recuperar un torneo
 * congelado es una operación de la organización— y además es lo que evita tener un
 * botón público que cualquiera pueda machacar. `/api/sync` no se cierra: sigue siendo el
 * disparo del cron de Supabase, sin cambios.
 *
 * ## Por qué comparte candado con el cron
 *
 * Es el mismo candado global de `/api/sync` (`src/lib/manual-sync.ts`), y no uno
 * propio. Con dos candados, un admin podía encadenar pasadas seguidas mientras el cron
 * seguía creyendo que su ventana estaba libre: el trabajo real —las peticiones a la API
 * de AoE4World y el presupuesto de CPU del plan Free— lo pagan las dos, y el candado
 * compartido es lo que impide que se apilen. El precio es que la cadencia real del
 * torneo sigue siendo la de un sync cada 5-10 minutos, no mejor.
 *
 * ## Por qué no registra `AdminAction`
 *
 * Porque la pasada ya deja un rastro más completo: `Setting["sync.lastRun"]` guarda los
 * contadores, los errores y los jugadores que no se pudieron sincronizar, y es lo que
 * alimenta el aviso de salud de `/admin`. Una fila en el historial de acciones por cada
 * pasada sería ruido: esto no cambia el torneo, solo lo consulta.
 *
 * ## Por qué no declara parámetros
 *
 * Porque no lee ni un campo del formulario ni el estado anterior: el botón no tiene nada
 * que mandar. Sigue siendo la acción que espera `useActionState` —devuelve el estado
 * nuevo y React refresca la ruta—, porque una función sin parámetros es asignable a la
 * que la pide.
 */
export async function syncNow(): Promise<SyncNowState> {
  await requireAdmin();

  let lock: ManualSyncLock;

  try {
    lock = await consumeManualSyncLock();
  } catch (error) {
    // Sin candado comprobado **no** se lanza la pasada. Al revés, el botón sería una
    // forma de pedir tantas pasadas como se pulsara, que es justo lo que el candado
    // existe para impedir. El motivo se queda en el log; a quien lo pulsó solo le
    // llega que ahora no se puede.
    console.error(
      "[admin/syncNow] No se ha podido comprobar el candado del sync manual:",
      error instanceof Error ? error.message : String(error),
    );

    return {
      status: "error",
      message:
        "No se ha podido comprobar si toca sincronizar. Inténtalo de nuevo en unos minutos.",
    };
  }

  if (!lock.allowed) {
    // No es un error: la pasada ya se hizo hace nada, así que tampoco hacía falta otra.
    // Por eso tiene su propio estado y no se pinta como fallo.
    return {
      status: "cooldown",
      message: `Se ha sincronizado hace poco; el candado deja una pasada cada ${MINUTOS_DE_CANDADO} minutos.`,
    };
  }

  let summary: SyncSummary;

  try {
    // La pasada son ~15 s de llamadas a AoE4World más el recálculo, así que el botón
    // tiene que aguantar en estado de "pendiente" ese rato. Es normal que tarde: no es
    // una escritura de formulario corta.
    summary = await syncApprovedPlayers();
  } catch (error) {
    // `syncApprovedPlayers()` no propaga ni el fallo de un jugador ni el del recálculo:
    // los deja en el resumen. Lo que llega aquí es que la pasada no se pudo hacer
    // (configuración o base de datos), y entonces el rastro tampoco se ha escrito.
    console.error(
      "[admin/syncNow] La pasada manual ha fallado:",
      error instanceof Error ? error.message : String(error),
    );

    return {
      status: "error",
      message: "No se ha podido sincronizar ahora mismo. El motivo está en el log del servidor.",
    };
  }

  // Al final, no antes: la pasada acaba de reescribir `PlayerScore` y `sync.lastRun`, que
  // son justo las dos cosas que pinta `/admin` (los contadores y el aviso de salud del
  // sincronizador).
  revalidatePath("/admin");

  const segundos = Math.round(summary.durationMs / 1000);

  return {
    status: "success",
    message: frase(
      `Pasada terminada en ${segundos} s.`,
      // Con cero aprobados la frase de "3 de 3 sincronizados" sería mentira de rigor:
      // no se ha sincronizado a nadie porque no hay a quién.
      summary.playersTotal === 0
        ? "No hay jugadores aprobados que sincronizar."
        : `${summary.playersOk} de ${summary.playersTotal} jugadores sincronizados.`,
      summary.playersFailed > 0
        ? `${summary.playersFailed} no se han podido sincronizar; están en el aviso de esta misma pestaña.`
        : "",
      `${summary.newMatches} ${summary.newMatches === 1 ? "partida nueva" : "partidas nuevas"}.`,
      // Un fallo del recálculo no da la vuelta atrás el trabajo ya hecho —las partidas
      // están guardadas— así que es un éxito con aviso, no un `error`. El motivo literal
      // no se enseña: ya lo registra el worker, y aquí solo hace falta que se sepa que la
      // clasificación que se ve es la anterior.
      summary.scoringError !== null
        ? "No se ha podido recalcular la clasificación, así que la web sigue enseñando la anterior: se reintentará en la próxima pasada."
        : "",
    ),
  };
}
