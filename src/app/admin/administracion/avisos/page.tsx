import type { Metadata } from "next";
import { AnnouncementsForm } from "@/app/admin/administracion/announcements-form";

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
    <section>
      <h2 className="text-lg font-medium">Avisos</h2>
      <p className="mt-1 max-w-[70ch] text-sm text-muted">
        El bot avisa del comienzo y del final del torneo en el canal de avisos de
        Discord. Cada aviso se manda solo, una vez, al cruzar su fecha: no hay que
        pulsar nada. El canal y el token del bot se configuran en el despliegue.
      </p>
      <div className="mt-4">
        <AnnouncementsForm />
      </div>
    </section>
  );
}
