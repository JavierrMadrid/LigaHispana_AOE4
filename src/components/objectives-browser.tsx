"use client";

import { useMemo, useState, type ReactNode } from "react";
import type { ObjectiveGroup, ObjectiveOption } from "@/lib/public";
import { ObjectiveDialogCard } from "@/components/objective-dialog-card";
import { ObjectiveFamilySection } from "@/components/objective-family-section";
import type { ObjectiveStandingPlayer } from "@/components/objective-standings";

type ObjectivesBrowserProps = {
  options: ObjectiveOption[];
  /** Rótulos de grupo del catálogo, para no duplicarlos en el cliente. */
  groupLabels: Record<ObjectiveGroup, string>;
  /** Clasificación del torneo, para el check de "Ver completados". */
  standings: ObjectiveStandingPlayer[] | null;
  /** Pool de mapas activo, solo para explicar `por-tierra-y-agua`. */
  mapPool: readonly string[];
};

type GroupSection = {
  id: ObjectiveGroup;
  label: string;
  /** Objetivos sin familia: tarjetas individuales. */
  standalone: ObjectiveOption[];
  /** Familias: cabeza + subobjetivos, en tarjeta agrupada. */
  families: { head: ObjectiveOption; children: ObjectiveOption[] }[];
  totals: { count: number; points: number; holders: number };
};

/**
 * Los objetivos especiales, agrupados por tipo.
 *
 * El servidor entrega los objetivos ya resueltos y aquí se agrupan por tipo y se
 * separan las familias (un logro cabeza con sus subobjetivos por civilización) de
 * los objetivos sueltos. Los sueltos son tarjetas que abren su clasificación a
 * tamaño ventana; una familia se lee como un bloque: la cabeza arriba, el filtro
 * de banderas y un riel con una tarjeta por civilización. La clasificación no se
 * pinta en la rejilla: se enseña al abrir cada tarjeta.
 */
export function ObjectivesBrowser({
  options,
  groupLabels,
  standings,
  mapPool,
}: ObjectivesBrowserProps) {
  const [group, setGroup] = useState<ObjectiveGroup | null>(null);

  const groups = useMemo(() => {
    const order: ObjectiveGroup[] = [];

    for (const option of options) {
      if (!order.includes(option.group)) {
        order.push(option.group);
      }
    }

    return order;
  }, [options]);

  // Una cabeza de familia es un objetivo que no cuelga de nadie pero del que
  // cuelga alguien. Se resuelve con `parent`, sin mirar ids.
  const heads = useMemo(() => {
    const parents = new Set(
      options.map((option) => option.parent).filter((id): id is string => id !== null),
    );

    return new Set(options.filter((option) => parents.has(option.id)).map((option) => option.id));
  }, [options]);

  const sections = useMemo<GroupSection[]>(
    () =>
      groups
        .filter((item) => group === null || item === group)
        .map((item) => {
          const groupOptions = options.filter((option) => option.group === item);
          const standalone: ObjectiveOption[] = [];
          const families: { head: ObjectiveOption; children: ObjectiveOption[] }[] = [];

          for (const option of groupOptions) {
            if (heads.has(option.id)) {
              families.push({
                head: option,
                children: groupOptions.filter((child) => child.parent === option.id),
              });
              continue;
            }

            if (option.parent === null) {
              standalone.push(option);
            }
          }

          return {
            id: item,
            label: groupLabels[item],
            standalone,
            families,
            totals: {
              count: groupOptions.length,
              points: groupOptions.reduce((total, option) => total + option.points, 0),
              holders: groupOptions.filter(
                (option) => option.holder !== null || option.beneficiaries.length > 0,
              ).length,
            },
          };
        }),
    [groups, group, options, groupLabels, heads],
  );

  const visibleCount = useMemo(
    () => (group === null ? options.length : options.filter((option) => option.group === group).length),
    [options, group],
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-lg border border-line bg-surface p-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
          <span id="filtro-tipos" className="shrink-0 text-xs font-semibold text-muted sm:w-20">
            Tipos
          </span>
          <div role="group" aria-labelledby="filtro-tipos" className="flex flex-wrap items-center gap-2">
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
          </div>
        </div>
      </div>

      {visibleCount === 0 ? (
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
        <div className="flex flex-col gap-12">
          {sections.map((section) => (
            <section key={section.id} id={`grupo-${section.id}`} className="scroll-mt-24">
              <h2 className="flex flex-col gap-1 border-b border-line pb-3 sm:flex-row sm:flex-wrap sm:items-baseline sm:justify-between sm:gap-x-4">
                <span className="font-display text-xl font-semibold text-foreground">
                  {section.label}
                </span>
                <span className="text-xs tabular-nums text-muted">
                  {section.totals.count} {section.totals.count === 1 ? "objetivo" : "objetivos"} ·{" "}
                  {section.totals.points} puntos · {section.totals.holders} con poseedor o
                  completados
                </span>
              </h2>

              <div className="mt-5 flex flex-col gap-10">
                {section.families.map((family) => (
                  <ObjectiveFamilySection
                    key={family.head.id}
                    head={family.head}
                    subobjectives={family.children}
                    standings={standings}
                    mapPool={mapPool}
                  />
                ))}

                {section.standalone.length > 0 ? (
                  <div className="flex flex-col gap-4">
                    {section.families.length > 0 ? (
                      <h3 className="text-sm font-semibold text-muted">
                        {section.id === "civilizacion"
                          ? "Competiciones por civilización"
                          : "Otros objetivos"}
                      </h3>
                    ) : null}
                    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                      {section.standalone.map((option) => (
                        <ObjectiveDialogCard
                          key={option.id}
                          option={option}
                          standings={standings}
                          mapPool={mapPool}
                        />
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            </section>
          ))}
        </div>
      )}
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
