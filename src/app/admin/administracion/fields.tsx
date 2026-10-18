"use client";

import { useId } from "react";
import type { AdminActionResult } from "@/app/admin/actions";

/**
 * Piezas de formulario compartidas por las pantallas de administración.
 *
 * El panel tiene un dialecto de campo muy estable —etiqueta en `muted`, control
 * a 6px con fondo `background`, pista en `text-xs`— que hasta ahora vivía
 * copiado en cada formulario. Con cuatro formularios nuevos en esta pestaña, se
 * extrae aquí: no es un sistema de formularios, es el mismo campo de siempre
 * escrito una vez para que no se puedan separar.
 */

type TextFieldProps = {
  name: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  placeholder?: string;
  /** Tipo del `input`; por defecto texto, como el resto del panel. */
  type?: "text" | "url" | "number" | "email" | "datetime-local";
  maxLength?: number;
  min?: number;
  step?: number;
  required?: boolean;
  /** Clases de la celda que envuelve el campo (por ejemplo, ocupar dos columnas). */
  className?: string;
};

/**
 * Campo de texto del panel, con su etiqueta real y su pista.
 *
 * La etiqueta es un `<label htmlFor>` de verdad y la pista se enlaza con
 * `aria-describedby`, no se deja como texto suelto: quien navega con lector de
 * pantalla oye el nombre del campo y su explicación, no solo el nombre.
 */
export function TextField({
  name,
  label,
  value,
  onChange,
  hint,
  placeholder,
  type = "text",
  maxLength,
  min,
  step,
  required,
  className,
}: TextFieldProps) {
  const id = useId();
  const hintId = hint !== undefined ? `${id}-hint` : undefined;

  return (
    <div className={`flex flex-col gap-1.5 ${className ?? ""}`}>
      <label htmlFor={id} className="text-sm text-muted">
        {label}
      </label>
      <input
        id={id}
        name={name}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        maxLength={maxLength}
        min={min}
        step={step}
        required={required}
        aria-describedby={hintId}
        autoComplete="off"
        className="h-10 rounded-md border border-line bg-background px-3 text-foreground placeholder:text-muted"
      />
      {hint !== undefined ? (
        <p id={hintId} className="text-xs leading-relaxed text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Línea de estado de un formulario de Server Action.
 *
 * Siempre está en el DOM —también vacía—, porque un `role="status"` que aparece
 * y desaparece no se anuncia; el color separa el fallo (`--loss`) del acierto
 * (neutro), como en el resto del panel.
 */
export function StatusLine({
  state,
  pending,
  pendingLabel = "",
}: {
  state: AdminActionResult;
  pending: boolean;
  /** Lo que se lee mientras la acción viaja; vacío si el botón ya lo dice. */
  pendingLabel?: string;
}) {
  return (
    <p
      role="status"
      aria-live="polite"
      className={`max-w-[70ch] text-sm leading-relaxed ${
        state.status === "error" ? "text-loss" : "text-muted"
      }`}
    >
      {pending ? pendingLabel : (state.message ?? "")}
    </p>
  );
}
