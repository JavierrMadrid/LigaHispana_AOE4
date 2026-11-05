"use server";

import type { User } from "@supabase/supabase-js";
import { revalidatePath } from "next/cache";
import type { AdminActionResult } from "@/app/admin/actions";
import { AdminActionType } from "@/generated/prisma/enums";
import { recordAdminAction, type CampoEditado } from "@/lib/admin-actions";
import { revertAdminAction as revertRecordedAction } from "@/lib/admin-revert";
import {
  deactivateAdminAccount,
  inviteAdminAccount,
  reactivateAdminAccount,
} from "@/lib/admin-users";
import { requireSuperadmin } from "@/lib/auth";
import { normalizeCountrySelection, readCountries, writeCountries } from "@/lib/countries";
import { db } from "@/lib/db";
import { logDatabaseFailure } from "@/lib/db-errors";
import {
  EDITION_CONFIG_VERSION,
  isAccentColor,
  isEmblemUrl,
  mergeEditionConfig,
  readEditionConfig,
  writeEditionConfig,
  type EditionConfig,
} from "@/lib/edition";
import {
  sendTestAnnouncement as sendTestAnnouncementToChannel,
  type EditionAnnouncementKind,
  type TestAnnouncementResult,
} from "@/lib/edition-announcements";
import { campoSiCambia } from "@/lib/player-fields";
import { parseEmail } from "@/lib/player-input";
import { VICTORIAS_ID } from "@/lib/objectives";
import { disableObjectsMode } from "@/lib/object-awards";
import { editionEnded, editionStarted, parseMadridLocalInstant } from "@/lib/ranked-match";
import {
  lockedRulesetChanges,
  mergeRuleset,
  readRuleset,
  recomputeScores,
  writeScoringRuleset,
  type ScoringRuleset,
} from "@/lib/scoring";

/**
 * Server Actions del superadministrador: la gestión de admins, la configuración de la
 * edición, la reversión de acciones y los avisos del torneo en Discord.
 *
 * Cuatro grupos que comparten una cosa: **solo las puede llamar el
 * superadministrador** (`requireSuperadmin()`). El primero da y retira acceso al panel;
 * el segundo publica lo que describe la edición —su nombre, su premio, su marca, si la
 * retransmisión es obligatoria, las fechas del torneo, las reglas de puntuación y la
 * lista de países admitidos—; el tercero deshace una acción del historial; y el cuarto
 * comprueba el canal de avisos del bot.
 *
 * Viven bajo `/admin/**` por el mismo motivo que las de `src/app/admin/actions.ts`:
 * el `matcher` del Proxy cubre `/admin/:path*` y **excluir una ruta excluye también
 * sus Server Functions**, así que una acción fuera de `/admin` no pasaría ni por la
 * comprobación optimista de la cookie. Y como una Server Action es un endpoint
 * público que se puede llamar directamente, cada una vuelve a comprobar los permisos
 * en el servidor.
 *
 * Reutiliza el patrón de resultado `AdminActionResult` (el mismo de las demás
 * acciones del panel) para que la pantalla que las consuma lo haga igual que con las
 * suyas: **validar la entrada fuera del `try`**, delegar en el DAL y devolver un
 * mensaje que no enseña ni el error ni la traza. Los fallos de base se registran con
 * `logDatabaseFailure` y el `try` cubre **solo** la base de datos.
 *
 * Las pantallas las pinta la interfaz de su fase; estas acciones existen ya para que
 * esas pantallas solo tengan que llamarlas.
 */

/**
 * Campo de texto de un formulario, ya recortado.
 *
 * Mismo criterio que en `src/app/admin/actions.ts`: `FormData.get` también puede
 * devolver un `File`, y sin el filtro `String(file)` sería `"[object File]"`, que es
 * un valor mal escrito con otra forma.
 */
function readField(formData: FormData, name: string): string {
  const value = formData.get(name);

  return typeof value === "string" ? value.trim() : "";
}

/**
 * Quién está actuando, para la columna `AdminAction.actorEmail`.
 *
 * En el tipo de Supabase `User.email` es opcional y `actorEmail` no admite nulos; sin
 * correo se guarda el id con un prefijo que lo hace evidente y sigue siendo
 * rastreable. Es la misma regla que en `src/app/admin/actions.ts`.
 */
function actorEmail(user: User): string {
  return user.email ?? `sin-correo:${user.id}`;
}

/** Junta frases sin que aparezca ni un espacio de más ni un doble espacio. */
function frase(...partes: string[]): string {
  return partes
    .map((parte) => parte.trim())
    .filter((parte) => parte !== "")
    .join(" ");
}

/** Un booleano como texto, para el `details` del rastro: es lo que se guarda. */
function boolText(value: boolean): string {
  return value ? "true" : "false";
}

/** Los campos de texto repetidos de un formulario, recortados y sin vacíos. */
function readList(formData: FormData, name: string): string[] {
  return formData
    .getAll(name)
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value !== "");
}

const EMAIL_INVALID_ERROR =
  "Ese correo no vale. Se puede escribir una dirección como nombre@correo.com, con algo antes y después de la arroba y el dominio acabando en una extensión de letras.";

const MISSING_ADMIN_ERROR = "No se ha podido saber sobre qué cuenta hay que actuar.";

/**
 * Invita a un correo a ser administrador del panel.
 *
 * El permiso lo comprueba `requireSuperadmin()` antes que nada: dar acceso al panel
 * es la operación que no se puede delegar. El correo se valida con el mismo
 * `parseEmail` que el resto del panel, porque aquí no se admite un valor mal escrito
 * —el correo es la identidad y no hay forma de corregirlo después desde esta
 * pantalla—.
 */
export async function inviteAdmin(
  _prevState: AdminActionResult,
  formData: FormData,
): Promise<AdminActionResult> {
  const admin = await requireSuperadmin();

  const email = parseEmail(readField(formData, "email"));

  if (email === null) {
    return { status: "error", message: EMAIL_INVALID_ERROR };
  }

  const result = await inviteAdminAccount(email, actorEmail(admin));

  if (result.status === "success") {
    revalidatePath("/admin");
    revalidatePath("/admin/acciones");
  }

  return result;
}

/**
 * Da de baja a un admin: le retira el acceso sin borrar la fila.
 *
 * La baja es reversible con `reactivateAdmin`, y el rastro queda en `AdminAction`.
 */
export async function deactivateAdmin(
  _prevState: AdminActionResult,
  formData: FormData,
): Promise<AdminActionResult> {
  const admin = await requireSuperadmin();

  const adminId = readField(formData, "adminId");

  if (adminId === "") {
    return { status: "error", message: MISSING_ADMIN_ERROR };
  }

  const result = await deactivateAdminAccount(adminId, actorEmail(admin));

  if (result.status === "success") {
    revalidatePath("/admin");
    revalidatePath("/admin/acciones");
  }

  return result;
}

