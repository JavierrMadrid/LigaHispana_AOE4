"use client";

import type { ReactNode } from "react";
import type { DivisionId } from "@/lib/public";
import { DIVISION_UI } from "@/components/division-icon";
import { LeagueIcon, leagueFilterRank } from "@/components/league-icon";
import { TwitchIcon } from "@/components/twitch-icon";

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
 * Barra de filtros de la clasificación: búsqueda por nombre de display, nombre
 * oficial o canal a la izquierda, toggles de estado y selección única de
 * división a la derecha. En
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
            className="h-10 w-full rounded-md border border-line bg-surface px-3 text-sm text-foreground transition-colors placeholder:text-muted"
          />
        </div>

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
          <FilterPill
            active={liveOnly}
            onClick={() => onLiveOnlyChange(!liveOnly)}
            activeClass="border-twitch/50 bg-twitch/10 text-twitch-soft"
            mark={
              <TwitchIcon
                className={`size-3.5 ${liveOnly ? "" : "opacity-50"}`}
              />
            }
          >
            En directo
          </FilterPill>
        </div>
      </div>

      <div
        role="group"
        aria-label="Filtrar por división"
        className="flex flex-wrap items-center gap-1.5"
      >
        <button
          type="button"
          aria-pressed={division === null}
          onClick={() => onDivisionChange(null)}
          className={`h-10 rounded-md px-3 text-xs font-semibold transition-colors ${
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
              className={`flex size-10 items-center justify-center rounded-md border transition-colors ${
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
      className={`inline-flex h-10 items-center gap-2 rounded-full border px-3 text-xs font-semibold transition-colors ${
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