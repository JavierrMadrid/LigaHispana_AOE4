import { PendingButton } from "@/components/pending-button";
import { setRegistrationOpen } from "./actions";

/**
 * Interruptor del plazo de inscripción del torneo.
 *
 * Es la cara visible de `Setting["registration.open"]`: el mismo booleano que
 * aplica el servidor en el envío público (`registerPlayer`) y en el alta de este
 * panel (`createPlayer`). Aquí no decide nada por su cuenta; solo publica el
 * estado y ofrece el cambio.
 *
 * El botón **nombra el cambio, no el estado**: con el plazo abierto dice "Cerrar
 * inscripciones" y con el cerrado "Abrir inscripciones", y el campo oculto lleva
 * el valor contrario al actual. Un botón que dijera el estado ("Abiertas") se
 * leería como una etiqueta y no como la acción disponible.
 *
 * El estado se marca con la píldora del dialecto del panel —oro para el plazo
 * abierto, filete neutro para el cerrado—, la misma forma que las etiquetas de
 * modo del resto de la casa. En cada estado hay un solo elemento dorado: la
 * píldora cuando está abierto, y el botón cuando está cerrado, que es cuando
 * abrir es la acción constructiva que hay que destacar.
 *
 * Es un componente de servidor: el `<form>` apunta a la Server Action y el
 * estado pendiente lo aporta `PendingButton` (`useFormStatus`), sin necesidad de
 * un componente de cliente propio. Tras escribir, la acción revalida `/admin` y
 * `/participar`, así que el estado que se lee aquí se refresca solo.
 */
export function RegistrationSwitch({ open }: { open: boolean }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-line bg-surface px-5 py-4">
      <div className="flex min-w-0 items-center gap-3">
        <span
          className={`inline-block shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium ${
            open ? "border-accent/40 text-accent" : "border-line-strong text-muted"
          }`}
        >
          {open ? "Abiertas" : "Cerradas"}
        </span>
        <p className="min-w-0 text-sm leading-relaxed text-muted">
          {open
            ? "Se admiten solicitudes nuevas desde la web y altas desde este panel."
            : "No se admiten solicitudes nuevas ni altas. Las ya recibidas se siguen pudiendo aprobar o rechazar."}
        </p>
      </div>

      <form action={setRegistrationOpen} className="shrink-0">
        <input type="hidden" name="open" value={open ? "false" : "true"} />
        <PendingButton
          pendingLabel="Aplicando…"
          className={
            open
              ? "h-10 rounded-md border border-line-strong px-4 text-sm text-foreground transition-colors hover:border-accent/50 hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
              : "h-10 rounded-md bg-accent px-4 text-sm font-semibold text-accent-ink transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-60"
          }
        >
          {open ? "Cerrar inscripciones" : "Abrir inscripciones"}
        </PendingButton>
      </form>
    </div>
  );
}
