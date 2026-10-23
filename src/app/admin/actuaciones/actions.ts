"use server";

import {
  ADMIN_ACT_KIND_LABELS,
  readAdminActKind,
  type AdminActField,
  type AdminActFormState,
  type AdminActMatchesResult,
  type AdminActTargetsResult,
} from "@/lib/admin-acts";
import { getAdminActMatchCandidates, getAdminActTargetCandidates } from "@/lib/admin-acts-read";
import { createAdminActRecord } from "@/lib/admin-act-service";
import { requireAdmin, requireSuperadmin } from "@/lib/auth";

/**
 * Server Actions de las actuaciones administrativas.
 *
 * Viven bajo `src/app/admin/**` a propósito: el `matcher` del Proxy cubre
 * `/admin/:path*`, y una Server Action fuera de esa ruta se saltaría también la
 * comprobación optimista de la cookie. La comprobación real es la de aquí:
 * `requireAdmin()` en todas, y `requireSuperadmin()` en la creación de reversiones,
 * que son la única operación que no puede hacer un admin normal.
 *
 * La acción valida permisos y entrada y **delega** en `createAdminActRecord()`
 * (`src/lib/admin-act-service.ts`). La lógica de qué se puede anular, cómo se aplica
 * la inversa y qué se hace si el recálculo falla no vive aquí.
 */

const SAVE_FAILED_MESSAGE = "No se ha podido guardar la actuación. Inténtalo de nuevo en unos minutos.";

/**
 * Campo de texto de un formulario, ya recortado.
 *
 * `FormData.get` puede devolver un `File`; sin el filtro, `String(file)` produciría
 * `"[object File]"` y ese texto acabaría en una consulta.
 */
function readField(formData: FormData, name: string): string {
  const value = formData.get(name);

  return typeof value === "string" ? value.trim() : "";
}

/** Los valores repetidos de un `select multiple` o de un grupo de casillas. */
function readAll(formData: FormData, name: string): string[] {
  return formData
    .getAll(name)
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value !== "");
}

/** El correo de quien actúa, con el mismo criterio que `src/app/admin/actions.ts`. */
function actorEmail(user: { email?: string | null; id: string }): string {
  return user.email ?? `sin-correo:${user.id}`;
}

function errorState(message: string, field?: AdminActField): AdminActFormState {
  return {
    status: "error",
    message,
    errors: field === undefined ? {} : { [field]: message },
    actId: null,
  };
}

/**
 * Crea una actuación y la aplica.
 *
 * Lee `kind`, `playerId`, `publicReason`, `privateInfo`, `matchIds` y `targetActIds`.
 * Una reversión exige `requireSuperadmin()`; las expulsiones y anulaciones las puede
 * crear cualquier admin. La respuesta lleva los errores **por campo** para que el
 * formulario pueda pintarlos donde toca y no perder lo escrito.
 */
export async function createAdminActAction(
  _prevState: AdminActFormState,
  formData: FormData,
): Promise<AdminActFormState> {
  const admin = await requireAdmin();
  const kind = readAdminActKind(readField(formData, "kind"));

  if (kind === null) {
    return errorState("No se ha podido saber qué actuación hay que crear.", "kind");
  }

  if (kind === "REVERSAL") {
    // Solo el superadministrador revierte. `requireSuperadmin()` redirige a quien no
    // lo es, igual que en el resto de acciones reservadas del panel.
    await requireSuperadmin();
  }

  const playerId = readField(formData, "playerId");

  if (playerId === "") {
    return errorState("Selecciona al participante de la actuación.", "playerId");
  }

  if (!/^[a-z0-9]{1,64}$/u.test(playerId)) {
    return errorState("Ese participante no es válido. Actualiza la página y vuelve a intentarlo.", "playerId");
  }

  const publicReason = readField(formData, "publicReason");
  const privateInfo = readField(formData, "privateInfo");

  if (kind === "MATCH_ANNULMENT" && readAll(formData, "matchIds").length === 0) {
    return errorState("Selecciona al menos una partida ganada para anular.", "matchIds");
  }

  if (kind === "REVERSAL" && readAll(formData, "targetActIds").length === 0) {
    return errorState("Selecciona al menos una actuación vigente para revertir.", "targetActIds");
  }

  try {
    const base = {
      playerId,
      publicReason,
      privateInfo,
      actorEmail: actorEmail(admin),
    };
    const input =
      kind === "BAN"
        ? { ...base, kind: "BAN" as const }
        : kind === "MATCH_ANNULMENT"
          ? { ...base, kind: "MATCH_ANNULMENT" as const, matchIds: readAll(formData, "matchIds") }
          : { ...base, kind: "REVERSAL" as const, targetActIds: readAll(formData, "targetActIds") };

    const result = await createAdminActRecord(input);

    if (result.status === "error") {
      return errorState(result.message, result.field);
    }

    return {
      status: "success",
      message: result.message,
      errors: {},
      actId: result.actId,
    };
  } catch (error) {
    console.error(
      `[admin/actuaciones] No se ha podido crear la actuación ${ADMIN_ACT_KIND_LABELS[kind]}:`,
      error instanceof Error ? error.message : String(error),
    );

    return errorState(SAVE_FAILED_MESSAGE);
  }
}

/** La forma válida de un `Player.id`; el mismo criterio que el DAL del panel. */
const PLAYER_ID_PATTERN = /^[a-z0-9]{1,64}$/u;

/**
 * Las victorias del jugador que hoy se pueden anular.
 *
 * La llama el formulario al elegir participante. Devuelve un error legible cuando la
 * base no responde o el id no es válido, y una lista vacía cuando no hay ninguna
 * partida anulable, que no es un fallo.
 */
export async function loadAdminActMatches(playerId: string): Promise<AdminActMatchesResult> {
  await requireAdmin();

  const id = playerId.trim();

  if (!PLAYER_ID_PATTERN.test(id)) {
    return { status: "error", message: "Ese participante no es válido. Actualiza la página y vuelve a intentarlo." };
  }

  const read = await getAdminActMatchCandidates(id);

  if (read.status === "degraded") {
    return {
      status: "error",
      message: "No se han podido leer las partidas del jugador. Inténtalo de nuevo en unos minutos.",
    };
  }

  return { status: "ok", data: read.data };
}

/**
 * Las actuaciones vigentes y revertibles del jugador, para el selector de reversión.
 *
 * Solo el superadministrador llega a revertir, pero la lectura la puede hacer
 * cualquier admin: la lista tampoco descubre nada que no esté ya en el panel.
 */
export async function loadAdminActTargets(playerId: string): Promise<AdminActTargetsResult> {
  await requireAdmin();

  const id = playerId.trim();

  if (!PLAYER_ID_PATTERN.test(id)) {
    return { status: "error", message: "Ese participante no es válido. Actualiza la página y vuelve a intentarlo." };
  }

  const read = await getAdminActTargetCandidates(id);

  if (read.status === "degraded") {
    return {
      status: "error",
      message: "No se han podido leer las actuaciones del jugador. Inténtalo de nuevo en unos minutos.",
    };
  }

  return { status: "ok", data: read.data };
}
