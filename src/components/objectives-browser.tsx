"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { MagnifyingGlass } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { Target } from "@phosphor-icons/react/dist/csr/Target";
import { Trophy } from "@phosphor-icons/react/dist/csr/Trophy";
import { ArrowUpRight } from "@phosphor-icons/react/dist/csr/ArrowUpRight";
import { X } from "@phosphor-icons/react/dist/csr/X";
import { CaretDown } from "@phosphor-icons/react/dist/csr/CaretDown";
import type { ObjectiveGroup, ObjectiveOption } from "@/lib/public";
import { ObjectiveDialogCard } from "@/components/objective-dialog-card";
import {
  ObjectiveFamilySection,
  ObjectiveMasterizandoSection,
} from "@/components/objective-family-section";
import { isMasterizandoId } from "@/components/objective-family-rail";
import type { ObjectiveStandingPlayer } from "@/components/objective-standings";

type Props = {
  options: ObjectiveOption[];
  groupLabels: Record<ObjectiveGroup, string>;
  standings: ObjectiveStandingPlayer[] | null;
  mapPool: readonly string[];
};
type Section = {
  id: ObjectiveGroup;
  label: string;
  standalone: ObjectiveOption[];
  masterizando: ObjectiveOption[];
  families: { head: ObjectiveOption; children: ObjectiveOption[] }[];
  count: number;
};

