import type { ReactNode } from "react";

type StatusPillProps = {
  /** El estado marcado: abierto, publicado, activo, o la condición que se cumple. */
  active: boolean;
  children: ReactNode;
  className?: string;
};

/**
 * Estado de un ajuste, en una píldora pegada a su control.
 *
 * Es la misma pieza en las tres pantallas que la tenían copiada —el plazo de
 * inscripción, el banner de donaciones y las cuentas del panel—, para que el
 * estado bueno se vea igual en las tres y el oro signifique lo mismo.
 */
export function StatusPill({ active, children, className }: StatusPillProps) {
  return (
    <span
      className={`inline-block shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium ${
        active ? "border-accent/40 text-accent" : "border-line-strong text-muted"
      } ${className ?? ""}`}
    >
      {children}
    </span>
  );
}
