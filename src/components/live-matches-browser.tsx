"use client";

import { useMemo, useState } from "react";
import { MagnifyingGlass } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { CaretDown } from "@phosphor-icons/react/dist/csr/CaretDown";
import { X } from "@phosphor-icons/react/dist/csr/X";
import { Broadcast } from "@phosphor-icons/react/dist/csr/Broadcast";
import { Funnel } from "@phosphor-icons/react/dist/csr/Funnel";
import type { DivisionId, LiveMatch } from "@/lib/public";
import { paginateRows } from "@/lib/pagination";
import { LiveMatchCard } from "@/components/live-match-card";
import { LiveMatchesFilters } from "@/components/live-matches-filters";
import { participantIsLive } from "@/components/live-channels";

const FORMAT_ORDER = [
  "1vs1",
  "2v2",
  "2vs2",
  "3v3",
  "3vs3",
  "4v4",
  "4vs4",
  "Por equipos",
];

export function LiveMatchesBrowser({
  matches,
  previewThumbnails = false,
}: {
  matches: LiveMatch[];
  previewThumbnails?: boolean;
}) {
  const [format, setFormat] = useState<string | null>(null);
  const [divisions, setDivisions] = useState<DivisionId[]>([]);
  const [liveOnly, setLiveOnly] = useState(false);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("original");
  const [page, setPage] = useState(1);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const activeFilterCount =
    (format !== null ? 1 : 0) +
    (divisions.length > 0 ? 1 : 0) +
    (liveOnly ? 1 : 0);
  const formats = useMemo(() => {
    const present = new Set(matches.map((match) => match.format));
    return [
      ...FORMAT_ORDER.filter((value) => present.has(value)),
      ...[...present]
        .filter((value) => !FORMAT_ORDER.includes(value))
        .sort((left, right) => left.localeCompare(right, "es")),
    ];
  }, [matches]);
  const filtered = useMemo(() => {
    const needle = normalize(query.trim());
    return matches.filter((match) => {
      if (format !== null && match.format !== format) return false;
      if (
        divisions.length > 0 &&
        !match.participants.some(
          (participant) =>
            participant.division !== null &&
            divisions.includes(participant.division)
        )
      )
        return false;
      if (liveOnly && !match.participants.some(participantIsLive)) return false;
      if (
        needle &&
        !normalize(
          `${match.map ?? ""} ${match.format} ${match.participants
            .map(
              (player) =>
                `${player.name} ${player.twitchChannel ?? ""} ${
                  player.youtubeChannel ?? ""
                } ${player.kickChannel ?? ""}`
            )
            .join(" ")}`
        ).includes(needle)
      )
        return false;
      return true;
    });
  }, [matches, format, divisions, liveOnly, query]);
  const sorted = useMemo(() => {
    if (sort === "original") return filtered;
    return [...filtered].sort((left, right) =>
      sort === "map"
        ? (left.map ?? "").localeCompare(right.map ?? "", "es")
        : sort === "duration-desc"
        ? right.elapsedSeconds - left.elapsedSeconds
        : left.elapsedSeconds - right.elapsedSeconds
    );
  }, [filtered, sort]);
  const pagination = paginateRows(sorted, page, 12);
  const hasFilters =
    format !== null || divisions.length > 0 || liveOnly || query.trim() !== "";
  function clearFilters() {
    setPage(1);
    setQuery("");
    setFormat(null);
    setDivisions([]);
    setLiveOnly(false);
  }
  const onlyLive =
    liveOnly && format === null && divisions.length === 0 && !query.trim();

  return (
    <section className="matches-browser" aria-labelledby="matches-list-heading">
      <div className="matches-browser-top">
        <h2 id="matches-list-heading">Enfrentamientos</h2>
        <label className="matches-search">
          <MagnifyingGlass size={18} aria-hidden="true" />
          <span className="sr-only">Buscar jugador, canal o mapa</span>
          <input
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(1);
            }}
            placeholder="Buscar jugador o mapa…"
          />
        </label>
        <button
          type="button"
          className="matches-mobile-filter-trigger"
          aria-expanded={filtersOpen}
          aria-controls="matches-filter-area"
          onClick={() => setFiltersOpen(!filtersOpen)}
        >
          <Funnel size={17} aria-hidden="true" />
          Filtros
          {activeFilterCount > 0 ? <span>{activeFilterCount}</span> : null}
        </button>
      </div>
      <div
        id="matches-filter-area"
        className={`matches-filter-area ${
          filtersOpen ? "matches-filters-open" : ""
        }`}
      >
        <LiveMatchesFilters
          formats={formats}
          format={format}
          onFormatChange={(value) => {
            setPage(1);
            setFormat(value);
          }}
          divisions={divisions}
          onDivisionsChange={(value) => {
            setPage(1);
            setDivisions(value);
          }}
          liveOnly={liveOnly}
          onLiveOnlyChange={(value) => {
            setPage(1);
            setLiveOnly(value);
          }}
        />
      </div>
      <div className="matches-results-bar">
        <p role="status">
          {pagination.total
            ? `${pagination.start}–${pagination.end} de ${pagination.total} ${
                pagination.total === 1 ? "partida" : "partidas"
              }`
            : "0 partidas"}
          {liveOnly ? " con alguien en directo" : ""}
        </p>
        <div className="matches-results-actions">
          {hasFilters ? (
            <button onClick={clearFilters}>
              Limpiar filtros
              <X size={14} aria-hidden="true" />
            </button>
          ) : null}
          <label>
            <span className="sr-only">Ordenar partidas</span>
            <span className="matches-select-wrap">
              <select
                value={sort}
                onChange={(event) => {
                  setSort(event.target.value);
                  setPage(1);
                }}
              >
                <option value="original">Orden original</option>
                <option value="duration-desc">Mayor duración</option>
                <option value="duration-asc">Menor duración</option>
                <option value="map">Mapa (A–Z)</option>
              </select>
              <CaretDown size={14} aria-hidden="true" />
            </span>
          </label>
        </div>
      </div>
      {filtered.length === 0 ? (
        <div className="matches-empty matches-filtered-empty">
          <Broadcast size={30} aria-hidden="true" />
          <h3>
            {onlyLive
              ? "Ninguna partida tiene a alguien en directo"
              : "Ninguna partida coincide con los filtros"}
          </h3>
          <p>
            {onlyLive
              ? "Solo se muestran emisiones comprobadas. Quita el filtro para volver a ver todas las partidas en juego."
              : "Prueba otro jugador o mapa, o quita alguno de los filtros."}
          </p>
          <button type="button" onClick={clearFilters} className="home-primary">
            Quitar filtros
          </button>
        </div>
      ) : (
        <ul className="matches-grid">
          {pagination.rows.map((match) => (
            <LiveMatchCard
              key={match.gameId}
              match={match}
              previewThumbnails={previewThumbnails}
            />
          ))}
        </ul>
      )}
      {pagination.pageCount > 1 ? (
        <nav className="matches-pagination" aria-label="Páginas de partidas">
          <p>
            Página {pagination.page} de {pagination.pageCount}
          </p>
          <div>
            <button
              disabled={pagination.page === 1}
              onClick={() => setPage(pagination.page - 1)}
            >
              Anterior
            </button>
            <button
              disabled={pagination.page === pagination.pageCount}
              onClick={() => setPage(pagination.page + 1)}
            >
              Siguiente
            </button>
          </div>
        </nav>
      ) : null}
    </section>
  );
}

function normalize(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}