/** Reactiva a un admin dado de baja: le devuelve el acceso. */
export async function reactivateAdmin(
  _prevState: AdminActionResult,
  formData: FormData,
): Promise<AdminActionResult> {
  const admin = await requireSuperadmin();

  const adminId = readField(formData, "adminId");

  if (adminId === "") {
    return { status: "error", message: MISSING_ADMIN_ERROR };
  }

  const result = await reactivateAdminAccount(adminId, actorEmail(admin));

  if (result.status === "success") {
    revalidatePath("/admin");
    revalidatePath("/admin/acciones");
  }

  return result;
}

/* -------------------------------------------------------------------------- */
/* Configuración de la edición                                                 */
/* -------------------------------------------------------------------------- */

const CONFIG_SAVE_FAILED_MESSAGE =
  "No se ha podido guardar la configuración. Inténtalo de nuevo en unos minutos.";

const EDITION_NAME_REQUIRED_ERROR =
  "El nombre de la edición es obligatorio: es el que se enseña en la cabecera del sitio.";

/**
 * El importe del premio, que es lo único de esta acción que se escribe a mano en un
 * campo libre.
 *
 * El parser puro (`mergeEditionConfig`) también lo valida, pero devuelve un aviso con
 * el nombre del campo; aquí se dice en el idioma de quien lo escribe, que es lo mismo
 * que hace el panel con la dirección de Matcherino: el parser descarta en silencio lo
 * que no vale porque su trabajo es leer lo guardado.
 */
const PRIZE_INVALID_ERROR =
  "El importe del premio tiene que ser un número entero de euros, sin decimales ni signos. Déjalo vacío si no hay premio anunciado.";

const EMBLEM_INVALID_ERROR =
  "El emblema tiene que ser una dirección que empiece por http:// o https://, o una ruta del propio sitio que empiece por /.";

const ACCENT_INVALID_ERROR =
  "El color de acento se escribe como #rrggbb, por ejemplo #e2b714. Déjalo vacío para usar el del sitio.";

/** El importe del premio como texto, para el rastro: `null` es "sin premio". */
function amountText(amount: number | null): string | null {
  return amount === null ? null : String(amount);
}

/**
 * El efecto de que la configuración de la edición quede con el modo de objetos apagado.
 *
 * Va **fuera** de la transacción que guarda la configuración: el cambio ya está escrito
 * y esto es su consecuencia, no parte del guardado. `disableObjectsMode()` es
 * idempotente, así que también repara un estado anterior a medias. Si ha desbloqueado
 * partidas se recalcula, y un fallo del recálculo no deshace nada: se avisa en el
 * mensaje y la pasada siguiente pone la clasificación al día.
 *
 * Devuelve la coletilla que se añade al mensaje de éxito.
 */
async function objectsDisabledNote(): Promise<string> {
  try {
    const { closed, unblocked } = await disableObjectsMode();
    let recomputeNote = "";

    if (unblocked > 0) {
      try {
        await recomputeScores();
        recomputeNote = " La clasificación se ha recalculado.";
      } catch (error) {
        logDatabaseFailure("admin/saveEditionConfig/recompute", error);
        recomputeNote =
          " El recálculo de la clasificación ha fallado: se pondrá al día en la próxima pasada del sincronizador.";
      }
    }

    return ` El modo de objetos ha quedado apagado (partidas desbloqueadas: ${unblocked}; objetos pendientes cerrados: ${closed}).${recomputeNote}`;
  } catch (error) {
    logDatabaseFailure("admin/saveEditionConfig/objetos", error);

    return " El modo de objetos ha quedado apagado, pero no se han podido desbloquear las partidas bloqueadas: vuelve a guardar la configuración para reintentarlo.";
  }
}

/**
 * Guarda la configuración de la edición: nombre, premio base, retransmisión, modo de
 * objetos y marca.
 *
 * Escribe `Setting["edition.config"]`, que es lo que leen la web pública (la marca y
 * el premio), el motor de alertas (la retransmisión obligatoria) y el servicio de
 * objetos (el interruptor del modo). Va **detrás de `requireSuperadmin()`**: la
 * configuración de la edición es del superadministrador, igual que el ruleset, y no
 * se deja al criterio de quien llame a la acción.
 *
 * ## El formulario es una foto completa
 *
 * Los siete campos se reescriben con lo que venga, como `updatePlayer()` con los suyos:
 * un importe o una nota vacíos son `null` ("no hay premio anunciado"), un
 * `streamingRequired` o un `objectsEnabled` ausentes son `false` (el estado seguro,
 * igual que en `setRegistrationOpen()`) y un emblema o un color vacíos son `null`
 * ("los del sitio"). No hay un "no tocado": si un campo no llega, cuenta como vacío.
 *
 * ## Qué valida y con qué palabras
 *
 * Lo que una persona puede escribir mal se comprueba aquí, con su mensaje: el nombre
 * (obligatorio), el importe (entero de euros) y el emblema y el color, con los
 * predicados puros de `src/lib/edition.ts` para no tener dos copias del criterio.
 * Después se fusiona con `mergeEditionConfig()`, que es la red de seguridad: si aun
 * así queda algún aviso, no se escribe y se dicen.
 *
 * ## Qué escribe y dónde queda
 *
 * El `upsert` y la fila de `AdminAction` (`CONFIG_CHANGED`) van en la **misma
 * transacción**: o se ve el cambio de configuración y su línea en el historial, o no
 * se ve ninguno. El rastro lleva qué campos han cambiado, con su valor de antes y el
 * de después, que es lo que se viene a mirar cuando alguien pregunta por qué la web
 * enseña otro nombre o si la retransmisión era obligatoria.
 *
 * Un envío sin cambios no escribe nada y sale como lo que es, un acierto: abrir el
 * formulario y cerrarlo sin tocar nada es lo más normal del mundo.
 *
 * ## El modo de objetos
 *
 * Apagarlo tiene efecto **inmediato** y va fuera de la transacción, después de que la
 * configuración quede guardada: `disableObjectsMode()` cierra los premios pendientes y
 * desbloquea todas las partidas marcadas. Si ha desbloqueado alguna, se recalcula la
 * clasificación en un `try`/`catch`: el cambio ya está escrito y un fallo del recálculo
 * no lo deshace, solo deja la tabla para la pasada siguiente. Encenderlo no tiene
 * efectos retroactivos.
 *
 * Lo demás no recalcula la clasificación: nada de esto puntúa. El otro cambio de
 * comportamiento es el motor de alertas —`streamingRequired` enciende
 * `NO_STREAM_CHANNEL`—, que lo recoge en su siguiente evaluación: una pasada del
 * sincronizador sin partidas nuevas evalúa a todos los aprobados, y el informe de
 * alertas fuerza una completa.
 */
