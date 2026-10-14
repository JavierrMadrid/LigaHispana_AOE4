"use client";

import type { DivisionId } from "@/lib/public";
import { DIVISION_UI } from "@/components/division-icon";
import { FilterPill, LiveFilterPill } from "@/components/filter-pill";
import { LeagueIcon, leagueFilterRank } from "@/components/league-icon";

/**
 * Controles de la clasificación, desmontados en piezas reutilizables.
 *
 * La misma barra se lee de dos maneras: en escritorio (`StandingsFilters`) va
 * desplegada bajo la tabla; en móvil, dentro del panel de `MobileStandingsControls`,
 * donde solo se enseña al pedirla. Por eso el buscador, los toggles de estado y
 * los botones de división viven aquí como piezas sueltas: cada forma decide qué
 * enseña y dónde, pero el comportamiento no se duplica. La píldora en sí, que es
 * la misma en las dos pantallas que filtran, la trae `filter-pill.tsx`.
 */

/** Buscador por nombre de display, nombre oficial o canal. */
export function SearchField({
  id,
  query,
  onQueryChange,
  className,
}: {
  /** Único por instancia: la vista de escritorio y la de móvil conviven en el DOM. */
  id: string;
  query: string;
  onQueryChange: (value: string) => void;
  className?: string;
}) {
  return (
    <div className={className}>
      <label htmlFor={id} className="sr-only">
        Buscar jugador
      </label>
      <input
        id={id}
        type="search"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        placeholder="Buscar jugador"
        autoComplete="off"
        className="h-10 w-full rounded-md border border-line bg-surface px-3 text-sm text-foreground transition-colors placeholder:text-muted"
      />
    </div>
  );
}

/** Toggles de estado: "en partida" y "en directo". */
export function StatusFilterPills({
  playingOnly,
  onPlayingOnlyChange,
  liveOnly,
  onLiveOnlyChange,
}: {
  playingOnly: boolean;
  onPlayingOnlyChange: (value: boolean) => void;
  liveOnly: boolean;
  onLiveOnlyChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <FilterPill
        active={playingOnly}
        onClick={() => onPlayingOnlyChange(!playingOnly)}
        activeClass="border-live/50 bg-live/10 text-live-soft"
        mark={
          <span
            aria-hidden="true"
            className={`size-1.5 rounded-full bg-live ${
              playingOnly ? "motion-safe:animate-pulse" : "opacity-50"
            }`}
          />
        }
      >
        En partida
      </FilterPill>
      <LiveFilterPill active={liveOnly} onToggle={onLiveOnlyChange} />
    </div>
  );
}

/**
 * Selección múltiple de división: "Todas" más los seis emblemas.
 *
 * Cada emblema se enciende y se apaga por su cuenta, así que se pueden pedir
 * varias divisiones a la vez y una fila entra si la suya está entre las
 * marcadas. Sin ninguna marcada no hay filtro de división —entran todas,
 * incluidas las que no tienen división resuelta— y "Todas" es el atajo que
 * limpia la selección.
 */
export function DivisionFilterButtons({
  divisions,
  onDivisionsChange,
}: {
  divisions: readonly DivisionId[];
  onDivisionsChange: (value: DivisionId[]) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Filtrar por división"
      className="flex flex-wrap items-center gap-1.5"
    >
      <button
        type="button"
        aria-pressed={divisions.length === 0}
        onClick={() => onDivisionsChange([])}
        className={`h-10 rounded-md px-3 text-xs font-semibold active:translate-y-px transition-colors ${
          divisions.length === 0
            ? "bg-accent text-accent-ink"
            : "bg-surface text-muted hover:bg-surface-raised hover:text-foreground"
        }`}
      >
        Todas
      </button>

      {DIVISION_UI.map((item) => {
        const active = divisions.includes(item.id);

        return (
          <button
            key={item.id}
            type="button"
            aria-pressed={active}
            aria-label={`Filtrar por división ${item.label}`}
            title={item.label}
            onClick={() =>
              onDivisionsChange(
                active
                  ? divisions.filter((division) => division !== item.id)
                  : [...divisions, item.id],
              )
            }
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
  );
}

/**
 * Barra de filtros de escritorio: búsqueda por nombre de display, nombre oficial
 * o canal a la izquierda y toggles de estado y división a la derecha. La
 * composición de escritorio es una sola fila; el orden de las columnas ya está
 * resuelto en las cabeceras de la tabla, así que aquí no hay control de orden.
 *
 * Solo se pinta a partir de `lg`, que es donde vive la tabla. Por debajo manda
 * `MobileStandingsControls`, que pliega estos mismos controles tras un botón.
 */
export function StandingsFilters({
  query,
  onQueryChange,
  playingOnly,
  onPlayingOnlyChange,
  liveOnly,
  onLiveOnlyChange,
  divisions,
  onDivisionsChange,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  playingOnly: boolean;
  onPlayingOnlyChange: (value: boolean) => void;
  liveOnly: boolean;
  onLiveOnlyChange: (value: boolean) => void;
  divisions: readonly DivisionId[];
  onDivisionsChange: (value: DivisionId[]) => void;
}) {
  return (
    <div className="hidden flex-col gap-3 lg:flex lg:flex-row lg:items-center lg:justify-between">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <SearchField
          id="buscar-jugador"
          query={query}
          onQueryChange={onQueryChange}
          className="sm:w-[300px]"
        />
        <StatusFilterPills
          playingOnly={playingOnly}
          onPlayingOnlyChange={onPlayingOnlyChange}
          liveOnly={liveOnly}
          onLiveOnlyChange={onLiveOnlyChange}
        />
      </div>

      <DivisionFilterButtons divisions={divisions} onDivisionsChange={onDivisionsChange} />
    </div>
  );
}
