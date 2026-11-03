"use client";

import { useActionState, useEffect, useState } from "react";
import type { AdminActionResult } from "@/app/admin/actions";
import { saveTournamentWindow } from "../actions";
import { StatusLine, TextField } from "../fields";

const initialState: AdminActionResult = { status: "idle", message: null };

type WindowFormProps = {
  /**
   * Los dos límites de la ventana ya convertidos al `datetime-local` de Madrid
   * (`formatMadridLocalInstant`). Vienen del servidor y no se calculan aquí: la
   * conversión vive en `@/lib/ranked-match`, que es `server-only` y no se puede
   * importar desde un componente de cliente. Llegan otra vez con cada render del
   * servidor, y el formulario los vuelve a adoptar: es lo que devuelve su valor a
   * los campos después de guardar.
   *
   * `windowFrom` es, además, la referencia con la que se decide si se está empezando
   * otra edición: el campo se compara contra este texto guardado.
   */
  windowFrom: string;
  windowTo: string;
  /**
   * ¿Está la edición **en marcha** (empezada y sin terminar)? Lo decide el servidor con
   * `editionStarted()` y `editionEnded()`, que son `server-only`. Mientras lo esté, la
   * acción solo admite el fin, así que la fecha de inicio se pinta como dato y **no
   * viaja** como campo: la acción rechaza el envío entero en cuanto ve un `windowFrom`,
   * aunque lleve el valor que ya estaba.
   */
  locked: boolean;
  /**
   * ¿Terminó ya la edición guardada? Con la ventana cerrada el torneo no reparte puntos
   * y la acción vuelve a admitir las dos fechas, pero mover el inicio **empieza una
   * edición nueva**: recalcula la clasificación y la anterior deja de mostrarse en la web,
   * así que se pide confirmación explícita (`confirmNewEdition`).
   */
  previousEnded: boolean;
};

/**
 * Las fechas de la ventana del torneo, en el estado que toque.
 *
 * Son dos formularios distintos, no uno con campos deshabilitados: con la edición en
 * marcha la acción rechaza **cualquier** envío que traiga la fecha de inicio, aunque
 * lleve el valor que ya estaba, así que un campo deshabilitado no basta —
 * deshabilitado no viaja, pero un `readonly` sí—. Cada estado monta sus propios hooks
 * dentro de su componente, y este despachador no tiene ninguno: así no hay forma de
 * que cambie el orden en que se llaman.
 *
 * Los tres estados de la ventana son: no empezada (todo editable, sin confirmación),
 * activa (`locked`: solo el fin) y terminada (`previousEnded`: todo editable, con
 * confirmación si se mueve el inicio para arrancar la siguiente edición).
 *
 * La fecha congelada no se enseña aquí sino en la página, que es quien tiene el instante
 * de Madrid ya formateado (`formatMadridDateTime`); este formulario solo recibe lo que
 * se escribe en un `datetime-local`.
 */
export function WindowForm({ locked, ...props }: WindowFormProps) {
  return locked ? <LockedWindowForm {...props} /> : <EditableWindowForm {...props} />;
}

type WindowFormStateProps = Omit<WindowFormProps, "locked">;

/**
 * Las dos fechas editables: la edición no ha empezado, o la anterior ya terminó.
 *
 * El inicio es obligatorio —sin él no hay corte desde el que contar— y el fin
 * opcional: vacío significa ventana abierta por la derecha, que es como se empieza el
 * torneo y como se fija el fin más adelante. Los dos campos son `datetime-local` sin
 * zona y el servidor los interpreta en `Europe/Madrid`.
 *
 * Con la edición anterior terminada, mover el inicio empieza una edición nueva y la
 * acción lo exige confirmado: el botón queda deshabilitado hasta marcar la casilla, y
 * solo mientras el campo difiera de lo guardado. Comparar es barato y el criterio es el
 * mismo que aplica el servidor, que además normaliza los dos instantes por su cuenta.
 */