export async function saveEditionConfig(
  _prevState: AdminActionResult,
  formData: FormData,
): Promise<AdminActionResult> {
  const admin = await requireSuperadmin();

  const name = readField(formData, "name");
  const prizeAmountRaw = readField(formData, "prizeAmount");
  const prizeNoteRaw = readField(formData, "prizeNote");
  const streamingRequired = readField(formData, "streamingRequired") === "true";
  const objectsEnabled = readField(formData, "objectsEnabled") === "true";
  const emblemUrlRaw = readField(formData, "emblemUrl");
  const accentColorRaw = readField(formData, "accentColor");

  if (name === "") {
    return { status: "error", message: EDITION_NAME_REQUIRED_ERROR };
  }

  let prizeAmount: number | null = null;

  if (prizeAmountRaw !== "") {
    const parsed = Number(prizeAmountRaw);

    if (!Number.isInteger(parsed) || parsed < 0) {
      return { status: "error", message: PRIZE_INVALID_ERROR };
    }

    prizeAmount = parsed;
  }

  if (emblemUrlRaw !== "" && !isEmblemUrl(emblemUrlRaw)) {
    return { status: "error", message: EMBLEM_INVALID_ERROR };
  }

  if (accentColorRaw !== "" && !isAccentColor(accentColorRaw)) {
    return { status: "error", message: ACCENT_INVALID_ERROR };
  }

  const candidato: EditionConfig = {
    version: EDITION_CONFIG_VERSION,
    name,
    prize: { amount: prizeAmount, note: prizeNoteRaw === "" ? null : prizeNoteRaw },
    streamingRequired,
    objectsEnabled,
    branding: {
      emblemUrl: emblemUrlRaw === "" ? null : emblemUrlRaw,
      accentColor: accentColorRaw === "" ? null : accentColorRaw.toLowerCase(),
    },
  };

  const merged = mergeEditionConfig(candidato);

  if (merged.warnings.length > 0) {
    return {
      status: "error",
      message: `No se ha guardado la configuración: ${merged.warnings.join("; ")}.`,
    };
  }

  let actual: EditionConfig;

  try {
    actual = await readEditionConfig();
  } catch (error) {
    logDatabaseFailure("admin/saveEditionConfig/leer", error);

    return { status: "error", message: CONFIG_SAVE_FAILED_MESSAGE };
  }

  const despues = merged.config;
  const cambios = [
    ...campoSiCambia(actual.name, despues.name, "name", "nombre de la edición"),
    ...campoSiCambia(
      amountText(actual.prize.amount),
      amountText(despues.prize.amount),
      "prize.amount",
      "importe del premio",
    ),
    ...campoSiCambia(actual.prize.note, despues.prize.note, "prize.note", "nota del premio"),
    ...campoSiCambia(
      boolText(actual.streamingRequired),
      boolText(despues.streamingRequired),
      "streamingRequired",
      "retransmisión obligatoria",
    ),
    ...campoSiCambia(
      boolText(actual.objectsEnabled),
      boolText(despues.objectsEnabled),
      "objectsEnabled",
      "objetos utilizables",
    ),
    ...campoSiCambia(
      actual.branding.emblemUrl,
      despues.branding.emblemUrl,
      "branding.emblemUrl",
      "emblema",
    ),
    ...campoSiCambia(
      actual.branding.accentColor,
      despues.branding.accentColor,
      "branding.accentColor",
      "color de acento",
    ),
  ];

  if (cambios.length === 0) {
    // Aunque no haya nada que guardar, si el modo está apagado se reintenta su efecto:
    // es idempotente y es lo que repara un desbloqueo que falló en un guardado anterior.
    const objectsNote = despues.objectsEnabled ? "" : await objectsDisabledNote();

    if (objectsNote !== "") {
      revalidatePath("/admin/objetos");
    }

    return {
      status: "success",
      message: `No había ningún cambio que guardar en la configuración de la edición.${objectsNote}`,
    };
  }

  try {
    await db.$transaction(async (tx) => {
      await writeEditionConfig(despues, tx);

      await recordAdminAction(tx, {
        type: AdminActionType.CONFIG_CHANGED,
        actorEmail: actorEmail(admin),
        cambios,
      });
    });
  } catch (error) {
    logDatabaseFailure("admin/saveEditionConfig", error);

    return { status: "error", message: CONFIG_SAVE_FAILED_MESSAGE };
  }

  // Apagar el modo tiene efecto inmediato y va **fuera** de la transacción: la
  // configuración ya está guardada y esto es su consecuencia, no parte del guardado.
  const objectsNote = despues.objectsEnabled ? "" : await objectsDisabledNote();

  // El nombre, el premio y la marca salen en la web pública; el color de acento, como
  // variable CSS del layout. El panel de objetos conserva su histórico aunque el modo
  // quede apagado, y el historial de acciones es donde queda el rastro.
  revalidatePath("/admin/administracion");
  revalidatePath("/admin/acciones");
  revalidatePath("/admin/objetos");
  revalidatePath("/(public)", "layout");

  return {
    status: "success",
    message: `Se ha guardado la configuración de la edición. Campos: ${cambios
      .map((cambio) => cambio.etiqueta)
      .join(", ")}.${objectsNote}`,
  };
}

/* -------------------------------------------------------------------------- */
/* Ruleset de puntuación                                                       */
/* -------------------------------------------------------------------------- */

const RULESET_SAVE_FAILED_MESSAGE =
  "No se han podido guardar las reglas. Inténtalo de nuevo en unos minutos.";

/** Fallo de base de la subpestaña `Fechas`. Distinto del de las reglas: no se ha escrito lo mismo. */
const WINDOW_SAVE_FAILED_MESSAGE =
  "No se han podido guardar las fechas del torneo. Inténtalo de nuevo en unos minutos.";

const POINTS_PER_WIN_INVALID_ERROR =
  "Los puntos por victoria tienen que ser un número entero mayor que cero.";

const OBJECTIVE_POINTS_INVALID_ERROR =
  "Los puntos de un objetivo tienen que ser un número entero mayor que cero.";

const WINDOW_FROM_INVALID_ERROR =
  "La fecha de inicio de la ventana no vale. Escribe fecha y hora (por ejemplo 2026-09-15T18:00, hora de Madrid) o un instante ISO-8601 con zona.";

/** La fecha de inicio no es opcional: sin ella no hay corte desde el que contar. */
const WINDOW_FROM_REQUIRED_ERROR =
  "La fecha de inicio de la ventana del torneo es obligatoria: marca desde cuándo cuentan las partidas.";

