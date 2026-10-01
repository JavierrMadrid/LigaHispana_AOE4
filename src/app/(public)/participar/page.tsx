import type { Metadata } from "next";
import Link from "next/link";
import { PageHead } from "@/components/page-head";
import { DEFAULT_COUNTRIES, readCountries } from "@/lib/countries";
import { RegistrationForm } from "./registration-form";

export const metadata: Metadata = {
  title: "Participa",
  description:
    "Inscripción en la Liga Hispana de Age of Empires IV: alta de la cuenta de AoE4World, país y, de forma opcional, los canales de Twitch, YouTube y Kick, con revisión de la organización antes de entrar en la clasificación.",
};

// La lista de países admitidos se lee de `Setting` en cada petición, así que la
// página deja de ser estática. Sin esto el `next build` intentaría prerenderizarla
// sin `DATABASE_URL` y fallaría.
export const dynamic = "force-dynamic";

export default async function ParticipatePage() {
  // Un fallo de la base de datos no debe tumbar una página pública: el formulario
  // se pinta con la lista por defecto y, al enviarlo, la acción vuelve a leer la
  // lista viva y pide reintentar si tampoco puede. Es la misma degradación que el
  // resto de la web.
  let countries: string[];

  try {
    countries = await readCountries();
  } catch {
    countries = [...DEFAULT_COUNTRIES];
  }

  return (
    // La página es una sola columna centrada: el formulario marca el ancho
    // (2xl) y la intro y la nota adoptan ese mismo ancho para que sus bordes
    // caigan sobre los de la tarjeta y el conjunto no descuadre.
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-8">
      <PageHead title="Participa" />

      <p className="text-[15px] leading-relaxed text-muted">
        Inscríbete con tu cuenta de AoE4World. Cada solicitud la revisa la
        organización antes de aprobarse, así que no aparecerás en la clasificación
        hasta entonces. No hay equipos: cada persona compite por su cuenta.
      </p>

      <RegistrationForm countries={countries} />

      <p className="border-t border-line pt-6 text-sm leading-relaxed text-muted">
        Las{" "}
        <Link
          href="/reglas"
          className="text-accent underline underline-offset-4 hover:text-accent-strong"
        >
          reglas
        </Link>{" "}
        explican qué cuenta como partida clasificatoria y cómo se reparten los
        puntos.
      </p>
    </div>
  );
}
