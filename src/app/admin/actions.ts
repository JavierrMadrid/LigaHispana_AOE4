"use server";

import type { User } from "@supabase/supabase-js";
import type { SyncSummary } from "@/lib/aoe4world/sync";
import type { ManualSyncLock } from "@/lib/manual-sync";
import { revalidatePath } from "next/cache";
import { Prisma } from "@/generated/prisma/client";
import { AdminActionType, MatchResult, PlayerStatus } from "@/generated/prisma/enums";
import { puntos, recordAdminAction } from "@/lib/admin-actions";
import { dispatchAdminNotice } from "@/lib/admin-notice-send";
import {
  countsWithoutRevertMark,
  deletePlayerCascade,
  recomputeWithWarning,
  type MatchForScoring,
} from "@/lib/admin-revert";
import { reevaluatePlayerAlerts } from "@/lib/alerts/evaluate";
import { readDivisionCutoffs } from "@/lib/alerts/settings";
import { syncApprovedPlayers } from "@/lib/aoe4world/sync";
import { requireAdmin, requireSuperadmin } from "@/lib/auth";
import { readCountries } from "@/lib/countries";
import { db } from "@/lib/db";
import { logDatabaseFailure, uniqueViolationOn } from "@/lib/db-errors";
import { parseMatcherinoDonations, type MatcherinoDonations } from "@/lib/donations";
import { formatAbsoluteTime } from "@/lib/format";
import { consumeManualSyncLock, MANUAL_SYNC_COOLDOWN_SECONDS } from "@/lib/manual-sync";
import {
  campoSiCambia,
  camposQueCambian,
  DISCORD_USERNAME_TAKEN_ERROR,
  parsePlayerField,
  parsePlayerFieldsWithoutCountry,
  type CamposEditables,
} from "@/lib/player-fields";
import { parseProfileId } from "@/lib/player-input";
import { rankedMatchWhere, parseMadridLocalInstant } from "@/lib/ranked-match";
import { registrationClosedMessage } from "@/lib/registration-open";
import { readRuleset, recomputeScores } from "@/lib/scoring";
import {
  readMatcherinoDonations,
  readRegistrationState,
  writeMatcherinoDonations,
  writeRegistrationClosesAt,
  writeRegistrationOpen,
} from "@/lib/settings";

/**
 * Server Actions del panel de administración.
 *
 * Todas viven bajo `src/app/admin/**` a propósito, y todas empiezan por una
 * comprobación de permisos en el servidor: `requireAdmin()` las de gestión del panel,
 * y `requireSuperadmin()` las dos opciones que solo puede tocar el superadministrador
 * (el plazo de inscripción y la campaña de donaciones). Las dos cosas son la misma
 * defensa:
 *
 * - El `matcher` del Proxy (`src/proxy.ts`) cubre `/admin/:path*`, y **excluir una
 *   ruta del `matcher` excluye también sus Server Functions**. Una acción fuera de
 *   `/admin` no se saltaría solo la comprobación optimista de la cookie: en el Proxy
 *   no se ejecutaría, así que su comprobación de permisos ni siquiera llegaría a
 *   hacer nada.
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
 * campos distintos: el alta empieza una fila y la edición reescribe siete campos de
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
   * No es un error: el jugador está dado de alta sí o sí. Es para avisar de cuándo
   * entra en la clasificación, que es la duda que deja el alta: como solo escribe el
   * estado, es la siguiente pasada del sincronizador la que le crea la fila. Una vez
   * aprobado aparece siempre en la tabla —con todo a cero si aún no tiene ninguna
   * partida clasificatoria—, así que el aviso habla de la hora de entrada, no de si
   * llegará a salir.
   */
  message: string | null;
};

/* -------------------------------------------------------------------------- */
/* Utilidades                                                                  */
/* -------------------------------------------------------------------------- */

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

/**
 * La fecha de cierre de inscripciones que se ha escrito no vale.
 *
 * Se aceptan las dos formas que puede mandar el panel: una fecha y hora de
 * `datetime-local` (**sin zona**), que el servidor interpreta en `Europe/Madrid` como
 * la ventana del ruleset, y un instante ISO-8601 **con zona**. Y se dice cómo quitar la
 * fecha, que es un caso de uso de verdad (reabrir después del cierre).
 */
const REGISTRATION_CLOSES_AT_INVALID_MESSAGE =
  "La fecha de cierre no es válida. Se acepta una fecha y hora (se interpreta en hora de Madrid) o un instante ISO-8601 con zona horaria, por ejemplo 2026-10-01T00:00:00Z. Para quitar la fecha, deja el campo vacío.";

/**
 * La validación de los campos de un jugador —el criterio y los mensajes— vive en
 * `src/lib/player-fields.ts`: la comparten el alta, la edición y la reversión de una
 * edición, y tenerla aquí la habría duplicado en cuanto apareciera la tercera.
 */

