import Link from "next/link";
import { activeEditionEvent, type EditionEvent } from "@/lib/edition-events";
import { formatEventWindow } from "@/lib/format";

/**
 * Aviso del evento puntual que está en curso, en lo alto de la web pública.
 *
 * Es el hermano urgente de `DonationBanner` y comparte su sitio: por encima de la
 * cabecera y **fuera de su `sticky`**, en el flujo normal, para que al desplazar la
 * cabecera se pegue al borde superior y el aviso, que ya ha subido, no la tape. Va
 * a ancho de cabecera (`max-w-[86rem]`) para alinear sus bordes con el emblema y
 * las acciones, y por delante del de donaciones: un multiplicador que se juega hoy
 * es más urgente que una invitación.
 *
 * El componente decide por sí mismo si pinta algo: de la lista que recibe toma el
 * evento que contiene el instante actual (`activeEditionEvent`). Si no hay ninguno
 * activo devuelve `null`; un banner vacío dejaría una franja de tinte sin contenido.
 * La lectura degradada ya la descarta el layout.
 *
 * La banda entera es un enlace a la sección de eventos de Reglas, que es donde está
 * el calendario completo con las instrucciones de cada ventana. El tinte es más
 * intenso que el de donaciones (`accent/10` frente a `accent/5`) porque esto no es
 * una invitación: es una condición que cambia cuánto paga cada victoria mientras
 * dura. El oro se queda en el multiplicador; el nombre va en el color del texto y
 * el resto en `muted`, para que la cifra sea lo primero que se lee.
 */
export function EventBanner({ events }: { events: readonly EditionEvent[] }) {
  const event = activeEditionEvent(events, new Date());

  if (event === null) {
    return null;
  }

  const windowText = formatEventWindow(event);

  return (
    <div className="thread-bottom relative border-b border-accent/30 bg-accent/10">
      <Link
        href="/reglas#eventos"
        className="group mx-auto flex w-full max-w-[86rem] flex-col items-center gap-y-1 px-4 py-2 text-center text-sm transition-colors hover:bg-accent/5 sm:flex-row sm:flex-wrap sm:justify-center sm:gap-x-3 sm:px-6"
      >
        {/* El multiplicador y el nombre son la primera línea en móvil: es lo que
            hay que saber de un vistazo. Las fechas y el requisito bajan a la
            segunda, que es más larga y puede envolver sin romper el aviso. */}
        <span className="flex items-baseline gap-2">
          <span className="font-display text-xl font-semibold leading-none tabular-nums text-accent">
            <span className="sr-only">Multiplicador </span>x{event.multiplier}
          </span>

          <span className="font-medium text-foreground group-hover:text-accent-strong">
            {event.name}
          </span>
        </span>

        {windowText !== null || event.discordRequired ? (
          <span className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-xs text-muted sm:text-sm">
            <span aria-hidden="true" className="hidden sm:inline">
              ·
            </span>

            {windowText !== null ? <span>{windowText}</span> : null}

            {event.discordRequired ? (
              <span className="rounded-full border border-line-strong px-2 py-0.5 text-xs text-muted">
                Solo participantes en Discord
              </span>
            ) : null}
          </span>
        ) : null}
      </Link>
    </div>
  );
}
