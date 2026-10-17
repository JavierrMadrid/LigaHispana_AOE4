import type { Metadata } from "next";
import { CountriesForm } from "@/app/admin/administracion/countries-form";
import { RegistrationDeadlineForm } from "@/app/admin/administracion/registration-deadline-form";
import { RegistrationSwitch } from "@/app/admin/administracion/registration-switch";
import { DEFAULT_COUNTRIES, readCountries } from "@/lib/countries";
import { formatMadridLocalInstant } from "@/lib/ranked-match";
import { DEFAULT_REGISTRATION_OPEN } from "@/lib/registration-open";
import { readRegistrationState } from "@/lib/settings";

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
 *
 * El plazo tiene dos mandos y la pantalla enseña los dos: el **interruptor
 * manual** (`switchOpen`, el que opera `RegistrationSwitch`) y la **fecha de
 * cierre** (`closesAt`, el de `RegistrationDeadlineForm`), que lo cierra sola.
 * El interruptor se pinta con lo que tiene el interruptor, no con el estado
 * efectivo: es lo que la acción compara para decidir si hay cambio, y con la fecha
 * ya pasada el estado efectivo está cerrado aunque el interruptor siga encendido.
 * El estado efectivo y su motivo (`open` | `switch` | `deadline`) los pinta la
 * píldora del interruptor.
 */
export default async function AdminRegistrationsPage() {
  const [registration, countries] = await Promise.all([
    readRegistrationState().catch(() => ({
      open: DEFAULT_REGISTRATION_OPEN,
      switchOpen: DEFAULT_REGISTRATION_OPEN,
      closesAt: null,
      reason: "switch" as const,
    })),
    readCountries().catch(() => [...DEFAULT_COUNTRIES]),
  ]);

  // La fecha se prefila en el `datetime-local` de Madrid. Se convierte aquí, en el
  // servidor, porque `formatMadridLocalInstant()` es `server-only`; el formulario
  // solo recibe el texto. Una fecha que no se pueda leer deja el campo vacío en vez
  // de con un valor inventado.
  const closesAt =
    registration.closesAt === null
      ? ""
      : (formatMadridLocalInstant(registration.closesAt) ?? "");

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
          El plazo se cierra de dos maneras: el interruptor manual lo cierra al
          instante y la fecha de cierre lo cierra sola cuando llega. Está cerrado si
          el interruptor está apagado o si la fecha ya ha pasado. Mientras está
          cerrado no se admiten solicitudes nuevas ni altas desde este panel; las
          solicitudes ya recibidas se siguen pudiendo aprobar o rechazar.
        </p>
        <div className="mt-3 flex flex-col gap-3">
          <RegistrationSwitch
            switchOpen={registration.switchOpen}
            reason={registration.reason}
          />
          <RegistrationDeadlineForm closesAt={closesAt} />
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
