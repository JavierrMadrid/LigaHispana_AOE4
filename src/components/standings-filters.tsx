"use client";

import type { ReactNode } from "react";
import type { DivisionId } from "@/lib/public";
import { DIVISION_UI } from "@/components/division-icon";
import { KickIcon } from "@/components/kick-icon";
import { LeagueIcon, leagueFilterRank } from "@/components/league-icon";
import { TwitchIcon } from "@/components/twitch-icon";
import { YoutubeIcon } from "@/components/youtube-icon";

/**
 * Controles de la clasificación, desmontados en piezas reutilizables.
 *
 * La misma barra se lee de dos maneras: en escritorio (`StandingsFilters`) va
 * desplegada bajo la tabla; en móvil, dentro del panel de `MobileStandingsControls`,
 * donde solo se enseña al pedirla. Por eso el buscador, los toggles de estado y
 * los botones de división viven aquí como piezas sueltas: cada forma decide qué
 * enseña y dónde, pero el comportamiento no se duplica.
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
      {/* El filtro cubre las tres plataformas, así que su marca son los tres
          iconos (no solo el de Twitch): un directo puede estar en cualquiera de
          ellas y el icono único diría que solo se busca en esa. */}
      <FilterPill
        active={liveOnly}
        onClick={() => onLiveOnlyChange(!liveOnly)}
        activeClass="border-live/50 bg-live/10 text-live-soft"
        mark={
          <span className="flex items-center gap-0.5">
            <TwitchIcon className={`size-3 ${liveOnly ? "text-twitch" : "text-muted/60"}`} />
            <YoutubeIcon className={`size-3 ${liveOnly ? "text-youtube" : "text-muted/60"}`} />
            <KickIcon className={`size-3 ${liveOnly ? "text-kick" : "text-muted/60"}`} />
          </span>
        }
      >
        En directo
      </FilterPill>
    </div>
  );
}

/** Selección única de división: "Todas" más los seis emblemas. */
export function DivisionFilterButtons({
  division,
  onDivisionChange,
}: {
  division: DivisionId | null;
  onDivisionChange: (value: DivisionId | null) => void;
}) {
  return (
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
  division,
  onDivisionChange,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  playingOnly: boolean;
  onPlayingOnlyChange: (value: boolean) => void;
  liveOnly: boolean;
  onLiveOnlyChange: (value: boolean) => void;
  division: DivisionId | null;
  onDivisionChange: (value: DivisionId | null) => void;
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

      <DivisionFilterButtons division={division} onDivisionChange={onDivisionChange} />
    </div>
  );
}

function FilterPill({
  active,
  onClick,
  activeClass,
  mark,
  children,
}: {
  active: boolean;
  onClick: () => void;
  activeClass: string;
  /** Marca de estado a la izquierda del texto; hereda el color del pill. */
  mark: ReactNode;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`inline-flex h-10 items-center gap-2 rounded-full border px-3 text-xs font-semibold active:translate-y-px transition-colors ${
        active
          ? activeClass
          : "border-line bg-surface text-muted hover:bg-surface-raised hover:text-foreground"
      }`}
    >
      <span aria-hidden="true" className="flex h-3.5 shrink-0 items-center justify-center">
        {mark}
      </span>
      {children}
    </button>
  );
}
