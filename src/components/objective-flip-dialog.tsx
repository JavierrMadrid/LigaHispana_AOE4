"use client";

import type { ReactNode } from "react";
import FlipCard from "@/components/flip-card";
import { Modal } from "@/components/modal";

/** Las cuatro esquinas del filete, para pintarles su remate. */
const CORNERS = ["tl", "tr", "bl", "br"] as const;

type Corner = (typeof CORNERS)[number];

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
 * Ventana de un objetivo: una tarjeta volteable **con marco**, dentro del `Modal` de
 * la casa.
 *
 * El `Modal` ya resuelve foco, `Esc`, clic en el fondo y bloqueo del scroll; aquí
 * solo se monta la tarjeta —su marco y la X— y se le pasan las dos caras. Se abre
 * mostrando la clasificación —la cara posterior—, igual que la ventana anterior, y
 * al girarla aparece el resumen. En móvil ocupa la pantalla completa; a partir de
 * `sm` es una tarjeta centrada. El nombre accesible del diálogo es fijo (`ariaLabel`)
 * y no apunta al título visible, que se oculta al girar la tarjeta.
 *
 * ## El marco
 *
 * Dos filetes finos de oro con un remate en cada esquina: el exterior a 10px del
 * borde, con el hilo de la casa (`--thread`, que ya es `--accent` al 30%), y el
 * interior a 16px, algo más marcado (`--accent` al 55%); en la esquina del interior
 * va un rombo de oro macizo (`--accent`) que es lo que ata los dos filetes. Todo sale
 * de los tokens, así que si cambia el oro de la casa cambia el marco, y no hay
 * sombras ni halos: la casa no los usa y el marco se basta con el contraste del filo.
 * El radio del filete exterior es el de la tarjeta menos su separación (6px), para
 * que las dos curvas sean concéntricas; el interior cae ya en la zona recta.
 *
 * Es cromo de la tarjeta, como la X: va **dentro de cada cara**, así que gira con
 * ella, es decorativo (`aria-hidden`) y no recibe el puntero. Queda por debajo del
 * contenido —si algo llegara a solaparlo, se tapa la línea y no el texto— y las
 * caras le dejan sitio con sus márgenes: 24/32px a los lados y 56/64px arriba. La X
 * se mueve a 20px del borde, dentro del filete interior, para que las dos líneas le
 * pasen por fuera en vez de cruzarle por delante la caja. Abajo va el único canal que
 * hacía falta (`pb-5`, 20px): deja las filas de la clasificación por encima del
 * filete interior y libre la barra de desplazamiento, que ocupa los 10px del canto.
 *
 * ## El volteo y la X
 *
 * La tarjeta grande no se inclina ni realza al pasar el ratón y no tiene brillo
 * especular: gira con clic o teclado y, al arrastrar, sigue al puntero (acotada)
 * mientras gira, y al soltarla vuelve a su sitio con un muelle. El arrastre queda
 * contenido para no salirse de la ventana, que recorta con `overflow-hidden`.
 *
 * **La X de cerrar va dentro de la tarjeta**, no en la esquina del `Modal`: así gira,
 * se ladea y se mueve con ella en vez de quedarse suelta sobre la ventana, que era
 * justo lo que se veía al inclinar la tarjeta. Por eso se pinta una por cara —la que
 * se ve—: la oculta va `inert`, así que el foco no se duplica. El `Modal` sigue
 * cerrando por `Esc`, clic en el fondo y devolviendo el foco, que no depende de dónde
 * esté el botón. Al pasar el ratón por encima de la X la tarjeta no arrastra ni gira:
 * `FlipCard` deja en paz los controles de sus caras.
 */
export function ObjectiveFlipDialog({
  onClose,
  closeLabel,
  front,
  back,
  ariaLabel,
  cardLabel,
}: ObjectiveFlipDialogProps) {
  // La X, el marco y el contenido viven en la misma caja de la cara y con `absolute`,
  // así que gira el conjunto. El disco translúcido de debajo mantiene la X legible: el
  // contenido de la cara pasa por debajo al desplazarse, y sin él el aspa quedaría
  // sobre texto ajeno. La X va antes que el contenido en el DOM para que quien navega
  // con teclado la encuentre sin recorrer la lista entera; el marco, en cambio, va
  // debajo del contenido.
  const face = (content: ReactNode) => (
    <div className="relative h-full pb-5">
      <button
        type="button"
        onClick={onClose}
        aria-label={closeLabel}
        className="absolute right-5 top-5 z-10 inline-flex size-9 items-center justify-center rounded-md bg-surface/90 text-muted backdrop-blur-sm transition-colors hover:bg-surface-raised hover:text-foreground"
      >
        <CloseIcon />
      </button>

      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-2.5 rounded-md border border-[var(--thread)]"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-4 rounded-xs border border-accent/55"
      >
        {CORNERS.map((corner) => (
          <CornerOrnament key={corner} corner={corner} />
        ))}
      </div>

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
        {/* El radio de la tarjeta lo cuenta el marco: el filete exterior va a 10px con
            6px de radio (16 − 10) para que las dos curvas sean concéntricas. */}
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
          front={face(front)}
          back={face(back)}
        />
      </div>
    </Modal>
  );
}

/**
 * Remate de una esquina del filete: un rombo de oro sobre la punta, lo que ata los
 * dos filetes y cierra el marco.
 *
 * Se cuelga del propio filete (`absolute` dentro de él) y se centra en la esquina con
 * medio lado de desplazamiento, así que el mismo elemento vale para cualquier tamaño:
 * en móvil el rombo se encoge a la mitad (4px) y sigue cayendo en el mismo sitio.
 */
function CornerOrnament({ corner }: { corner: Corner }) {
  const placement: Record<Corner, string> = {
    tl: "left-0 top-0 -translate-x-1/2 -translate-y-1/2",
    tr: "right-0 top-0 translate-x-1/2 -translate-y-1/2",
    bl: "bottom-0 left-0 -translate-x-1/2 translate-y-1/2",
    br: "right-0 bottom-0 translate-x-1/2 translate-y-1/2",
  };

  return (
    <span
      aria-hidden="true"
      className={`absolute size-1 rotate-45 bg-accent sm:size-1.5 ${placement[corner]}`}
    />
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
