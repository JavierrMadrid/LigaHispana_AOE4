import type { ReactNode } from "react";

type FieldGridProps = {
  className?: string;
  children: ReactNode;
};

/**
 * Dos campos por fila a partir de `sm`, apilados en móvil.
 *
 * El hueco es el mismo en todos los formularios del panel: sin esto, cada uno
 * elegía su `gap` y dos tarjetas vecinas no alineaban sus campos.
 */
export function FieldGrid({ className, children }: FieldGridProps) {
  return <div className={`grid gap-4 sm:grid-cols-2 ${className ?? ""}`}>{children}</div>;
}
