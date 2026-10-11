"use client";

import { useActionState, useState } from "react";
import type { MatcherinoDonations } from "@/lib/public";
import { setMatcherinoDonations, type AdminActionResult } from "./actions";

const initialState: AdminActionResult = { status: "idle", message: null };

/**
 * Control de la campaña de donaciones del torneo.
 *
 * Es la cara visible de `Setting["donations.matcherino"]`: el mismo par
 * (activación + URL) que lee el layout público para pintar el banner. Aquí no
 * decide nada; solo publica el estado y ofrece el cambio, como `RegistrationSwitch`
 * con el plazo de inscripción.
 *
 * ## El formulario es una foto completa
 *
 * Manda **siempre** los dos campos, también el apagado: `enabled` va en un campo
 * oculto con su valor textual, porque el contrato de `setMatcherinoDonations` lee
 * `"true"`/`"false"` y un campo ausente cuenta como apagado —el estado seguro—. El
 * interruptor visible es un `role="switch"` que solo mueve el estado del cliente;
 * cuando se envía el formulario, el valor real viaja en el oculto.
 *
 * ## Por qué el interruptor y la URL son controlados
 *
 * Porque un envío con error no debe borrar lo escrito: el mensaje del servidor
 * ("esa dirección no vale") se lee junto al valor que hay que corregir, no sobre un
 * campo vacío. El estado del cliente arranca con lo que trae el servidor y no se
 * sincroniza sola tras un acierto (React conserva la instancia), pero tras un
 * acierto lo que se ve ya coincide con lo guardado.
 *
 * El resultado se pinta en un `role="status"` que **siempre** está en el DOM, como
 * el de `SyncNowButton`: si apareciera y desapareciera, un lector de pantalla no
 * anunciaría el cambio. El color distingue el fallo (`--loss`) del acierto
 * (`--muted`): el oro es para liga y estructura, no para confirmaciones.
 */
export function DonationsForm({ donations }: { donations: MatcherinoDonations }) {
  const [state, formAction, pending] = useActionState(setMatcherinoDonations, initialState);
  const [enabled, setEnabled] = useState(donations.enabled);
  const [url, setUrl] = useState(donations.url);

  return (
    <form action={formAction} className="rounded-lg border border-line bg-surface p-4">
      {/* Fila de estado: píldora y explicación a la izquierda, interruptor a la
          derecha, como el control del plazo. La píldora dice el estado ("Publicado"
          / "Oculto") y el interruptor nombra la acción con su `aria-label`. */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <span
            className={`inline-block shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium ${
              enabled ? "border-accent/40 text-accent" : "border-line-strong text-muted"
            }`}
          >
            {enabled ? "Publicado" : "Oculto"}
          </span>
          <p className="min-w-0 text-sm leading-relaxed text-muted">
            {enabled
              ? "Visible en la parte superior de todas las páginas públicas."
              : "No se muestra en ninguna página pública."}
          </p>
        </div>

        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="Publicar el banner de donaciones en la web"
          onClick={() => setEnabled((value) => !value)}
          className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors ${
            enabled ? "border-accent/60 bg-accent/25" : "border-line-strong bg-surface-raised"
          }`}
        >
          <span
            aria-hidden="true"
            className={`inline-block size-4 rounded-full transition-transform motion-reduce:transition-none ${
              enabled ? "translate-x-6 bg-accent" : "translate-x-1 bg-muted"
            }`}
          />
        </button>

        <input type="hidden" name="enabled" value={enabled ? "true" : "false"} />
      </div>

      <div className="mt-4 flex flex-col gap-1 text-sm">
        <label htmlFor="donations-url" className="text-muted">
          Dirección de la campaña de Matcherino
        </label>
        <input
          id="donations-url"
          name="url"
          type="url"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://matcherino.com/..."
          autoComplete="off"
          className="h-10 rounded-md border border-line bg-background px-3 text-foreground placeholder:text-muted"
        />
        <span className="text-xs leading-relaxed text-muted">
          Cópiala tal cual desde la campaña; tiene que empezar por http:// o https://.
          Puede quedar guardada aunque el banner esté oculto.
        </span>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-4">
        <button
          type="submit"
          disabled={pending}
          className="h-10 rounded-md bg-accent px-4 text-sm font-semibold text-accent-ink transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? "Guardando…" : "Guardar"}
        </button>
        <p
          role="status"
          aria-live="polite"
          className={`max-w-[70ch] text-sm leading-relaxed ${
            state.status === "error" ? "text-loss" : "text-muted"
          }`}
        >
          {pending ? "" : (state.message ?? "")}
        </p>
      </div>
    </form>
  );
}
