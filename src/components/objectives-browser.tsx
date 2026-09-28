"use client";

import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { ObjectiveGroup, ObjectiveOption } from "@/lib/public";
import { ObjectiveCard } from "@/components/objective-card";

/**
 * Objetivos especiales con filtros y secciones plegables.
 *
 * El servidor le pasa los objetivos ya resueltos y aquí solo se filtra y se
 * pinta: dos categorías de filtro que se combinan con AND (el tipo de objetivo
 * y si tiene poseedor) y una sección plegable por grupo. Las secciones arrancan
 * abiertas porque el contenido es la página; plegarlas es una comodidad para
 * quien quiere ir directo a un grupo.
 */

/** Qué se juega cada grupo. El orden es el de `ObjectiveGroup`. */
const GROUP_DESCRIPTIONS: Record<ObjectiveGroup, string> = {
  actividad:
    "Jugar mucho y hacerlo bien: quien más partidas clasificatorias acumula y quien más victorias suma con una misma civilización.",
  racha:
    "Ir en racha: la mejor cadena de victorias seguidas y el mejor ratio. Los dos piden un mínimo de partidas clasificatorias.",
  division: "El jugador con más victorias dentro de cada división de la ladder.",
  formato: "El jugador con más victorias en cada tamaño de partida.",
  civilizacion:
    "Carrera a 10 victorias con la misma civilización. Nadie cobra hasta que alguien llega a 10.",
};

type HolderFilter = "todos" | "con" | "sin";

const HOLDER_FILTERS: { id: HolderFilter; label: string }[] = [
  { id: "todos", label: "Todos" },
  { id: "con", label: "Con poseedor" },
  { id: "sin", label: "Sin poseedor" },
];

type ObjectivesBrowserProps = {
  options: ObjectiveOption[];
  /** Rótulos de grupo del catálogo, para no duplicarlos en el cliente. */
  groupLabels: Record<ObjectiveGroup, string>;
};

export function ObjectivesBrowser({ options, groupLabels }: ObjectivesBrowserProps) {
  const [group, setGroup] = useState<ObjectiveGroup | null>(null);
  const [holder, setHolder] = useState<HolderFilter>("todos");

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

  // El filtro de poseedor decide qué objetivos existen para el resto de la
  // vista, incluidos los recuentos de los tipos.
  const byHolder = useMemo(
    () =>
      options.filter((option) => {
        if (holder === "con") {
          return option.holder !== null;
        }

        if (holder === "sin") {
          return option.holder === null;
        }

        return true;
      }),
    [options, holder],
  );

  const visible = useMemo(
    () => (group === null ? byHolder : byHolder.filter((option) => option.group === group)),
    [byHolder, group],
  );

  // Un grupo sin objetivos que pasen el filtro de poseedor no pinta sección:
  // mejor una lista más corta que un titular vacío.
  const sections = useMemo(
    () =>
      groups
        .filter((item) => group === null || item === group)
        .map((item) => {
          const groupOptions = options.filter((option) => option.group === item);
          const shown = byHolder.filter((option) => option.group === item);

          return {
            id: item,
            label: groupLabels[item],
            shown,
            totals: {
              count: groupOptions.length,
              points: groupOptions.reduce((total, option) => total + option.points, 0),
              holders: groupOptions.filter((option) => option.holder !== null).length,
            },
          };
        })
        .filter((section) => section.shown.length > 0),
    [groups, group, byHolder, options, groupLabels],
  );

  const hasFilters = group !== null || holder !== "todos";

  function clearFilters() {
    setGroup(null);
    setHolder("todos");
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-4">
        <FilterCategory label="Tipos" id="filtro-tipos">
          <FilterPill active={group === null} onClick={() => setGroup(null)}>
            Todos
            <Count value={byHolder.length} />
          </FilterPill>
          {groups.map((item) => (
            <FilterPill
              key={item}
              active={group === item}
              onClick={() => setGroup(group === item ? null : item)}
            >
              {groupLabels[item]}
              <Count value={byHolder.filter((option) => option.group === item).length} />
            </FilterPill>
          ))}
        </FilterCategory>

        <FilterCategory label="Poseedor" id="filtro-poseedor">
          {HOLDER_FILTERS.map((item) => (
            <FilterPill
              key={item.id}
              active={holder === item.id}
              onClick={() => setHolder(item.id)}
            >
              {item.label}
            </FilterPill>
          ))}
        </FilterCategory>
      </div>

      {hasFilters ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* Con resultados, el recuento se lee; sin resultados, el aviso grande
              de abajo ya lo dice y esto queda solo para lectores de pantalla. */}
          <p role="status" className={visible.length === 0 ? "sr-only" : "text-xs text-muted"}>
            {visible.length === 1
              ? "1 objetivo coincide con los filtros"
              : `${visible.length} objetivos coinciden con los filtros`}
          </p>
          {visible.length > 0 ? (
            <button
              type="button"
              onClick={clearFilters}
              className="text-xs font-medium text-muted underline-offset-4 transition-colors hover:text-accent hover:underline"
            >
              Quitar filtros
            </button>
          ) : null}
        </div>
      ) : null}

      {visible.length === 0 ? (
        <div className="rounded-lg border border-line bg-surface px-6 py-12 text-center">
          <p className="font-display text-lg font-semibold text-foreground">
            Ningún objetivo coincide con los filtros
          </p>
          <p className="mt-2 text-sm text-muted">
            Prueba a cambiar el tipo de objetivo o el poseedor.
          </p>
          <button
            type="button"
            onClick={clearFilters}
            className="mt-5 inline-flex h-10 items-center rounded-md bg-accent px-4 text-sm font-semibold text-accent-ink transition-colors hover:bg-accent-strong"
          >
            Quitar filtros
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-10">
          {sections.map((section) => (
            <details
              key={section.id}
              id={`grupo-${section.id}`}
              open
              className="group scroll-mt-24"
            >
              <summary className="flex cursor-pointer list-none flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-line pb-3 transition-colors hover:border-line-strong [&::-webkit-details-marker]:hidden">
                <h2 className="font-display text-xl font-semibold text-foreground">
                  {section.label}
                </h2>
                <span className="flex items-center gap-2 text-xs tabular-nums text-muted">
                  {section.totals.count}{" "}
                  {section.totals.count === 1 ? "objetivo" : "objetivos"} ·{" "}
                  {section.totals.points} puntos · {section.totals.holders} con poseedor
                  <svg
                    viewBox="0 0 12 12"
                    aria-hidden="true"
                    className="size-3 shrink-0 text-muted transition-transform group-open:rotate-180"
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
                </span>
              </summary>

              <p className="mt-3 max-w-[68ch] text-sm leading-relaxed text-muted">
                {GROUP_DESCRIPTIONS[section.id]}
              </p>

              <div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {section.shown.map((option) => (
                  <ObjectiveCard key={option.id} option={option} />
                ))}
              </div>
            </details>
          ))}
        </div>
      )}
    </div>
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
      className={`inline-flex h-9 items-center gap-2 rounded-full border px-3 text-xs font-semibold transition-colors ${
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
