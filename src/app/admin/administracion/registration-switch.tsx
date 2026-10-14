import { PendingButton } from "@/components/pending-button";
import { setRegistrationOpen } from "@/app/admin/actions";
import type { RegistrationClosureReason } from "@/lib/registration-open";

/**
 * El motivo del estado, en una frase: la píldora dice si se puede inscribir y esto,
 * por qué. Los tres textos nombran **qué mando** manda —el interruptor o la
 * fecha—, porque con el plazo cerrado la pregunta que sigue es cómo reabrirlo, y
 * no se reabre igual en los dos casos.
 */
const REASON_TEXT: Record<RegistrationClosureReason, string> = {
  open: "Se admiten solicitudes nuevas desde la web y altas desde este panel.",
  switch:
    "Cerradas por el interruptor manual: no se admiten solicitudes nuevas ni altas desde la web ni desde este panel.",
  deadline:
    "Cerradas por la fecha de cierre, que ya ha pasado: aunque el interruptor siga encendido, no se admiten solicitudes nuevas ni altas. Para reabrirlas hay que quitar o mover la fecha.",
};

/**
 * El estado del plazo y su **interruptor manual**.
 *
 * El interruptor es la cara visible de `Setting["registration.open"]`: el mismo
 * booleano que aplica el servidor en el envío público (`registerPlayer`) y en el
 * alta de este panel (`createPlayer`). Aquí no decide nada por su cuenta; solo
 * publica el estado y ofrece el cambio. Vive en la subpestaña **Inscripciones** de
 * Administración, junto a la fecha de cierre automático
 * (`RegistrationDeadlineForm`), que es el otro mando del mismo plazo.
 *
 * ## La píldora enseña el estado **efectivo**, no el interruptor
 *
 * Con la fecha de cierre ya pasada el plazo está cerrado aunque el interruptor
 * siga encendido, así que pintar el interruptor como estado diría "Abiertas"
 * cuando no se admite nada: `reason` (`open` | `switch` | `deadline`) decide la
 * píldora y el motivo que se lee a su lado, y el motivo nombra **qué mando** ha
 * cerrado el plazo, que es lo que hay que saber para reabrirlo.
 *
 * El botón, en cambio, sigue operando el interruptor **tal cual** (`switchOpen`),
 * que es lo que la acción compara para decidir si hay cambio: con la fecha pasada
 * el estado efectivo está cerrado y el interruptor encendido a la vez, y comparar
 * el efectivo reescribiría un cambio que nadie ha hecho.
 *
 * El botón **nombra el cambio, no el estado**: con el interruptor encendido dice
 * "Cerrar inscripciones" y con el apagado "Abrir inscripciones", y el campo oculto
 * lleva el valor contrario al actual. Un botón que dijera el estado ("Abiertas") se
 * leería como una etiqueta y no como la acción disponible.
 *
 * El estado se marca con la píldora del dialecto del panel —oro para el plazo
 * abierto, filete neutro para el cerrado—, la misma forma que las etiquetas de
 * modo del resto de la casa y que el banner de donaciones. En cada estado hay un
 * solo elemento dorado: la píldora cuando está abierto, y el botón cuando está
 * cerrado, que es cuando abrir es la acción constructiva que hay que destacar.
 *
 * Es un componente de servidor: el `<form>` apunta a la Server Action y el
 * estado pendiente lo aporta `PendingButton` (`useFormStatus`), sin necesidad de
 * un componente de cliente propio. Tras escribir, la acción revalida
 * `/admin/administracion/inscripciones`, `/admin` y `/participar`, así que el
 * estado que se lee aquí se refresca solo.
 */
export function RegistrationSwitch({
  switchOpen,
  reason,
}: {
  /** El **interruptor manual** tal cual, sin aplicar la fecha. */
  switchOpen: boolean;
  /** Por qué está el plazo como está: decide la píldora y el motivo de al lado. */
  reason: RegistrationClosureReason;
}) {
  const effectiveOpen = reason === "open";

  return (
    <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-line bg-surface px-5 py-4">
      <div className="flex min-w-0 items-center gap-3">
        <span
          className={`inline-block shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium ${
            effectiveOpen ? "border-accent/40 text-accent" : "border-line-strong text-muted"
          }`}
        >
          {effectiveOpen ? "Abiertas" : "Cerradas"}
        </span>
        <p className="min-w-0 text-sm leading-relaxed text-muted">{REASON_TEXT[reason]}</p>
      </div>

      <form action={setRegistrationOpen} className="shrink-0">
        <input type="hidden" name="open" value={switchOpen ? "false" : "true"} />
        <PendingButton
          pendingLabel="Aplicando…"
          className={
            switchOpen
              ? "h-10 rounded-md border border-line-strong px-4 text-sm text-foreground transition-colors hover:border-accent/50 hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
              : "h-10 rounded-md bg-accent px-4 text-sm font-semibold text-accent-ink transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-60"
          }
        >
          {switchOpen ? "Cerrar inscripciones" : "Abrir inscripciones"}
        </PendingButton>
      </form>
    </div>
  );
}
