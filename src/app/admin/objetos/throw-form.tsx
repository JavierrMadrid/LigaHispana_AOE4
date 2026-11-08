"use client";

import { useActionState, useId } from "react";
import { useActionFeedback } from "@/components/action-feedback";
import { throwObjectAction } from "./actions";
import { INITIAL_THROW_OBJECT_STATE, type ObjectActionState } from "./state";
import { SubmitButton } from "./submit-button";

/** Un destino del desplegable: el id que viaja y lo que se lee. */
export type ThrowTargetOption = {
  playerId: string;
  name: string;
  /** Puesto en la clasificación; `null` si todavía no tiene fila. */
  rank: number | null;
};

type ThrowFormProps = {
  awardId: string;
  objectName: string;
  holderName: string;
  /** Destinos que hoy no están bloqueados, ya ordenados por puesto. */
  targets: ThrowTargetOption[];
  /** Nombres que ya recibieron este objeto hoy: la regla Y rechazaría el envío. */
  blockedNames: string[];
};

/**
 * Formulario de lanzamiento de un objeto.
 *
 * El fallo de la Server Action se pinta **tal cual llega** bajo el botón, y el
 * éxito se publica en la banda del panel: al revalidar, un lanzamiento devuelto
 * sustituye este formulario por la explicación de la regla, así que el mensaje
 * del servicio necesita un sitio que sobreviva al refresco. La página decide qué
 * se ofrece; aquí solo queda elegir destino y enviar.
 *
 * El destino va ordenado por puesto y quien no tiene fila queda al final; el
 * desplegable lo muestra para que se vea de un vistazo a quién se lanza.
 */
export function ThrowForm({
  awardId,
  objectName,
  holderName,
  targets,
  blockedNames,
}: ThrowFormProps) {
  const report = useActionFeedback();
  const [state, formAction] = useActionState(runAction, INITIAL_THROW_OBJECT_STATE);
  const selectId = useId();
  const hintId = `${selectId}-hint`;

  /**
   * El éxito se publica en la banda del panel y no solo bajo el botón: tras un
   * lanzamiento la ruta se revalida, y si la tirada se devuelve el formulario se
   * sustituye por la explicación de la regla. Sin la banda, el mensaje del
   * servicio desaparecería con él. El error se queda aquí, al lado del botón.
   */
  async function runAction(
    previous: ObjectActionState,
    formData: FormData,
  ): Promise<ObjectActionState> {
    const result = await throwObjectAction(previous, formData);

    if (result.ok && result.message !== "") {
      report({ tone: "success", message: result.message });
    }

    return result;
  }

  return (
    <form
      action={formAction}
      aria-label={`Lanzar ${objectName}`}
      className="mt-3 flex flex-col gap-3"
    >
      <input type="hidden" name="awardId" value={awardId} />

      <div className="flex flex-col gap-1.5">
        <label htmlFor={selectId} className="text-sm text-muted">
          Jugador de destino
        </label>
        <select
          id={selectId}
          name="toId"
          defaultValue=""
          required
          aria-describedby={hintId}
          className="h-10 w-full rounded-md border border-line bg-background px-3 text-foreground"
        >
          <option value="" disabled>
            Elige un jugador
          </option>
          {targets.map((target) => (
            <option key={target.playerId} value={target.playerId}>
              {target.rank === null
                ? `Sin puesto · ${target.name}`
                : `${target.rank}.º · ${target.name}`}
            </option>
          ))}
        </select>
        <p id={hintId} className="max-w-[60ch] text-xs leading-relaxed text-muted">
          La tirada decide si se devuelve: cuanto peor clasificado esté el destino
          respecto a {holderName}, más probable es que el objeto vuelva.
        </p>
      </div>

      {blockedNames.length > 0 ? (
        <p className="max-w-[60ch] text-xs leading-relaxed text-muted">
          Ya lo recibieron hoy: {blockedNames.join(", ")}. No pueden repetir hasta
          que cambie el día UTC.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <SubmitButton idleLabel="Lanzar" pendingLabel="Lanzando…" />
        <p
          role="status"
          aria-live="polite"
          className={`max-w-[60ch] text-sm leading-relaxed ${
            state.ok ? "text-muted" : "text-loss"
          }`}
        >
          {state.ok ? "" : state.message}
        </p>
      </div>
    </form>
  );
}
