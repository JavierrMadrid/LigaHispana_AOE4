"use client";

import { useActionState, useId } from "react";
import { useActionFeedback } from "@/components/action-feedback";
import { fulfillObjectAction } from "./actions";
import { INITIAL_FULFILL_OBJECT_STATE, type ObjectActionState } from "./state";
import { SubmitButton } from "./submit-button";

/** Una partida del portador, con su etiqueta ya montada en el servidor. */
export type FulfillMatchOption = {
  matchId: string;
  label: string;
};

type FulfillFormProps = {
  awardId: string;
  objectName: string;
  matches: FulfillMatchOption[];
};

/**
 * Formulario para dar la desventaja por cumplida sobre una partida concreta.
 *
 * La lista solo trae partidas del portador empezadas después de recibir el
 * objeto, que son las que el servicio acepta; la etiqueta de cada una lleva
 * fecha, rival, mapa, resultado y si la partida cuenta o está excluida. El aviso
 * de debajo del desplegable es la consecuencia exacta del cierre: la partida
 * elegida y las posteriores vuelven a puntuar, las anteriores no.
 *
 * El fallo se pinta tal cual llega bajo el botón; el éxito va a la banda del
 * panel, porque al revalidar la tarjeta deja de estar pendiente y desaparece.
 */
export function FulfillForm({ awardId, objectName, matches }: FulfillFormProps) {
  const report = useActionFeedback();
  const [state, formAction] = useActionState(runAction, INITIAL_FULFILL_OBJECT_STATE);
  const selectId = useId();
  const hintId = `${selectId}-hint`;

  /**
   * Al cumplirse, el objeto deja de estar pendiente y su tarjeta desaparece del
   * listado en el mismo refresco que trae la respuesta. El éxito va a la banda
   * que sobrevive al refresco; el error se queda bajo el botón, que es donde se
   * está mirando cuando falla.
   */
  async function runAction(
    previous: ObjectActionState,
    formData: FormData,
  ): Promise<ObjectActionState> {
    const result = await fulfillObjectAction(previous, formData);

    if (result.ok && result.message !== "") {
      report({ tone: "success", message: result.message });
    }

    return result;
  }

  return (
    <form
      action={formAction}
      aria-label={`Dar por cumplida la desventaja de ${objectName}`}
      className="mt-3 flex flex-col gap-3"
    >
      <input type="hidden" name="awardId" value={awardId} />

      <div className="flex flex-col gap-1.5">
        <label htmlFor={selectId} className="text-sm text-muted">
          Partida con la que se cumple
        </label>
        <select
          id={selectId}
          name="matchId"
          defaultValue=""
          required
          aria-describedby={hintId}
          className="h-10 w-full rounded-md border border-line bg-background px-3 text-foreground"
        >
          <option value="" disabled>
            Elige la partida
          </option>
          {matches.map((match) => (
            <option key={match.matchId} value={match.matchId}>
              {match.label}
            </option>
          ))}
        </select>
        <p id={hintId} className="max-w-[60ch] text-xs leading-relaxed text-muted">
          Solo aparecen las partidas del portador empezadas después de recibir el
          objeto. La que elijas y las posteriores vuelven a puntuar; las anteriores
          siguen sin puntuar.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <SubmitButton idleLabel="Dar por cumplida" pendingLabel="Guardando…" />
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
