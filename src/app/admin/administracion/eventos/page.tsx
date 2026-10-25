import type { Metadata } from "next";
import Link from "next/link";
import { deleteEditionEvent } from "@/app/admin/administracion/eventos/actions";
import {
  EventForm,
  type EventFormValues,
} from "@/app/admin/administracion/eventos/event-form";
import { ActionFeedbackProvider } from "@/components/action-feedback";
import { ConfirmAction } from "@/components/confirm-action";
import { EmptyState } from "@/components/empty-state";
import {
  EDITION_EVENT_DESCRIPTION_MAX_LENGTH,
  EDITION_EVENT_NAME_MAX_LENGTH,
  MIN_EVENT_MULTIPLIER,
  editionEventsLocked,
  readEditionEvents,
  type EditionEvent,
} from "@/lib/edition-events";
import { formatEventWindow, formatMadridDateTime } from "@/lib/format";
import { formatMadridLocalInstant } from "@/lib/ranked-match";
import { readRuleset } from "@/lib/scoring";

export const metadata: Metadata = {
  title: { absolute: "Eventos · Admin" },
};

/** Los eventos por fecha de inicio: es el orden en que se leen y se juegan. */
function byStart(a: EditionEvent, b: EditionEvent): number {
  return new Date(a.from).getTime() - new Date(b.from).getTime();
}

/**
 * Subpestaña de eventos puntuales: el calendario con multiplicador.
 *
 * Un evento reparte un extra **solo sobre los puntos por victoria** y se define
 * antes de que empiece el torneo. Por eso la pantalla tiene dos estados: antes del
 * inicio, calendario editable y formulario; después, calendario en lectura y un
 * aviso que dice por qué. La comprobación de bloqueo se hace **también** en la
 * acción —una Server Action es un endpoint público—, así que este aviso es la
 * explicación, no la defensa.
 *
 * La edición vive en la URL (`?editar=<id>`), como los filtros del historial: así
 * el formulario se prellena en el servidor con las fechas de Madrid y recargar no
 * pierde qué se estaba editando. El `key` del formulario es el id del evento, para
 * que pasar de editar uno a crear otro —o a editar un tercero— monte estado nuevo
 * en vez de conservar los valores anteriores.
 *
 * Las dos lecturas van en paralelo: los eventos y el ruleset, del que sale la
 * ventana del torneo. Si alguna falla no se pinta un panel a medias: no se sabe qué
 * hay publicado ni si se puede tocar, así que se dice que no se ha podido leer.
 */