/** Junta frases sin que aparezca ni un espacio de más ni un doble espacio. */
function frase(...partes: string[]): string {
  return partes
    .map((parte) => parte.trim())
    .filter((parte) => parte !== "")
    .join(" ");
}

/**
 * Un booleano como texto, para el `details` del rastro.
 *
 * `campoSiCambia` compara cadenas, y el `details` guarda primitivos: el valor de
 * un interruptor se registra tal cual —"true" o "false"— y no como un booleano de
 * verdad, para que la fila del historial se lea igual que la de la edición de un
 * jugador. Es la misma conversión que `boolText()` en `administracion/actions.ts`.
 */
function boolText(value: boolean): string {
  return value ? "true" : "false";
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
 * ## El país y el correo son opcionales aquí y obligatorios en `/participar`
 *
 * Los dos los **exige** el formulario público —el país es de los datos con los que
 * la organización organiza el torneo, y el correo es donde se responde a las
 * dudas— y los dos los **admite** el alta de admin con el mismo criterio: se puede
 * dar de alta a alguien sin saber su país o sin que nos hayan dado su correo, y
 * por eso las dos columnas son nullable en el schema.
 *
 * Lo que no se admite en ningún caso es un valor **mal escrito**: un país que no
 * está en la lista vigente y un correo que no es una dirección son errores, no
 * algo que se ignore en silencio y se guarde como `null`. Si se guardara, la fila
 * diría "no lo sabemos" cuando en realidad lo que pasó es que alguien escribió un
 * país que no existe o un correo que no vale, y esas dos cosas son distintas.
 * Vacío sí es `null`, que es lo que la columna significa.
 *
 * ## Qué se escribe y en qué orden
 *
 * El alta **solo escribe la fila**. No trae partidas ni recalcula en línea: el
 * jugador entra en la clasificación en la siguiente pasada del sincronizador
 * (hasta 10 minutos) o cuando la organización pulse «Sincronizar ahora» en esta
 * misma pestaña. Es una decisión de producto, no un olvido: en el plan Free de
 * Cloudflare el presupuesto es de 10 ms de CPU por invocación y una pasada gasta
 * ~500 ms, así que lanzarla dentro de la petición del alta muere con `Worker
 * exceeded CPU time limit` (1102) en cuanto se apilan dos altas. El aviso que
 * devuelve el formulario lo explica.
 *
 * Un aprobado tiene fila en la clasificación aunque no haya jugado nada todavía:
 * sale con todo a cero y con su puesto por el desempate. El aviso no promete que ya
 * esté, porque la fila se la crea el recálculo: dice que entra en el siguiente, que
 * es lo que hace el sincronizador.
 *
 * Los tres canales de directo —Twitch, YouTube y Kick— se validan con **el mismo
 * criterio y los mismos mensajes** que la edición (`updatePlayer`), y los tres están
 * definidos en `src/lib/player-fields.ts`: opcionales, y un valor escrito que no se
 * puede guardar es un error en lugar de un `null` silencioso. Que no haya respaldo
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
  // formulario público: es el mismo estado (`Setting["registration.open"]` y la fecha
  // `Setting["registration.closesAt"]`) y se comprueba en servidor aunque la acción se
  // llame a mano. Va lo primero, antes de validar nada, porque con el plazo cerrado no
  // se va a escribir: no tiene sentido pagar validaciones ni lecturas para un alta
  // descartada.
  //
  // Aprobar y rechazar solicitudes **no** pasan por aquí y siguen funcionando
  // siempre: el cierre cierra el alta, no la gestión de lo ya recibido.
  let registration;

  try {
    registration = await readRegistrationState();
  } catch (error) {
    logDatabaseFailure("admin/createPlayer/plazo", error);

    return { error: REGISTRATION_UNAVAILABLE_MESSAGE, message: null };
  }

  if (!registration.open) {
    return { error: registrationClosedMessage(registration), message: null };
  }

  // `readField` en todos, como en la edición: `formData.get` también puede
  // devolver un `File`, y el parser recibiría `"[object File]"`, que es un valor
  // escrito mal con otra forma. En el nombre eso además pasaba la validación.
  const profileId = parseProfileId(readField(formData, "profileId"));
  const statusRaw = readField(formData, "status") || "APPROVED";
  const status =
    statusRaw === "PENDING" || statusRaw === "REJECTED" ? statusRaw : "APPROVED";

  if (!profileId) {
    return { error: "El profile ID de AoE4World debe ser un número.", message: null };
  }

  // Los seis campos que no necesitan leer nada se validan con el criterio compartido
  // (`src/lib/player-fields.ts`), y **antes** de tocar la base: un envío mal escrito no
  // tiene por qué pagar la lectura de la lista de países.
  const campos = parsePlayerFieldsWithoutCountry({
    name: readField(formData, "name"),
    contactEmail: readField(formData, "email"),
    twitchChannel: readField(formData, "twitchChannel"),
    youtubeChannel: readField(formData, "youtubeChannel"),
    kickChannel: readField(formData, "kickChannel"),
    discordUsername: readField(formData, "discordUsername"),
  });

  if (!campos.ok) {
    return { error: campos.error, message: null };
  }

  const countryRaw = readField(formData, "country");

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

  // Vacío es `null` (el campo es opcional aquí); un valor que no está en la lista
  // es un error, no algo que se guarde como si no se hubiera escrito.
  const parsedCountry = parsePlayerField("country", countryRaw, countries);

  if (!parsedCountry.ok) {
    return { error: parsedCountry.error, message: null };
  }

  const { name, contactEmail, twitchChannel, youtubeChannel, kickChannel, discordUsername } =
    campos.campos;
  const country = parsedCountry.value;

  // El `try` cubre **solo** la base de datos. Un fallo de validación tiene que
  // seguir siendo un error de aplicación, y por eso el bloque va aquí y no
  // alrededor de la acción entera.
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
          contactEmail,
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

  // El alta solo escribe el estado; quién entra en la clasificación lo decide la
  // siguiente pasada del sincronizador. Por eso el mensaje de un aprobado avisa de
  // cuándo entra y de que se puede forzar: todavía no tiene fila en `PlayerScore`
  // (la crea el recálculo), así que decir que ya está lo haría mentir.
  if (status === PlayerStatus.APPROVED) {
    return {
      error: null,
      message: `Se ha dado de alta a ${name}. Aparecerá en la clasificación en la próxima pasada del sincronizador (hasta 10 minutos), con 0 puntos y 0 partidas hasta que tenga partidas clasificatorias; puedes forzarla con «Sincronizar ahora» en esta misma pestaña.`,
    };
  }

  if (status === PlayerStatus.PENDING) {
    return {
      error: null,
      message: `Se ha dado de alta a ${name} como pendiente. Al aprobarlo aparecerá en la clasificación en la próxima pasada del sincronizador (hasta 10 minutos), con 0 puntos y 0 partidas hasta que tenga partidas clasificatorias.`,
    };
  }

  return { error: null, message: null };
}

