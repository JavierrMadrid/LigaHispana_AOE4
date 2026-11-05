"use client";

import { useActionState, useEffect, useState } from "react";
import type { AdminActionResult } from "@/app/admin/actions";
import { Callout } from "@/components/admin/callout";
import { FieldGrid } from "@/components/admin/field-grid";
import { SectionCard } from "@/components/admin/section";
import { StatusPill } from "@/components/admin/status-pill";
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
  /** Inicio de la ventana en hora de Madrid, ya formateado, o `null` si no se puede leer. */
  windowStartLabel: string | null;
  /** Fin de la ventana en hora de Madrid, ya formateado, o `null` si no se puede leer. */
  windowEndLabel: string | null;
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
 * La tarjeta es del formulario y no de la página porque el guardado vive en su pie:
 * así no hay dos maneras de pintar el mismo botón. La fecha congelada no se enseña
 * aquí sino en el aviso, que la recibe ya formateada de la página.
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
  windowEndLabel,
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
    <form action={formAction}>
      <SectionCard
        title="Ventana del torneo"
        description="Cuentan las partidas que empezaron dentro de estas fechas."
        actions={
          <StatusPill active={false}>{previousEnded ? "Terminada" : "Sin empezar"}</StatusPill>
        }
        footer={
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-4">
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
              <p className="text-xs leading-relaxed text-muted">
                Marca la confirmación de edición nueva para poder guardar, o deja el
                inicio como está si solo querías mover el fin.
              </p>
            )}
          </div>
        }
      >
        {previousEnded ? (
          <Callout tone="locked" title="La edición anterior ha terminado">
            <p>
              {windowEndLabel !== null
                ? `Terminó el ${windowEndLabel}`
                : "La ventana ya tiene un fin pasado"}{" "}
              y desde entonces no reparte puntos. Mover el inicio empieza una edición
              nueva: la clasificación se recalcula y la anterior deja de mostrarse en la
              web.
            </p>

            {startsNewEdition ? (
              <label className="mt-3 flex items-start gap-2 text-sm text-foreground">
                <input
                  type="checkbox"
                  name="confirmNewEdition"
                  value="true"
                  checked={confirmNewEdition}
                  onChange={(event) => setConfirmNewEdition(event.target.checked)}
                  className="mt-0.5 size-4 shrink-0 rounded border-line bg-background accent-accent"
                />
                <span>
                  Entiendo que al mover el inicio empiezo una edición nueva y que la
                  clasificación se recalculará.
                </span>
              </label>
            ) : null}
          </Callout>
        ) : null}

        <FieldGrid className={previousEnded ? "mt-4" : undefined}>
          <TextField
            name="windowFrom"
            label="Inicio"
            type="datetime-local"
            value={windowFrom}
            onChange={handleWindowFromChange}
            hint="Hora de Madrid. Cuenta la partida que empezó a partir de aquí."
            required
          />

          <TextField
            name="windowTo"
            label="Fin (opcional)"
            type="datetime-local"
            value={windowTo}
            onChange={setWindowTo}
            hint="Hora de Madrid; el fin no entra. Vacío deja la ventana abierta."
          />
        </FieldGrid>
      </SectionCard>
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
 * congelada se enseña en el aviso, como dato de lectura.
 *
 * Vaciar el campo deja la ventana **abierta** por la derecha, que es lo que permite
 * reabrir una edición cerrada antes de tiempo: el mismo gesto que en el formulario
 * editable, con el mismo significado.
 */
function LockedWindowForm({ windowTo: serverWindowTo, windowStartLabel }: LockedWindowFormProps) {
  const [state, formAction, pending] = useActionState(saveTournamentWindow, initialState);
  const [windowTo, setWindowTo] = useState(serverWindowTo);

  // El `to` vuelve al campo después de guardar, igual que en el formulario editable:
  // React resetea los controlados al terminar la acción y este render los devuelve.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reaplica al DOM el fin que el servidor acaba de guardar
    setWindowTo(serverWindowTo);
  }, [serverWindowTo]);

  return (
    <form action={formAction}>
      <SectionCard
        title="Ventana del torneo"
        description="Cuentan las partidas que empezaron dentro de estas fechas."
        actions={<StatusPill active>En marcha</StatusPill>}
        footer={
          <div className="flex flex-wrap items-center gap-4">
            <button
              type="submit"
              disabled={pending}
              className="h-10 rounded-md bg-accent px-4 text-sm font-semibold text-accent-ink transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-60"
            >
              {pending ? "Guardando…" : "Guardar el fin"}
            </button>
            <StatusLine state={state} pending={pending} />
          </div>
        }
      >
        <Callout tone="locked" title="El inicio está congelado">
          {windowStartLabel !== null
            ? `La edición empezó el ${windowStartLabel}`
            : "La edición ya ha empezado"}{" "}
          y moverlo cambiaría el corte de las partidas publicadas. Solo se puede fijar,
          mover o vaciar el fin.
        </Callout>

        <div className="mt-4 max-w-md">
          <TextField
            name="windowTo"
            label="Fin (opcional)"
            type="datetime-local"
            value={windowTo}
            onChange={setWindowTo}
            hint="Hora de Madrid; el fin no entra. Vacío deja la ventana sin fin."
          />
        </div>
      </SectionCard>
    </form>
  );
}
