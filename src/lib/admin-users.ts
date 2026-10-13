import "server-only";

import { AdminActionType } from "@/generated/prisma/enums";
import { isSuperadminEmail, normalizeAdminEmail } from "@/lib/admin-access";
import { recordAdminAction } from "@/lib/admin-actions";
import { db } from "@/lib/db";
import { logDatabaseFailure, uniqueViolationOn } from "@/lib/db-errors";
import { readRuntimeEnv } from "@/lib/runtime-env";
import {
  banAuthUser,
  findAuthUserByEmail,
  inviteAuthUser,
  unbanAuthUser,
  type AuthAdminResult,
} from "@/lib/supabase/admin";

/**
 * La lista de administradores del panel y las operaciones para gestionarla.
 *
 * Es la cara de servidor de la tabla `Admin`: leerla, invitar por correo, dar de
 * baja (desactivar) y reactivar. Todo lo que **decide el acceso** está en
 * `src/lib/admin-access.ts` (puro) y en `src/lib/auth.ts` (que resuelve la sesión);
 * aquí solo se escribe y se lee lo que esas dos capas necesitan.
 *
 * ## Quién puede llamar a esto
 *
 * Nada de aquí comprueba permisos: son funciones de datos, y quien decide si se
 * pueden ejecutar es la Server Action que las llama, que empieza por
 * `requireSuperadmin()`. Es el mismo reparto que el resto del panel, donde la
 * comprobación vive en la acción y no en el DAL.
 *
 * ## La baja no borra y el rastro no se pierde
 *
 * Dar de baja pone `active = false` y una fecha; reactivar lo deshace. Lo que se
 * hizo queda en `AdminAction` (append-only), así que el historial no depende de que
 * la fila siga activa. El best-effort contra Supabase Auth —banear y desbanear— es
 * solo para cortar una sesión viva: la comprobación de verdad es la fila, que se lee
 * en cada petición.
 */

/** Fallo de base de datos al guardar. El motivo se queda en el log del servidor. */
const SAVE_FAILED_MESSAGE = "No se ha podido guardar. Inténtalo de nuevo en unos minutos.";

/**
 * No se puede invitar porque falta la clave de servicio.
 *
 * Es una degradación conocida, no un fallo: dar de baja y reactivar siguen
 * funcionando porque solo tocan la base. El texto lo dice para que se entienda que
 * el problema es de configuración y no de la cuenta invitada.
 */
const SERVICE_KEY_MISSING_MESSAGE =
  "No se puede invitar: falta la clave de servicio de Supabase (SUPABASE_SERVICE_ROLE_KEY) en el servidor.";

const AUTH_LOOKUP_FAILED_MESSAGE =
  "No se ha podido comprobar si ese correo ya tiene cuenta. Inténtalo de nuevo en unos minutos.";

const AUTH_INVITE_FAILED_MESSAGE =
  "No se ha podido enviar la invitación. Inténtalo de nuevo en unos minutos.";

/**
 * Resultado de una operación de gestión de admins.
 *
 * Mismos estados que `AdminActionResult` (el de las Server Actions) menos `idle`,
 * que no pinta nada en un DAL: una operación aquí o ha ido bien o ha fallado. Se
 * tipa aparte para no importar un tipo de un módulo `"use server"`.
 */
export type AdminUserResult = {
  status: "success" | "error";
  message: string;
};

/** Una fila de `Admin` tal como la necesita el panel para listarla. */
export type AdminSummary = {
  id: string;
  email: string;
  active: boolean;
  authUserId: string | null;
  addedByEmail: string | null;
  createdAt: Date;
  deactivatedAt: Date | null;
};

let superadminWarned = false;

/**
 * El correo del superadministrador, ya canónico, o `null` si no está configurado.
 *
 * Sin `SUPERADMIN_EMAIL` **nadie es superadministrador**: la app arranca igual (es
 * el criterio degradante del proyecto) pero la sección de administración de admins
 * queda inaccesible, porque no hay quien pueda entrar a ella. Se avisa **una vez
 * por isolate** para no llenar el log con una petición por cada navegación.
 */
