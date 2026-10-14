"use client";

import type { DivisionId } from "@/lib/public";
import { DIVISION_UI } from "@/components/division-icon";
import { FilterPill, LiveFilterPill } from "@/components/filter-pill";
import { LeagueIcon, leagueFilterRank } from "@/components/league-icon";

type LiveMatchesFiltersProps = {
  /** Tipos de partida presentes ahora mismo, en orden de lectura. */
  formats: readonly string[];
  format: string | null;
  onFormatChange: (value: string | null) => void;
  division: DivisionId | null;
  onDivisionChange: (value: DivisionId | null) => void;
  liveOnly: boolean;
  onLiveOnlyChange: (value: boolean) => void;
};

/**
 * Barra de filtros de las partidas en juego: el tipo de partida a la izquierda
 * (el eje principal: 1vs1, 2vs2…) y a la derecha lo que estrecha esa lista —el
 * filtro de directo y la división, cada uno en su grupo porque son ejes
 * distintos—. En móvil cae en dos bloques, como en la clasificación.
 *
 * El filtro de directo se pinta siempre, aunque ahora mismo no haya nadie
 * emitiendo: la clasificación hace lo mismo, y un botón que aparece y desaparece
 * entre dos lecturas de la misma página se lee como un fallo. Si no deja pasar
 * nada, el estado vacío lo explica.
 *
 * Solo se ofrecen los tipos que existen entre las partidas cargadas: un filtro
 * que no puede devolver nada no se pinta.
 */
export function LiveMatchesFilters({
  formats,
  format,
  onFormatChange,
  division,
  onDivisionChange,
  liveOnly,
  onLiveOnlyChange,
}: LiveMatchesFiltersProps) {
  return (
    <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
      <div
        role="group"
        aria-label="Filtrar por tipo de partida"
        className="flex flex-wrap items-center gap-1.5"
      >
        <FilterPill
          active={format === null}
          onClick={() => onFormatChange(null)}
          activeClass="border-accent bg-accent text-accent-ink"
        >
          Todos
        </FilterPill>

        {formats.map((item) => (
          <FilterPill
            key={item}
            active={format === item}
            onClick={() => onFormatChange(format === item ? null : item)}
            activeClass="border-accent bg-accent text-accent-ink"
          >
            {item}
          </FilterPill>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <LiveFilterPill active={liveOnly} onToggle={onLiveOnlyChange} />

        <div
          role="group"
          aria-label="Filtrar por división"
          className="flex flex-wrap items-center gap-1.5"
        >
          <button
            type="button"
            aria-pressed={division === null}
            onClick={() => onDivisionChange(null)}
            className={`h-10 rounded-md px-3 text-xs font-semibold active:translate-y-px transition-colors ${
              division === null
                ? "bg-accent text-accent-ink"
                : "bg-surface text-muted hover:bg-surface-raised hover:text-foreground"
            }`}
          >
            Todas
          </button>

          {DIVISION_UI.map((item) => {
            const active = division === item.id;

            return (
              <button
                key={item.id}
                type="button"
                aria-pressed={active}
                aria-label={`Filtrar por división ${item.label}`}
                title={item.label}
                onClick={() => onDivisionChange(active ? null : item.id)}
                className={`flex size-10 items-center justify-center rounded-md border active:translate-y-px transition-colors ${
                  active
                    ? item.activeClass
                    : "border-transparent bg-surface text-muted hover:bg-surface-raised hover:text-foreground"
                }`}
              >
                <LeagueIcon rank={leagueFilterRank(item.id)} className="h-6 w-4" />
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
