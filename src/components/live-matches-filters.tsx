"use client";

import type { DivisionId } from "@/lib/public";
import { FilterPill, LiveFilterPill } from "@/components/filter-pill";
import { DivisionFilterButtons } from "@/components/standings-filters";

type LiveMatchesFiltersProps = {
  /** Tipos de partida presentes ahora mismo, en orden de lectura. */
  formats: readonly string[];
  format: string | null;
  onFormatChange: (value: string | null) => void;
  /** Divisiones marcadas; sin ninguna, no hay filtro de división. */
  divisions: readonly DivisionId[];
  onDivisionsChange: (value: DivisionId[]) => void;
  liveOnly: boolean;
  onLiveOnlyChange: (value: boolean) => void;
};

/**
 * Barra de filtros de las partidas en juego: el tipo de partida a la izquierda
 * (el eje principal: 1vs1, 2vs2…) y a la derecha lo que estrecha esa lista —el
 * filtro de directo y las divisiones, cada uno en su grupo porque son ejes
 * distintos—. En móvil cae en dos bloques, como en la clasificación.
 *
 * El filtro de directo se pinta siempre, aunque ahora mismo no haya nadie
 * emitiendo: la clasificación hace lo mismo, y un botón que aparece y desaparece
 * entre dos lecturas de la misma página se lee como un fallo. Si no deja pasar
 * nada, el estado vacío lo explica.
 *
 * Solo se ofrecen los tipos que existen entre las partidas cargadas: un filtro
 * que no puede devolver nada no se pinta.
 *
 * Los emblemas de división son los mismos que los de la clasificación, así que
 * se traen de allí en vez de repetir el marcado: dos copias del mismo control se
 * separan en cuanto una cambia.
 */
export function LiveMatchesFilters({
  formats,
  format,
  onFormatChange,
  divisions,
  onDivisionsChange,
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
        <DivisionFilterButtons divisions={divisions} onDivisionsChange={onDivisionsChange} />
      </div>
    </div>
  );
}