/* -------------------------------------------------------------------------- */
/* Edición de jugador                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Los siete campos editables y su comparación viven en `src/lib/player-fields.ts`,
 * junto con su validación: la edición y la reversión de una edición tienen que
 * comparar y validar exactamente lo mismo.
 */

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
 * Escribe **siete** campos —`name`, `contactEmail`, `twitchChannel`,
 * `youtubeChannel`, `kickChannel`, `country` y `discordUsername`— y nada más. Se
 * quedan fuera a propósito:
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
 * Ninguno de los siete campos entra en el motor de puntos ni en el de alertas —
 * `PlayerScore` y `Alert` hablan de partidas y de lo que se ha comprobado fuera del
 * juego, no de cómo se llama alguien—, así que no hay nada derivado que se quede
 * viejo y ninguna llamada a AoE4World que hacer. Revalida solo `/admin`, donde vive la
 * lista; la web pública es `force-dynamic` y relee en cada visita.
 *
 * ## El formulario es una foto completa de la fila
 *
 * Los siete campos se **reescriben** con lo que venga y un vacío es `null`: es el
 * mismo criterio del alta, donde un canal vacío significa "no tiene canal" y un
 * correo o un país vacíos "no lo sabemos". Aquí **no hay un "no tocado"**, y es
 * deliberado: si faltara el campo en el `FormData` contaría como vacío, igual que
 * en el alta.
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
 * Los mismos parsers y los mismos textos del alta (`createPlayer`), con el país y
 * el correo **opcionales**: vacío es `null` y un valor mal escrito —fuera de la
 * lista admitida en el caso del país, con una forma que no es de dirección en el del
 * correo— es un error, no un `null` en silencio. Ni el país, ni el correo, ni los
 * canales de YouTube y Kick tienen respaldo en el perfil de AoE4World, así que un
 * valor guardado a escondidas no lo arregla nadie en la siguiente pasada; del de
 * Twitch hay `Player.twitchUrl` como plan B, pero sale de la ladder y no de la
 * columna que escribe el panel. Del `@usuario` no hay plan B en ningún sitio, y por
 * eso tampoco se admite escrito mal.
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
 * estado por un lado, los siete campos por otro— así que el `UPDATE` de una no
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
 * panel. El correo no sale de aquí —es un dato de contacto y la web pública no lo
 * publica—, pero cambiarlo sigue siendo una edición del panel. La frase la redacta
 * `admin-actions.ts` (que es donde se redactan todas, para
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
  const campos = parsePlayerFieldsWithoutCountry({
    name: readField(formData, "name"),
    contactEmail: readField(formData, "email"),
    twitchChannel: readField(formData, "twitchChannel"),
    youtubeChannel: readField(formData, "youtubeChannel"),
    kickChannel: readField(formData, "kickChannel"),
    discordUsername: readField(formData, "discordUsername"),
  });

  if (!campos.ok) {
    return { error: campos.error, message: null };
  }

  const { name, contactEmail, twitchChannel, youtubeChannel, kickChannel, discordUsername } =
    campos.campos;
  const countryRaw = readField(formData, "country");

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

    const parsedCountry = parsePlayerField("country", countryRaw, countries);

    if (!parsedCountry.ok) {
      return { error: parsedCountry.error, message: null };
    }

    country = parsedCountry.value;
  }

  let actual: ({ id: string; profileId: number } & CamposEditables) | null;

  try {
    actual = await db.player.findUnique({
      where: { id: playerId },
      select: {
        id: true,
        name: true,
        profileId: true,
        contactEmail: true,
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
    contactEmail,
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
      // Solo los siete campos, nunca el resto del `data` de un `Player`: lo que no se
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
 * Escribe el estado **y su línea en el historial de acciones** en la misma
 * transacción: aprobar mete al jugador en la clasificación y rechazar lo deja fuera,
 * así que son los dos movimientos que la organización viene a auditar en
 * `/admin/acciones` y tienen que quedar con quién y cuándo aunque la escritura del
 * estado no llegue a confirmarse.
 *
 * Repetir un POST no inventa un movimiento: si el jugador ya está en el estado pedido
 * no se escribe ni el `update` ni la fila de `AdminAction`. Y si la fila ya no existe
 * —la carrera con otro admin que lo haya borrado entretanto— no hay nada que cambiar
 * y solo queda el rastro del fallo en el log.
 *
 * Sigue **sin traer partidas ni recalcular**: al pasar a `APPROVED` el jugador entra
 * en el siguiente cálculo del sincronizador, y ese cálculo lo hace el cron (cada 10
 * minutos) o la llamada manual (`syncNow`), no esta petición. Una pasada gasta
 * ~500 ms de CPU y el plan Free de Cloudflare da 10 ms por invocación, así que
 * lanzarla dentro del aprobado mataba el *isolate* con `Worker exceeded CPU time
 * limit` (1102) en cuanto se apilaban dos clics. No hay estado de vuelta que
 * informar —el botón no lleva diálogo— así que un fallo solo se registra, y el estado
 * no ha cambiado.
 */
async function setPlayerStatus(playerId: string, status: PlayerStatus) {
  const admin = await requireAdmin();

  if (!playerId) {
    return;
  }

  let player: {
    id: string;
    name: string;
    profileId: number;
    status: PlayerStatus;
  } | null;

  try {
    player = await db.player.findUnique({
      where: { id: playerId },
      select: { id: true, name: true, profileId: true, status: true },
    });
  } catch (error) {
    logDatabaseFailure(`admin/${status}`, error);

    return;
  }

  // El `P2025` que antes lanzaba el `update` a secas cuando la fila no estaba. Sin
  // estado de vuelta, el log es el único rastro de que la acción no se pudo hacer.
  if (player === null) {
    logDatabaseFailure(`admin/${status}`, new Error(`No existe el jugador ${playerId}`));

    return;
  }

  if (player.status === status) {
    return;
  }

  // `const` a propósito: se usa dentro de un cierre (la transacción) y TypeScript
  // solo estrecha un `let` si no puede haber sido reasignado entre medias.
  const fila = player;

  try {
    await db.$transaction(async (tx) => {
      await tx.player.update({ where: { id: fila.id }, data: { status } });

      await recordAdminAction(tx, {
        type:
          status === PlayerStatus.APPROVED
            ? AdminActionType.PLAYER_APPROVED
            : AdminActionType.PLAYER_REJECTED,
        actorEmail: actorEmail(admin),
        targetId: fila.id,
        name: fila.name,
        profileId: fila.profileId,
        statusBefore: fila.status,
        statusAfter: status,
      });
    });
  } catch (error) {
    // Sin estado de vuelta, un fallo aquí solo puede registrarse: la acción termina
    // sin cambiar nada y no hay superficie en la que informar a quien la pulsó.
    logDatabaseFailure(`admin/${status}`, error);

    return;
  }

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
 * (alta de admin). Es una opción **solo del superadministrador**
 * (`requireSuperadmin()`): el plazo decide quién puede inscribirse y no se deja al
 * criterio de quien llame a la acción, que es un endpoint público.
 *
 * ## Deja rastro, y solo si cambia algo
 *
 * El `upsert` y la fila de `AdminAction` (`CONFIG_CHANGED`) van en la **misma
 * transacción**: o se ve el cambio de plazo y su línea en el historial, o no se ve
 * ninguno. El rastro lleva el campo con su valor de antes y el de después, igual
 * que la edición de un jugador y que los demás cambios de configuración.
 *
 * Abrir el formulario y cerrarlo sin tocar nada no escribe ni el `upsert` ni la
 * fila: se lee el estado actual antes de escribir y, si ya era el pedido, se sale
 * sin dejar rastro.
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
  const admin = await requireSuperadmin();

  const open = readField(formData, "open") === "true";

  let antes: Awaited<ReturnType<typeof readRegistrationState>>;

  try {
    antes = await readRegistrationState();
  } catch (error) {
    logDatabaseFailure("admin/setRegistrationOpen/leer", error);

    return;
  }

  // Se compara el **interruptor**, no el estado efectivo: con la fecha de cierre ya
  // pasada el plazo está cerrado aunque el interruptor siga encendido, y comparar el
  // efectivo haría creer que hay un cambio cuando no lo hay.
  const cambios = campoSiCambia(
    boolText(antes.switchOpen),
    boolText(open),
    "registration.open",
    "plazo de inscripción",
  );

  // El estado ya era este: no se escribe ni se deja rastro, que es lo mismo que
  // hace `updatePlayer()` cuando el formulario se envía sin tocar nada.
  if (cambios.length === 0) {
    return;
  }

  try {
    await db.$transaction(async (tx) => {
      await writeRegistrationOpen(open, tx);

      await recordAdminAction(tx, {
        type: AdminActionType.CONFIG_CHANGED,
        actorEmail: actorEmail(admin),
        cambios,
      });
    });
  } catch (error) {
    logDatabaseFailure("admin/setRegistrationOpen", error);

    return;
  }

  // El valor del interruptor se lee en tres sitios: la Administración donde se
  // cambia, el alta de `/admin`, que se deshabilita con el plazo cerrado, y el
  // formulario público.
  revalidatePath("/admin/administracion/inscripciones");
  revalidatePath("/admin");
  revalidatePath("/participar");
}

/**
 * Fija la fecha de cierre de las inscripciones, o la quita.
 *
 * Escribe (o borra) `Setting["registration.closesAt"]`, que es lo que comparten
 * `registerPlayer` y `createPlayer` a través de `readRegistrationState()`. Pasada esa
 * fecha, el plazo se cierra solo; el interruptor manual (`setRegistrationOpen`) sigue
 * pudiendo cerrar antes, y para **reabrir** después de la fecha el superadministrador
 * quita o mueve la fecha. Va **detrás de `requireSuperadmin()`**, como el interruptor:
 * decide quién puede inscribirse y no se deja al criterio de quien llame a la acción.
 *
 * ## Qué espera y qué devuelve
 *
 * Lee un campo `closesAt` del `FormData` y acepta las **dos formas** que puede mandar un
 * formulario, con la misma función que usa la ventana del ruleset
 * (`parseMadridLocalInstant()`):
 *
 * - una fecha y hora de `<input type="datetime-local">` (`YYYY-MM-DDTHH:mm`, con
 *   segundos opcionales) **sin zona**, que el **servidor** interpreta en
 *   `Europe/Madrid`; y
 * - un instante ISO-8601 **con zona** (`2026-10-01T00:00:00Z` o con desplazamiento),
 *   que se normaliza tal cual.
 *
 * En los dos casos se guarda en `Setting["registration.closesAt"]` como ISO-8601 UTC.
 * Vacío quita la fecha. Un campo vacío y una fecha mal escrita no son lo mismo: vacío es
 * una intención válida y mal escrita es un error que hay que corregir, así que se
 * distinguen y la segunda devuelve un `AdminActionResult` de error.
 *
 * ## Deja rastro, y solo si cambia algo
 *
 * El `upsert` (o el `deleteMany`) y la fila de `AdminAction` (`CONFIG_CHANGED`) van en
 * la **misma transacción**: o se ve la fecha nueva y su línea en el historial, o no se
 * ve ninguna. Se lee la fecha actual —normalizada— antes de escribir y, si ya era la
 * pedida, se sale sin escribir y sin rastro: abrir el formulario y cerrarlo sin tocar
 * nada no puede dejar huella.
 *
 * ## Qué revalida
 *
 * Las mismas tres rutas que el interruptor, porque la fecha cambia el mismo estado:
 * la Administración donde se configura, el alta de `/admin` y el formulario público.
 */
export async function setRegistrationClosesAt(
  _prevState: AdminActionResult,
  formData: FormData,
): Promise<AdminActionResult> {
  const admin = await requireSuperadmin();

  const raw = readField(formData, "closesAt");
  const closesAt = raw === "" ? null : parseMadridLocalInstant(raw);

  if (raw !== "" && closesAt === null) {
    return { status: "error", message: REGISTRATION_CLOSES_AT_INVALID_MESSAGE };
  }

  let antes: Awaited<ReturnType<typeof readRegistrationState>>;

  try {
    antes = await readRegistrationState();
  } catch (error) {
    logDatabaseFailure("admin/setRegistrationClosesAt/leer", error);

    return { status: "error", message: SAVE_FAILED_MESSAGE };
  }

  const cambios = campoSiCambia(
    antes.closesAt,
    closesAt,
    "registration.closesAt",
    "fecha de cierre de inscripciones",
  );

  // La fecha ya era esta: no se escribe, no se deja rastro y no se dice nada. La
  // línea de estado vacía es la misma respuesta que da el interruptor cuando el valor
  // ya era el pedido; decir "quitada" con el campo vacío sería contar algo que no ha
  // pasado.
  if (cambios.length === 0) {
    return { status: "success", message: null };
  }

  const message =
    closesAt === null
      ? "Fecha de cierre de las inscripciones quitada."
      : `Cierre de las inscripciones fijado para el ${formatAbsoluteTime(new Date(closesAt))}.`;

  try {
    await db.$transaction(async (tx) => {
      await writeRegistrationClosesAt(closesAt, tx);

      await recordAdminAction(tx, {
        type: AdminActionType.CONFIG_CHANGED,
        actorEmail: actorEmail(admin),
        cambios,
      });
    });
  } catch (error) {
    logDatabaseFailure("admin/setRegistrationClosesAt", error);

    return { status: "error", message: SAVE_FAILED_MESSAGE };
  }

  revalidatePath("/admin/administracion/inscripciones");
  revalidatePath("/admin");
  revalidatePath("/participar");

  return { status: "success", message };
}

/* -------------------------------------------------------------------------- */
/* Banner de donaciones                                                         */
/* -------------------------------------------------------------------------- */

/**
 * La dirección no vale.
 *
 * La decidimos aquí y no en el parser para poder decírselo a quien la escribió: el
 * parser (`parseMatcherinoDonations()`) descarta en silencio lo que no es `http` o
 * `https` porque su trabajo es leer lo guardado, pero un formulario que se queda
 * sin guardar sin explicar por qué es peor que uno que pide corregirlo.
 */
const DONATIONS_INVALID_URL_ERROR =
  "La dirección de la campaña tiene que empezar por http:// o https://. Cópiala tal cual desde Matcherino.";

/** Un banner activo sin dirección no lleva a ningún sitio: mejor no publicarlo. */
const DONATIONS_ENABLED_WITHOUT_URL_ERROR =
  "Para activar el banner hay que indicar la dirección de la campaña de Matcherino.";

/**
 * Activa o desactiva el banner de donaciones y guarda la URL de la campaña.
 *
 * Escribe `Setting["donations.matcherino"]`, que es lo que lee el layout público
 * para pintar el banner. Va **detrás de `requireSuperadmin()`**: es un cambio de
 * cara al público y no se deja al criterio de quien llame a la acción
 * directamente.
 *
 * ## Un solo formulario, una foto completa
 *
 * La acción escribe activación y URL **juntas**, como `updatePlayer()` reescribe sus
 * siete campos: el formulario del panel es una foto de la campaña y siempre manda
 * los dos campos. Un `enabled` ausente cuenta como apagado —el estado seguro, igual
 * que en `setRegistrationOpen()`—, así que una casilla sin marcar (que el navegador
 * no envía) desactiva el banner en lugar de dejarlo en un estado ambiguo.
 *
 * ## Por qué devuelve estado y no es `void` como `setRegistrationOpen()`
 *
 * Porque aquí hay un campo de texto libre que se puede escribir mal. Un `void` sin
 * estado no tendría dónde decir "esa dirección no vale" y el formulario se cerraría
 * como si hubiera guardado, cuando lo que pasó es que no. Se devuelve
 * `AdminActionResult` para que el panel pueda enseñar el motivo; el `try` cubre
 * **solo** la escritura, como manda el patrón de este archivo.
 *
 * ## Deja rastro, y solo si cambia algo
 *
 * El `upsert` y la fila de `AdminAction` (`CONFIG_CHANGED`) van en la **misma
 * transacción**: o se ve el cambio de la campaña y su línea en el historial, o no
 * se ve ninguno. El rastro lleva los dos campos —el banner y la dirección— con su
 * valor de antes y el de después, igual que los demás cambios de configuración.
 *
 * Se lee la campaña actual antes de escribir y, si ya era la pedida, se sale sin
 * escribir y sin rastro: abrir el formulario y cerrarlo sin tocar nada no puede
 * dejar huella.
 *
 * ## Qué revalida
 *
 * `/admin/administracion/donaciones`, donde está el formulario, y el layout de
 * `(public)`, que es quien pinta el banner: apagarlo o cambiarle la URL tiene que
 * verse en la siguiente visita sin desplegar. Las páginas públicas son
 * `force-dynamic` y releen igualmente, pero revalidar el layout es lo que invalida
 * lo que envuelve.
 */
export async function setMatcherinoDonations(
  _prevState: AdminActionResult,
  formData: FormData,
): Promise<AdminActionResult> {
  const admin = await requireSuperadmin();

  const urlRaw = readField(formData, "url");
  const enabled = readField(formData, "enabled") === "true";

  // El parser es la única definición de qué es una campaña válida: valida la URL y,
  // además, la deja apagada si no hay dirección. Se le pasa lo que se ha escrito y
  // se comparan los dos casos por separado para poder decir qué hay que corregir.
  const donations = parseMatcherinoDonations({ enabled, url: urlRaw });

  if (urlRaw !== "" && donations.url === "") {
    return { status: "error", message: DONATIONS_INVALID_URL_ERROR };
  }

  // `enabled` es el valor crudo, no el ya normalizado: si se pidió activar y no hay
  // dirección, el parser ya la apagó y hay que explicar que falta lo uno o lo otro.
  if (enabled && donations.url === "") {
    return { status: "error", message: DONATIONS_ENABLED_WITHOUT_URL_ERROR };
  }

  let antes: MatcherinoDonations;

  try {
    antes = await readMatcherinoDonations();
  } catch (error) {
    logDatabaseFailure("admin/setMatcherinoDonations/leer", error);

    return { status: "error", message: SAVE_FAILED_MESSAGE };
  }

  const cambios = [
    ...campoSiCambia(
      boolText(antes.enabled),
      boolText(donations.enabled),
      "donations.matcherino.enabled",
      "banner de donaciones",
    ),
    ...campoSiCambia(
      antes.url,
      donations.url,
      "donations.matcherino.url",
      "dirección de la campaña",
    ),
  ];

  const message = donations.enabled
    ? "Banner de donaciones activado."
    : donations.url === ""
      ? "Banner de donaciones desactivado."
      : "Banner de donaciones desactivado. La dirección queda guardada por si la vuelves a activar.";

  // La campaña ya era esta: sale como un acierto y no se escribe ni se deja rastro.
  if (cambios.length === 0) {
    return { status: "success", message };
  }

  try {
    await db.$transaction(async (tx) => {
      await writeMatcherinoDonations(donations, tx);

      await recordAdminAction(tx, {
        type: AdminActionType.CONFIG_CHANGED,
        actorEmail: actorEmail(admin),
        cambios,
      });
    });
  } catch (error) {
    logDatabaseFailure("admin/setMatcherinoDonations", error);

    return { status: "error", message: SAVE_FAILED_MESSAGE };
  }

  revalidatePath("/admin/administracion/donaciones");
  revalidatePath("/(public)", "layout");

  return { status: "success", message };
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
 * El **cursor de sincronización** (`Setting["aoe4world.sync.player.<profileId>"]`)
 * no cae con la cascada —vive en `Setting`, sin FK al jugador— y por eso se borra
 * aquí, en la misma transacción: dejar el cursor huérfano hacía que un alta
 * posterior del mismo perfil creyera que ya tenía el histórico y solo pidiera
 * partidas desde esa fecha, importando cero.
 *
 * **A diferencia del revert, aquí un fallo del recálculo no se compensa**, y es a
 * propósito: el jugador ya está borrado y no se puede deshacer un borrado sin
 * inventar un "deshacer" que nadie pidió. Pero tampoco queda nada incoherente: los
 * puntos de cada jugador son de sus propias partidas, así que quitar a un jugador no
 * cambia los totales de los demás, y su fila de `PlayerScore` ya no existe. Lo único
 * pendiente es el rastro de `scoring.lastRun`, que se rellena en la siguiente
 * pasada. Por eso el estado devuelto es de **éxito con un aviso**: el borrado sí ha
 * pasado, y callarlo sería peor que decirlo.
 *
 * ## Qué cuenta como "sus partidas"
 *
 * El número del rastro no son las filas de `Match` que caen en cascada —el jugador
 * tiene importado su histórico entero, con modos que no puntúan y partidas anteriores
 * a la inscripción, y ese número no significa nada para el torneo—, sino sus
 * **partidas clasificatorias dentro de la ventana**, con la misma definición única que
 * el motor y que la columna "Partidas" del panel: `rankedMatchWhere()` con los `modes`
 * y la `window` del ruleset activo y el `registeredAt` del propio jugador. Es un
 * `db.match.count()` y no el `_count` de la cascada precisamente para leer esa regla y
 * no inventar una segunda.
 *
 * El estado del jugador **no** entra en la cuenta: `ranked-match.ts` dice que la
 * definición de partida clasificatoria no incluye el estado y que lo pone quien
 * consulta. La baja trata con un APPROVED, pero añadirlo como condición sería una
 * sexta regla que las otras traducciones no tienen.
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
    /** Columnas capturadas antes del borrado: la fila desaparece en la transacción. */
    status: PlayerStatus;
    discordUserId: string | null;
    discordUsername: string | null;
  } | null;

  try {
    const row = await db.player.findUnique({
      where: { id: playerId },
      select: {
        id: true,
        name: true,
        profileId: true,
        registeredAt: true,
        status: true,
        discordUserId: true,
        discordUsername: true,
      },
    });

    if (row === null) {
      encontrado = null;
    } else {
      const ruleset = await readRuleset();
      const matchCount = await db.match.count({
        where: {
          playerId: row.id,
          ...rankedMatchWhere(ruleset.modes, ruleset.window, row.registeredAt),
        },
      });

      encontrado = {
        id: row.id,
        name: row.name,
        profileId: row.profileId,
        matchCount,
        status: row.status,
        discordUserId: row.discordUserId,
        discordUsername: row.discordUsername,
      };
    }
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
      // El borrado en cascada y el cursor de sincronización viven en
      // `deletePlayerCascade()` (`src/lib/admin-revert.ts`), que es lo mismo que hace
      // la reversión de un alta: las dos tienen que borrar exactamente lo mismo.
      await deletePlayerCascade(player, tx);

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

  // El aviso va **después** de la transacción —si hubiera fallado no habría nada que
  // avisar—, no bloquea ni puede cambiar lo que ve el administrador (ver
  // `dispatchAdminNotice()`), y las columnas de Discord se capturaron antes del borrado.
  dispatchAdminNotice({
    kind: "player-removed",
    player: {
      name: player.name,
      status: player.status,
      discordUserId: player.discordUserId,
      discordUsername: player.discordUsername,
    },
    matchCount: player.matchCount,
  });

  const partidas =
    player.matchCount === 0
      ? "No tenía partidas clasificatorias."
      : `Sus ${player.matchCount} ${player.matchCount === 1 ? "partida clasificatoria" : "partidas clasificatorias"} se han borrado con ella.`;

  return {
    status: "success",
    message: frase(
      `Se ha eliminado a ${player.name} (AoE4World ${player.profileId}).`,
      partidas,
      await recomputeWithWarning("admin/deletePlayer"),
    ),
  };
}

/* -------------------------------------------------------------------------- */
/* Puntos de una partida                                                       */
/* -------------------------------------------------------------------------- */

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
 * "revertidos 2 puntos", la pestaña de partidas la mostraría marcada y la
 * clasificación pública seguiría contando esos 2 puntos. Y no durarían mucho: el
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

  let encontrada:
    | (MatchForScoring & {
        /** Columnas de Discord del jugador, capturadas para el aviso de la acción. */
        playerDiscord: { discordUserId: string | null; discordUsername: string | null };
      })
    | null;

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
        rawJson: true,
        player: {
          select: {
            name: true,
            profileId: true,
            registeredAt: true,
            discordUserId: true,
            discordUsername: true,
          },
        },
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
            rawJson: row.rawJson,
            playerName: row.player.name,
            playerProfileId: row.player.profileId,
            playerDiscord: {
              discordUserId: row.player.discordUserId,
              discordUsername: row.player.discordUsername,
            },
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
   * La guarda: solo tiene sentido tocar la marca de una partida que **cuenta**. Al
   * revertir, porque es lo que se le quita; al restaurar, porque es lo que vuelve. La
   * pregunta y su porqué viven en `countsWithoutRevertMark()`
   * (`src/lib/admin-revert.ts`), que es la misma que usa la reversión de una acción de
   * puntos: las dos tienen que decidir igual.
   *
   * Los cortes y el ruleset se leen **una vez por clic** y se le pasan: la guarda es la
   * regla entera, condición de equipos incluida, y sin los cortes la partida cuenta
   * (como en el motor), así que la guarda no puede bloquear un revert que sí toca.
   */
  const ruleset = await readRuleset();
  const cutoffs = await readDivisionCutoffs();

  if (!countsWithoutRevertMark(match, ruleset, cutoffs)) {
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

  // Solo la **invalidación** avisa: restaurar los puntos devuelve lo que se quitó y no es
  // noticia. Va después del recálculo (si hubiera fallado, se habría deshecho el cambio)
  // y sin bloquear, como el resto de avisos de administración.
  if (revert) {
    dispatchAdminNotice({
      kind: "match-points-reverted",
      player: {
        name: match.playerName,
        discordUserId: match.playerDiscord.discordUserId,
        discordUsername: match.playerDiscord.discordUsername,
      },
      gameId: match.gameId,
      points: puntosDeLaPartida,
    });
  }

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
