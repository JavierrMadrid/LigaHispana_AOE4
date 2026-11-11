"use client";

import { useEffect, useRef } from "react";
import { Broadcast } from "@phosphor-icons/react/dist/csr/Broadcast";
import { CaretDown } from "@phosphor-icons/react/dist/csr/CaretDown";
import { SlidersHorizontal } from "@phosphor-icons/react/dist/csr/SlidersHorizontal";
import type { DivisionId } from "@/lib/public";
import { DIVISION_UI } from "@/components/division-icon";
import { LeagueIcon, leagueFilterRank } from "@/components/league-icon";

type LiveMatchesFiltersProps = {
  formats: readonly string[];
  format: string | null;
  onFormatChange: (value: string | null) => void;
  divisions: readonly DivisionId[];
  onDivisionsChange: (value: DivisionId[]) => void;
  liveOnly: boolean;
  onLiveOnlyChange: (value: boolean) => void;
};

export function LiveMatchesFilters({
  formats,
  format,
  onFormatChange,
  divisions,
  onDivisionsChange,
  liveOnly,
  onLiveOnlyChange,
}: LiveMatchesFiltersProps) {
  const menu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    function dismiss(event: PointerEvent) {
      if (!menu.current?.contains(event.target as Node))
        menu.current?.removeAttribute("open");
    }
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, []);
  function toggleDivision(id: DivisionId) {
    onDivisionsChange(
      divisions.includes(id)
        ? divisions.filter((value) => value !== id)
        : [...divisions, id]
    );
  }
  return (
    <div className="matches-filters">
      <label className="matches-field">
        <span>Tipo de partida</span>
        <span className="matches-select-wrap">
          <select
            value={format ?? ""}
            onChange={(event) => onFormatChange(event.target.value || null)}
          >
            <option value="">Todos los formatos</option>
            {formats.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
          <CaretDown size={15} aria-hidden="true" />
        </span>
      </label>
      <div className="matches-field">
        <span id="matches-division-label">División de la liga</span>
        <details
          ref={menu}
          className="matches-division-menu"
          onKeyDown={(event) => {
            if (event.key === "Escape" && menu.current?.open) {
              event.preventDefault();
              menu.current.removeAttribute("open");
              menu.current.querySelector("summary")?.focus();
            }
          }}
        >
          <summary aria-labelledby="matches-division-label matches-division-value">
            <SlidersHorizontal size={17} aria-hidden="true" />
            <span id="matches-division-value">
              {divisions.length
                ? `${divisions.length} ${
                    divisions.length === 1 ? "división" : "divisiones"
                  }`
                : "Todas las divisiones"}
            </span>
            <CaretDown size={15} aria-hidden="true" />
          </summary>
          <fieldset className="matches-division-panel">
            <legend className="sr-only">Filtrar por divisiones</legend>
            <p>Al menos un jugador de la liga</p>
            {DIVISION_UI.map((item) => (
              <label key={item.id}>
                <LeagueIcon
                  rank={leagueFilterRank(item.id)}
                  className="matches-division-emblem"
                />
                <span>{item.label}</span>
                <input
                  type="checkbox"
                  checked={divisions.includes(item.id)}
                  onChange={() => toggleDivision(item.id)}
                />
              </label>
            ))}
            <button
              type="button"
              onClick={() => onDivisionsChange([])}
              disabled={!divisions.length}
            >
              Mostrar todas
            </button>
          </fieldset>
        </details>
      </div>
      <div className="matches-field">
        <span>Retransmisiones</span>
        <button
          type="button"
          className="matches-live-filter"
          aria-pressed={liveOnly}
          onClick={() => onLiveOnlyChange(!liveOnly)}
        >
          <Broadcast size={18} aria-hidden="true" />
          Solo con directos
          <span className="matches-toggle" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
