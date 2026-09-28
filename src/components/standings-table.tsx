"use client";

import { useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import type {
  DivisionId,
  ObjectiveGroup,
  StandingObjective,
  StandingRow,
} from "@/lib/public";
import { divisionColor } from "@/components/division-icon";
import { EmptyState } from "@/components/empty-state";
import { LeagueIcon, rankLevelToLeague } from "@/components/league-icon";
import { LiveDot } from "@/components/live-dot";
import { ObjectiveIcon } from "@/components/objective-icon";
import { StandingsFilters } from "@/components/standings-filters";
import { TwitchIcon } from "@/components/twitch-icon";

const HEADING = "px-3 pb-2 text-xs font-medium text-muted";
const CELL = "bg-surface px-3 py-2.5 transition-colors group-hover:bg-surface-raised";
/** La fila desplegable de objetivos ocupa el ancho de toda la tabla. */
const OBJECTIVE_COLUMNS = 8;

/** Podio: el oro de la casa para el 1.º, plata y bronce para el 2.º y el 3.º. */
const RANK_CLASS: Record<number, string> = {
  1: "font-display text-base text-accent",
  2: "font-display text-base text-podium-silver",
  3: "font-display text-base text-podium-bronze",
};

/**
 * Rótulos de grupo de los objetivos para la fila desplegable.
 *
 * `OBJECTIVE_GROUP_LABELS` vive en `objectives.ts`, que es `server-only`, así que
 * un componente cliente no puede leerlo: se copia aquí el mismo mapa que usa
 * `division-icon.tsx` con las divisiones. Mantener en sincronía con
 * `src/lib/objectives.ts`.
 */
const GROUP_LABELS: Record<ObjectiveGroup, string> = {
  actividad: "Actividad",
  racha: "Racha",
  division: "Divisiones",
  formato: "Formatos",
  civilizacion: "Civilizaciones",
};

function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word.charAt(0))
    .join("")
    .toUpperCase();
}

type SortKey =
  | "rank"
  | "name"
  | "matches"
  | "points"
  | "elo"
  | "record"
  | "streak";
type SortState = { key: SortKey; direction: "asc" | "desc" } | null;

/**
 * Los nulos nunca participan del sentido de la ordenación: van al final tanto en
 * ascendente como en descendente. Así un jugador sin clasificar no encabeza la
 * tabla al ordenar por elo o racha en un sentido o en el otro.
 */
function compareNullable(
  a: number | null,
  b: number | null,
  direction: 1 | -1,
): number {
  if (a === null && b === null) {
    return 0;
  }

  if (a === null) {
    return 1;
  }

  if (b === null) {
    return -1;
  }

  return (a - b) * direction;
}

/**
 * "V - D" se ordena por diferencia de victorias y derrotas (`wins - losses`) y
 * desempata por número de victorias: el récord es comparable de un vistazo y no
 * premia haber jugado más partidas perdiendo.
 */
function compareRows(
  a: StandingRow,
  b: StandingRow,
  sort: { key: SortKey; direction: "asc" | "desc" },
): number {
  const direction = sort.direction === "asc" ? 1 : -1;

  switch (sort.key) {
    case "rank":
      return (a.rank - b.rank) * direction;
    case "matches":
      return (a.wins + a.losses - (b.wins + b.losses)) * direction;
    case "points":
      return (a.points - b.points) * direction;
    case "elo":
      return compareNullable(a.elo, b.elo, direction);
    case "streak":
      return compareNullable(a.streak, b.streak, direction);
    case "record": {
      const diffA = a.wins - a.losses;
      const diffB = b.wins - b.losses;

      if (diffA !== diffB) {
        return (diffA - diffB) * direction;
      }

      return (a.wins - b.wins) * direction;
    }
    case "name":
      return normalize(a.name).localeCompare(normalize(b.name), "es") * direction;
  }
}

/**
 * Clasificación con filtros y orden en cliente. El servidor le pasa las filas ya
 * resueltas y aquí solo se filtra, se ordena y se pinta: búsqueda por nombre de
 * display, nombre oficial o canal, toggles de "en partida" y "en directo" y
 * selección única de división, todo combinado con AND. El orden por defecto es el del servidor (puesto
 * ascendente) y las cabeceras alternan ascendente, descendente y vuelta al
 * orden original.
 */