export function ObjectivesBrowser({
  options,
  groupLabels,
  standings,
  mapPool,
}: Props) {
  const [group, setGroup] = useState<ObjectiveGroup | null>(null);
  const [kind, setKind] = useState<"all" | ObjectiveOption["kind"]>("all");
  const [query, setQuery] = useState("");
  const groups = useMemo(
    () => [...new Set(options.map((option) => option.group))],
    [options]
  );
  const heads = useMemo(
    () =>
      new Set(
        options.flatMap((option) => (option.parent ? [option.parent] : []))
      ),
    [options]
  );
  const eligible = useMemo(() => {
    const needle = normalize(query.trim());
    const matchesKind = (option: ObjectiveOption) =>
      kind === "all" || option.kind === kind;
    const matchesText = (option: ObjectiveOption) =>
      !needle ||
      normalize(
        `${option.label} ${option.description} ${groupLabels[option.group]}`
      ).includes(needle);
    const visible = new Set(
      options
        .filter((option) => matchesKind(option) && matchesText(option))
        .map((option) => option.id)
    );
    // Buscar una familia conserva sus civilizaciones; buscar un hijo conserva su cabeza como contexto.
    for (const head of options)
      if (needle && heads.has(head.id) && matchesText(head))
        for (const child of options)
          if (child.parent === head.id && matchesKind(child))
            visible.add(child.id);
    return visible;
  }, [options, query, kind, heads, groupLabels]);
  const sections = useMemo(
    () =>
      groups
        .filter((id) => group === null || id === group)
        .map<Section>((id) => {
          const items = options.filter((option) => option.group === id);
          const standalone: ObjectiveOption[] = [];
          const masterizando: ObjectiveOption[] = [];
          const families: Section["families"] = [];
          for (const option of items) {
            if (heads.has(option.id)) {
              const children = items.filter(
                (child) => child.parent === option.id && eligible.has(child.id)
              );
              if (eligible.has(option.id) || children.length)
                families.push({ head: option, children });
            } else if (option.parent === null && eligible.has(option.id)) {
              if (isMasterizandoId(option.id)) masterizando.push(option);
              else standalone.push(option);
            }
          }
          return {
            id,
            label: groupLabels[id],
            standalone,
            masterizando,
            families,
            count: items.filter((option) => eligible.has(option.id)).length,
          };
        })
        .filter((section) => section.count > 0),
    [groups, group, options, heads, eligible, groupLabels]
  );
  const visibleCount = options.filter(
    (option) =>
      eligible.has(option.id) && (group === null || option.group === group)
  ).length;
  const active = group !== null || kind !== "all" || query.trim() !== "";
  function reset() {
    setGroup(null);
    setKind("all");
    setQuery("");
  }

  return (
    <div className="catalog-layout">
      <aside className="catalog-context" aria-labelledby="catalog-title">
        <h1 id="catalog-title">Objetivos</h1>
        <p>Logros para completar y competiciones para liderar.</p>
        <nav className="catalog-index" aria-label="Grupos de objetivos">
          <button aria-pressed={group === null} onClick={() => setGroup(null)}>
            <Target size={16} aria-hidden="true" />
            <span>Todos los objetivos</span>
            <span>{options.length}</span>
          </button>
          {groups.map((id) => (
            <button
              key={id}
              aria-pressed={group === id}
              onClick={() => setGroup(group === id ? null : id)}
            >
              <span>{groupLabels[id]}</span>
              <span>
                {options.filter((option) => option.group === id).length}
              </span>
            </button>
          ))}
        </nav>
        <div className="catalog-guide">
          <h2>Cómo consultarlos</h2>
          <p>
            Abre un objetivo para ver quién lo disputa y cuánto ha avanzado.
            Gira la tarjeta para consultar su regla.
          </p>
          <Link href="/puntuacion" target="_blank" rel="noopener noreferrer">
            Cómo se puntúa
            <ArrowUpRight size={14} aria-hidden="true" />
          </Link>
        </div>
      </aside>
      <div className="catalog-main">
        <section
          className="catalog-toolbar"
          aria-label="Buscar y filtrar objetivos"
        >
          <label className="catalog-search">
            <MagnifyingGlass size={18} aria-hidden="true" />
            <span className="sr-only">Buscar objetivo o civilización</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Buscar objetivo o civilización…"
            />
          </label>
          <label className="catalog-kind">
            <span className="sr-only">Clase de objetivo</span>
            <select
              value={kind}
              onChange={(event) => setKind(event.target.value as typeof kind)}
            >
              <option value="all">Logros y competiciones</option>
              <option value="achievement">Solo logros</option>
              <option value="competition">Solo competiciones</option>
            </select>
            <CaretDown size={14} aria-hidden="true" />
          </label>
        </section>
        <div className="catalog-result-count">
          <p role="status">
            {active
              ? `${visibleCount} ${visibleCount === 1 ? "objetivo coincide" : "objetivos coinciden"} con los filtros · ${options.length} en el catálogo`
              : `${options.length} objetivos en el catálogo`}
          </p>
          {active ? (
            <button onClick={reset}>
              Limpiar filtros
              <X size={13} aria-hidden="true" />
            </button>
          ) : null}
        </div>
        {standings === null && options.length > 0 ? (
          <p className="catalog-read-notice">
            El catálogo está disponible, pero no se ha podido cargar la lista de
            participantes para consultar los completados.
          </p>
        ) : null}
        {visibleCount === 0 ? (
          <section className="catalog-empty">
            <Trophy size={30} aria-hidden="true" />
            <h2>
              {options.length
                ? "No hay objetivos que coincidan"
                : "No hay objetivos activos"}
            </h2>
            <p>
              {options.length
                ? "Prueba otro nombre, otra civilización o quita los filtros."
                : "Los objetivos aparecerán cuando la organización publique el catálogo de esta edición."}
            </p>
            {options.length ? (
              <button className="home-primary" onClick={reset}>
                Ver todos los objetivos
              </button>
            ) : (
              <Link
                href="/puntuacion"
                target="_blank"
                rel="noopener noreferrer"
              >
                Consultar la puntuación
                <ArrowUpRight size={14} aria-hidden="true" />
              </Link>
            )}
          </section>
        ) : (
          <div className="catalog-sections">
            {sections.map((section) => (
              <section
                key={section.id}
                id={`grupo-${section.id}`}
                className="catalog-group"
              >
                <header className="catalog-group-heading">
                  <h2>{section.label}</h2>
                  <span>
                    {section.count}{" "}
                    {section.count === 1 ? "objetivo" : "objetivos"}
                  </span>
                </header>
                <div className="catalog-group-content">
                  {section.masterizando.length ? (
                    <div className="catalog-family-block">
                      <ObjectiveMasterizandoSection
                        catalog
                        subobjectives={section.masterizando}
                        standings={standings}
                      />
                    </div>
                  ) : null}
                  {section.families.map((family) => (
                    <div key={family.head.id} className="catalog-family-block">
                      <ObjectiveFamilySection
                        catalog
                        head={family.head}
                        subobjectives={family.children}
                        allSubobjectives={options.filter(
                          (option) => option.parent === family.head.id
                        )}
                        standings={standings}
                        mapPool={mapPool}
                      />
                    </div>
                  ))}
                  {section.standalone.length ? (
                    <div className="catalog-grid">
                      {section.standalone.map((option) => (
                        <ObjectiveDialogCard
                          catalog
                          key={option.id}
                          option={option}
                          standings={standings}
                          mapPool={mapPool}
                        />
                      ))}
                    </div>
                  ) : null}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function normalize(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

export function ObjectivesReload() {
  return (
    <button
      type="button"
      className="home-primary"
      onClick={() => window.location.reload()}
    >
      Volver a cargar
    </button>
  );
}
