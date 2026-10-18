"use client";

import { useActionState, useState } from "react";
import { setRegistrationClosesAt, type AdminActionResult } from "@/app/admin/actions";
import { StatusLine, TextField } from "./fields";

const initialState: AdminActionResult = { status: "idle", message: null };

/**
 * La fecha de cierre **automático** de las inscripciones.
 *
 * Es la cara visible de `Setting["registration.closesAt"]`: pasada esa hora, el
 * plazo se cierra solo, sin que nadie toque el interruptor. El interruptor
 * (`RegistrationSwitch`) sigue siendo el mando **manual**, y por eso los dos
 * controles van juntos y separados: son dos maneras de cerrar el mismo plazo.
 *
 * El campo es un `datetime-local`, como la ventana del ruleset: **sin zona**, y lo
 * interpreta el servidor en `Europe/Madrid`. Lo que se manda vacío **quita** la
 * fecha, que es la única forma de reabrir después del cierre: con la fecha en el
 * pasado, encender el interruptor no abre nada.
 *
 * El valor llega ya convertido al `datetime-local` de Madrid
 * (`formatMadridLocalInstant`), calculado en la página: la conversión vive en
 * `@/lib/ranked-match`, que es `server-only` y no se puede importar desde un
 * componente de cliente.
 *
 * El resultado lo pinta `StatusLine`, la misma línea de estado de los demás
 * formularios del panel: el acierto en el gris de la casa y el fallo en el rojo
 * reservado a lo que hay que corregir.
 */
export function RegistrationDeadlineForm({ closesAt: initialClosesAt }: { closesAt: string }) {
  const [state, formAction, pending] = useActionState(setRegistrationClosesAt, initialState);
  const [closesAt, setClosesAt] = useState(initialClosesAt);

  return (
    <form action={formAction} className="rounded-lg border border-line bg-surface p-4">
      <TextField
        name="closesAt"
        label="Fecha de cierre (opcional)"
        type="datetime-local"
        value={closesAt}
        onChange={setClosesAt}
        hint="Fecha y hora local de Madrid; se guarda en UTC. Cuando llega, el plazo se cierra solo, sin tocar el interruptor. Déjalo vacío para quitar la fecha, que es lo que hace falta para reabrir después del cierre: volver a encender el interruptor no basta."
      />

      <div className="mt-4 flex flex-wrap items-center gap-4">
        <button
          type="submit"
          disabled={pending}
          className="h-10 rounded-md bg-accent px-4 text-sm font-semibold text-accent-ink transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? "Guardando…" : "Guardar la fecha de cierre"}
        </button>
        <StatusLine state={state} pending={pending} />
      </div>
    </form>
  );
}