export function readSuperadminEmail(): string | null {
  const raw = readRuntimeEnv("SUPERADMIN_EMAIL");
  const email = raw === undefined ? "" : normalizeAdminEmail(raw);

  if (email === "") {
    if (!superadminWarned) {
      superadminWarned = true;
      console.warn(
        "[admin] SUPERADMIN_EMAIL no está definida: nadie es superadministrador y la gestión de admins queda bloqueada.",
      );
    }

    return null;
  }

  return email;
}

/**
 * La fila de `Admin` de un correo, reducida a lo que decide su acceso.
 *
 * Es lo que `requireAdmin()` consulta en cada petición y lo que espera
 * `resolveAdminAccess()`. Se lee por la clave única `email`, así que no hay listado.
 * Devolver solo `email` y `active` deja claro que el resto de la fila no decide nada
 * sobre quién entra.
 */
export async function findAdminForAccess(
  email: string,
): Promise<{ email: string; active: boolean } | null> {
  return db.admin.findUnique({
    where: { email: normalizeAdminEmail(email) },
    select: { email: true, active: true },
  });
}

/** Los admins del panel, los activos primero y por correo. Para la pantalla de administración. */
export async function listAdmins(): Promise<AdminSummary[]> {
  return db.admin.findMany({
    orderBy: [{ active: "desc" }, { email: "asc" }],
    select: {
      id: true,
      email: true,
      authUserId: true,
      active: true,
      addedByEmail: true,
      createdAt: true,
      deactivatedAt: true,
    },
  });
}

/**
 * Invita a un correo y le da acceso al panel.
 *
 * ## Los dos caminos
 *
 * El objetivo es que el correo acabe con una cuenta de Auth **y** una fila activa.
 * Cómo se llega depende de si la cuenta ya existía:
 *
 * - **No existía**: se crea por `inviteUserByEmail`, que le manda el correo para
 *   fijar su contraseña (el enlace pasa por `/auth/confirm` y termina en
 *   `/login/establecer-contrasena`). Es una **invitación**.
 * - **Ya existía** (los admins anteriores, que tenían cuenta y no fila): no se manda
 *   ningún correo; se localiza su `authUserId` y se vincula. Es un **alta** de alguien
 *   que ya tenía cuenta, y la frase lo dice.
 *
 * Una fila que ya existe **no** se vuelve a invitar: si está activa es un error
 * ("ya es admin") y si está de baja se remite a reactivar, para que "alta" y
 * "reactivación" no sean dos textos para el mismo movimiento.
 *
 * ## Qué se escribe y en qué orden
 *
 * Primero se resuelve la cuenta de Auth (fuera de la transacción, porque es una
 * llamada de red) y luego, en **una transacción**, la fila y su línea en
 * `AdminAction`. Si la fila falla, la cuenta de Auth puede quedar creada sin vincular
 * —una invitación ya enviada no se puede deshacer—, pero el siguiente intento la
 * encuentra y la vincula: el estado no se rompe, se pospone.
 *
 * El correo del superadministrador se rechaza aquí y no se puede invitar: no
 * necesita fila y una fila con su correo se podría "dar de baja" desde el panel.
 */