function EditableWindowForm({
  windowFrom: serverWindowFrom,
  windowTo: serverWindowTo,
  previousEnded,
}: WindowFormStateProps) {
  const [state, formAction, pending] = useActionState(saveTournamentWindow, initialState);
  const [windowFrom, setWindowFrom] = useState(serverWindowFrom);
  const [windowTo, setWindowTo] = useState(serverWindowTo);
  const [confirmNewEdition, setConfirmNewEdition] = useState(false);

  // React resetea los campos cuando una Server Action termina: los controlados vuelven
  // al valor con el que se montaron y, como el estado del cliente no cambia, ningún
  // render los devuelve a su sitio —hasta recargar se ve lo anterior a lo que se acaba
  // de guardar—. Adoptar lo que manda el servidor es ese render: el estado no deriva de
  // otro estado, es el mismo dato del servidor, y por eso se silencia la regla. La
  // confirmación se limpia en el mismo gesto: la edición nueva que se acaba de guardar ya
  // no es una decisión pendiente.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reaplica al DOM las fechas que el servidor acaba de guardar
    setWindowFrom(serverWindowFrom);
    setWindowTo(serverWindowTo);
    setConfirmNewEdition(false);
  }, [serverWindowFrom, serverWindowTo]);

  // Devolver el inicio a su sitio deshace la decisión: la casilla se oculta y se
  // desmarca en el mismo gesto, para que volver a moverlo no aparezca ya confirmado.
  function handleWindowFromChange(value: string) {
    setWindowFrom(value);

    if (value === serverWindowFrom) {
      setConfirmNewEdition(false);
    }
  }

  const startsNewEdition = previousEnded && windowFrom !== serverWindowFrom;
  const canSave = !startsNewEdition || confirmNewEdition;

  return (
    <form action={formAction} className="rounded-lg border border-line bg-surface p-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          name="windowFrom"
          label="Inicio de la ventana"
          type="datetime-local"
          value={windowFrom}
          onChange={handleWindowFromChange}
          hint="Fecha y hora local de Madrid; se guarda en UTC. Cuenta la partida que empezó a partir de aquí."
          required
        />

        <TextField
          name="windowTo"
          label="Fin de la ventana (opcional)"
          type="datetime-local"
          value={windowTo}
          onChange={setWindowTo}
          hint="Fecha y hora local de Madrid, exclusiva; se guarda en UTC. Déjalo vacío para una ventana abierta: el fin se fija más tarde sin tocar nada más."
        />
      </div>

      {previousEnded ? (
        <div className="mt-4 rounded-md border border-accent/30 bg-accent/5 px-4 py-3">
          <p className="max-w-[70ch] text-sm leading-relaxed text-muted">
            <strong className="font-semibold text-foreground">
              Esta ventana ya ha terminado
            </strong>
            .{" "}
            {startsNewEdition
              ? "Al mover el inicio empiezas una edición nueva: la clasificación se recalcula y la anterior deja de mostrarse en la web. Confírmalo para poder guardar."
              : "Guardar solo el fin no empieza ninguna edición nueva. Si mueves el inicio, la anterior deja de mostrarse en la web y tendrás que confirmarlo."}
          </p>

          {startsNewEdition ? (
            <label className="mt-3 flex max-w-[70ch] items-start gap-2 text-sm">
              <input
                type="checkbox"
                name="confirmNewEdition"
                value="true"
                checked={confirmNewEdition}
                onChange={(event) => setConfirmNewEdition(event.target.checked)}
                className="mt-0.5 size-4 shrink-0 rounded border-line bg-background accent-accent"
              />
              <span className="text-foreground">
                Entiendo que al mover el inicio empiezo una edición nueva y que la
                clasificación se recalculará.
              </span>
            </label>
          ) : null}
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-4">
        <button
          type="submit"
          disabled={pending || !canSave}
          className="h-10 rounded-md bg-accent px-4 text-sm font-semibold text-accent-ink transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? "Guardando…" : "Guardar las fechas"}
        </button>
        <StatusLine state={state} pending={pending} />
      </div>

      {canSave ? null : (
        <p className="mt-2 max-w-[70ch] text-xs leading-relaxed text-muted">
          Marca la confirmación de edición nueva para poder guardar, o deja el inicio
          como está si solo querías mover el fin.
        </p>
      )}
    </form>
  );
}

type LockedWindowFormProps = WindowFormStateProps;

/**
 * El fin de la ventana con la edición **en marcha**: el **único** ajuste de fechas que
 * queda vivo.
 *
 * El formulario **no manda** el inicio —ni como campo oculto, ni como `readonly`—: la
 * acción rechaza el envío entero en cuanto ve un `windowFrom` (ver
 * `touchesLockedRulesetFields()` en `actions.ts`). Tampoco manda `confirmNewEdition`:
 * con el torneo en marcha no se empieza ninguna edición, solo se cierra. La fecha
 * congelada se enseña en la página, como dato de lectura.
 *
 * Vaciar el campo deja la ventana **abierta** por la derecha, que es lo que permite
 * reabrir una edición cerrada antes de tiempo: el mismo gesto que en el formulario
 * editable, con el mismo significado.
 */
function LockedWindowForm({ windowTo: serverWindowTo }: LockedWindowFormProps) {
  const [state, formAction, pending] = useActionState(saveTournamentWindow, initialState);
  const [windowTo, setWindowTo] = useState(serverWindowTo);

  // El `to` vuelve al campo después de guardar, igual que en el formulario editable:
  // React resetea los controlados al terminar la acción y este render los devuelve.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reaplica al DOM el fin que el servidor acaba de guardar
    setWindowTo(serverWindowTo);
  }, [serverWindowTo]);

  return (
    <form action={formAction} className="rounded-lg border border-line bg-surface p-4">
      <div className="max-w-md">
        <TextField
          name="windowTo"
          label="Fin de la ventana (opcional)"
          type="datetime-local"
          value={windowTo}
          onChange={setWindowTo}
          hint="Fecha y hora local de Madrid, exclusiva; se guarda en UTC. Déjalo vacío para dejar la ventana sin fin: las partidas posteriores vuelven a contar."
        />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-4">
        <button
          type="submit"
          disabled={pending}
          className="h-10 rounded-md bg-accent px-4 text-sm font-semibold text-accent-ink transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? "Guardando…" : "Guardar el fin de la ventana"}
        </button>
        <StatusLine state={state} pending={pending} />
      </div>
    </form>
  );
}
