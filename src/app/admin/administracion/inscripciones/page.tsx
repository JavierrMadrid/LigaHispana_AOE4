import type { Metadata } from "next";
import Link from "next/link";
import { CountriesForm } from "@/app/admin/administracion/countries-form";
import { RegistrationSwitch } from "@/app/admin/administracion/registration-switch";
import { AdminPageHeader } from "@/components/admin/page-header";
import { SectionCard } from "@/components/admin/section";
import { DEFAULT_COUNTRIES, readCountries } from "@/lib/countries";
import { DEFAULT_REGISTRATION_OPEN } from "@/lib/registration-open";
import { readRegistrationState } from "@/lib/settings";

export const metadata: Metadata = {
  title: { absolute: "Inscripciones · Admin" },
};

/**
 * Subpestaña de inscripciones: quién puede entrar al torneo.
 *
 * El interruptor y los países son la misma decisión vista por dos lados, así que viven
 * juntos. Las dos lecturas degradan a su valor de respaldo en vez de tumbar el panel: el
 * plazo, a cerrado, y la lista, a la de por defecto. El servidor vuelve a comprobar ambas
 * al guardar —el país en el alta y el plazo en el alta y en el envío público—, así que
 * una lectura degradada aquí no abre nada por accidente.
 *
 * El plazo tiene dos mandos y esta pantalla enseña **solo uno**: el interruptor manual
 * (`switchOpen`, el que opera `RegistrationSwitch`). La **fecha de cierre**
 * (`closesAt`) vive en la subpestaña `Fechas`, junto a la ventana del torneo, porque es
 * configuración temporal de la edición; aquí se enlaza en vez de duplicarla. El
 * interruptor se pinta con lo que tiene el interruptor, no con el estado efectivo: es lo
 * que la acción compara para decidir si hay cambio, y con la fecha ya pasada el estado
 * efectivo está cerrado aunque el interruptor siga encendido. El estado efectivo y su
 * motivo (`open` | `switch` | `deadline`) los pinta la píldora del interruptor.
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

  return (
    <div className="flex flex-col gap-6">
      <AdminPageHeader
        level={2}
        title="Inscripciones"
        description="Quién puede inscribirse y si el plazo admite solicitudes nuevas."
      />

      <SectionCard
        title="Plazo"
        description={
          <>
            El interruptor lo cierra al instante; la fecha de cierre lo cierra sola y se
            edita en{" "}
            <Link
              href="/admin/administracion/fechas"
              className="text-accent underline underline-offset-4 transition-colors hover:text-accent-strong"
            >
              Fechas
            </Link>
            .
          </>
        }
      >
        <RegistrationSwitch
          switchOpen={registration.switchOpen}
          reason={registration.reason}
        />
      </SectionCard>

      <CountriesForm catalog={[...DEFAULT_COUNTRIES]} selected={countries} />
    </div>
  );
}
