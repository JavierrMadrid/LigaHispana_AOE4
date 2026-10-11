"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { CivilizationIcon } from "@/components/civilization-icon";

/**
 * Prefijo de las competiciones `masterizando-<civ>`.
 *
 * No forman familia —el catálogo los lista uno a uno, sin cabeza que los
 * agrupe—, pero comparten el sufijo de civilización con los `lider-`/`acolito-`,
 * así que el riel los reconoce igual y les monta su filtro de banderas.
 */
const MASTERIZANDO_PREFIX = "masterizando-";

/** Prefijos de id que llevan la civilización pegada (`lider-japanese` → `japanese`). */
const FAMILY_CIV_PREFIXES = ["lider-", "acolito-", MASTERIZANDO_PREFIX] as const;

/** Separación entre tarjetas (`gap-4`), para avanzar una tarjeta por pulsación. */
const SCROLL_STEP_GAP = 16;

/** `true` si el id es una competición `masterizando-<civ>`. */
export function isMasterizandoId(id: string): boolean {
  return id.startsWith(MASTERIZANDO_PREFIX);
}

/** La civilización de un id de subobjetivo, o `null` si no la lleva pegada. */
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
  /**
   * Cómo se llama lo que va en el riel ("subobjetivos" en las familias, que es
   * el caso por defecto; "competiciones" en `Masterizando`), para el recuento.
   */
  itemsLabel?: string;
  /** A quién agrupa el filtro de banderas, para el `aria-label` del grupo. */
  flagsLabel?: string;
  /** Clases del `<li>` de cada tarjeta (ancho y anclaje de scroll). */
  itemClassName?: string;
};

/**
 * El riel horizontal de un conjunto de objetivos por civilización: el filtro de
 * banderas arriba y una tarjeta por objetivo debajo.
 *
 * Es la pieza que comparten `/objetivos` (las familias y el bloque `Masterizando`),
 * la ficha de un participante y el carrusel de cada familia, que pintan tarjetas
 * distintas sobre el mismo riel. El filtro
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
 * scroll. Como el riel usa `snap-mandatory` con `snap-start`, el relleno
 * desplazaría la primera tarjeta al borde del área de scroll (el navegador ancla
 * al borde de la caja, no al contenido); el `scroll-padding` insetado el mismo
 * valor vuelve a alinear la tarjeta con el contenido de la sección, en reposo y
 * al saltar a una civilización.
 */
export function ObjectiveFamilyRail<T extends { id: string; label: string }>({
  items,
  renderCard,
  filterLabel = "Salta a una civilización",
  itemsLabel = "subobjetivos",
  flagsLabel = "Civilizaciones de la familia",
  // 19rem en móvil: el ancho que necesita la tarjeta más larga (`Masterizando
  // <civ>`, con su etiqueta y su pie de poseedor) para que el contenido no
  // desborde el borde de la tarjeta; desde `sm`, 20rem, el mismo que ya usa la
  // ficha de participante.
  itemClassName = "w-[19rem] shrink-0 snap-start sm:w-[20rem]",
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

  /**
   * Marca la civilización de la tarjeta anclada a la izquierda —la que queda en
   * `snap-start`—. Se recalcula en cada `scroll` y al acomodar el riel, para que
   * las flechas y el desplazamiento muevan también la bandera activa. El punto
   * de anclaje lleva el `scroll-padding` del riel, que inseta el snapport igual
   * que el relleno del halo.
   */
  const syncActiveCiv = useCallback(() => {
    const rail = railRef.current;

    if (rail === null) {
      return;
    }

    const scrollPadding = parseFloat(getComputedStyle(rail).scrollPaddingLeft) || 0;
    const anchor = rail.getBoundingClientRect().left + scrollPadding;
    let nearest: HTMLLIElement | null = null;
    let nearestDistance = Number.POSITIVE_INFINITY;

    for (const card of rail.querySelectorAll<HTMLLIElement>("li")) {
      const distance = Math.abs(card.getBoundingClientRect().left - anchor);

      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = card;
      }
    }

    const civ = nearest?.dataset.civ;

    // Las tarjetas sin civilización no pisan la selección anterior.
    if (civ !== undefined) {
      setActiveCiv((current) => (civ === current ? current : civ));
    }
  }, []);

  const updateScrollState = useCallback(() => {
    const rail = railRef.current;

    if (rail === null) {
      return;
    }

    setAtStart(rail.scrollLeft <= 1);
    setAtEnd(rail.scrollLeft + rail.clientWidth >= rail.scrollWidth - 1);
    syncActiveCiv();
  }, [syncActiveCiv]);

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
              {items.length} {itemsLabel}
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
          aria-label={flagsLabel}
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

      {/* El `scroll-px-3` iguala el `p-3`: sin él, el `snap-start` ancla la
          primera tarjeta al borde del área de scroll (12px fuera del contenido);
          con él, la ancla al contenido, que es donde encaja con la sección. */}
      <ul
        ref={railRef}
        onScroll={updateScrollState}
        className="-m-3 flex snap-x snap-mandatory gap-4 overflow-x-auto scroll-px-3 p-3"
      >
        {items.map((item) => {
          const civ = familyCivId(item.id);

          return (
            <li
              key={item.id}
              data-civ={civ ?? undefined}
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
      ? "Ver la tarjeta anterior"
      : "Ver la tarjeta siguiente";

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
