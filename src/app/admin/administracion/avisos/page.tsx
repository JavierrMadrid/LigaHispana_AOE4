import type { Metadata } from "next";
import { AnnouncementsForm } from "@/app/admin/administracion/announcements-form";
import { AdminPageHeader } from "@/components/admin/page-header";

export const metadata: Metadata = {
  title: { absolute: "Avisos · Admin" },
};

/**
 * Subpestaña de avisos: la prueba del canal de Discord del bot.
 *
 * No lee nada de la base: los dos avisos reales los manda el reloj al cruzar su
 * fecha, y aquí solo se comprueba que el canal está bien puesto.
 */
export default function AdminAnnouncementsPage() {
  return (
    <div className="flex flex-col gap-6">
      <AdminPageHeader
        level={2}
        title="Avisos"
        description="El canal de Discord donde el bot avisa del comienzo y del final."
      />

      <AnnouncementsForm />
    </div>
  );
}
