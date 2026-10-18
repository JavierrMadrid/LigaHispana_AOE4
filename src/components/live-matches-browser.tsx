"use client";

import { useMemo, useState } from "react";
import type { DivisionId, LiveMatch } from "@/lib/public";
import { LiveMatchCard } from "@/components/live-match-card";
import { LiveMatchesFilters } from "@/components/live-matches-filters";
import { participantIsLive } from "@/components/live-channels";

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
 * aquí solo se decide cuáles se ven: tipo de partida, divisiones y directo se
 * combinan con AND. El filtro de división no busca partidas "de esa división",
 * sino partidas en las que juega al menos un participante de la liga de alguna
 * de las divisiones marcadas, que es lo que la división de un jugador significa
 * aquí. El de directo busca lo que el lector quiere ver: partidas en las que
 * **alguien** está retransmitiendo, sea del torneo o no.
 *
 * El estado vive en este componente, así que el auto-refresco de la página
 * (`LiveRefresh`) trae partidas nuevas sin perder los filtros puestos.
 */
export function LiveMatchesBrowser({ matches }: { matches: LiveMatch[] }) {
  const [format, setFormat] = useState<string | null>(null);
  const [divisions, setDivisions] = useState<DivisionId[]>([]);
  const [liveOnly, setLiveOnly] = useState(false);

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
          divisions.length > 0 &&
          !match.participants.some(
            (participant) =>
              participant.division !== null && divisions.includes(participant.division),
          )
        ) {
          return false;
        }

        if (liveOnly && !match.participants.some(participantIsLive)) {
          return false;
        }

        return true;
      }),
    [matches, format, divisions, liveOnly],
  );

  const hasFilters = format !== null || divisions.length > 0 || liveOnly;

  function clearFilters() {
    setFormat(null);
    setDivisions([]);
    setLiveOnly(false);
  }

  // El recuento nombra el directo cuando es el filtro puesto: es el único que
  // cambia entre dos lecturas de la misma página, así que es el que hay que oír.
  const countMessage = liveOnly
    ? filtered.length === 1
      ? "1 partida con alguien en directo"
      : `${filtered.length} partidas con alguien en directo`
    : filtered.length === 1
      ? "1 partida coincide con los filtros"
      : `${filtered.length} partidas coinciden con los filtros`;

  // El aviso de "no hay nada" tiene que ser cierto en los dos casos que puede
  // darse: con el filtro de directo solo, lo que falta decir es que nadie de la
  // partida está emitiendo; con varios filtros, que el lector sepa cuáles quitar.
  const onlyLive = liveOnly && format === null && divisions.length === 0;
  // El eje se nombra en singular cuando hay una división marcada y en plural
  // cuando hay varias: el filtro es el mismo, pero "quitar la división" sonaría
  // a que solo se puede desmarcar una.
  const divisionFilterLabel = divisions.length > 1 ? "las divisiones" : "la división";
  const activeFilters = [
    format === null ? null : "el tipo de partida",
    divisions.length === 0 ? null : divisionFilterLabel,
    liveOnly ? "el filtro de directos" : null,
  ].filter((item): item is string => item !== null);

  return (
    <div className="flex flex-col gap-4">
      <LiveMatchesFilters
        formats={formats}
        format={format}
        onFormatChange={setFormat}
        divisions={divisions}
        onDivisionsChange={setDivisions}
        liveOnly={liveOnly}
        onLiveOnlyChange={setLiveOnly}
      />

      {hasFilters ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* Con resultados, el recuento se lee; sin resultados, el aviso grande
              de abajo ya lo dice y esto queda solo para lectores de pantalla. */}
          <p role="status" className={filtered.length === 0 ? "sr-only" : "text-xs text-muted"}>
            {countMessage}
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
            {onlyLive
              ? "Ninguna partida en juego tiene a alguien en directo"
              : "Ninguna partida coincide con los filtros"}
          </p>
          <p className="mt-2 text-sm text-muted">
            {onlyLive
              ? "El filtro solo deja pasar las partidas con algún participante retransmitiendo ahora mismo, y un canal sin comprobar no cuenta como directo. Quítalo para volver a ver todas las partidas en juego."
              : `Prueba a quitar ${joinWithOr(activeFilters)}.`}
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

/** Enumera con la conjunción del español: "A", "A o B", "A, B o C". */
function joinWithOr(items: readonly string[]): string {
  if (items.length <= 1) {
    return items[0] ?? "";
  }

  return `${items.slice(0, -1).join(", ")} o ${items[items.length - 1]}`;
}
