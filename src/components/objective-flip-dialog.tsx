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
 *
 * **La X de cerrar va dentro de la tarjeta**, no en la esquina del `Modal`: así
 * gira, se ladea y se mueve con ella en vez de quedarse suelta sobre la ventana,
 * que era justo lo que se veía al inclinar la tarjeta. Por eso se pinta una por
 * cara —la que se ve—: la oculta va `inert`, así que el foco no se duplica. El
 * `Modal` sigue cerrando por `Esc`, clic en el fondo y devolviendo el foco, que no
 * depende de dónde esté el botón. Al pasar el ratón por encima de la X la tarjeta
 * no arrastra ni gira: `FlipCard` deja en paz los controles de sus caras.
 */
export function ObjectiveFlipDialog({
  onClose,
  closeLabel,
  front,
  back,
  ariaLabel,
  cardLabel,
}: ObjectiveFlipDialogProps) {
  // El disco translúcido de debajo mantiene la X legible: el contenido de la cara
  // pasa por debajo al desplazarse, y sin él el aspa quedaría sobre texto ajeno. Va
  // antes que el contenido en el DOM —la posición la fija `absolute`— para que quien
  // navega con teclado la encuentre sin recorrer la lista entera.
  const withCloseButton = (content: ReactNode) => (
    <div className="relative h-full">
      <button
        type="button"
        onClick={onClose}
        aria-label={closeLabel}
        className="absolute right-3 top-3 z-10 inline-flex size-9 items-center justify-center rounded-md bg-surface/90 text-muted backdrop-blur-sm transition-colors hover:bg-surface-raised hover:text-foreground"
      >
        <CloseIcon />
      </button>
      {content}
    </div>
  );

  return (
    <Modal
      open
      onClose={onClose}
      ariaLabel={ariaLabel}
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
          front={withCloseButton(front)}
          back={withCloseButton(back)}
        />
      </div>
    </Modal>
  );
}

/**
 * Aspa de cierre: dos trazos cruzados, mismo glifo que el del `Modal` (caja de 24,
 * `currentColor`, 1.5 de grosor y extremos redondeados). Es decorativa: el nombre
 * accesible lo pone el `aria-label` del botón.
 */
function CloseIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="size-5"
    >
      <path d="M6.5 6.5l11 11" />
      <path d="M17.5 6.5l-11 11" />
    </svg>
  );
}