export function StandingsTable({ rows }: { rows: StandingRow[] }) {
  const [query, setQuery] = useState("");
  const [playingOnly, setPlayingOnly] = useState(false);
  const [liveOnly, setLiveOnly] = useState(false);
  const [division, setDivision] = useState<DivisionId | null>(null);
  const [sort, setSort] = useState<SortState>(null);
  // Objetivos desplegados, por `profileId`: al vivir aquí sobrevive a los
  // filtros y a la reordenación, que solo cambian qué filas se pintan y en qué
  // orden, no el estado de cada jugador.
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());

  const filtered = useMemo(() => {
    const needle = normalize(query.trim());

    return rows.filter((row) => {
      if (playingOnly && !row.isPlaying) {
        return false;
      }

      if (liveOnly && !row.twitchIsLive) {
        return false;
      }

      if (division !== null && row.division !== division) {
        return false;
      }

      if (needle !== "") {
        const haystack = normalize(
          `${row.name} ${row.aoe4WorldName ?? ""} ${row.twitchChannel ?? ""}`,
        );

        if (!haystack.includes(needle)) {
          return false;
        }
      }

      return true;
    });
  }, [rows, query, playingOnly, liveOnly, division]);

  // La ordenación se aplica sobre el resultado ya filtrado: primero se decide
  // quién entra y después en qué orden se muestra.
  const sorted = useMemo(() => {
    if (sort === null) {
      return filtered;
    }

    return [...filtered].sort((a, b) => compareRows(a, b, sort));
  }, [filtered, sort]);

  const hasFilters = query.trim() !== "" || playingOnly || liveOnly || division !== null;

  function clearFilters() {
    setQuery("");
    setPlayingOnly(false);
    setLiveOnly(false);
    setDivision(null);
  }

  // Un clic ordena ascendente, el segundo descendente y el tercero devuelve el
  // orden original del servidor (puesto ascendente).
  function toggleSort(key: SortKey) {
    setSort((current) => {
      if (current === null || current.key !== key) {
        return { key, direction: "asc" };
      }

      return current.direction === "asc" ? { key, direction: "desc" } : null;
    });
  }

  function toggleObjectives(profileId: number) {
    setExpanded((current) => {
      const next = new Set(current);

      if (next.has(profileId)) {
        next.delete(profileId);
      } else {
        next.add(profileId);
      }

      return next;
    });
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        title="Todavía no hay nadie en la clasificación"
        body="Solo tienen fila los jugadores aprobados que ya han terminado al menos una partida clasificatoria. En cuanto alguien cierre su primera partida de ranked, aparecerá aquí."
        action={
          <Link
            href="/reglas"
            className="inline-block text-sm text-accent underline underline-offset-4 hover:text-accent-strong"
          >
            Ver qué cuenta como partida clasificatoria
          </Link>
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <StandingsFilters
        query={query}
        onQueryChange={setQuery}
        playingOnly={playingOnly}
        onPlayingOnlyChange={setPlayingOnly}
        liveOnly={liveOnly}
        onLiveOnlyChange={setLiveOnly}
        division={division}
        onDivisionChange={setDivision}
      />

      {hasFilters ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* Con resultados, el recuento se lee; sin resultados, el aviso grande
              de abajo ya lo dice y esto queda solo para lectores de pantalla. */}
          <p
            role="status"
            className={filtered.length === 0 ? "sr-only" : "text-xs text-muted"}
          >
            {filtered.length === 1
              ? "1 jugador coincide con los filtros"
              : `${filtered.length} jugadores coinciden con los filtros`}
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
            Ningún jugador coincide con los filtros
          </p>
          <p className="mt-2 text-sm text-muted">
            Prueba a quitar algún filtro o a buscar otro nombre.
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
        <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          <table className="w-full min-w-[960px] border-separate border-spacing-y-1.5 text-sm">
            <caption className="sr-only">
              Clasificación de la liga: puesto, jugador, partidas jugadas,
              puntos totales con su desglose por victorias y objetivos, elo,
              victorias y derrotas, racha y enlace al perfil de AoE4World.
            </caption>
            <thead>
              <tr>
                <SortableHeader
                  label="Puesto"
                  sortKey="rank"
                  sort={sort}
                  onSort={toggleSort}
                  className="w-14"
                />
                {/* El jugador es la única columna flexible: se queda con el
                    ancho sobrante, de modo que las dos primeras columnas viven
                    a la izquierda de la tabla y las cifras se agrupan a la
                    derecha, todas con el mismo margen de celda entre ellas. */}
                <SortableHeader
                  label="Jugador"
                  sortKey="name"
                  sort={sort}
                  onSort={toggleSort}
                  align="left"
                />
                <SortableHeader
                  label="Partidas"
                  sortKey="matches"
                  sort={sort}
                  onSort={toggleSort}
                  className="w-20"
                />
                <SortableHeader
                  label="Puntos"
                  sublabel="victorias / objetivos"
                  sortKey="points"
                  sort={sort}
                  onSort={toggleSort}
                  className="w-44"
                />
                <SortableHeader
                  label="Elo"
                  sortKey="elo"
                  sort={sort}
                  onSort={toggleSort}
                  className="w-24"
                />
                <SortableHeader
                  label="V - D"
                  visual={
                    <>
                      <span className="text-win">V</span>
                      <span className="text-muted"> - </span>
                      <span className="text-loss">D</span>
                    </>
                  }
                  sortKey="record"
                  sort={sort}
                  onSort={toggleSort}
                  className="w-24"
                />
                <SortableHeader
                  label="Racha"
                  sortKey="streak"
                  sort={sort}
                  onSort={toggleSort}
                  className="w-20"
                />
                <th scope="col" className={`${HEADING} w-20 text-center`}>
                  Stats
                </th>
              </tr>
            </thead>
            {/* Una `tbody` por participante: así la fila y su panel de
                objetivos forman un mismo grupo y el resalte al pasar el ratón
                abarca a los dos. */}
            {sorted.map((row) => (
              <StandingsRow
                key={row.profileId}
                row={row}
                objectivesExpanded={expanded.has(row.profileId)}
                onToggleObjectives={toggleObjectives}
              />
            ))}
          </table>
        </div>
      )}
    </div>
  );
}

