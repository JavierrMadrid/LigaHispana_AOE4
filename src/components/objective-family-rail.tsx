"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { CivilizationIcon } from "@/components/civilization-icon";

/** Prefijos de id que llevan la civilización pegada (`lider-japanese` → `japanese`). */
const FAMILY_CIV_PREFIXES = ["lider-", "acolito-"] as const;

/** Separación entre tarjetas (`gap-4`), para avanzar una tarjeta por pulsación. */
const SCROLL_STEP_GAP = 16;

/** La civilización de un id de subobjetivo, o `null` si no es de familia. */
export function familyCivId(id: string): string | null {
  for (const prefix of FAMILY_CIV_PREFIXES) {
    if (id.startsWith(prefix)) {
      return id.slice(prefix.length);
    }
  }

  return null;
}

type ObjectiveFamilyRailProps<T extends { id: string; label: string }> = {
  /** Los subobjetivos, en el orden del catálogo. */
  items: T[];
  /** Cómo se pinta cada tarjeta del riel. */
  renderCard: (item: T) => ReactNode;
  /** Rótulo del filtro de banderas. */
  filterLabel?: string;
  /** Clases del `<li>` de cada tarjeta (ancho y anclaje de scroll). */
  itemClassName?: string;
};

/**
 * El riel horizontal de una familia de objetivos: el filtro de banderas arriba
 * y una tarjeta por subobjetivo debajo.
 *
 * Es la pieza que comparten `/objetivos` (`ObjectiveFamilySection`) y la ficha de
 * un participante, que pintan tarjetas distintas sobre el mismo riel. El filtro
 * no filtra: **salta** a la tarjeta de esa civilización dentro del riel
 * (`scrollIntoView`), que es lo que se pidió para no perder de vista el conjunto.
 * El riel se recorre con la rueda o el gesto táctil nativos, con el teclado —cada
 * tarjeta es un botón, y enfocarla la trae a la vista— y con dos botones de
 * flecha que avanzan una tarjeta; se atenúan en los extremos. No hay arrastre con
 * el ratón: el gesto no funcionaba bien y, al quitarlo, el clic de la tarjeta
 * abre su clasificación como en el resto del sitio.
 *
 * El `<ul>` lleva margen negativo y relleno iguales para que el halo de
 * `BorderGlow` que se sale de las tarjetas no se recorte dentro del área de
 * scroll.
 */
export function ObjectiveFamilyRail<T extends { id: string; label: string }>({
  items,
  renderCard,
  filterLabel = "Salta a una civilización",
  itemClassName = "w-[17rem] shrink-0 snap-start sm:w-[18rem]",
}: ObjectiveFamilyRailProps<T>) {
  const [activeCiv, setActiveCiv] = useState<string | null>(null);
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(true);
  const cardRefs = useRef<Record<string, HTMLElement | null>>({});
  const railRef = useRef<HTMLUListElement>(null);

  const childrenByCiv = new Map<string, T>();

  for (const item of items) {
    const civ = familyCivId(item.id);

    if (civ !== null) {
      childrenByCiv.set(civ, item);
    }
  }

  const updateScrollState = useCallback(() => {
    const rail = railRef.current;

    if (rail === null) {
      return;
    }

    setAtStart(rail.scrollLeft <= 1);
    setAtEnd(rail.scrollLeft + rail.clientWidth >= rail.scrollWidth - 1);
  }, []);

  useEffect(() => {
    const rail = railRef.current;

    if (rail === null) {
      return;
    }

    updateScrollState();

    const observer = new ResizeObserver(updateScrollState);
    observer.observe(rail);

    return () => observer.disconnect();
  }, [updateScrollState, items.length]);

  // Avanza una tarjeta; el paso sale del ancho real del primer `<li>` más el
  // hueco entre tarjetas, así vale para los dos anchos (rejilla y riel).
  function scrollByStep(direction: -1 | 1) {
    const rail = railRef.current;

    if (rail === null) {
      return;
    }

    const first = rail.querySelector("li");
    const step =
      first === null
        ? rail.clientWidth * 0.9
        : first.getBoundingClientRect().width + SCROLL_STEP_GAP;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    rail.scrollBy({ left: direction * step, behavior: reduce ? "auto" : "smooth" });
  }

  function jumpTo(civ: string) {
    setActiveCiv(civ);

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    cardRefs.current[civ]?.scrollIntoView({
      behavior: reduce ? "auto" : "smooth",
      inline: "start",
      block: "nearest",
    });
  }

  return (
    <>
      <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <p className="text-xs font-semibold text-muted">{filterLabel}</p>
          <div className="flex items-center gap-3">
            <p className="text-xs tabular-nums text-muted">
              {items.length} subobjetivos
            </p>
            <div className="flex items-center gap-1">
              <RailArrow
                direction="prev"
                disabled={atStart}
                onClick={() => scrollByStep(-1)}
              />
              <RailArrow
                direction="next"
                disabled={atEnd}
                onClick={() => scrollByStep(1)}
              />
            </div>
          </div>
        </div>

        <ul
          role="group"
          aria-label="Civilizaciones de la familia"
          className="flex flex-wrap items-center gap-2"
        >
          {[...childrenByCiv.entries()].map(([civ, item]) => (
            <li key={civ}>
              <button
                type="button"
                onClick={() => jumpTo(civ)}
                aria-pressed={activeCiv === civ}
                title={item.label}
                className={`flex size-11 items-center justify-center rounded-md border transition-colors ${
                  activeCiv === civ
                    ? "border-accent bg-accent/10"
                    : "border-line bg-surface-raised hover:border-line-strong"
                }`}
              >
                <CivilizationIcon civ={civ} label={item.label} className="size-7" />
              </button>
            </li>
          ))}
        </ul>
      </div>

      <ul
        ref={railRef}
        onScroll={updateScrollState}
        className="-m-3 flex snap-x snap-mandatory gap-4 overflow-x-auto p-3"
      >
        {items.map((item) => {
          const civ = familyCivId(item.id);

          return (
            <li
              key={item.id}
              ref={(element) => {
                if (civ !== null) {
                  cardRefs.current[civ] = element;
                }
              }}
              className={itemClassName}
            >
              {renderCard(item)}
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** Botón de flecha del riel: avanza o retrocede una tarjeta. */
function RailArrow({
  direction,
  disabled,
  onClick,
}: {
  direction: "prev" | "next";
  disabled: boolean;
  onClick: () => void;
}) {
  const label =
    direction === "prev"
      ? "Ver los subobjetivos anteriores"
      : "Ver los subobjetivos siguientes";

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="flex size-9 items-center justify-center rounded-md border border-line bg-surface-raised text-muted transition-colors hover:border-line-strong hover:text-foreground disabled:cursor-default disabled:opacity-40 disabled:hover:border-line disabled:hover:text-muted"
    >
      <svg
        viewBox="0 0 16 16"
        aria-hidden="true"
        className="size-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d={direction === "prev" ? "M10 3 5 8l5 5" : "M6 3l5 5-5 5"} />
      </svg>
    </button>
  );
}
