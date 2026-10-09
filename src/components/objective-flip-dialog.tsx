"use client";

import type { ReactNode } from "react";
import FlipCard from "@/components/flip-card";
import { Modal } from "@/components/modal";

type ObjectiveFlipDialogProps = {
  onClose: () => void;
  closeLabel: string;
  /** Cara frontal: el resumen que se ve en la tarjeta pequeña. */
  front: ReactNode;
  /** Cara posterior: la clasificación, que es la que se ve al abrir. */
  back: ReactNode;
  /** Nombre accesible del diálogo. */
  ariaLabel: string;
  /** Nombre accesible de la tarjeta volteable. */
  cardLabel: string;
};

/**
 * Ventana de un objetivo: una tarjeta volteable dentro del `Modal` de la casa.
 *
 * El `Modal` ya resuelve foco, `Esc`, clic en el fondo y bloqueo del scroll; aquí
 * solo se monta la tarjeta y se le pasan las dos caras. Se abre mostrando la
 * clasificación —la cara posterior—, igual que la ventana anterior, y al girarla
 * aparece el resumen. En móvil ocupa la pantalla completa; a partir de `sm` es
 * una tarjeta centrada. El nombre accesible del diálogo es fijo (`ariaLabel`) y
 * no apunta al título visible, que se oculta al girar la tarjeta.
 *
 * La tarjeta grande no se inclina ni realza al pasar el ratón y no tiene brillo
 * especular: gira con clic o teclado y, al arrastrar, sigue al puntero (acotada)
 * mientras gira, y al soltarla vuelve a su sitio con un muelle. El arrastre queda
 * contenido para no salirse de la ventana, que recorta con `overflow-hidden`.
 */
export function ObjectiveFlipDialog({
  onClose,
  closeLabel,
  front,
  back,
  ariaLabel,
  cardLabel,
}: ObjectiveFlipDialogProps) {
  return (
    <Modal
      open
      onClose={onClose}
      ariaLabel={ariaLabel}
      closeLabel={closeLabel}
      className="m-auto h-[100dvh] max-h-[100dvh] w-full max-w-none overflow-hidden border-0 bg-transparent p-0 sm:h-[85vh] sm:max-h-[44rem] sm:max-w-3xl"
    >
      <div className="animate-dialog-in flex h-full w-full motion-reduce:animate-none">
        <FlipCard
          className="h-full w-full"
          defaultFlipped
          width="100%"
          height="100%"
          radius={16}
          background="var(--surface)"
          color="var(--foreground)"
          ariaLabel={`${cardLabel}. Pulsa o arrastra para girar la tarjeta.`}
          tilt={false}
          glare={false}
          hoverScale={1}
          front={front}
          back={back}
        />
      </div>
    </Modal>
  );
}
