import type { Metadata } from "next";
import Link from "next/link";
import { deleteEditionEvent } from "@/app/admin/administracion/eventos/actions";
import {
  EventForm,
  type EventFormValues,
} from "@/app/admin/administracion/eventos/event-form";
import { AdminPageHeader } from "@/components/admin/page-header";
import { Callout } from "@/components/admin/callout";
import { SectionCard } from "@/components/admin/section";
import { StatusPill } from "@/components/admin/status-pill";
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
 *
 * El calendario es una tarjeta con una fila por evento, no una tarjeta por evento:
 * un evento dentro de otra caja sería una caja dentro de una caja, y aquí lo que
 * separa es el filete.
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
      <div className="flex flex-col gap-6">
        <AdminPageHeader
          level={2}
          title="Eventos"
          description="Ventanas con multiplicador para las victorias clasificatorias."
        />
        <EmptyState
          title="No se han podido leer los eventos"
          body="La base de datos no ha respondido. El calendario y su estado de bloqueo no se pueden comprobar, así que no se ofrece el formulario. Vuelve a intentarlo en unos minutos."
        />
      </div>
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
    <div className="flex flex-col gap-6">
      <AdminPageHeader
        level={2}
        title="Eventos"
        description="Ventanas con multiplicador para las victorias clasificatorias."
      />

      {locked ? (
        <Callout tone="locked" title="Los eventos están cerrados">
          El torneo{" "}
          {windowStart !== null ? `empezó el ${windowStart}` : "ya ha empezado"} y
          cambiar una ventana movería puntos ya publicados. El calendario se ve aquí
          abajo en modo lectura.
        </Callout>
      ) : null}

      {events.length === 0 ? (
        <EmptyState
          title="Todavía no hay eventos"
          body={
            locked
              ? "Esta edición se ha quedado sin eventos puntuales. Una vez empezado el torneo, el calendario ya no se puede cambiar."
              : "Programa el primero con el formulario de abajo; se publica en Reglas al guardarlo."
          }
        />
      ) : (
        <SectionCard
          title="Calendario"
          description="Dos eventos no pueden solaparse ni salirse de la ventana; van de más antiguo a más reciente."
        >
          <ActionFeedbackProvider>
            <ul className="divide-y divide-line">
              {events.map((event) => {
                const windowText = formatEventWindow(event);

                return (
                  <li key={event.id} className="py-4 first:pt-0 last:pb-0">
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
                        <StatusPill active>Requiere Discord</StatusPill>
                      </p>
                    ) : null}

                    {locked ? null : (
                      <div className="mt-3 flex flex-wrap justify-end gap-2">
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
        </SectionCard>
      )}

      {locked ? null : (
        <div id="formulario" className="flex scroll-mt-24 flex-col gap-4">
          {editNotFound ? (
            <Callout tone="info">
              El evento que se quería editar ya no está en el calendario. El formulario
              de abajo crea uno nuevo.
            </Callout>
          ) : null}

          <EventForm
            key={editing?.id ?? "nuevo"}
            event={formValues}
            nameMaxLength={EDITION_EVENT_NAME_MAX_LENGTH}
            descriptionMaxLength={EDITION_EVENT_DESCRIPTION_MAX_LENGTH}
            minMultiplier={MIN_EVENT_MULTIPLIER}
          />
        </div>
      )}
    </div>
  );
}