export async function inviteAdminAccount(
  rawEmail: string,
  actorEmail: string,
): Promise<AdminUserResult> {
  const email = normalizeAdminEmail(rawEmail);

  if (isSuperadminEmail(email, readSuperadminEmail())) {
    return { status: "error", message: "Ese correo ya es la cuenta de superadministración." };
  }

  let existing: { id: string; active: boolean } | null;

  try {
    existing = await db.admin.findUnique({
      where: { email },
      select: { id: true, active: true },
    });
  } catch (error) {
    logDatabaseFailure("admin/inviteAdmin/consulta", error);

    return { status: "error", message: SAVE_FAILED_MESSAGE };
  }

  if (existing !== null) {
    return existing.active
      ? { status: "error", message: "Ese correo ya es administrador del panel." }
      : {
          status: "error",
          message:
            "Ese correo ya estuvo en el panel y está de baja. Reactívalo en lugar de invitarlo otra vez.",
        };
  }

  const found = await findAuthUserByEmail(email);

  if (found.status === "not-configured") {
    return { status: "error", message: SERVICE_KEY_MISSING_MESSAGE };
  }

  if (found.status === "error") {
    return { status: "error", message: AUTH_LOOKUP_FAILED_MESSAGE };
  }

  let authUserId: string;
  let mode: "invited" | "linked";

  if (found.data !== null) {
    authUserId = found.data.id;
    mode = "linked";
  } else {
    const invited = await inviteAuthUser(email);

    if (invited.status === "not-configured") {
      return { status: "error", message: SERVICE_KEY_MISSING_MESSAGE };
    }

    if (invited.status === "error") {
      return { status: "error", message: AUTH_INVITE_FAILED_MESSAGE };
    }

    authUserId = invited.data.id;
    mode = "invited";
  }

  try {
    await db.$transaction(async (tx) => {
      const created = await tx.admin.create({
        data: { email, authUserId, addedByEmail: actorEmail },
        select: { id: true },
      });

      await recordAdminAction(tx, {
        type: AdminActionType.ADMIN_ADDED,
        actorEmail,
        targetId: created.id,
        email,
        mode,
      });
    });
  } catch (error) {
    // La carrera real: dos invitaciones del mismo correo a la vez. La comprobación
    // de arriba no las ve y las para la unicidad de `email`, con el mismo mensaje.
    if (uniqueViolationOn(error, "email")) {
      return { status: "error", message: "Ese correo ya es administrador del panel." };
    }

    logDatabaseFailure("admin/inviteAdmin", error);

    return { status: "error", message: SAVE_FAILED_MESSAGE };
  }

  return {
    status: "success",
    message:
      mode === "invited"
        ? `Se ha invitado a ${email}. Recibirá un correo para fijar su contraseña y entrar al panel.`
        : `Se ha dado acceso a ${email}, que ya tenía cuenta en la web. Puede entrar con su contraseña de siempre.`,
  };
}

/**
 * Cierra la sesión viva de una cuenta en Supabase Auth, o explica por qué no.
 *
 * Es el "después" best-effort de una baja: el acceso ya está cortado por la fila, y
 * esto solo evita que quien tenía la pestaña abierta siga viendo el panel hasta que
 * el token caduque. Un fallo **no** revierte la baja, así que se avisa en el
 * mensaje en lugar de devolver un error.
 */
async function cerrarSesionDeAuth(authUserId: string | null): Promise<string> {
  if (authUserId === null) {
    return "";
  }

  const result: AuthAdminResult<null> = await banAuthUser(authUserId);

  if (result.status === "not-configured") {
    return " Sin la clave de servicio de Supabase no se ha podido cerrar su sesión abierta; perderá el acceso en cuanto navegue.";
  }

  if (result.status === "error") {
    return " No se ha podido cerrar su sesión abierta de Supabase; perderá el acceso en cuanto navegue.";
  }

  return "";
}

/** Lo contrario de {@link cerrarSesionDeAuth}: quita el ban para que pueda volver a entrar. */
async function reabrirSesionDeAuth(authUserId: string | null): Promise<string> {
  if (authUserId === null) {
    return "";
  }

  const result: AuthAdminResult<null> = await unbanAuthUser(authUserId);

  if (result.status === "ok" || result.status === "not-configured") {
    return "";
  }

  return " No se ha podido restablecer su cuenta en Supabase Auth; si tenía la sesión cortada, puede que necesite volver a intentarlo.";
}

