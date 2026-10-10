"use client";

import { useMemo, useState } from "react";
import type { DivisionId, LiveMatch } from "@/lib/public";
import { LiveMatchCard } from "@/components/live-match-card";
import { LiveMatchesFilters } from "@/components/live-matches-filters";

/**
 * Orden de lectura de los tipos conocidos. Lo que no esté aquí (un modo nuevo de
 * la API que `describeMode` devuelva tal cual) se añade después, en orden
 * alfabético: preferimos un filtro de más a esconder partidas por no saber
 * etiquetarlas.
 */
const FORMAT_ORDER: readonly string[] = ["1vs1", "2vs2", "3vs3", "4vs4", "Por equipos"];

/**
 * Partidas en juego con filtros de cliente.
 *
 * El servidor le pasa las partidas ya agrupadas y con la alineación resuelta, y
 * aquí solo se decide cuáles se ven: tipo de partida y división se combinan con
 * AND. Un filtro de división no busca partidas "de esa división", sino partidas
 * en las que juega al menos un participante de la liga de esa división, que es
 * lo que la división de un jugador significa aquí.
 *
 * El estado vive en este componente, así que el auto-refresco de la página
 * (`LiveRefresh`) trae partidas nuevas sin perder los filtros puestos.
 */
export function LiveMatchesBrowser({ matches }: { matches: LiveMatch[] }) {
  const [format, setFormat] = useState<string | null>(null);
  const [division, setDivision] = useState<DivisionId | null>(null);

  const formats = useMemo(() => {
    const present = new Set(matches.map((match) => match.format));
    const known = FORMAT_ORDER.filter((item) => present.has(item));
    const extra = [...present]
      .filter((item) => !FORMAT_ORDER.includes(item))
      .sort((left, right) => left.localeCompare(right, "es"));

    return [...known, ...extra];
  }, [matches]);

  const filtered = useMemo(
    () =>
      matches.filter((match) => {
        if (format !== null && match.format !== format) {
          return false;
        }

        if (
          division !== null &&
          !match.participants.some((participant) => participant.division === division)
        ) {
          return false;
        }

        return true;
      }),
    [matches, format, division],
  );

  const hasFilters = format !== null || division !== null;

  function clearFilters() {
    setFormat(null);
    setDivision(null);
  }

  return (
    <div className="flex flex-col gap-4">
      <LiveMatchesFilters
        formats={formats}
        format={format}
        onFormatChange={setFormat}
        division={division}
        onDivisionChange={setDivision}
      />

      {hasFilters ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* Con resultados, el recuento se lee; sin resultados, el aviso grande
              de abajo ya lo dice y esto queda solo para lectores de pantalla. */}
          <p role="status" className={filtered.length === 0 ? "sr-only" : "text-xs text-muted"}>
            {filtered.length === 1
              ? "1 partida coincide con los filtros"
              : `${filtered.length} partidas coinciden con los filtros`}
          </p>
          {filtered.length > 0 ? (
            <button
              type="button"
              onClick={clearFilters}
              className="text-xs font-medium text-muted underline-offset-4 transition-colors hover:text-accent hover:underline"
            >
              Quitar filtros
            </button>
          ) : null}
        </div>
      ) : null}

      {filtered.length === 0 ? (
        <div className="rounded-lg border border-line bg-surface px-6 py-12 text-center">
          <p className="font-display text-lg font-semibold text-foreground">
            Ninguna partida coincide con los filtros
          </p>
          <p className="mt-2 text-sm text-muted">
            Prueba a quitar la división o el tipo de partida.
          </p>
          <button
            type="button"
            onClick={clearFilters}
            className="mt-5 inline-flex h-10 items-center rounded-md bg-accent px-4 text-sm font-semibold text-accent-ink transition-colors hover:bg-accent-strong"
          >
            Quitar filtros
          </button>
        </div>
      ) : (
        <ul className="grid items-start gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {filtered.map((match) => (
            <LiveMatchCard key={match.gameId} match={match} />
          ))}
        </ul>
      )}
    </div>
  );
}
