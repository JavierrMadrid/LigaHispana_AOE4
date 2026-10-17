import type { Metadata } from "next";
import { AdminsPanel } from "@/app/admin/administracion/admins-panel";
import { listAdmins } from "@/lib/admin-users";

export const metadata: Metadata = {
  title: { absolute: "Administradores · Admin" },
};

/**
 * Subpestaña de administradores: las cuentas del panel y su alta por invitación.
 *
 * La lista degrada a `null` si la base no responde, y el panel lo dice en su sitio
 * en vez de pintar una lista vacía, que se leería como "no hay ninguno". La puerta
 * de la sección la cierra el layout.
 */
export default async function AdminAdministrationPage() {
  const admins = await listAdmins().catch(() => null);

  return (
    <section>
      <h2 className="text-lg font-medium">Administradores</h2>
      <p className="mt-1 max-w-[70ch] text-sm text-muted">
        Las cuentas que pueden entrar al panel. El alta es por invitación: se escribe
        el correo y la persona recibe un enlace para fijar su contraseña. Dar de baja
        desactiva la cuenta —no la borra—, así que se puede reactivar.
      </p>
      <div className="mt-4">
        <AdminsPanel admins={admins} />
      </div>
    </section>
  );
}
