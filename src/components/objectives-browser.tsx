"use client";

import { useMemo, useState, type ReactNode } from "react";
import type { ObjectiveGroup, ObjectiveOption, ObjectiveView } from "@/lib/public";
import { ObjectiveCard } from "@/components/objective-card";
import { ObjectiveRankingDialog } from "@/components/objective-ranking-dialog";

/**
 * Objetivos especiales agrupados por familia.
 *
 * El servidor entrega los objetivos ya resueltos y aquí solo se agrupa y se
 * filtra por tipo. El `ranking` completo de un objetivo no se pinta en la
 * tarjeta: se enseña entero en el diálogo que abre "Ver clasificación", para
 * que la rejilla se pueda escanear de un vistazo. Las secciones arrancan
 * abiertas porque el contenido es la página; plegarlas es una comodidad para
 * quien quiere ir directo a un grupo.
 */

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

              <div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {section.shown.map((option) => (
                  <ObjectiveCard
                    key={option.id}
                    option={option}
                    onOpen={() => setActive(option)}
                  />
                ))}
              </div>
            </details>
          ))}
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
