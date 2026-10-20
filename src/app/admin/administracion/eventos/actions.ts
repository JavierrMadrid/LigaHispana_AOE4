"use server";

import type { User } from "@supabase/supabase-js";
import { revalidatePath } from "next/cache";
import type { AdminActionResult } from "@/app/admin/actions";
import { AdminActionType } from "@/generated/prisma/enums";
import { recordAdminAction, type CampoEditado } from "@/lib/admin-actions";
import { requireSuperadmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { logDatabaseFailure } from "@/lib/db-errors";
import {
  EDITION_EVENTS_MAX,
  EDITION_EVENTS_VERSION,
  EDITION_EVENT_DESCRIPTION_MAX_LENGTH,
  EDITION_EVENT_NAME_MAX_LENGTH,
  MIN_EVENT_MULTIPLIER,
  editionEventsLocked,
  mergeEditionEvents,
  readEditionEvents,
  readEditionEventsState,
  removeEditionEventState,
  validateEditionEvents,
  writeEditionEvents,
  writeEditionEventsState,
  type EditionEvent,
  type EditionEventsConfig,
} from "@/lib/edition-events";
import { campoSiCambia } from "@/lib/player-fields";
import { parseMadridLocalInstant } from "@/lib/ranked-match";
import { readRuleset, recomputeScores, type ScoringRuleset } from "@/lib/scoring";

/**
 * Server Actions de los eventos puntuales: alta, edición y baja.
 *
 * Un evento es una ventana con multiplicador de puntos (ver
 * `src/lib/edition-events.ts` y `docs/PUNTUACION.md`). Estas acciones escriben
 * `Setting["edition.events"]` y, al borrar, limpian también su entrada de
 * `Setting["edition.events.state"]`, para no dejar snapshots de eventos que ya no
 * existen.
 *
 * ## Solo antes de empezar
 *
 * Crear o editar un evento **después de que empiece la ventana del torneo** movería
 * puntos ya publicados, así que las dos acciones se niegan cuando
 * `editionEventsLocked()` lo dice. La comprobación va en el servidor, no en el
 * formulario: una Server Action es un endpoint público.
 *
 * ## Lo que valida
 *
 * Los campos que una persona escribe mal se comprueban aquí, con su mensaje: el
 * nombre, la descripción, las fechas (llegan como `datetime-local` de Madrid y se
 * convierten con `parseMadridLocalInstant()`), el multiplicador y el rango. Después
 * se valida el **documento completo** contra la ventana del torneo y los solapes
 * (`validateEditionEvents()`): si queda un aviso, no se escribe nada y se enseña el
 * primero, porque el panel solo tiene un `message`.
 *
 * ## El rastro y el recálculo
 *
 * El `upsert` de `Setting` y la fila de `AdminAction` (`CONFIG_CHANGED`) van en la
 * **misma transacción**, como en `saveEditionConfig`. Un evento mueve puntos, así
 * que después se llama a `recomputeScores()` **fuera** de la transacción: si el
 * recálculo falla, los eventos están guardados y se avisa de que la clasificación se
 * pondrá al día en la siguiente pasada, igual que con el ruleset.
 */

/** Campo de texto de un formulario, ya recortado. */
function readField(formData: FormData, name: string): string {
  const value = formData.get(name);

  return typeof value === "string" ? value.trim() : "";
}

/**
 * Quién está actuando, para la columna `AdminAction.actorEmail`.
 *
 * Misma regla que en el resto del panel: sin correo se guarda el id con un prefijo
 * que lo hace evidente y sigue siendo rastreable.
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

/** Cómo se describe un evento en el rastro: todo lo que reparte puntos, en una línea. */
function eventText(event: EditionEvent): string {
  const discord = event.discordRequired ? ", Discord obligatorio" : "";

  return `${event.name} (${event.from} → ${event.to}, x${event.multiplier}${discord})`;
}

const EVENTS_SAVE_FAILED_MESSAGE =
  "No se han podido guardar los eventos. Inténtalo de nuevo en unos minutos.";

const MISSING_EVENT_ERROR = "No se ha podido saber qué evento hay que borrar.";

const UNKNOWN_EVENT_ERROR = "Ese evento ya no existe. Recarga la página y vuelve a intentarlo.";

const EVENTS_LOCKED_ERROR =
  "Los eventos ya no se pueden cambiar: la ventana del torneo ha empezado. Solo se pueden crear o editar antes de su fecha de inicio.";

const EVENT_NAME_REQUIRED_ERROR =
  "El nombre del evento es obligatorio: es lo que se enseña en el calendario.";

const EVENT_NAME_TOO_LONG_ERROR = `El nombre del evento no puede pasar de ${EDITION_EVENT_NAME_MAX_LENGTH} caracteres.`;

const EVENT_DESCRIPTION_TOO_LONG_ERROR = `Las instrucciones del evento no pueden pasar de ${EDITION_EVENT_DESCRIPTION_MAX_LENGTH} caracteres.`;

const EVENT_FROM_INVALID_ERROR =
  "La fecha de inicio del evento no vale. Escríbela como fecha y hora (por ejemplo 2026-09-20T18:00, hora de Madrid) o como un instante ISO-8601 con zona.";

const EVENT_TO_INVALID_ERROR =
  "La fecha de fin del evento no vale. Escríbela como fecha y hora (por ejemplo 2026-09-20T22:00, hora de Madrid) o como un instante ISO-8601 con zona.";

const EVENT_RANGE_ERROR = "La fecha de fin del evento tiene que ser posterior a la de inicio.";

const EVENT_MULTIPLIER_ERROR = `El multiplicador tiene que ser un número entero mayor o igual que ${MIN_EVENT_MULTIPLIER}.`;

const EVENTS_FULL_ERROR = `Una edición no puede tener más de ${EDITION_EVENTS_MAX} eventos.`;

/** Los campos que cambian entre dos versiones del mismo evento, para el rastro. */
function eventChanges(antes: EditionEvent, despues: EditionEvent): CampoEditado[] {
  const name = `evento "${antes.name}"`;
  const key = (field: string): string => `edition.events.${antes.id}.${field}`;

  return [
    ...campoSiCambia(antes.name, despues.name, key("name"), `nombre del ${name}`),
    ...campoSiCambia(
      antes.description,
      despues.description,
      key("description"),
      `instrucciones del ${name}`,
    ),
    ...campoSiCambia(
      `${antes.from} → ${antes.to}`,
      `${despues.from} → ${despues.to}`,
      key("window"),
      `fechas del ${name}`,
    ),
    ...campoSiCambia(
      String(antes.multiplier),
      String(despues.multiplier),
      key("multiplier"),
      `multiplicador del ${name}`,
    ),
    ...campoSiCambia(
      String(antes.discordRequired),
      String(despues.discordRequired),
      key("discordRequired"),
      `Discord del ${name}`,
    ),
  ];
}

/** El aviso del recálculo, para el mensaje de éxito. */
function recomputeMessage(recomputed: boolean): string {
  return recomputed
    ? "La clasificación se ha recalculado con los eventos nuevos."
    : "Los eventos están guardados, pero la clasificación se pondrá al día en la próxima pasada del sincronizador.";
}

/**
 * Recalcula la clasificación sin tumbar la acción si falla.
 *
 * Los eventos ya están confirmados: deshacerlos porque el recálculo no ha salido
 * dejaría al panel diciendo que no se guardó lo que sí está. El aviso del mensaje es
 * lo que le dice a quien lo pulsó que la tabla que ve es la anterior.
 */
async function recomputeAfterEventsWrite(): Promise<boolean> {
  try {
    await recomputeScores();

    return true;
  } catch (error) {
    logDatabaseFailure("admin/eventos/recompute", error);

    return false;
  }
}

/**
 * Guarda un evento: lo crea si no trae `id` y lo edita si lo trae.
 *
 * El formulario manda `name`, `description`, `from`, `to`, `multiplier` y
 * `discordRequired`. Las fechas llegan del `<input type="datetime-local">` en hora de
 * Madrid y se guardan como ISO-8601 UTC, que es lo que lee el motor.
 *
 * Al crear, el `id` lo genera el servidor (`crypto.randomUUID()`) y no se acepta uno
 * del formulario: un id elegido por quien llama podría repetirse o parecerse a otro,
 * y el id es la clave del snapshot de elegibilidad. Al editar se conserva el que
 * tenía, para no perder ese snapshot ni el rastro de una ventana que ya estaba
 * publicada.
 */
export async function saveEditionEvent(
  _prevState: AdminActionResult,
  formData: FormData,
): Promise<AdminActionResult> {
  const admin = await requireSuperadmin();

  const id = readField(formData, "id");
  const name = readField(formData, "name");
  const descriptionRaw = readField(formData, "description");
  const fromRaw = readField(formData, "from");
  const toRaw = readField(formData, "to");
  const multiplierRaw = readField(formData, "multiplier");
  const discordRequired = readField(formData, "discordRequired") === "true";

  if (name === "") {
    return { status: "error", message: EVENT_NAME_REQUIRED_ERROR };
  }

  if (name.length > EDITION_EVENT_NAME_MAX_LENGTH) {
    return { status: "error", message: EVENT_NAME_TOO_LONG_ERROR };
  }

  if (descriptionRaw.length > EDITION_EVENT_DESCRIPTION_MAX_LENGTH) {
    return { status: "error", message: EVENT_DESCRIPTION_TOO_LONG_ERROR };
  }

  const from = parseMadridLocalInstant(fromRaw);

  if (from === null) {
    return { status: "error", message: EVENT_FROM_INVALID_ERROR };
  }

  const to = parseMadridLocalInstant(toRaw);

  if (to === null) {
    return { status: "error", message: EVENT_TO_INVALID_ERROR };
  }

  if (new Date(to).getTime() <= new Date(from).getTime()) {
    return { status: "error", message: EVENT_RANGE_ERROR };
  }

  const multiplier = Number(multiplierRaw);

  if (!Number.isInteger(multiplier) || multiplier < MIN_EVENT_MULTIPLIER) {
    return { status: "error", message: EVENT_MULTIPLIER_ERROR };
  }

  let actual: EditionEventsConfig;
  let ruleset: ScoringRuleset;

  try {
    [actual, ruleset] = await Promise.all([readEditionEvents(), readRuleset()]);
  } catch (error) {
    logDatabaseFailure("admin/saveEditionEvent/leer", error);

    return { status: "error", message: EVENTS_SAVE_FAILED_MESSAGE };
  }

  if (editionEventsLocked(ruleset.window, new Date())) {
    return { status: "error", message: EVENTS_LOCKED_ERROR };
  }

  const anterior = id === "" ? null : (actual.events.find((event) => event.id === id) ?? null);

  if (id !== "" && anterior === null) {
    return { status: "error", message: UNKNOWN_EVENT_ERROR };
  }

  if (anterior === null && actual.events.length >= EDITION_EVENTS_MAX) {
    return { status: "error", message: EVENTS_FULL_ERROR };
  }

  const event: EditionEvent = {
    id: anterior?.id ?? crypto.randomUUID(),
    name,
    description: descriptionRaw === "" ? null : descriptionRaw,
    from,
    to,
    multiplier,
    discordRequired,
  };

  // El mismo id se sustituye, no se añade: editar no puede duplicar la clave del
  // snapshot de elegibilidad.
  const events = [...actual.events.filter((existing) => existing.id !== event.id), event];
  const merged = mergeEditionEvents({ version: EDITION_EVENTS_VERSION, events });

  if (merged.warnings.length > 0) {
    return {
      status: "error",
      message: `No se ha guardado el evento: ${merged.warnings.join("; ")}.`,
    };
  }

  const validado = validateEditionEvents(merged.config.events, ruleset.window);

  if (validado.warnings.length > 0) {
    return {
      status: "error",
      message: `No se ha guardado el evento: ${validado.warnings.join("; ")}.`,
    };
  }

  const cambios: CampoEditado[] =
    anterior === null
      ? [
          {
            campo: "edition.events",
            etiqueta: `alta del evento "${event.name}"`,
            antes: null,
            despues: eventText(event),
          },
        ]
      : eventChanges(anterior, event);

  if (cambios.length === 0) {
    return {
      status: "success",
      message: "No había ningún cambio que guardar en el evento.",
    };
  }

  try {
    await db.$transaction(async (tx) => {
      await writeEditionEvents({ version: EDITION_EVENTS_VERSION, events: validado.events }, tx);

      await recordAdminAction(tx, {
        type: AdminActionType.CONFIG_CHANGED,
        actorEmail: actorEmail(admin),
        cambios,
      });
    });
  } catch (error) {
    logDatabaseFailure("admin/saveEditionEvent", error);

    return { status: "error", message: EVENTS_SAVE_FAILED_MESSAGE };
  }

  const recomputed = await recomputeAfterEventsWrite();

  revalidatePath("/reglas");
  revalidatePath("/(public)", "layout");
  revalidatePath("/admin/administracion/eventos");
  revalidatePath("/admin/acciones");
  revalidatePath("/puntuacion");
  revalidatePath("/");

  return {
    status: "success",
    message: frase(
      `Se ha guardado el evento "${event.name}".`,
      recomputeMessage(recomputed),
    ),
  };
}

/**
 * Borra un evento y su snapshot de elegibilidad.
 *
 * Las dos escrituras van en la **misma transacción** que el rastro: si el borrado del
 * evento se confirma y el de su snapshot no, quedaría en `Setting` la elegibilidad de
 * un evento que ya no existe. Se borra solo si había entrada, para no tocar la fila ni
 * anotar un cambio que no ha existido.
 *
 * Como el alta y la edición, se niega si la ventana del torneo ya ha empezado.
 */
export async function deleteEditionEvent(
  _prevState: AdminActionResult,
  formData: FormData,
): Promise<AdminActionResult> {
  const admin = await requireSuperadmin();

  const id = readField(formData, "id");

  if (id === "") {
    return { status: "error", message: MISSING_EVENT_ERROR };
  }

  let actual: EditionEventsConfig;
  let ruleset: ScoringRuleset;

  try {
    [actual, ruleset] = await Promise.all([readEditionEvents(), readRuleset()]);
  } catch (error) {
    logDatabaseFailure("admin/deleteEditionEvent/leer", error);

    return { status: "error", message: EVENTS_SAVE_FAILED_MESSAGE };
  }

  if (editionEventsLocked(ruleset.window, new Date())) {
    return { status: "error", message: EVENTS_LOCKED_ERROR };
  }

  const event = actual.events.find((existing) => existing.id === id) ?? null;

  if (event === null) {
    return { status: "error", message: UNKNOWN_EVENT_ERROR };
  }

  const events = actual.events.filter((existing) => existing.id !== id);
  const merged = mergeEditionEvents({ version: EDITION_EVENTS_VERSION, events });

  if (merged.warnings.length > 0) {
    return {
      status: "error",
      message: `No se ha borrado el evento: ${merged.warnings.join("; ")}.`,
    };
  }

  const cambios: CampoEditado[] = [
    {
      campo: "edition.events",
      etiqueta: `baja del evento "${event.name}"`,
      antes: eventText(event),
      despues: null,
    },
  ];

  try {
    await db.$transaction(async (tx) => {
      await writeEditionEvents({ version: EDITION_EVENTS_VERSION, events: merged.config.events }, tx);

      const state = await readEditionEventsState(tx);
      const sinEntrada = removeEditionEventState(state, id);

      if (sinEntrada !== null) {
        await writeEditionEventsState(sinEntrada, tx);
      }

      await recordAdminAction(tx, {
        type: AdminActionType.CONFIG_CHANGED,
        actorEmail: actorEmail(admin),
        cambios,
      });
    });
  } catch (error) {
    logDatabaseFailure("admin/deleteEditionEvent", error);

    return { status: "error", message: EVENTS_SAVE_FAILED_MESSAGE };
  }

  const recomputed = await recomputeAfterEventsWrite();

  revalidatePath("/reglas");
  revalidatePath("/(public)", "layout");
  revalidatePath("/admin/administracion/eventos");
  revalidatePath("/admin/acciones");
  revalidatePath("/puntuacion");
  revalidatePath("/");

  return {
    status: "success",
    message: frase(
      `Se ha borrado el evento "${event.name}".`,
      recomputeMessage(recomputed),
    ),
  };
}