function SortableHeader({
  label,
  visual,
  sublabel,
  sortKey,
  sort,
  onSort,
  align = "center",
  className,
}: {
  /** Texto accesible: alimenta el `aria-label` de la pista de ordenación. */
  label: string;
  /** Contenido visual cuando no coincide con el texto accesible (p. ej. color). */
  visual?: ReactNode;
  /**
   * Leyenda de las cifras de la columna, bajo el botón. No entra en el texto
   * accesible del control de ordenación: es apoyo visual para las celdas.
   */
  sublabel?: string;
  sortKey: SortKey;
  sort: SortState;
  onSort: (key: SortKey) => void;
  align?: "left" | "center";
  className?: string;
}) {
  const state: "none" | "asc" | "desc" =
    sort?.key === sortKey ? sort.direction : "none";

  const ariaSort =
    state === "asc" ? "ascending" : state === "desc" ? "descending" : "none";
  const hint =
    state === "asc"
      ? `${label}: orden ascendente. Pulsar para descendente`
      : state === "desc"
        ? `${label}: orden descendente. Pulsar para quitar la ordenación`
        : `Ordenar por ${label}`;

  const alignment = align === "center" ? "text-center" : "text-left";
  const stack = align === "center" ? "items-center" : "items-start";

  return (
    <th scope="col" aria-sort={ariaSort} className={`${HEADING} ${alignment} ${className ?? ""}`}>
      <span className={`inline-flex flex-col gap-0.5 ${stack}`}>
        <button
          type="button"
          onClick={() => onSort(sortKey)}
          aria-label={hint}
          className="group/header inline-flex items-center gap-1 whitespace-nowrap rounded-sm transition-colors hover:text-foreground"
        >
          {visual ?? label}
          <SortIndicator state={state} />
        </button>
        {sublabel !== undefined ? (
          <span className="whitespace-nowrap text-[11px] font-normal leading-none text-muted">
            {sublabel}
          </span>
        ) : null}
      </span>
    </th>
  );
}

