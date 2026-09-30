"use client";

import { useId, type ReactNode } from "react";
import { Modal } from "@/components/modal";

type ConfirmDialogProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Hay una acción en curso: no se puede cerrar y el botón lo refleja. */
  pending: boolean;
  children: ReactNode;
};

/**
 * Diálogo de confirmación para acciones destructivas del panel.
 *
 * Es una capa controlada (abrir y cerrar los decide quien lo usa) y solo aporta
 * lo específico de una confirmación: el título y el cromo de tarjeta. Toda la
 * mecánica de la capa —`showModal()`, trampa de foco, `Esc`, clic en el fondo y
 * scroll bloqueado— vive en `Modal`, que es la única implementación de esa
 * trampa en el repositorio. Así el login puede reutilizarla sin copiarla.
 *
 * `pending` se traduce en `closeDisabled`: mientras la acción está en curso el
 * diálogo no se cierra por `Esc` ni por el fondo, para que quien la lanzó no
 * pierda de vista el resultado.
 */
export function ConfirmDialog({ open, onClose, title, pending, children }: ConfirmDialogProps) {
  const titleId = useId();

  return (
    <Modal
      open={open}
      onClose={onClose}
      closeDisabled={pending}
      labelledBy={titleId}
      className="m-auto w-[calc(100%-2rem)] max-w-md rounded-lg border border-line bg-surface p-0 text-foreground"
    >
      <div className="p-5">
        <h2 id={titleId} className="text-lg font-semibold text-foreground">
          {title}
        </h2>
        <div className="mt-3">{children}</div>
      </div>
    </Modal>
  );
}