const WINDOW_TO_INVALID_ERROR =
  "La fecha de fin de la ventana no vale. Escribe fecha y hora (por ejemplo 2026-10-15T23:59, hora de Madrid), un instante ISO-8601 con zona, o déjala vacía para que la ventana no tenga fin.";

/**
 * Prefijo de los campos con los puntos de un objetivo: `objectivePoints.<id>`.
 *
 * Es opcional: un formulario que no los mande deja los puntos que ya tenía cada
 * objetivo (los del catálogo o los que se hayan retocado), así que la pantalla puede
 * empezar editando solo la ventana y los objetivos activos y añadir los puntos por
 * objetivo cuando haga falta. Tiene que coincidir con el `name` que pinta
 * `ruleset-form.tsx` (`OBJECTIVE_POINTS_FIELD_PREFIX`), que no puede importar esta
 * constante: los módulos `"use server"` solo exportan funciones async.
 */
const OBJECTIVE_POINTS_PREFIX = "objectivePoints.";

/**
 * El error de "la edición ya ha empezado" al guardar las **reglas**.
 *
 * Aquí ya no queda nada editable: la fecha de fin de la ventana tiene su propia acción
 * (`saveTournamentWindow`) y su propia subpestaña (`Fechas`), así que el mensaje no
 * promete un cambio que esta pantalla ya no puede hacer.
 */
const RULESET_LOCKED_ERROR =
  "La edición ya ha empezado: los puntos y las reglas de puntuación ya no se pueden cambiar. La fecha de fin de la ventana se edita en la subpestaña Fechas.";

/**
 * El error de "la edición ya ha empezado" al guardar la **ventana**.
 *
 * Es lo que sale cuando el formulario de `Fechas` trae, con la edición en marcha, algún
 * campo que ya no se puede tocar: la fecha de inicio o cualquier regla de puntuación.
 * El fin sí se puede fijar, mover o vaciar.
 */
const WINDOW_LOCKED_ERROR =
  "La edición ya ha empezado: de las fechas solo se puede cambiar la fecha de fin. La fecha de inicio y el resto de reglas quedan congelados.";

/**
 * El formulario de reglas ya no lleva fechas.
 *
 * Se rechaza en lugar de ignorarlas: quien envía una fecha espera que se guarde, y
 * guardar los puntos mientras se cree que la ventana ha cambiado es el peor resultado de
 * los dos.
 */
const RULESET_WINDOW_MOVED_ERROR =
  "Las fechas del torneo no se editan aquí: se cambian en la subpestaña Fechas. Este formulario guarda solo los puntos y las reglas.";

/**
 * Mover el inicio de una edición terminada empieza otra.
 *
 * No se hace sin confirmación porque el efecto no se ve en el formulario: la
 * clasificación se recalcula contra la ventana nueva y la edición anterior desaparece de
 * la web. Es el mismo criterio de los borrados: una operación con consecuencias que no se
 * deshacen con volver a escribir lo de antes se pide dos veces.
 */
const NEW_EDITION_CONFIRMATION_REQUIRED_ERROR =
  "Se ha movido la fecha de inicio, y eso empieza una edición nueva: la clasificación se recalcula contra la ventana nueva y la edición anterior deja de mostrarse en la web (sus partidas y sus historiales siguen guardados). Marca la confirmación de la edición nueva para guardarla; si solo querías mover el fin, deja el inicio como está.";

/**
 * Los campos del formulario que quedan congelados cuando la edición ha empezado.
 *
 * No se editan desde `saveScoringRuleset()` —con la edición en marcha no deja guardar
 * nada—, sino desde `saveWindowEnd()`, que los usa para rechazar cualquier envío que los
 * traiga: con la edición en marcha el formulario bueno es el que solo manda `windowTo`.
 * Los puntos por objetivo no se pueden listar aquí —son hasta 94 claves
 * `objectivePoints.<id>`— y se detectan por su prefijo.
 */
const LOCKED_RULESET_FIELDS = [
  "windowFrom",
  "pointsPerWin",
  "modes",
  "countRandomizedCivs",
  "disabledObjectives",
] as const;

/**
 * ¿Trae el formulario algún campo que la edición empezada ya no admite?
 *
 * Se mira lo que **llega** y no lo que cambia: con la edición en marcha, el formulario
 * bueno es el que solo manda `windowTo`, y un campo bloqueado en el `FormData` es una
 * petición de cambiarlo, aunque venga con el valor que ya estaba. Así el rechazo es
 * explícito y no depende de que la interfaz haya deshabilitado el campo de verdad.
 */
function touchesLockedRulesetFields(formData: FormData): boolean {
  if (LOCKED_RULESET_FIELDS.some((name) => formData.has(name))) {
    return true;
  }

  for (const key of formData.keys()) {
    if (key.startsWith(OBJECTIVE_POINTS_PREFIX)) {
      return true;
    }
  }

  return false;
}

/** La ventana como texto, para el rastro: `from → to`, con el `to` abierto explícito. */
function windowText(window: ScoringRuleset["window"]): string {
  return `${window.from} → ${window.to ?? "sin fin"}`;
}

/** Los objetivos desactivados como texto, ordenados: el orden de la lista no significa nada. */
function disabledObjectivesText(ids: readonly string[]): string {
  return ids.length === 0 ? "ninguno" : [...ids].sort().join(", ");
}

/**
 * Los puntos de objetivos que han cambiado, como un solo campo del rastro.
 *
 * Va junto y no un campo por objetivo a propósito: son hasta 94 valores, y una frase
 * de historial con 94 campos no se lee. Lo que sí se ve es **cuáles** han cambiado y
 * de qué valor a qué valor.
 */
function objectivesChanged(
  antes: Record<string, number>,
  despues: Record<string, number>,
): CampoEditado[] {
  const ids = Object.keys(despues).filter((id) => antes[id] !== despues[id]);

  if (ids.length === 0) {
    return [];
  }

  return [
    {
      campo: "objectives",
      etiqueta: "puntos de objetivos",
      antes: ids.map((id) => `${id}=${antes[id] ?? ""}`).join(", "),
      despues: ids.map((id) => `${id}=${despues[id]}`).join(", "),
    },
  ];
}