/**
 * Indicador de orden: la forma distingue el sentido, no solo el color. Sin
 * ordenar se ven dos chevrones apagados como pista de que la columna se puede
 * pulsar; ascendente y descendente muestran uno solo, orientado.
 */
function SortIndicator({ state }: { state: "none" | "asc" | "desc" }) {
  if (state === "none") {
    return (
      <svg
        viewBox="0 0 12 12"
        aria-hidden="true"
        className="size-3 shrink-0 text-muted/40 transition-colors group-hover/header:text-muted"
      >
        <path
          d="M3 6.25 6 3.25l3 3"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M3 5.75 6 8.75l3-3"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  return (
    <svg
      viewBox="0 0 12 12"
      aria-hidden="true"
      className="size-3 shrink-0 text-accent"
    >
      <path
        d={state === "asc" ? "M2.5 7.25 6 3.75l3.5 3.5" : "M2.5 4.75 6 8.25l3.5-3.5"}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function StandingsRow({
  row,
  objectivesExpanded,
  onToggleObjectives,
}: {
  row: StandingRow;
  objectivesExpanded: boolean;
  onToggleObjectives: (profileId: number) => void;
}) {
  const league = rankLevelToLeague(row.rankLevel);
  const objectivesPanelId = `objetivos-${row.profileId}`;

  return (
    <tbody className="group">
      <tr>
        <td
          className={`${CELL} ${
            objectivesExpanded ? "rounded-tl-lg" : "rounded-l-lg"
          } text-center font-semibold tabular-nums ${
            RANK_CLASS[row.rank] ?? "text-muted"
          }`}
        >
          {row.rank}
        </td>

        <td className={CELL}>
          <div className="flex items-center gap-3">
            <PlayerAvatar row={row} />
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
              <PlayerName row={row} />
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                {row.isPlaying ? (
                  <span title="En partida ahora mismo" className="inline-flex">
                    <LiveDot />
                    <span className="sr-only">En partida ahora mismo</span>
                  </span>
                ) : null}
                {row.twitchChannel !== null ? <TwitchLink row={row} /> : null}
                {row.twitchIsLive ? (
                  <span className="inline-flex shrink-0 items-center rounded-full bg-twitch/10 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-twitch-soft">
                    En directo
                  </span>
                ) : null}
                {row.objectives.length > 0 ? (
                  <ObjectivesToggle
                    count={row.objectives.length}
                    expanded={objectivesExpanded}
                    controls={objectivesPanelId}
                    onClick={() => onToggleObjectives(row.profileId)}
                  />
                ) : null}
              </div>
            </div>
          </div>
        </td>

        <td className={`${CELL} text-center`}>
          <span className="tabular-nums text-muted">{row.wins + row.losses}</span>
        </td>

        <td className={`${CELL} text-center`}>
          {/* Total dominante con su desglose debajo: las tres cifras se leen
              sin hover, y el total conserva el peso del dato principal. La
              leyenda del desglose vive en la cabecera de la columna. */}
          <div className="flex flex-col items-center gap-0.5">
            <span
              className={`font-semibold tabular-nums ${
                row.rank === 1 ? "text-accent" : "text-foreground"
              }`}
            >
              {row.points}
            </span>
            <span className="whitespace-nowrap text-[11px] leading-none tabular-nums text-muted">
              {row.pointsByWins}
              <span aria-hidden="true"> / </span>
              {row.pointsByObjectives}
            </span>
          </div>
        </td>

        <td className={`${CELL} text-center`}>
          <span className="inline-flex items-center justify-center gap-1.5 tabular-nums text-foreground">
            {row.elo === null ? <span className="text-muted">-</span> : row.elo}
            {league !== null ? (
              <span
                title={league.label}
                className="inline-flex"
                style={{ color: divisionColor(league.division) }}
              >
                <LeagueIcon rank={league} label={league.label} className="h-6 w-4" />
              </span>
            ) : null}
          </span>
        </td>

        <td className={`${CELL} whitespace-nowrap text-center tabular-nums`}>
          <span className="text-win">{row.wins}</span>
          <span className="text-muted"> - </span>
          <span className="text-loss">{row.losses}</span>
        </td>

        <td className={`${CELL} text-center tabular-nums`}>
          <StreakValue streak={row.streak} />
        </td>

        <td
          className={`${CELL} ${
            objectivesExpanded ? "rounded-tr-lg" : "rounded-r-lg"
          } text-center`}
        >
          <a
            href={row.profileUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs font-medium text-muted underline-offset-4 transition-colors hover:text-accent hover:underline"
          >
            Stats
            <span className="sr-only">
              {" "}
              de {row.name} en AoE4World (se abre en una pestaña nueva)
            </span>
          </a>
        </td>
      </tr>

      {objectivesExpanded ? (
        <tr id={objectivesPanelId}>
          <td
            colSpan={OBJECTIVE_COLUMNS}
            className="relative rounded-b-lg bg-surface px-4 pb-4 pt-3 transition-colors group-hover:bg-surface-raised"
          >
            {/* Salva el hueco de `border-spacing` entre la fila y el panel: al
                compartir superficie, se leen como un único bloque. */}
            <div
              aria-hidden="true"
              className="absolute inset-x-0 -top-1.5 h-1.5 bg-surface transition-colors group-hover:bg-surface-raised"
            />
            {/* Filete de 1px que separa el desplegable de la fila: hereda el
                relleno del `<td>`, así que no toca los bordes del panel. */}
            <div className="border-t border-line pt-3">
              <ObjectivesDetail objectives={row.objectives} />
            </div>
          </td>
        </tr>
      ) : null}
    </tbody>
  );
}

/**
 * Control del desplegable de objetivos: un botón de texto, en el mismo registro
 * discreto que los enlaces de la tabla ("Stats", "Quitar filtros"), con un
 * chevron que señala el estado. Se pinta el texto y el icono dentro del mismo
 * botón, así que cualquiera de los dos abre y cierra.
 */
function ObjectivesToggle({
  count,
  expanded,
  controls,
  onClick,
}: {
  count: number;
  expanded: boolean;
  controls: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={expanded}
      aria-controls={controls}
      onClick={onClick}
      className={`inline-flex shrink-0 items-center gap-1 rounded-sm text-xs font-medium underline-offset-4 transition-colors hover:underline ${
        expanded ? "text-accent" : "text-muted hover:text-accent"
      }`}
    >
      +{count} {count === 1 ? "objetivo" : "objetivos"}
      <Chevron expanded={expanded} />
    </button>
  );
}

/** Chevron del desplegable: hacia abajo cerrado, girado hacia arriba abierto. */
function Chevron({ expanded }: { expanded: boolean }) {
  return (
    <svg
      viewBox="0 0 12 12"
      aria-hidden="true"
      className={`size-3 shrink-0 transition-transform motion-reduce:transition-none ${
        expanded ? "rotate-180" : ""
      }`}
    >
      <path
        d="M3 4.5 6 7.5l3-3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Objetivos conseguidos, desplegados bajo la fila.
 *
 * Es la cara "crónica" de la fila: los objetivos se agrupan por familia (el
 * orden de `StandingRow.objectives` ya llega agrupado) y cada uno se lee como
 * una ficha de botín, con su icono, su etiqueta y los puntos que aporta. Cada
 * ficha va sobre `surface-raised` para que destaque del panel, que comparte el
 * tono de la fila.
 */
function ObjectivesDetail({ objectives }: { objectives: StandingObjective[] }) {
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-3">
      {groupObjectives(objectives).map(([group, groupItems]) => (
        <div key={group} className="flex flex-col gap-1.5">
          <p className="text-xs font-medium text-muted">{GROUP_LABELS[group]}</p>
          <ul className="flex flex-wrap gap-1.5">
            {groupItems.map((objective) => (
              <li
                key={objective.id}
                className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-raised px-2.5 py-1 text-xs"
              >
                <ObjectiveIcon option={objective} className="size-4 shrink-0" />
                <span className="text-foreground">{objective.label}</span>
                <span className="font-semibold tabular-nums text-accent">
                  +{objective.points}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/**
 * Agrupa los objetivos conservando el orden recibido: la lectura de
 * `StandingRow.objectives` ya viene ordenada por grupo (`actividad` →
 * `civilizacion`), así que cada grupo aparece la primera vez que se encuentra y
 * los objetivos no se barajan dentro de él.
 */
function groupObjectives(
  objectives: StandingObjective[],
): [ObjectiveGroup, StandingObjective[]][] {
  const groups = new Map<ObjectiveGroup, StandingObjective[]>();

  for (const objective of objectives) {
    const list = groups.get(objective.group) ?? [];
    list.push(objective);
    groups.set(objective.group, list);
  }

  return [...groups.entries()];
}

/**
 * Identidad del jugador: el nombre de display manda y, debajo, el nombre oficial
 * de AoE4World en registro de subtítulo.
 *
 * El segundo se omite cuando no aporta: si aún no se ha sincronizado (`null`) o
 * si coincide con el de display, repetirlo bajo el primero solo añadiría ruido.
 */
function PlayerName({ row }: { row: StandingRow }) {
  const officialName =
    row.aoe4WorldName !== null && row.aoe4WorldName !== row.name
      ? row.aoe4WorldName
      : null;

  return (
    <div className="flex min-w-0 flex-col">
      <span
        title={row.name}
        className="max-w-[16rem] truncate font-medium text-foreground"
      >
        {row.name}
      </span>
      {officialName !== null ? (
        <span
          title={officialName}
          className="max-w-[16rem] truncate text-xs text-muted"
        >
          {officialName}
        </span>
      ) : null}
    </div>
  );
}

function PlayerAvatar({ row }: { row: StandingRow }) {
  if (row.avatarUrl === null) {
    return (
      <span
        aria-hidden="true"
        className="flex size-9 shrink-0 items-center justify-center rounded-md border border-line bg-surface-raised text-xs font-semibold text-muted"
      >
        {initials(row.name)}
      </span>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- los avatares vienen de AoE4World (o como data: en el mock); next/image exigiría declarar el host remoto.
    <img
      src={row.avatarUrl}
      alt=""
      width={36}
      height={36}
      loading="lazy"
      decoding="async"
      className="size-9 shrink-0 rounded-md border border-line bg-surface-raised object-cover"
    />
  );
}

function TwitchLink({ row }: { row: StandingRow }) {
  const live = row.twitchIsLive;

  return (
    <a
      href={`https://twitch.tv/${row.twitchChannel}`}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Canal de Twitch de ${row.name}${
        live ? ", en directo ahora mismo" : ""
      } (se abre en una pestaña nueva)`}
      className={`inline-flex shrink-0 transition-colors ${
        live ? "text-twitch hover:opacity-80" : "text-muted/70 hover:text-muted"
      }`}
    >
      <TwitchIcon className="size-3.5" />
    </a>
  );
}

/**
 * Escala de color de la racha. Los umbrales salen del signo y la magnitud, en
 * un solo sitio para que el corte y el estilo no se dispersen: -6 o menos rojo,
 * de -5 a -1 naranja, de 0 a 4 verde amarillento y de 5 en adelante verde. El
 * signo `+` y la cifra ya dicen el dato; el color es solo refuerzo.
 */
const STREAK_CLASS = {
  slump: "text-streak-slump",
  dip: "text-streak-dip",
  rise: "text-streak-rise",
  surge: "text-streak-surge",
} as const;

function streakTone(streak: number): string {
  if (streak <= -6) {
    return STREAK_CLASS.slump;
  }

  if (streak < 0) {
    return STREAK_CLASS.dip;
  }

  if (streak < 5) {
    return STREAK_CLASS.rise;
  }

  return STREAK_CLASS.surge;
}

function StreakValue({ streak }: { streak: number | null }) {
  if (streak === null) {
    return <span className="text-muted">-</span>;
  }

  return (
    <span className={`font-medium ${streakTone(streak)}`}>
      {streak > 0 ? `+${streak}` : streak}
    </span>
  );
}