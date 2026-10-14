import type { Metadata } from "next";
import { CountriesForm } from "@/app/admin/administracion/countries-form";
import { RegistrationSwitch } from "@/app/admin/administracion/registration-switch";
import { DEFAULT_COUNTRIES, readCountries } from "@/lib/countries";
import { DEFAULT_REGISTRATION_OPEN } from "@/lib/registration-open";
import { readRegistrationOpen } from "@/lib/settings";

export const metadata: Metadata = {
  title: { absolute: "Inscripciones · Admin" },
};

/**
 * Subpestaña de inscripciones: quién puede entrar al torneo.
 *
 * El plazo y los países son la misma decisión vista por dos lados, así que viven
 * juntos. Las dos lecturas degradan a su valor de respaldo en vez de tumbar el
 * panel: el plazo, a cerrado, y la lista, a la de por defecto. El servidor vuelve a
 * comprobar ambas al guardar —el país en el alta y el plazo en el alta y en el
 * envío público—, así que una lectura degradada aquí no abre nada por accidente.
 */
export default async function AdminRegistrationsPage() {
  const [registrationOpen, countries] = await Promise.all([
    readRegistrationOpen().catch(() => DEFAULT_REGISTRATION_OPEN),
    readCountries().catch(() => [...DEFAULT_COUNTRIES]),
  ]);

  return (
    <section className="flex flex-col gap-6">
      <div>
        <h2 className="text-lg font-medium">Inscripciones</h2>
        <p className="mt-1 max-w-[70ch] text-sm text-muted">
          Quién puede entrar al torneo. El plazo que admite solicitudes nuevas y los
          países que se aceptan en el alta son la misma decisión vista por dos lados.
        </p>
      </div>

      <div>
        <h3 className="text-base font-medium text-foreground">Plazo</h3>
        <p className="mt-1 max-w-[70ch] text-sm text-muted">
          Con el plazo abierto se admiten solicitudes nuevas desde la web y altas desde
          este panel; con el plazo cerrado, solo se gestionan las solicitudes ya
          recibidas.
        </p>
        <div className="mt-3">
          <RegistrationSwitch open={registrationOpen} />
        </div>
      </div>

      <div>
        <h3 className="text-base font-medium text-foreground">Países admitidos</h3>
        <p className="mt-1 max-w-[70ch] text-sm text-muted">
          La lista de países que se ofrece en la inscripción y contra la que se valida
          el país de un participante.
        </p>
        <div className="mt-3">
          <CountriesForm catalog={[...DEFAULT_COUNTRIES]} selected={countries} />
        </div>
      </div>
    </section>
  );
}