/**
 * Guarda las reglas de puntuación: familias, puntos, civ aleatoria y objetivos.
 *
 * Escribe `Setting["scoring.ruleset"]`, que es el documento del que salen **todas** las
 * reglas de la clasificación. Va **detrás de `requireSuperadmin()`**, como la
 * configuración de la edición: desactivar un objetivo o mover los puntos cambia quién
 * cobra qué, y no se deja al criterio de quien llame a la acción.
 *
 * ## Las fechas no se editan aquí
 *
 * La **ventana del torneo** (`window.from` y `window.to`) tiene su propia acción,
 * `saveTournamentWindow()`, y su propia subpestaña, `Fechas`. Si este formulario trae
 * `windowFrom` o `windowTo` se **rechaza** con `RULESET_WINDOW_MOVED_ERROR`; el
 * candidato conserva la ventana guardada.
 *
 * ## Parte del documento que ya está
 *
 * El formulario manda los campos que se editan, y lo que no manda se conserva: los
 * puntos por objetivo, si no vienen como `objectivePoints.<id>`, siguen con el valor
 * que tenían. Es lo contrario de "foto completa" de la edición y es deliberado: el
 * catálogo tiene 94 puntos y la pantalla puede no editarlos todos, así que un
 * formulario que no los mencione **no puede borrarlos**.
 *
 * ## Validación
 *
 * Los dos números que se escriben a mano (puntos por victoria y puntos de un objetivo)
 * se comprueban aquí con su mensaje. El resto —las familias, la lista de objetivos
 * desactivados, la ventana que ya estaba— se valida con `mergeRuleset()`, cuyos avisos
 * ya dicen qué campo falla y por qué, así que se enseñan tal cual. Si queda algún aviso
 * no se escribe nada.
 *
 * ## Qué escribe y qué recalcula
 *
 * `writeScoringRuleset()` hace el `upsert`, el rastro (`CONFIG_CHANGED`, en la misma
 * transacción) y, si el cambio mueve puntos, el recálculo de la clasificación. Un fallo
 * del recálculo no deshace el cambio de reglas: el mensaje avisa de que la
 * clasificación que se ve es la anterior y que la pondrá al día el sincronizador.
 *
 * Revalida las pantallas que leen las reglas: el panel, la clasificación, los objetivos
 * y la puntuación.
 *
 * ## Con la edición empezada las reglas quedan congeladas
 *
 * Desde `window.from` (`editionStarted()`) los puntos y las reglas que los mueven
 * quedan **congelados**: las familias de ladder, los puntos por victoria, la civ
 * aleatoria, los puntos de objetivos y los objetivos desactivados. Cambiarlos a mitad
 * de edición reescribiría una clasificación que ya está publicada. Aquí no queda nada
 * editable; el único cambio de fechas que se permite después del inicio es **fijar o
 * mover `window.to`**, y eso se hace en la subpestaña `Fechas`
 * (`saveTournamentWindow()` → `saveWindowEnd()`).
 *
 * El bloqueo lo decide **este servidor**: la interfaz puede deshabilitar campos y
 * explicar el motivo, pero una Server Action es un endpoint público y quien se niega es
 * esta función.
 */
export async function saveScoringRuleset(
  _prevState: AdminActionResult,
  formData: FormData,
): Promise<AdminActionResult> {
  const admin = await requireSuperadmin();

  // Las fechas ya no son parte de este formulario. Se miran antes de leer nada: no hay
  // por qué pagar una consulta para rechazar un campo que se edita en otra pantalla.
  if (formData.has("windowFrom") || formData.has("windowTo")) {
    return { status: "error", message: RULESET_WINDOW_MOVED_ERROR };
  }

  // El ruleset guardado se lee **antes** de validar los campos: si la edición ya ha
  // empezado no hay nada que guardar aquí y lo que decide el camino es la ventana
  // guardada, no lo que traiga el formulario.
  let actual: ScoringRuleset;

  try {
    actual = await readRuleset();
  } catch (error) {
    logDatabaseFailure("admin/saveScoringRuleset/leer", error);

    return { status: "error", message: RULESET_SAVE_FAILED_MESSAGE };
  }

  if (editionStarted(actual.window, new Date())) {
    return { status: "error", message: RULESET_LOCKED_ERROR };
  }

  const modes = readList(formData, "modes");
  const pointsPerWinRaw = readField(formData, "pointsPerWin");
  const countRandomizedCivs = readField(formData, "countRandomizedCivs") === "true";
  const disabledObjectives = readList(formData, "disabledObjectives");

  const pointsPerWin = Number(pointsPerWinRaw);

  if (!Number.isInteger(pointsPerWin) || pointsPerWin <= 0) {
    return { status: "error", message: POINTS_PER_WIN_INVALID_ERROR };
  }

  const objectives = { ...actual.objectives };

  for (const [key, value] of formData.entries()) {
    if (!key.startsWith(OBJECTIVE_POINTS_PREFIX) || typeof value !== "string") {
      continue;
    }

    const id = key.slice(OBJECTIVE_POINTS_PREFIX.length);

    // `victorias` no tiene precio propio: cada victoria vale `pointsPerWin` (el motor
    // ignora `objectives["victorias"]`), así que un campo con su nombre se descarta
    // aquí. Ni escribe un valor que nadie lee ni deja en el historial un cambio que no
    // ha existido.
    if (id === VICTORIAS_ID) {
      continue;
    }

    const text = value.trim();

    // Vacío es "no lo toco": el formulario puede pintar el campo sin obligar a
    // reescribirlo, y un objetivo que no se menciona conserva sus puntos.
    if (text === "") {
      continue;
    }

    const parsed = Number(text);

    if (!Number.isInteger(parsed) || parsed <= 0) {
      return { status: "error", message: OBJECTIVE_POINTS_INVALID_ERROR };
    }

    objectives[id] = parsed;
  }

  // El `label` no es un campo del formulario: es texto de producto que recalcula
  // `mergeRuleset()` con los puntos y los objetivos que se acaban de fusionar. Si
  // viajara en el candidato, la etiqueta guardada —la de las reglas *anteriores*— no
  // coincidiría con la nueva en cuanto el cambio moviera puntos u objetivos, y
  // `mergeRuleset` rechazaría el guardado con el aviso de "label se ignora". Se quita
  // del candidato por eso, no del aviso: leer un documento guardado con la etiqueta
  // obsoleta tiene que seguir avisando.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- la etiqueta se descarta a propósito
  const { label: _etiquetaCalculada, ...documento } = actual;

  const candidato = {
    ...documento,
    modes,
    // La ventana se conserva tal cual: este formulario no la edita (ver el docblock).
    window: actual.window,
    pointsPerWin,
    countRandomizedCivs,
    objectives,
    disabledObjectives,
  };

  const merged = mergeRuleset(candidato);

  if (merged.warnings.length > 0) {
    return {
      status: "error",
      message: `No se han guardado las reglas: ${merged.warnings.join("; ")}.`,
    };
  }

  const despues = merged.ruleset;
  // La ventana no entra en la comparación: no es un campo de este formulario y el
  // candidato la conserva, así que un cambio suyo aquí solo podría venir de una
  // normalización del documento guardado, no de quien envía.
  const cambios = [
    ...campoSiCambia(actual.modes.join(", "), despues.modes.join(", "), "modes", "familias de ladder"),
    ...campoSiCambia(
      String(actual.pointsPerWin),
      String(despues.pointsPerWin),
      "pointsPerWin",
      "puntos por victoria",
    ),
    ...campoSiCambia(
      boolText(actual.countRandomizedCivs),
      boolText(despues.countRandomizedCivs),
      "countRandomizedCivs",
      "civilizaciones aleatorias",
    ),
    ...objectivesChanged(actual.objectives, despues.objectives),
    ...campoSiCambia(
      disabledObjectivesText(actual.disabledObjectives),
      disabledObjectivesText(despues.disabledObjectives),
      "disabledObjectives",
      "objetivos desactivados",
    ),
  ];

  if (cambios.length === 0) {
    return {
      status: "success",
      message: "No había ningún cambio que guardar en las reglas de puntuación.",
    };
  }

  let resultado;

  try {
    resultado = await writeScoringRuleset(despues, cambios, actorEmail(admin));
  } catch (error) {
    logDatabaseFailure("admin/saveScoringRuleset", error);

    return { status: "error", message: RULESET_SAVE_FAILED_MESSAGE };
  }

  revalidatePath("/admin/administracion");
  revalidatePath("/admin/acciones");
  revalidatePath("/");
  revalidatePath("/objetivos");
  revalidatePath("/puntuacion");

  return {
    status: "success",
    message: frase(
      `Se han guardado las reglas de puntuación. Campos: ${cambios
        .map((cambio) => cambio.etiqueta)
        .join(", ")}.`,
      resultado.recomputed
        ? "La clasificación se ha recalculado con las reglas nuevas."
        : resultado.recomputeWarning ?? "El cambio no mueve la puntuación, así que no ha hecho falta recalcular.",
    ),
  };
}

