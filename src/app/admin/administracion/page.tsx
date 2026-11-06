import type { Metadata } from "next";
import { AdminsPanel } from "@/app/admin/administracion/admins-panel";
import { AdminPageHeader } from "@/components/admin/page-header";
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
    <div className="flex flex-col gap-6">
      <AdminPageHeader
        level={2}
        title="Administradores"
        description="Las cuentas que pueden entrar al panel."
      />

      <AdminsPanel admins={admins} />
    </div>
  );
}
