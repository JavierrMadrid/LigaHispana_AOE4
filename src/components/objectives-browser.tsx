"use client";

import { useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import type { ObjectiveGroup, ObjectiveOption, ObjectiveView } from "@/lib/public";
import { ObjectiveCard } from "@/components/objective-card";
import { ObjectiveRankingDialog } from "@/components/objective-ranking-dialog";

/**
 * Objetivos especiales agrupados por familia.
 *
 * El servidor entrega los objetivos ya resueltos y aquí solo se agrupa y se
 * filtra por tipo. El `ranking` completo de un objetivo no se pinta en la
 * tarjeta: se enseña entero en el diálogo que abre "Ver clasificación", para
 * que la rejilla se pueda escanear de un vistazo.
 *
 * ## Por qué las secciones no arrancan siempre abiertas
 *
 * En escritorio la rejilla es a tres columnas y el contenido es la página: los
 * grupos se despliegan solos y plegarlos es una comodidad para quien quiere ir
 * directo a uno. En móvil, a una columna, los 38 objetivos suman del orden de
 * 11 000 px de desplazamiento (unas 29 pantallas), y ahí "el contenido es la
 * página" ya no describe nada: la página no se ve. Por eso por debajo de `sm`
 * los grupos arrancan **plegados** y la lista de cabeceras hace de índice, con
 * "Desplegar los grupos" para quien quiera leerlo entero.
 *
 * El ancho no se conoce en el servidor, así que el defecto lo resuelve el CSS
 * (`hidden sm:grid`): la primera pintura ya sale plegada en móvil y desplegada
 * en escritorio, sin parpadeo. `useIsDesktop` solo ajusta el `aria-expanded` y
 * el rótulo de "Desplegar los grupos". La decisión de una persona manda sobre
 * el defecto.
 */

/** Corte de la rejilla a una columna (móvil) frente a varias (escritorio). */
const DESKTOP_QUERY = "(min-width: 640px)";

function subscribeDesktop(callback: () => void) {
  const query = window.matchMedia(DESKTOP_QUERY);
  query.addEventListener("change", callback);

  return () => query.removeEventListener("change", callback);
}

function getDesktopSnapshot() {
  return window.matchMedia(DESKTOP_QUERY).matches;
}

/** Sin viewport en el servidor: se asume móvil, que es el caso que necesita el índice. */
function getDesktopServerSnapshot() {
  return false;
}

function useIsDesktop() {
  return useSyncExternalStore(subscribeDesktop, getDesktopSnapshot, getDesktopServerSnapshot);
}

/**
 * Clases del cuerpo de un grupo.
 *
 * Sin decisión de la persona el defecto lo resuelve el CSS —plegado por debajo
 * de `sm`, rejilla desde ahí—, así que se puede pintar entero desde el servidor
 * sin saber el ancho. Un `true`/`false` explícito manda sobre las dos cosas.
 * No se añade un `grid` de base a propósito: ganaría a `hidden` en la cascada y
 * el grupo plegado se vería.
 */
function bodyClass(override: boolean | undefined): string {
  if (override === true) {
    return "grid";
  }

  if (override === false) {
    return "hidden";
  }

  return "hidden sm:grid";
}

type ObjectivesBrowserProps = {
  options: ObjectiveOption[];
  /** Rótulos de grupo del catálogo, para no duplicarlos en el cliente. */
  groupLabels: Record<ObjectiveGroup, string>;
  /** Mínimos del ruleset, para el copy de las carreras (`masterizar-*`). */
  minimums: ObjectiveView["minimums"];
  /** Id del objetivo que abarca las 23 civilizaciones (única fuente: el servidor). */
  masterizarTodosId: string;
};

export function ObjectivesBrowser({
  options,
  groupLabels,
  minimums,
  masterizarTodosId,
}: ObjectivesBrowserProps) {
  const [group, setGroup] = useState<ObjectiveGroup | null>(null);
  const [active, setActive] = useState<ObjectiveOption | null>(null);
  // Solo guarda lo que la persona ha decidido a mano; lo que no está aquí sigue
  // el defecto del ancho. Así un cambio de tamaño no pisa su elección.
  const [overrides, setOverrides] = useState<Partial<Record<ObjectiveGroup, boolean>>>({});
  const desktop = useIsDesktop();

  // El orden de los grupos se toma de los propios objetivos, que ya llegan en
  // el orden de presentación de `docs/PUNTUACION.md`.
  const groups = useMemo(() => {
    const order: ObjectiveGroup[] = [];

    for (const option of options) {
      if (!order.includes(option.group)) {
        order.push(option.group);
      }
    }

    return order;
  }, [options]);

  const visible = useMemo(
    () => (group === null ? options : options.filter((option) => option.group === group)),
    [options, group],
  );

  const sections = useMemo(
    () =>
      groups
        .filter((item) => group === null || item === group)
        .map((item) => {
          const groupOptions = options.filter((option) => option.group === item);

          return {
            id: item,
            label: groupLabels[item],
            shown: groupOptions,
            totals: {
              count: groupOptions.length,
              points: groupOptions.reduce((total, option) => total + option.points, 0),
              holders: groupOptions.filter((option) => option.holder !== null).length,
            },
          };
        }),
    [groups, group, options, groupLabels],
  );

  // Estado tri-valor de una sección: `undefined` significa que lo decide el CSS
  // (plegado por debajo de `sm`, abierto desde ahí). Con un filtro activo el
  // defecto es abierto en cualquier ancho —quien filtra ya dijo qué quiere ver—
  // salvo que la persona haya plegado esa sección a mano, que entonces manda.
  function sectionState(id: ObjectiveGroup): boolean | undefined {
    const override = overrides[id];

    if (override !== undefined) {
      return override;
    }

    return group !== null ? true : undefined;
  }

  function isOpen(id: ObjectiveGroup): boolean {
    const state = sectionState(id);

    return state !== undefined ? state : desktop;
  }

  function toggle(id: ObjectiveGroup) {
    setOverrides((current) => ({ ...current, [id]: !isOpen(id) }));
  }

  const allOpen = sections.every((section) => isOpen(section.id));

  function toggleAll() {
    const next = !allOpen;
    const updated: Partial<Record<ObjectiveGroup, boolean>> = {};

    for (const section of sections) {
      updated[section.id] = next;
    }

    setOverrides(updated);
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-4">
        <FilterCategory label="Tipos" id="filtro-tipos">
          <FilterPill active={group === null} onClick={() => setGroup(null)}>
            Todos
            <Count value={options.length} />
          </FilterPill>
          {groups.map((item) => (
            <FilterPill
              key={item}
              active={group === item}
              onClick={() => setGroup(group === item ? null : item)}
            >
              {groupLabels[item]}
              <Count value={options.filter((option) => option.group === item).length} />
            </FilterPill>
          ))}
        </FilterCategory>

        {sections.length > 1 ? (
          <div className="flex justify-end">
            <button
              type="button"
              onClick={toggleAll}
              className="text-xs font-medium text-muted underline-offset-4 transition-colors hover:text-accent hover:underline"
            >
              {allOpen ? "Plegar los grupos" : "Desplegar los grupos"}
            </button>
          </div>
        ) : null}
      </div>

      {group === null ? null : (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p role="status" className="text-xs text-muted">
            {visible.length === 1
              ? "1 objetivo coincide con el filtro"
              : `${visible.length} objetivos coinciden con el filtro`}
          </p>
          <button
            type="button"
            onClick={() => setGroup(null)}
            className="text-xs font-medium text-muted underline-offset-4 transition-colors hover:text-accent hover:underline"
          >
            Quitar filtro
          </button>
        </div>
      )}

      {visible.length === 0 ? (
        <div className="rounded-lg border border-line bg-surface px-6 py-12 text-center">
          <p className="font-display text-lg font-semibold text-foreground">
            No hay objetivos en este tipo
          </p>
          <p className="mt-2 text-sm text-muted">
            Elige otro tipo de objetivo para ver su clasificación.
          </p>
          <button
            type="button"
            onClick={() => setGroup(null)}
            className="mt-5 inline-flex h-10 items-center rounded-md bg-accent px-4 text-sm font-semibold text-accent-ink transition-colors hover:bg-accent-strong"
          >
            Ver todos los objetivos
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-8">
          {sections.map((section) => {
            const open = isOpen(section.id);
            const bodyId = `grupo-${section.id}-contenido`;

            return (
              <section key={section.id} id={`grupo-${section.id}`} className="scroll-mt-24">
                {/* La cabecera es el control: el `h2` mantiene el encabezado de la
                    sección y el botón de dentro lleva el estado y el nombre, para
                    que se pueda plegar sin perder la jerarquía de encabezados. */}
                <h2 className="group/head border-b border-line transition-colors hover:border-line-strong">
                  <button
                    type="button"
                    aria-expanded={open}
                    aria-controls={bodyId}
                    onClick={() => toggle(section.id)}
                    className="flex w-full flex-col gap-1 pb-3 text-left sm:flex-row sm:flex-wrap sm:items-baseline sm:justify-between sm:gap-x-4"
                  >
                    <span className="font-display text-xl font-semibold text-foreground">
                      {section.label}
                    </span>
                    <span className="flex items-center gap-2 text-xs tabular-nums text-muted">
                      {section.totals.count}{" "}
                      {section.totals.count === 1 ? "objetivo" : "objetivos"} ·{" "}
                      {section.totals.points} puntos · {section.totals.holders} con poseedor
                      <Chevron open={open} />
                    </span>
                  </button>
                </h2>

                {/* El cuerpo se renderiza siempre y se enseña u oculta con clases,
                    no condicionalmente: así el HTML sale entero —los 38 objetivos
                    se pueden rastrear y un escritorio sin JavaScript los lee— y la
                    visibilidad en la primera pintura la decide el CSS (`hidden
                    sm:grid`), sin parpadeo ni salto. `isOpen` solo alimenta el
                    `aria-expanded` y el botón; el estado explícito de la persona
                    manda sobre el defecto del ancho. */}
                <div
                  id={bodyId}
                  className={`mt-5 gap-4 sm:grid-cols-2 xl:grid-cols-3 ${bodyClass(
                    sectionState(section.id),
                  )}`}
                >
                  {section.shown.map((option) => (
                    <ObjectiveCard
                      key={option.id}
                      option={option}
                      onOpen={() => setActive(option)}
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {active === null ? null : (
        <ObjectiveRankingDialog
          key={active.id}
          option={active}
          minimums={minimums}
          masterizarTodosId={masterizarTodosId}
          onClose={() => setActive(null)}
        />
      )}
    </div>
  );
}

/** Chevron del grupo: hacia abajo plegado, girado hacia arriba desplegado. */
function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 12 12"
      aria-hidden="true"
      className={`size-3 shrink-0 text-muted transition-transform motion-reduce:transition-none ${
        open ? "rotate-180" : ""
      }`}
    >
      <path
        d="M2.5 4.5 6 8l3.5-3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function FilterCategory({
  label,
  id,
  children,
}: {
  label: string;
  id: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
      <span id={id} className="shrink-0 text-xs font-semibold text-muted sm:w-20">
        {label}
      </span>
      <div role="group" aria-labelledby={id} className="flex flex-wrap items-center gap-2">
        {children}
      </div>
    </div>
  );
}

function FilterPill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`inline-flex h-10 items-center gap-2 rounded-full border px-3 text-xs font-semibold transition-colors ${
        active
          ? "border-accent bg-accent text-accent-ink"
          : "border-line bg-surface text-muted hover:bg-surface-raised hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

function Count({ value }: { value: number }) {
  return <span className="tabular-nums opacity-70">{value}</span>;
}