/**
 * La única escritura que se permite con la edición **activa**: el **fin** de la ventana.
 *
 * La llama `saveTournamentWindow()`, que es la acción de la subpestaña `Fechas`, cuando
 * la edición ha empezado y todavía no ha terminado: en ese tramo el inicio está
 * congelado, porque moverlo cambiaría el corte de todas las partidas ya publicadas.
 * Cuando la edición termina (`editionEnded()`), `saveTournamentWindow()` deja de pasar
 * por aquí y admite las dos fechas como en una edición nueva.
 *
 * Se niega si el formulario trae un campo congelado, y no solo si lo cambia: con la
 * edición en marcha el formulario bueno es el que manda solo `windowTo`, así que un
 * campo de puntos o la fecha de inicio en el `FormData` es una petición de cambiarlos.
 * Después se arma el documento con **los valores guardados** de todo lo bloqueado y
 * solo el `to` del formulario, de modo que lo que se escribe no puede mover puntos ni
 * aunque llegue un documento manipulado; y aun así se compara el resultado con el
 * guardado (`lockedRulesetChanges()`) antes de tocar la base, como última guarda.
 *
 * Un `to` vacío deja la ventana **abierta** por la derecha, igual que en el camino
 * normal: es lo que permite reabrir el fin de una edición que se cerró antes de tiempo.
 */
