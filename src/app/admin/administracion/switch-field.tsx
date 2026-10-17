"use client";

import { useId } from "react";

type SwitchFieldProps = {
  /** Nombre del campo oculto que viaja con el formulario (`"true"`/`"false"`). */
  name: string;
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
};

/**
 * Interruptor de un ajuste booleano del panel.
 *
 * Es el mismo control que el del plazo de inscripción y el del banner de
 * donaciones: un botón `role="switch"` que solo mueve el estado del cliente y un
 * campo oculto que lleva el valor real al formulario, porque el contrato de las
 * acciones lee `"true"`/`"false"` y un campo ausente cuenta como apagado —el
 * estado seguro—.
 *
 * Se extrae a un componente porque la pestaña de administración tiene dos
 * ajustes de este tipo (retransmisión obligatoria y civilizaciones aleatorias) y
 * los dos tienen que verse y comportarse igual. El nombre accesible lo da la
 * etiqueta visible enlazada con `aria-labelledby`, no un `aria-label` suelto.
 */
export function SwitchField({ name, label, hint, checked, onChange }: SwitchFieldProps) {
  const labelId = useId();
  const hintId = hint !== undefined ? `${labelId}-hint` : undefined;

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 rounded-md border border-line bg-background px-3 py-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span id={labelId} className="text-sm text-foreground">
          {label}
        </span>
        {hint !== undefined ? (
          <p id={hintId} className="max-w-[70ch] text-xs leading-relaxed text-muted">
            {hint}
          </p>
        ) : null}
      </div>

      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={labelId}
        aria-describedby={hintId}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors ${
          checked ? "border-accent/60 bg-accent/25" : "border-line-strong bg-surface-raised"
        }`}
      >
        <span
          aria-hidden="true"
          className={`inline-block size-4 rounded-full transition-transform motion-reduce:transition-none ${
            checked ? "translate-x-6 bg-accent" : "translate-x-1 bg-muted"
          }`}
        />
      </button>

      <input type="hidden" name={name} value={checked ? "true" : "false"} />
    </div>
  );
}
