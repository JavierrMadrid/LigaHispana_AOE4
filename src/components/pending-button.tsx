"use client";

import { useFormStatus } from "react-dom";
import type { ReactNode } from "react";

/**
 * Botón de envío de un formulario de Server Action.
 *
 * Se deshabilita mientras la acción viaja, lo que cierra la ventana de doble
 * envío sin guardar estado propio: `useFormStatus` lee el envío del `<form>` que
 * lo contiene. La espera se muestra con puntos suspensivos en vez de un texto
 * distinto para que el botón no cambie de ancho y la fila no se mueva.
 *
 * Vive aquí y no en cada pantalla porque la cola de pendientes (servidor) y el
 * listado con filtros (cliente) tienen el mismo problema y la misma solución.
 */
export function PendingButton({
  className,
  children,
  pendingLabel = "…",
}: {
  className: string;
  children: ReactNode;
  pendingLabel?: string;
}) {
  const { pending } = useFormStatus();

  return (
    <button type="submit" disabled={pending} className={className}>
      {pending ? pendingLabel : children}
    </button>
  );
}
