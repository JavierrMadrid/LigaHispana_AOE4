"use client";

import { useEffect, useRef, type MouseEvent, type ReactNode } from "react";

type ModalProps = {
  open: boolean;
  onClose: () => void;
  /** Hay una acción en curso: no se cierra por `Esc` ni por clic en el fondo. */
  closeDisabled?: boolean;
  /** id del elemento que titula el diálogo. */
  labelledBy?: string;
  /** Nombre accesible cuando el título no es un elemento con id. */
  ariaLabel?: string;
  /** id del elemento que describe el diálogo. */
  describedBy?: string;
  /** Si se indica, pinta un botón de cierre en la esquina con ese nombre. */
  closeLabel?: string;
  /** Clases del propio `<dialog>`: cada uso decide tamaño, cromo y radios. */
  className?: string;
  children: ReactNode;
};

/**
 * Diálogo con la mecánica común de cualquier capa: apertura, foco, `Esc`,
 * clic en el fondo y bloqueo del scroll.
 *
 * Por dentro se apoya en el `<dialog>` nativo con `showModal()`, que ya aporta
 * lo que más cuesta hacer bien a mano: queda por encima de todo, bloquea el
 * resto de la página y atrapa el foco dentro. No hay ninguna librería de
 * primitivas en el proyecto, así que el diálogo es código propio; usar el
 * elemento nativo evita reimplementar la trampa de foco y el cierre con `Esc`,
 * que es justo donde se falla. Aquí solo se añaden las cosas que el elemento
 * nativo no resuelve solo:
 *
 * - **El foco vuelve al elemento que abrió el diálogo** al cerrar, capturado al
 *   mostrar. Sin eso, quien navega con teclado aterriza en el principio del
 *   documento después de cancelar.
 * - **`Esc` no cierra mientras hay una acción en curso**: quien la lanzó
 *   perdería de vista su resultado, que es justo lo que el diálogo está para
 *   contar.
 * - **Scroll de fondo bloqueado** mientras está abierto. `showModal()` deja el
 *   resto de la página inerte, pero no impide desplazarla en todos los
 *   navegadores. Al bloquearlo se compensa el ancho de la barra de
 *   desplazamiento con un `padding-right`, para que el fondo no dé un salto
 *   lateral.
 * - **Clic en el fondo** cierra, salvo que el gesto haya empezado dentro de la
 *   tarjeta (arrastrar para seleccionar texto no debe cerrar el diálogo).
 *
 * El `cancel` se escucha con un listener nativo y no como evento de React
 * porque se dispara desde el navegador; leer el estado por cierre dejaría
 * valores viejos, así que `onClose` y `closeDisabled` se guardan también en refs.
 *
 * Esta es la única implementación de la trampa de foco del repositorio:
 * `ConfirmDialog` la envuelve para el panel de administración, la ventana de
 * acceso la usa para el login y el diálogo de clasificación de objetivos la
 * envuelve para su clasificación, sin duplicar la mecánica.
 */
export function Modal({
  open,
  onClose,
  closeDisabled = false,
  labelledBy,
  ariaLabel,
  describedBy,
  closeLabel,
  className,
  children,
}: ModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const backdropPressRef = useRef(false);

  const closeRef = useRef(onClose);
  const closeDisabledRef = useRef(closeDisabled);

  useEffect(() => {
    closeRef.current = onClose;
    closeDisabledRef.current = closeDisabled;
  });

  useEffect(() => {
    const dialog = dialogRef.current;

    if (dialog === null) {
      return;
    }

    const handleCancel = (event: Event) => {
      event.preventDefault();

      if (!closeDisabledRef.current) {
        closeRef.current();
      }
    };

    dialog.addEventListener("cancel", handleCancel);

    return () => dialog.removeEventListener("cancel", handleCancel);
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;

    if (dialog === null) {
      return;
    }

    if (open) {
      if (!dialog.open) {
        openerRef.current =
          document.activeElement instanceof HTMLElement ? document.activeElement : null;
        dialog.showModal();

        const target = dialog.querySelector<HTMLElement>("[data-autofocus]") ?? dialog;
        target.focus();
      }

      return;
    }

    if (dialog.open) {
      dialog.close();
      openerRef.current?.focus();
    }
  }, [open]);

  // Sincroniza el DOM con el estado abierto/cerrado. No hay `setState` aquí: se
  // guarda el valor previo y se restaura al cerrar o al desmontar.
  useEffect(() => {
    if (!open) {
      return;
    }

    const previousOverflow = document.body.style.overflow;
    const previousPaddingRight = document.body.style.paddingRight;
    // Compensa el ancho de la barra de desplazamiento para que el fondo no dé
    // un salto lateral al bloquearse el scroll.
    const scrollbar = window.innerWidth - document.documentElement.clientWidth;

    document.body.style.overflow = "hidden";

    if (scrollbar > 0) {
      document.body.style.paddingRight = `${scrollbar}px`;
    }

    return () => {
      document.body.style.overflow = previousOverflow;
      document.body.style.paddingRight = previousPaddingRight;
    };
  }, [open]);

  function handleMouseDown(event: MouseEvent<HTMLDialogElement>) {
    backdropPressRef.current = event.target === dialogRef.current;
  }

  function handleClick(event: MouseEvent<HTMLDialogElement>) {
    if (
      !closeDisabledRef.current &&
      backdropPressRef.current &&
      event.target === dialogRef.current
    ) {
      closeRef.current();
    }

    backdropPressRef.current = false;
  }

  return (
    <dialog
      ref={dialogRef}
      aria-label={labelledBy === undefined ? ariaLabel : undefined}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      aria-modal="true"
      tabIndex={-1}
      onMouseDown={handleMouseDown}
      onClick={handleClick}
      className={`backdrop:bg-background/85 backdrop:animate-overlay-in ${className ?? ""}`}
    >
      {closeLabel !== undefined ? (
        <button
          type="button"
          onClick={onClose}
          disabled={closeDisabled}
          aria-label={closeLabel}
          className="absolute right-2.5 top-2.5 inline-flex size-9 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-raised hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
        >
          <CloseIcon />
        </button>
      ) : null}
      {children}
    </dialog>
  );
}

/**
 * Aspa de cierre: dos trazos cruzados, mismo lenguaje que el resto de glifos
 * del sitio (caja de 24, `currentColor`, 1.5 de grosor y extremos redondeados).
 * Es decorativa: el nombre accesible lo pone el `aria-label` del botón.
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
