import type { Metadata } from "next";
import { DonationsForm } from "@/app/admin/administracion/donations-form";
import { AdminPageHeader } from "@/components/admin/page-header";
import { DEFAULT_MATCHERINO_DONATIONS } from "@/lib/donations";
import { readMatcherinoDonations } from "@/lib/settings";

export const metadata: Metadata = {
  title: { absolute: "Donaciones · Admin" },
};

/**
 * Subpestaña de donaciones: el banner de la campaña de Matcherino.
 *
 * La lectura degrada a apagada y sin URL si la base no responde, y el formulario
 * vuelve a validar en el servidor al guardar, así que una lectura degradada aquí no
 * publica un banner roto.
 */
export default async function AdminDonationsPage() {
  const donations = await readMatcherinoDonations().catch(
    () => DEFAULT_MATCHERINO_DONATIONS,
  );

  return (
    <div className="flex flex-col gap-6">
      <AdminPageHeader
        level={2}
        title="Donaciones"
        description="La campaña de Matcherino que se publica en la web."
      />

      <DonationsForm donations={donations} />
    </div>
  );
}
