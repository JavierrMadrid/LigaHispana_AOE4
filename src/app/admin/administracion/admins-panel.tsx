"use client";

import { useActionState, useState } from "react";
import type { AdminActionResult } from "@/app/admin/actions";
import { ActionFeedbackProvider } from "@/components/action-feedback";
import { ConfirmAction } from "@/components/confirm-action";
import { EmptyState } from "@/components/empty-state";
import type { AdminSummary } from "@/lib/admin-users";
import { formatAbsoluteTime } from "@/lib/format";
import { deactivateAdmin, inviteAdmin, reactivateAdmin } from "./actions";
import { StatusLine, TextField } from "./fields";

const initialState: AdminActionResult = { status: "idle", message: null };

/**
 * Gestión de las cuentas del panel.
 *
 * Tres operaciones, todas de superadministrador: invitar por correo, dar de baja
 * y reactivar. La lista llega ya resuelta del servidor; si esa lectura falló,
 * `admins` es `null` y se dice en su sitio en vez de pintar una lista vacía, que
 * se leería como "no hay ninguno".
 *
 * La baja **desactiva** —no borra— y por eso el mismo listado ofrece reactivar:
 * las dos caras del mismo estado. El alta es por invitación: el correo recibe un
 * enlace para fijar su contraseña, y eso se explica junto al campo.
 */
export function AdminsPanel({ admins }: { admins: AdminSummary[] | null }) {
  return (
    <div className="flex flex-col gap-6">
      <InviteForm />

      {admins === null ? (
        <EmptyState
          title="No se ha podido leer la lista de administradores"
          body="La base de datos no ha respondido. Vuelve a intentarlo en unos minutos."
        />
      ) : admins.length === 0 ? (
        <EmptyState
          title="Todavía no hay administradores"
          body="Invita por correo a la primera persona administradora. La cuenta de superadministración no aparece aquí: vive en la configuración del despliegue, no en esta lista."
        />
      ) : (
        <ActionFeedbackProvider>
          <AdminsTable admins={admins} />
        </ActionFeedbackProvider>
      )}
    </div>
  );
}

/** Invitación de un correo nuevo al panel. */
function InviteForm() {
  const [state, formAction, pending] = useActionState(inviteAdmin, initialState);
  const [email, setEmail] = useState("");

  return (
    <form action={formAction} className="rounded-lg border border-line bg-surface p-4">
      <div className="max-w-md">
        <TextField
          name="email"
          label="Correo de la nueva persona administradora"
          type="email"
          placeholder="nombre@correo.com"
          value={email}
          onChange={setEmail}
          hint="Recibirá un correo para fijar su contraseña y entrar al panel. Si ya tiene cuenta en la web, entra con la contraseña de siempre."
          required
        />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-4">
        <button
          type="submit"
          disabled={pending}
          className="h-10 rounded-md bg-accent px-4 text-sm font-semibold text-accent-ink transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? "Invitando…" : "Invitar"}
        </button>
        <StatusLine state={state} pending={pending} />
      </div>
    </form>
  );
}

/**
 * Listado de cuentas con su estado y su acción.
 *
 * En pantalla estrecha la fecha de alta cede: la tabla se desplaza en horizontal
 * como el resto de tablas del panel, y lo que no puede faltar —el correo, el
 * estado y el botón— se queda en las columnas fijas.
 */
function AdminsTable({ admins }: { admins: AdminSummary[] }) {
  return (
    <div className="overflow-x-auto overscroll-x-contain rounded-lg border border-line">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">
          Administradores del panel: correo, estado, quién los añadió y cuándo, y
          las acciones para dar de baja o reactivar.
        </caption>
        <thead className="bg-surface text-muted">
          <tr>
            <th scope="col" className="px-4 py-3 font-medium">
              Correo
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              Estado
            </th>
            <th scope="col" className="hidden px-4 py-3 font-medium md:table-cell">
              Alta
            </th>
            <th scope="col" className="px-4 py-3 text-right font-medium">
              Acciones
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {admins.map((admin) => (
            <tr key={admin.id}>
              <td className="px-4 py-3 align-top">
                <span className="break-all text-foreground">{admin.email}</span>
                {admin.addedByEmail !== null ? (
                  <span className="mt-0.5 block text-xs text-muted">
                    Añadido por {admin.addedByEmail}
                  </span>
                ) : null}
                <span className="mt-0.5 block text-xs text-muted md:hidden">
                  Alta el{" "}
                  <time dateTime={admin.createdAt.toISOString()}>
                    {formatAbsoluteTime(admin.createdAt)}
                  </time>
                </span>
              </td>

              <td className="px-4 py-3 align-top">
                <StatusPill active={admin.active} />
                {!admin.active && admin.deactivatedAt !== null ? (
                  <span className="mt-1 block text-xs text-muted">
                    de baja el{" "}
                    <time dateTime={admin.deactivatedAt.toISOString()}>
                      {formatAbsoluteTime(admin.deactivatedAt)}
                    </time>
                  </span>
                ) : null}
              </td>

              <td className="hidden whitespace-nowrap px-4 py-3 align-top text-muted md:table-cell">
                <time dateTime={admin.createdAt.toISOString()} className="tabular-nums">
                  {formatAbsoluteTime(admin.createdAt)}
                </time>
              </td>

              <td className="px-4 py-3 text-right align-top">
                {admin.active ? (
                  <ConfirmAction
                    action={deactivateAdmin}
                    fields={{ adminId: admin.id }}
                    title="Dar de baja al administrador"
                    body={
                      <>
                        Se retirará el acceso al panel a {admin.email}. La cuenta no se
                        borra: queda de baja y se puede reactivar cuando haga falta.
                      </>
                    }
                    triggerLabel="Dar de baja"
                    triggerClassName="h-10 whitespace-nowrap rounded-md border border-loss/40 px-3 text-xs text-loss transition-colors hover:bg-loss/10"
                    confirmLabel="Dar de baja"
                    confirmPendingLabel="Aplicando…"
                    confirmClassName="bg-loss text-accent-ink hover:brightness-110"
                  />
                ) : (
                  <ConfirmAction
                    action={reactivateAdmin}
                    fields={{ adminId: admin.id }}
                    title="Reactivar al administrador"
                    body={
                      <>
                        Se devolverá el acceso al panel a {admin.email}. Podrá entrar de
                        nuevo con su cuenta de siempre.
                      </>
                    }
                    triggerLabel="Reactivar"
                    triggerClassName="h-10 whitespace-nowrap rounded-md border border-line-strong px-3 text-xs text-foreground transition-colors hover:border-accent/60 hover:text-accent"
                    confirmLabel="Reactivar"
                    confirmPendingLabel="Aplicando…"
                    confirmClassName="bg-accent text-accent-ink hover:bg-accent-strong"
                  />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StatusPill({ active }: { active: boolean }) {
  return (
    <span
      className={`inline-block rounded-full border px-2 py-0.5 text-xs ${
        active ? "border-accent/40 text-accent" : "border-line-strong text-muted"
      }`}
    >
      {active ? "Activo" : "De baja"}
    </span>
  );
}
