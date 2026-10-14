"use client";

import { useActionState, useState } from "react";
import type { AdminActionResult } from "@/app/admin/actions";
import { saveCountries } from "./actions";
import { StatusLine } from "./fields";

const initialState: AdminActionResult = { status: "idle", message: null };

type CountriesFormProps = {
  /** El catálogo completo del torneo; la lista no se puede ampliar sin tocar código. */
  catalog: string[];
  /** Los países admitidos ahora mismo. */
  selected: string[];
};

/**
 * Países admitidos en la inscripción.
 *
 * Las casillas son el catálogo entero y lo que se publica es lo que quede
 * marcado. Al guardar, la acción lo devuelve **en el orden del catálogo**, no en
 * el de las casillas, así que el orden con el que se enseña la lista en la
 * inscripción no depende de cómo se haya pulsado aquí.
 *
 * El catálogo no se puede ampliar desde esta pantalla: cada país necesita su
 * código ISO de AoE4World para poder resolver el de un perfil, y eso vive en el
 * código. La pista lo dice para que nadie busque un "añadir país" que no existe.
 */
export function CountriesForm({ catalog, selected }: CountriesFormProps) {
  const [state, formAction, pending] = useActionState(saveCountries, initialState);
  const [countries, setCountries] = useState<string[]>(selected);

  function toggle(country: string) {
    setCountries((current) =>
      current.includes(country)
        ? current.filter((item) => item !== country)
        : [...current, country],
    );
  }

  return (
    <form action={formAction} className="rounded-lg border border-line bg-surface p-4">
      <div>
        <p className="max-w-[70ch] text-xs leading-relaxed text-muted">
          Quien se inscribe solo puede elegir un país de esta lista, y el país de un
          participante se valida contra ella. Deja al menos uno marcado. El catálogo
          no se amplía desde aquí: un país nuevo necesita su código de AoE4World en
          el código del sitio.
        </p>

        <div className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
          {catalog.map((country) => (
            <label key={country} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="countries"
                value={country}
                checked={countries.includes(country)}
                onChange={() => toggle(country)}
                className="size-4 shrink-0 rounded border-line bg-background accent-accent"
              />
              <span className="text-foreground">{country}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-4">
        <button
          type="submit"
          disabled={pending}
          className="h-10 rounded-md bg-accent px-4 text-sm font-semibold text-accent-ink transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? "Guardando…" : "Guardar los países"}
        </button>
        <StatusLine state={state} pending={pending} />
      </div>
    </form>
  );
}