/**
 * Da de baja a un admin: `active = false` y la fecha.
 *
 * No borra la fila, por lo que explica `Admin`. La baja se escribe **antes** de la
 * llamada a Auth y en su propia transacción con el rastro: si el ban falla, el
 * acceso ya está cortado por la fila, que es lo que de verdad se comprueba.
 */
export async function deactivateAdminAccount(
  adminId: string,
  actorEmail: string,
): Promise<AdminUserResult> {
  let row: { id: string; email: string; active: boolean; authUserId: string | null } | null;

  try {
    row = await db.admin.findUnique({
      where: { id: adminId },
      select: { id: true, email: true, active: true, authUserId: true },
    });
  } catch (error) {
    logDatabaseFailure("admin/deactivateAdmin", error);

    return { status: "error", message: SAVE_FAILED_MESSAGE };
  }

  if (row === null) {
    return { status: "error", message: "Esa cuenta ya no está en la lista de administración." };
  }

  if (!row.active) {
    return { status: "error", message: "Esa cuenta ya estaba de baja." };
  }

  // El superadministrador no se puede dar de baja desde el panel: su acceso no sale
  // de la tabla, así que la baja no le quitaría el acceso, solo dejaría una fila
  // engañosa. Se dice tal cual en vez de dejar creer que se ha hecho algo.
  if (isSuperadminEmail(row.email, readSuperadminEmail())) {
    return {
      status: "error",
      message: "La cuenta de superadministración no se puede dar de baja desde el panel.",
    };
  }

  const admin = row;

  try {
    await db.$transaction(async (tx) => {
      await tx.admin.update({
        where: { id: admin.id },
        data: { active: false, deactivatedAt: new Date() },
      });

      await recordAdminAction(tx, {
        type: AdminActionType.ADMIN_DEACTIVATED,
        actorEmail,
        targetId: admin.id,
        email: admin.email,
      });
    });
  } catch (error) {
    logDatabaseFailure("admin/deactivateAdmin", error);

    return { status: "error", message: SAVE_FAILED_MESSAGE };
  }

  const aviso = await cerrarSesionDeAuth(admin.authUserId);

  return { status: "success", message: `Se ha dado de baja a ${admin.email}.${aviso}` };
}

/**
 * Reactiva a un admin que estaba de baja: `active = true` y `deactivatedAt = null`.
 *
 * Quita también el ban de Auth (best-effort) para que pueda volver a entrar. El
 * orden es el mismo que en la baja: primero la fila, después Auth.
 */
export async function reactivateAdminAccount(
  adminId: string,
  actorEmail: string,
): Promise<AdminUserResult> {
  let row: { id: string; email: string; active: boolean; authUserId: string | null } | null;

  try {
    row = await db.admin.findUnique({
      where: { id: adminId },
      select: { id: true, email: true, active: true, authUserId: true },
    });
  } catch (error) {
    logDatabaseFailure("admin/reactivateAdmin", error);

    return { status: "error", message: SAVE_FAILED_MESSAGE };
  }

  if (row === null) {
    return { status: "error", message: "Esa cuenta ya no está en la lista de administración." };
  }

  if (row.active) {
    return { status: "error", message: "Esa cuenta ya estaba activa." };
  }

  const admin = row;

  try {
    await db.$transaction(async (tx) => {
      await tx.admin.update({
        where: { id: admin.id },
        data: { active: true, deactivatedAt: null },
      });

      await recordAdminAction(tx, {
        type: AdminActionType.ADMIN_REACTIVATED,
        actorEmail,
        targetId: admin.id,
        email: admin.email,
      });
    });
  } catch (error) {
    logDatabaseFailure("admin/reactivateAdmin", error);

    return { status: "error", message: SAVE_FAILED_MESSAGE };
  }

  const aviso = await reabrirSesionDeAuth(admin.authUserId);

  return { status: "success", message: `Se ha reactivado a ${admin.email}.${aviso}` };
}