async function saveWindowEnd(
  admin: User,
  formData: FormData,
  windowTo: string,
  actual: ScoringRuleset,
): Promise<AdminActionResult> {
  if (touchesLockedRulesetFields(formData)) {
    return { status: "error", message: WINDOW_LOCKED_ERROR };
  }

  const windowToInstant = windowTo === "" ? null : parseMadridLocalInstant(windowTo);

  if (windowTo !== "" && windowToInstant === null) {
    return { status: "error", message: WINDOW_TO_INVALID_ERROR };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- la etiqueta la recalcula `mergeRuleset`
  const { label: _etiquetaCalculada, ...documento } = actual;

  const merged = mergeRuleset({
    ...documento,
    window: { from: actual.window.from, to: windowToInstant },
  });

  if (merged.warnings.length > 0) {
    return {
      status: "error",
      message: `No se ha guardado el fin de la ventana: ${merged.warnings.join("; ")}.`,
    };
  }

  const despues = merged.ruleset;
  const bloqueados = lockedRulesetChanges(actual, despues);

  if (bloqueados.length > 0) {
    return { status: "error", message: WINDOW_LOCKED_ERROR };
  }

  const cambios = campoSiCambia(
    windowText(actual.window),
    windowText(despues.window),
    "window",
    "fin de la ventana del torneo",
  );

  if (cambios.length === 0) {
    return {
      status: "success",
      message: "No había ningún cambio que guardar en el fin de la ventana.",
    };
  }

  let resultado;

  try {
    resultado = await writeScoringRuleset(despues, cambios, actorEmail(admin));
  } catch (error) {
    logDatabaseFailure("admin/saveTournamentWindow/fin", error);

    return { status: "error", message: WINDOW_SAVE_FAILED_MESSAGE };
  }

  // El fin de la ventana mueve puntos (las partidas que quedan fuera del corte dejan de
  // contar), así que el recálculo y su aviso se conservan tal cual: las pantallas que
  // leen las reglas son las mismas que en el camino normal.
  revalidatePath("/admin/administracion");
  revalidatePath("/admin/administracion/fechas");
  revalidatePath("/admin/acciones");
  revalidatePath("/");
  revalidatePath("/objetivos");
  revalidatePath("/puntuacion");

  return {
    status: "success",
    message: frase(
      "Se ha guardado la fecha de fin de la ventana del torneo.",
      resultado.recomputed
        ? "La clasificación se ha recalculado con las reglas nuevas."
        : resultado.recomputeWarning ?? "El cambio no mueve la puntuación, así que no ha hecho falta recalcular.",
    ),
  };
}

/* -------------------------------------------------------------------------- */
/* Ventana del torneo                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Guarda las fechas del torneo: el inicio y el fin de la ventana.
 *
 * Escribe `Setting["scoring.ruleset"].window`, el intervalo `[from, to)` sobre
 * `Match.startedAt` del que depende qué partidas puntúan. Va **detrás de
 * `requireSuperadmin()`**, como el resto de la configuración: mover el corte cambia
 * quién cobra qué.
 *
 * ## Por qué tiene acción propia
 *
 * Hasta la issue 173 la ventana se editaba en el formulario de Puntuación, mezclada con
 * las reglas. Ahora `saveScoringRuleset()` **rechaza** `windowFrom` y `windowTo`, y las
 * fechas viven en la subpestaña `Fechas` junto a la fecha de cierre de inscripciones
 * (`setRegistrationClosesAt`): son la configuración temporal de la edición, no las
 * reglas de puntuación.
 *
 * ## Tres estados de la ventana
 *
 * | Estado | Quién lo dice | Qué se puede editar |
 * |---|---|---|
 * | **No empezada** | `!editionStarted()` | Inicio y fin: es la configuración inicial del torneo |
 * | **Activa** | `editionStarted()` y `!editionEnded()` | Solo el fin (`saveWindowEnd()`): mover el inicio cambiaría el corte de las partidas ya publicadas |
 * | **Terminada** | `editionEnded()` | Inicio y fin, como en una edición nueva: el torneo ya no reparte puntos y la organización puede preparar el siguiente |
 *
 * Los dos predicados son de `src/lib/ranked-match.ts` y puros. El estado se decide con
 * la ventana **guardada**, no con lo que traiga el formulario.
 *
 * ## La confirmación al empezar otra edición
 *
 * Mover la fecha de inicio de una edición terminada **empieza una edición nueva**: la
 * clasificación se recalcula contra la ventana nueva y la anterior deja de mostrarse en
 * la web (sus partidas y sus historiales siguen guardados). Por eso se exige el campo
 * `confirmNewEdition` con `"true"` cuando el inicio enviado difiere del guardado. Solo
 * se pide si se mueve el inicio: mover el fin de una edición terminada —por ejemplo para
 * corregir la fecha de cierre— no reemplaza nada.
 *
 * ## Validación, rastro y recálculo
 *
 * Las dos fechas se escriben como **fecha y hora local de Madrid** (`datetime-local`) o
 * como un instante ISO-8601 con zona; `parseMadridLocalInstant()` hace la conversión y
 * un texto que no sea ninguna de las dos cosas se rechaza con el mensaje de su campo.
 * `to` vacío es `null` (ventana abierta por la derecha). El resto del ruleset se
 * conserva y se valida entero con `mergeRuleset()`.
 *
 * `writeScoringRuleset()` hace el `upsert`, el rastro (`CONFIG_CHANGED`, en la misma
 * transacción) y el recálculo de la clasificación, porque la ventana mueve puntos.
 *
 * Revalida las pantallas que leen las fechas: la Administración, la propia subpestaña de
 * fechas, el historial, la clasificación, los objetivos y la puntuación.
 */
export async function saveTournamentWindow(
  _prevState: AdminActionResult,
  formData: FormData,
): Promise<AdminActionResult> {
  const admin = await requireSuperadmin();

  const windowFrom = readField(formData, "windowFrom");
  const windowTo = readField(formData, "windowTo");

  let actual: ScoringRuleset;

  try {
    actual = await readRuleset();
  } catch (error) {
    logDatabaseFailure("admin/saveTournamentWindow/leer", error);

    return { status: "error", message: WINDOW_SAVE_FAILED_MESSAGE };
  }

  const now = new Date();
  const terminada = editionEnded(actual.window, now);

  // Edición **activa**: empezada y sin terminar. El único campo que se puede tocar es el
  // fin; mover la fecha de inicio cambiaría el corte de todas las partidas ya
  // publicadas. Una edición **terminada** sí deja mover el inicio, para empezar la
  // siguiente.
  if (editionStarted(actual.window, now) && !terminada) {
    return saveWindowEnd(admin, formData, windowTo, actual);
  }

  // El panel escribe fecha y hora **local de Madrid** (`datetime-local`) y se guarda
  // ISO-8601 UTC, que es lo que lee `parseWindow()`. El parser acepta también el ISO
  // con zona por si el campo se rellena a mano, y el mensaje de error es el del campo,
  // no el aviso técnico de `mergeRuleset`.
  if (windowFrom === "") {
    return { status: "error", message: WINDOW_FROM_REQUIRED_ERROR };
  }

  const windowFromInstant = parseMadridLocalInstant(windowFrom);

  if (windowFromInstant === null) {
    return { status: "error", message: WINDOW_FROM_INVALID_ERROR };
  }

  const windowToInstant = windowTo === "" ? null : parseMadridLocalInstant(windowTo);

  if (windowTo !== "" && windowToInstant === null) {
    return { status: "error", message: WINDOW_TO_INVALID_ERROR };
  }

  // Los dos lados se comparan ya normalizados por sus parsers, así que el mismo instante
  // escrito distinto no pide confirmación.
  const empiezaOtraEdicion = terminada && windowFromInstant !== actual.window.from;

  if (empiezaOtraEdicion && readField(formData, "confirmNewEdition") !== "true") {
    return { status: "error", message: NEW_EDITION_CONFIRMATION_REQUIRED_ERROR };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- la etiqueta la recalcula `mergeRuleset`
  const { label: _etiquetaCalculada, ...documento } = actual;

  const merged = mergeRuleset({
    ...documento,
    // Un `to` vacío es la ventana abierta: `null` explícito es lo que `mergeRuleset`
    // exige para no heredar el del documento por defecto.
    window: { from: windowFromInstant, to: windowToInstant },
  });

  if (merged.warnings.length > 0) {
    return {
      status: "error",
      message: `No se han guardado las fechas del torneo: ${merged.warnings.join("; ")}.`,
    };
  }

  const despues = merged.ruleset;
  const cambios = campoSiCambia(
    windowText(actual.window),
    windowText(despues.window),
    "window",
    "ventana del torneo",
  );

  if (cambios.length === 0) {
    return {
      status: "success",
      message: "No había ningún cambio que guardar en las fechas del torneo.",
    };
  }

  let resultado;

  try {
    resultado = await writeScoringRuleset(despues, cambios, actorEmail(admin));
  } catch (error) {
    logDatabaseFailure("admin/saveTournamentWindow", error);

    return { status: "error", message: WINDOW_SAVE_FAILED_MESSAGE };
  }

  revalidatePath("/admin/administracion");
  revalidatePath("/admin/administracion/fechas");
  revalidatePath("/admin/acciones");
  revalidatePath("/");
  revalidatePath("/objetivos");
  revalidatePath("/puntuacion");

  return {
    status: "success",
    message: frase(
      "Se han guardado las fechas del torneo.",
      empiezaOtraEdicion
        ? "Al mover el inicio empieza una edición nueva: la anterior deja de mostrarse en la web, aunque sus partidas y sus historiales siguen guardados."
        : "",
      resultado.recomputed
        ? "La clasificación se ha recalculado con las reglas nuevas."
        : resultado.recomputeWarning ?? "El cambio no mueve la puntuación, así que no ha hecho falta recalcular.",
    ),
  };
}

/* -------------------------------------------------------------------------- */
/* Países admitidos                                                            */
/* -------------------------------------------------------------------------- */

const COUNTRIES_SAVE_FAILED_MESSAGE =
  "No se ha podido guardar la lista de países. Inténtalo de nuevo en unos minutos.";

/**
 * Guarda la lista de países admitidos en la inscripción.
 *
 * Escribe `Setting["registration.countries"]`, el documento del que sale la lista que
 * ve quien se inscribe y contra la que se valida el país de un participante en el alta
 * y la edición. Va **detrás de `requireSuperadmin()`**, como la configuración de la
 * edición y el ruleset: admitir o retirar un país cambia quién puede inscribirse, y no
 * se deja al criterio de quien llame a la acción.
 *
 * ## Qué acepta
 *
 * El formulario manda las casillas marcadas como `countries` repetido; `readList()`
 * las recorta y descarta las vacías. La validación y la normalización —cada rótulo
 * exactamente en el catálogo, sin duplicados, con al menos uno y en el orden del
 * catálogo— las hace `normalizeCountrySelection()`, que es pura y tiene su test.
 *
 * **La lista no se puede ampliar más allá del catálogo sin tocar código**: los ISO de
 * AoE4World con los que se resuelve el país de un perfil viven en
 * `COUNTRY_LABEL_BY_ISO` (`src/lib/countries.ts`), así que un rótulo nuevo no tendría
 * ISO con el que compararse. Es un límite del dato, no de esta pantalla, y por eso el
 * mensaje de un rótulo desconocido no lo menciona.
 *
 * ## Qué escribe y dónde queda
 *
 * El `upsert` de `writeCountries()` —que vuelve a validar por su cuenta— y la fila de
 * `AdminAction` (`CONFIG_CHANGED`) van en la **misma transacción**: o se ve el cambio
 * de lista y su línea en el historial, o no se ve ninguno. El rastro lleva la lista de
 * antes y la de después como un solo campo, unidas por ", ", porque lo que se viene a
 * mirar es qué países se han admitido o retirado.
 *
 * Un envío sin cambios no escribe nada y sale como lo que es, un acierto.
 *
 * Revalida las pantallas que pintan la lista: el formulario público de inscripción y
 * el alta de participantes del panel, más el propio panel de administración y el
 * historial.
 */
export async function saveCountries(
  _prevState: AdminActionResult,
  formData: FormData,
): Promise<AdminActionResult> {
  const admin = await requireSuperadmin();

  const seleccion = normalizeCountrySelection(readList(formData, "countries"));

  if (!seleccion.ok) {
    return { status: "error", message: seleccion.error };
  }

  const despues = seleccion.countries;

  let antes: string[];

  try {
    antes = await readCountries();
  } catch (error) {
    logDatabaseFailure("admin/saveCountries/leer", error);

    return { status: "error", message: COUNTRIES_SAVE_FAILED_MESSAGE };
  }

  const cambios = campoSiCambia(
    antes.join(", "),
    despues.join(", "),
    "countries",
    "países admitidos",
  );

  if (cambios.length === 0) {
    return {
      status: "success",
      message: "No había ningún cambio que guardar en la lista de países admitidos.",
    };
  }

  try {
    await db.$transaction(async (tx) => {
      await writeCountries(despues, tx);

      await recordAdminAction(tx, {
        type: AdminActionType.CONFIG_CHANGED,
        actorEmail: actorEmail(admin),
        cambios,
      });
    });
  } catch (error) {
    logDatabaseFailure("admin/saveCountries", error);

    return { status: "error", message: COUNTRIES_SAVE_FAILED_MESSAGE };
  }

  revalidatePath("/participar");
  revalidatePath("/admin");
  revalidatePath("/admin/administracion");
  revalidatePath("/admin/acciones");

  return {
    status: "success",
    message: `Se ha guardado la lista de países admitidos. Campos: ${cambios
      .map((cambio) => cambio.etiqueta)
      .join(", ")}.`,
  };
}

/* -------------------------------------------------------------------------- */
/* Reversión de acciones                                                       */
/* -------------------------------------------------------------------------- */

const MISSING_ACTION_ERROR = "No se ha podido saber qué acción hay que deshacer.";

/**
 * Deshace una acción del historial del panel.
 *
 * Es lo que hay detrás del botón de "deshacer" de `/admin/acciones`, y va **detrás de
 * `requireSuperadmin()`**: revisar y deshacer lo que hicieron los admins regulares es
 * justo lo que el superadministrador existe para poder hacer, y una Server Action es un
 * endpoint público que se puede llamar directamente.
 *
 * El trabajo —qué se deshace, con qué validaciones y en qué transacción— vive en
 * `revertAdminAction()` (`src/lib/admin-revert.ts`), que es lo que comparten esta
 * acción, su test y la interfaz que decide si pinta el botón
 * (`isRevertibleActionType()`). Aquí solo se comprueba el permiso, se lee el id y se
 * firma el rastro con el correo de quien lo pulsa.
 *
 * Devuelve `AdminActionResult` como las demás del panel, para que la pantalla lo lea
 * igual que el resto.
 */
export async function revertAdminAction(
  _prevState: AdminActionResult,
  formData: FormData,
): Promise<AdminActionResult> {
  const admin = await requireSuperadmin();

  const actionId = readField(formData, "actionId");

  if (actionId === "") {
    return { status: "error", message: MISSING_ACTION_ERROR };
  }

  const result = await revertRecordedAction(actionId, actorEmail(admin));

  if (result.status === "success") {
    // La clasificación y la lista de participantes pueden haber cambiado, y el
    // historial es donde se acaba de anotar la reversión.
    revalidatePath("/admin");
    revalidatePath("/admin/acciones");
  }

  return result;
}

/* -------------------------------------------------------------------------- */
/* Avisos del torneo en Discord                                                */
/* -------------------------------------------------------------------------- */

const ANNOUNCEMENT_FAILED_ERROR =
  "No se ha podido enviar el aviso. Inténtalo de nuevo en unos minutos.";

/**
 * Manda un aviso de prueba al canal de avisos del torneo.
 *
 * Solo el superadministrador: es una escritura en un canal de Discord y el sitio donde
 * se comprueba que `DISCORD_BOT_TOKEN` y `DISCORD_ANNOUNCE_CHANNEL_ID` están bien
 * puestos. Manda el texto **real** del aviso que se pida (comienzo o final, con el
 * nombre y las fechas de la edición) y con el prefijo `(Prueba)`, así que lo que se ve
 * en el canal es cómo va a quedar el mensaje de verdad.
 *
 * **No** anota nada en la memoria (`Setting["edition.announcements"]`): una prueba no es
 * el aviso del torneo y no puede impedir que el de verdad salga. Un `kind` que no se
 * entiende vale como el de comienzo, que es el que se quiere probar por defecto.
 */
export async function sendTestAnnouncement(
  _prevState: AdminActionResult,
  formData: FormData,
): Promise<AdminActionResult> {
  await requireSuperadmin();

  const kind: EditionAnnouncementKind = readField(formData, "kind") === "end" ? "end" : "start";

  let result: TestAnnouncementResult;

  try {
    result = await sendTestAnnouncementToChannel(kind);
  } catch (error) {
    logDatabaseFailure("admin/sendTestAnnouncement", error);

    return { status: "error", message: ANNOUNCEMENT_FAILED_ERROR };
  }

  return result;
}