export default async function AdminEventsPage({
  searchParams,
}: PageProps<"/admin/administracion/eventos">) {
  const params = await searchParams;
  const editId = typeof params.editar === "string" ? params.editar : "";

  let events: EditionEvent[];
  let windowFrom: string;
  let windowTo: string | null;

  try {
    const [config, ruleset] = await Promise.all([readEditionEvents(), readRuleset()]);
    events = [...config.events].sort(byStart);
    windowFrom = ruleset.window.from;
    windowTo = ruleset.window.to;
  } catch {
    return (
      <section className="flex flex-col gap-6">
        <div>
          <h2 className="text-lg font-medium">Eventos</h2>
          <p className="mt-1 max-w-[70ch] text-sm text-muted">
            Las ventanas con multiplicador de puntos de esta edición.
          </p>
        </div>
        <EmptyState
          title="No se han podido leer los eventos"
          body="La base de datos no ha respondido. El calendario y su estado de bloqueo no se pueden comprobar, así que no se ofrece el formulario: vuelve a intentarlo en unos minutos."
        />
      </section>
    );
  }

  const locked = editionEventsLocked({ from: windowFrom, to: windowTo }, new Date());
  const windowStart = formatMadridDateTime(windowFrom);
  const editing = editId === "" ? null : (events.find((event) => event.id === editId) ?? null);
  const editNotFound = editId !== "" && editing === null;

  const formValues: EventFormValues | null =
    editing === null
      ? null
      : {
          id: editing.id,
          name: editing.name,
          description: editing.description ?? "",
          from: formatMadridLocalInstant(editing.from) ?? "",
          to: formatMadridLocalInstant(editing.to) ?? "",
          multiplier: String(editing.multiplier),
          discordRequired: editing.discordRequired,
        };

  return (
    <section className="flex flex-col gap-8">
      <div>
        <h2 className="text-lg font-medium">Eventos</h2>
        <p className="mt-1 max-w-[70ch] text-sm text-muted">
          Ventanas dentro del torneo en las que cada victoria clasificatoria paga un
          multiplicador. El extra se aplica solo a los puntos por victoria: las
          derrotas siguen sin sumar y los objetivos conservan su valor. Se definen
          antes de que empiece el torneo; el calendario se publica en Reglas y, cuando
          su ventana está en curso, el evento se anuncia en el banner de la web.
        </p>
      </div>

      {locked ? (
        <p className="max-w-[70ch] rounded-md border border-accent/30 bg-accent/5 px-4 py-3 text-sm leading-relaxed text-muted">
          <strong className="font-semibold text-foreground">
            Los eventos están cerrados
          </strong>
          . El torneo{" "}
          {windowStart !== null ? `empezó el ${windowStart}` : "ya ha empezado"} y,
          desde ese momento, cambiar una ventana movería puntos ya publicados. El
          calendario se ve aquí abajo en modo lectura.
        </p>
      ) : null}

      <div className="flex flex-col gap-4">
        <div>
          <h3 className="text-base font-medium">Calendario</h3>
          <p className="mt-1 max-w-[70ch] text-sm text-muted">
            De más antiguo a más reciente. Dos eventos no pueden compartir fechas y
            ninguno puede salirse de la ventana del torneo; si pasa, el guardado lo
            dice y no escribe nada.
          </p>
        </div>

        {events.length === 0 ? (
          <EmptyState
            title="Todavía no hay eventos"
            body={
              locked
                ? "Esta edición se ha quedado sin eventos puntuales. Una vez empezado el torneo, el calendario ya no se puede cambiar."
                : "Programa el primero con el formulario de abajo. Se publica en Reglas al guardarlo y se anuncia en el banner de la web cuando llega su ventana."
            }
          />
        ) : (
          <ActionFeedbackProvider>
            <ul className="flex flex-col gap-3">
              {events.map((event) => {
                const windowText = formatEventWindow(event);

                return (
                  <li
                    key={event.id}
                    className="rounded-lg border border-line bg-surface p-4"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
                      <div className="min-w-0">
                        <h4 className="text-base font-medium text-foreground">
                          {event.name}
                        </h4>
                        <p className="mt-1 text-sm text-muted">
                          {windowText ?? "Las fechas guardadas no se pueden leer."}
                        </p>
                      </div>

                      <p className="ml-auto shrink-0 font-display text-2xl font-semibold leading-none tabular-nums text-accent">
                        <span className="sr-only">Multiplicador </span>x{event.multiplier}
                      </p>
                    </div>

                    {event.description !== null ? (
                      <p className="mt-2 max-w-[70ch] text-sm leading-relaxed text-muted">
                        {event.description}
                      </p>
                    ) : null}

                    {event.discordRequired ? (
                      <p className="mt-3">
                        <span className="inline-block rounded-full border border-accent/40 px-2 py-0.5 text-xs text-accent">
                          Requiere Discord
                        </span>
                      </p>
                    ) : null}

                    {locked ? null : (
                      <div className="mt-3 flex flex-wrap justify-end gap-2 border-t border-line pt-3">
                        <Link
                          href={`/admin/administracion/eventos?editar=${encodeURIComponent(event.id)}#formulario`}
                          className="inline-flex h-10 items-center rounded-md border border-line-strong px-3 text-xs text-foreground transition-colors hover:border-accent/60 hover:text-accent"
                        >
                          Editar
                        </Link>

                        <ConfirmAction
                          action={deleteEditionEvent}
                          fields={{ id: event.id }}
                          title="Eliminar el evento"
                          body={
                            <>
                              Se quitará «{event.name}» del calendario y dejará de
                              repartir puntos. No se puede deshacer.
                            </>
                          }
                          triggerLabel="Eliminar"
                          triggerClassName="h-10 rounded-md border border-loss/40 px-3 text-xs text-loss transition-colors hover:bg-loss/10"
                          confirmLabel="Eliminar"
                          confirmPendingLabel="Eliminando…"
                          confirmClassName="bg-loss text-accent-ink hover:brightness-110"
                        />
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </ActionFeedbackProvider>
        )}
      </div>

      {locked ? null : (
        <div id="formulario" className="scroll-mt-24">
          <h3 className="text-base font-medium">
            {editing !== null ? "Editar el evento" : "Nuevo evento"}
          </h3>
          <p className="mt-1 max-w-[70ch] text-sm text-muted">
            {editing !== null
              ? "Los cambios se publican al guardar y la clasificación se recalcula con ellos."
              : "Las fechas se escriben en hora de Madrid. El multiplicador se aplica a las partidas que empiezan dentro de la ventana."}
          </p>

          {editNotFound ? (
            <p className="mt-3 max-w-[70ch] rounded-md border border-line bg-surface px-3 py-2 text-sm leading-relaxed text-muted">
              El evento que se quería editar ya no está en el calendario. El formulario
              de abajo crea uno nuevo.
            </p>
          ) : null}

          <div className="mt-3">
            <EventForm
              key={editing?.id ?? "nuevo"}
              event={formValues}
              nameMaxLength={EDITION_EVENT_NAME_MAX_LENGTH}
              descriptionMaxLength={EDITION_EVENT_DESCRIPTION_MAX_LENGTH}
              minMultiplier={MIN_EVENT_MULTIPLIER}
            />
          </div>
        </div>
      )}
    </section>
  );
}
