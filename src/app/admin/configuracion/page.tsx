import type { Metadata } from "next";
import { DonationsForm } from "@/app/admin/donations-form";
import { RegistrationSwitch } from "@/app/admin/registration-switch";
import { requireAdmin } from "@/lib/auth";
import { DEFAULT_MATCHERINO_DONATIONS } from "@/lib/donations";
import { DEFAULT_REGISTRATION_OPEN } from "@/lib/registration-open";
import { readMatcherinoDonations, readRegistrationOpen } from "@/lib/settings";

export const metadata: Metadata = {
  title: { absolute: "Configuración · Admin" },
};

/**
 * Pestaña de configuración: los ajustes del torneo que se ven en la web pública.
 *
 * El plazo de inscripción y la campaña de donaciones se leen de `Setting`, y las
 * dos lecturas degradan a su valor de respaldo en vez de tumbar el panel: el
 * plazo, a cerrado, y la campaña, a apagada y sin URL. El servidor vuelve a
 * comprobar el plazo al guardarlo —en el alta y en el envío público— y la campaña
 * en su propio formulario, así que una lectura degradada aquí no abre ni publica
 * nada por accidente. Activar el banner exige una dirección, así que tampoco puede
 * publicarse uno roto. Van en paralelo porque son independientes.
 */
export default async function AdminConfigurationPage() {
  await requireAdmin();

  const [registrationOpen, donations] = await Promise.all([
    readRegistrationOpen().catch(() => DEFAULT_REGISTRATION_OPEN),
    readMatcherinoDonations().catch(() => DEFAULT_MATCHERINO_DONATIONS),
  ]);

  return (
    <div className="flex flex-col gap-8">
      <section>
        <h1 className="text-2xl font-semibold">Configuración</h1>
        <p className="mt-1 max-w-[70ch] text-sm text-muted">
          Los ajustes del torneo que se ven en la web pública: quién puede
          inscribirse y el banner de donaciones.
        </p>
      </section>

      <section>
        <h2 className="text-lg font-medium">Inscripciones</h2>
        <p className="mt-1 max-w-[70ch] text-sm text-muted">
          Quién puede entrar al torneo. Con el plazo abierto se admiten solicitudes
          nuevas desde la web y altas desde este panel; con el plazo cerrado, solo se
          gestionan las solicitudes ya recibidas.
        </p>
        <div className="mt-4">
          <RegistrationSwitch open={registrationOpen} />
        </div>
      </section>

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
    </div>
  );
}
