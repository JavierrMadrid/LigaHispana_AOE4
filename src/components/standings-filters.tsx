"use client";

import type { ReactNode } from "react";
import type { DivisionId } from "@/lib/public";
import { DIVISION_UI, DivisionIcon } from "@/components/division-icon";

type StandingsFiltersProps = {
  query: string;
  onQueryChange: (value: string) => void;
  playingOnly: boolean;
  onPlayingOnlyChange: (value: boolean) => void;
  liveOnly: boolean;
  onLiveOnlyChange: (value: boolean) => void;
  division: DivisionId | null;
  onDivisionChange: (value: DivisionId | null) => void;
};

/**
 * Barra de filtros de la clasificación: búsqueda por nombre o canal a la
 * izquierda, toggles de estado y selección única de división a la derecha. En
 * móvil se apila en dos bloques.
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
}: StandingsFiltersProps) {
  return (
    <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="sm:w-[300px]">
          <label htmlFor="buscar-jugador" className="sr-only">
            Buscar jugador
          </label>
          <input
            id="buscar-jugador"
            type="search"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Buscar jugador"
            autoComplete="off"
            className="h-9 w-full rounded-md border border-line bg-surface px-3 text-sm text-foreground transition-colors placeholder:text-muted/70 focus:border-accent/60"
          />
        </div>

        <div className="flex items-center gap-2">
          <FilterPill
            active={playingOnly}
            onClick={() => onPlayingOnlyChange(!playingOnly)}
            dotClass="bg-accent"
            activeClass="border-accent/50 bg-accent/10 text-accent"
          >
            En partida
          </FilterPill>
          <FilterPill
            active={liveOnly}
            onClick={() => onLiveOnlyChange(!liveOnly)}
            dotClass="bg-twitch"
            activeClass="border-twitch/50 bg-twitch/10 text-twitch-soft"
          >
            En directo
          </FilterPill>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          aria-pressed={division === null}
          onClick={() => onDivisionChange(null)}
          className={`h-9 rounded-md px-3 text-xs font-semibold transition-colors ${
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
              className={`flex size-9 items-center justify-center rounded-md border transition-colors ${
                active
                  ? item.activeClass
                  : "border-transparent bg-surface text-muted hover:bg-surface-raised hover:text-foreground"
              }`}
            >
              <DivisionIcon division={item.id} className="size-5" />
            </button>
          );
        })}
      </div>
    </div>
  );
}

function FilterPill({
  active,
  onClick,
  dotClass,
  activeClass,
  children,
}: {
  active: boolean;
  onClick: () => void;
  dotClass: string;
  activeClass: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`inline-flex h-9 items-center gap-2 rounded-full border px-3 text-xs font-semibold transition-colors ${
        active
          ? activeClass
          : "border-line bg-surface text-muted hover:bg-surface-raised hover:text-foreground"
      }`}
    >
      <span
        aria-hidden="true"
        className={`size-1.5 rounded-full ${dotClass} ${
          active ? "motion-safe:animate-pulse" : "opacity-50"
        }`}
      />
      {children}
    </button>
  );
}