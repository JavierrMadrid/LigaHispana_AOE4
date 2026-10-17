import type { Metadata } from "next";
import { DonationsForm } from "@/app/admin/administracion/donations-form";
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
    <section>
      <h2 className="text-lg font-medium">Donaciones</h2>
      <p className="mt-1 max-w-[70ch] text-sm text-muted">
        El banner de donaciones de la web pública. Mientras esté publicado y tenga la
        dirección de la campaña de Matcherino, aparece en lo alto de todas las páginas
        del sitio.
      </p>
      <div className="mt-4">
        <DonationsForm donations={donations} />
      </div>
    </section>
  );
}
