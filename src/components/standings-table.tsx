"use client";

import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import Link from "next/link";
import type {
  DivisionId,
  ObjectiveGroup,
  StandingObjective,
  StandingRow,
} from "@/lib/public";
import { countryFlagSvgUrl } from "@/lib/flag";
import { ChannelLinks } from "@/components/channel-links";
import { divisionColor } from "@/components/division-icon";
import { EmptyState } from "@/components/empty-state";
import { LeagueIcon, rankLevelToLeague } from "@/components/league-icon";
import { LiveDot } from "@/components/live-dot";
import { ObjectiveIcon } from "@/components/objective-icon";
import { PlayerAvatar } from "@/components/player-avatar";
import {
  DivisionFilterButtons,
  SearchField,
  StandingsFilters,
  StatusFilterPills,
} from "@/components/standings-filters";
import {
  SortIndicator,
  nextSortState,
  sortHint,
  type ActiveSort,
} from "@/components/sortable-header";

const HEADING = "px-3 pb-2 text-xs font-medium text-muted";
const CELL = "bg-surface px-3 py-2.5 transition-colors group-hover:bg-surface-raised";
/** La fila desplegable de objetivos ocupa el ancho de toda la tabla. */
const OBJECTIVE_COLUMNS = 8;

/**
 * Medalla de podio: oro, plata y bronce por tokens. Es la única marca de las tres
 * primeras plazas y va donde iría el número: en la celda «Puesto» de la tabla y
 * en el distintivo de puesto de la tarjeta. El oro es `--accent`, el mismo token
 * que globals.css reserva a la medalla de la primera plaza.
 */
const MEDAL_CLASS: Record<number, string> = {
  1: "text-accent",
  2: "text-podium-silver",
  3: "text-podium-bronze",
};

/** ¿La plaza es de podio (oro, plata o bronce)? */
function isPodium(rank: number): boolean {
  return MEDAL_CLASS[rank] !== undefined;
}

/**
 * Estilo de la bandera: solo la imagen de fondo, limpia y sin fundido, para que
 * el borde derecho quede nítido. Se estira al alto de la fila en vez de usar
 * `cover` para que su escala vertical sea la misma que la del tinte y el empalme
 * no muestre un escalón. El fondo va en un `span` y no en la celda para no anular
 * el `group-hover:bg-surface-raised`, que es un `background-color`.
 */
function flagStyle(svg: string): CSSProperties {
  return {
    backgroundImage: `url(${svg})`,
    backgroundSize: "100% 100%",
  };
}

/**
 * Tinte que prolonga la bandera hacia la izquierda con sus propios colores: la
 * misma imagen, estirada para que solo asome su franja izquierda y volteada, de
 * modo que el borde que toca la bandera muestra justo su columna izquierda y el
 * empalme no se ve. La máscara lo funde a transparente al final del tinte: se
 * define opaca a la izquierda y transparente a la derecha porque el `scaleX(-1)`
 * la invierte al pintar.
 */
function flagTintStyle(svg: string): CSSProperties {
  const mask = "linear-gradient(to right, black, transparent)";

  return {
    backgroundImage: `url(${svg})`,
    backgroundSize: "2000% 100%",
    backgroundPosition: "left center",
    backgroundRepeat: "no-repeat",
    transform: "scaleX(-1)",
    maskImage: mask,
    WebkitMaskImage: mask,
  };
}

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
  hazanas: "Hazañas",
  formato: "Formatos",
  civilizacion: "Civilizaciones",
};

function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

type SortKey =
  | "rank"
  | "name"
  | "matches"
  | "points"
  | "elo"
  | "record"
  | "streak";
type SortState = ActiveSort<SortKey>;

/** "V - D" en color: comparte forma entre cabecera y control de orden de móvil. */
const RECORD_VISUAL = (
  <>
    <span className="text-win">V</span>
    <span className="text-muted"> - </span>
    <span className="text-loss">D</span>
  </>
);

/**
 * Campos que ofrece el control de orden de móvil, en el mismo orden que las
 * columnas. Por debajo de `lg` la tabla esconde las cabeceras secundarias (para
 * no obligar a desplazar), así que el orden por cualquier columna se concentra
 * en este único control.
 */
const SORT_FIELDS: { key: SortKey; label: string; visual?: ReactNode }[] = [
  { key: "rank", label: "Puesto" },
  { key: "name", label: "Jugador" },
  { key: "matches", label: "Partidas" },
  { key: "points", label: "Puntos" },
  { key: "elo", label: "Elo" },
  { key: "record", label: "V - D", visual: RECORD_VISUAL },
  { key: "streak", label: "Racha" },
];

/**
 * Los nulos nunca participan del sentido de la ordenación: van al final tanto en
 * ascendente como en descendente. Así un jugador sin clasificar no encabeza la
 * tabla al ordenar por elo o racha en un sentido o en el otro.
 */
function compareNullable(
  a: number | null,
  b: number | null,
  dir: 1 | -1,
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

  return (a - b) * dir;
}

/**
 * "V - D" se ordena por diferencia de victorias y derrotas (`wins - losses`) y
 * desempata por número de victorias: el récord es comparable de un vistazo y no
 * premia haber jugado más partidas perdiendo.
 */
function compareRows(
  a: StandingRow,
  b: StandingRow,
  sort: { key: SortKey; dir: "asc" | "desc" },
): number {
  const dir = sort.dir === "asc" ? 1 : -1;

  switch (sort.key) {
    case "rank":
      return (a.rank - b.rank) * dir;
    case "matches":
      return (a.wins + a.losses - (b.wins + b.losses)) * dir;
    case "points":
      return (a.points - b.points) * dir;
    case "elo":
      return compareNullable(a.elo, b.elo, dir);
    case "streak":
      return compareNullable(a.streak, b.streak, dir);
    case "record": {
      const diffA = a.wins - a.losses;
      const diffB = b.wins - b.losses;

      if (diffA !== diffB) {
        return (diffA - diffB) * dir;
      }

      return (a.wins - b.wins) * dir;
    }
    case "name":
      return normalize(a.name).localeCompare(normalize(b.name), "es") * dir;
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

      if (liveOnly && !row.twitchIsLive && !row.youtubeIsLive && !row.kickIsLive) {
        return false;
      }

      if (division !== null && row.division !== division) {
        return false;
      }

      if (needle !== "") {
        const haystack = normalize(
          `${row.name} ${row.aoe4WorldName ?? ""} ${row.twitchChannel ?? ""} ${
            row.youtubeChannel ?? ""
          } ${row.kickChannel ?? ""}`,
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
  // Solo los controles plegables: la búsqueda está a la vista, así que no entra
  // en el contador del botón "Filtros".
  const activeFilterCount =
    (playingOnly ? 1 : 0) + (liveOnly ? 1 : 0) + (division !== null ? 1 : 0);

  function clearFilters() {
    setQuery("");
    setPlayingOnly(false);
    setLiveOnly(false);
    setDivision(null);
  }

  // Un clic ordena ascendente, el segundo descendente y el tercero devuelve el
  // orden original del servidor (puesto ascendente).
  function toggleSort(key: SortKey) {
    setSort((current) => nextSortState(current, key));
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
            href="/puntuacion"
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

      <MobileStandingsControls
        query={query}
        onQueryChange={setQuery}
        playingOnly={playingOnly}
        onPlayingOnlyChange={setPlayingOnly}
        liveOnly={liveOnly}
        onLiveOnlyChange={setLiveOnly}
        division={division}
        onDivisionChange={setDivision}
        activeFilterCount={activeFilterCount}
        sort={sort}
        onSort={toggleSort}
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
            className="mt-5 inline-flex h-10 items-center rounded-md bg-accent px-4 text-sm font-semibold text-accent-ink transition-colors hover:bg-accent-strong active:translate-y-px"
          >
            Quitar filtros
          </button>
        </div>
      ) : (
        <>
          {/* Por debajo de `lg` la clasificación se lee como tarjetas apiladas:
              con siete columnas la tabla solo cabría desplazando en horizontal.
              Es la misma fila, con las cifras secundarias bajo el jugador. */}
          <ul className="flex flex-col gap-2 lg:hidden">
            {sorted.map((row) => (
              <StandingsCard
                key={row.profileId}
                row={row}
                objectivesExpanded={expanded.has(row.profileId)}
                onToggleObjectives={toggleObjectives}
              />
            ))}
          </ul>

          {/* A partir de `lg` vuelve la tabla completa, con su `caption` y sus
              `<th>`. La tabla no se oculta columna a columna: eso dejaría el
              `colSpan` del desplegable de objetivos descuadrado, porque un
              `colspan` mayor que las columnas visibles añade columnas vacías. */}
          <div className="hidden lg:block">
            <div className="overflow-x-auto overscroll-x-contain">
              <table className="w-full min-w-[900px] border-separate border-spacing-y-1.5 text-sm">
                <caption className="sr-only">
                  Clasificación de la liga: puesto, jugador, partidas jugadas,
                  puntos totales con su desglose por victorias y objetivos, elo,
                  victorias y derrotas y racha. El nombre de cada jugador enlaza
                  con su perfil de AoE4World y la última columna con su ficha de
                  objetivos.
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
                      visual={RECORD_VISUAL}
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
                    {/* Columna de acción, no de dato: enlaza con la ficha de
                        objetivos del jugador. No es ordenable, así que no pasa
                        por `SortableHeader`; solo lleva el `scope` de columna. */}
                    <th scope="col" className={`${HEADING} w-24 text-center`}>
                      Objetivos
                    </th>
                  </tr>
                </thead>
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
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Controles de la clasificación en pantallas estrechas.
 *
 * En escritorio los filtros viven desplegados y el orden está en las cabeceras
 * de la tabla. Por debajo de `lg` no existe ninguna de las dos cosas —la tabla no
 * se pinta—, así que aquí se concentra todo, pero plegado: una fila con el
 * buscador, un botón "Filtros" con el contador de los que están activos y un
 * botón "Ordenar" que enseña el campo y el sentido vigentes. El panel que abre
 * cada uno se pide, no se sirve.
 *
 * El motivo es de espacio: medido en 390 px, la barra de filtros desplegada más
 * los siete chips de orden gastaban 226 px de alto antes de la primera tarjeta de
 * jugador. Con los controles plegados son 44 px, y la clasificación empieza a
 * enseñar datos en la primera pantalla.
 *
 * El orden no puede desaparecer sin sustituto: sin cabeceras que pulsar, este
 * control es el único acceso a la ordenación en móvil, así que su panel abre los
 * mismos chips de tres estados (`SortControls`).
 */
function MobileStandingsControls({
  query,
  onQueryChange,
  playingOnly,
  onPlayingOnlyChange,
  liveOnly,
  onLiveOnlyChange,
  division,
  onDivisionChange,
  activeFilterCount,
  sort,
  onSort,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  playingOnly: boolean;
  onPlayingOnlyChange: (value: boolean) => void;
  liveOnly: boolean;
  onLiveOnlyChange: (value: boolean) => void;
  division: DivisionId | null;
  onDivisionChange: (value: DivisionId | null) => void;
  activeFilterCount: number;
  sort: SortState;
  onSort: (key: SortKey) => void;
}) {
  const [panel, setPanel] = useState<"filters" | "sort" | null>(null);
  const sortField =
    sort === null ? null : (SORT_FIELDS.find((field) => field.key === sort.key) ?? null);

  return (
    <div className="lg:hidden">
      <div className="flex items-center gap-2">
        <SearchField
          id="buscar-jugador-movil"
          query={query}
          onQueryChange={onQueryChange}
          className="min-w-0 flex-1"
        />

        <button
          type="button"
          aria-expanded={panel === "filters"}
          aria-controls="filtros-movil"
          onClick={() => setPanel((current) => (current === "filters" ? null : "filters"))}
          className={`inline-flex h-10 shrink-0 items-center gap-1.5 rounded-md border px-3 text-xs font-semibold transition-colors ${
            panel === "filters"
              ? "border-line-strong bg-surface-raised text-foreground"
              : "border-line bg-surface text-muted hover:bg-surface-raised hover:text-foreground"
          }`}
        >
          Filtros
          {activeFilterCount > 0 ? (
            <span className="inline-flex min-w-4 items-center justify-center rounded-full bg-accent px-1 text-xs font-semibold leading-4 tabular-nums text-accent-ink">
              {activeFilterCount}
            </span>
          ) : null}
        </button>

        <button
          type="button"
          aria-expanded={panel === "sort"}
          aria-controls="orden-movil"
          aria-label={
            sortField === null
              ? "Elegir el orden de la clasificación"
              : `Elegir el orden de la clasificación. Ahora: ${sortField.label}, ${
                  sort?.dir === "desc" ? "descendente" : "ascendente"
                }`
          }
          onClick={() => setPanel((current) => (current === "sort" ? null : "sort"))}
          className={`inline-flex h-10 shrink-0 items-center gap-1.5 rounded-md border px-3 text-xs font-semibold transition-colors ${
            panel === "sort"
              ? "border-line-strong bg-surface-raised text-foreground"
              : "border-line bg-surface text-muted hover:bg-surface-raised hover:text-foreground"
          }`}
        >
          {sortField?.label ?? "Ordenar"}
          <SortIndicator state={sort?.dir ?? "none"} />
        </button>
      </div>

      {panel === "filters" ? (
        <div
          id="filtros-movil"
          className="mt-3 flex flex-col gap-3 rounded-lg border border-line bg-surface p-4"
        >
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span className="text-xs font-semibold text-muted">Estado</span>
            <StatusFilterPills
              playingOnly={playingOnly}
              onPlayingOnlyChange={onPlayingOnlyChange}
              liveOnly={liveOnly}
              onLiveOnlyChange={onLiveOnlyChange}
            />
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span className="text-xs font-semibold text-muted">División</span>
            <DivisionFilterButtons division={division} onDivisionChange={onDivisionChange} />
          </div>
        </div>
      ) : null}

      {panel === "sort" ? (
        <div id="orden-movil" className="mt-3 rounded-lg border border-line bg-surface p-4">
          <SortControls sort={sort} onSort={onSort} />
        </div>
      ) : null}
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
    sort?.key === sortKey ? sort.dir : "none";

  const ariaSort =
    state === "asc" ? "ascending" : state === "desc" ? "descending" : "none";

  const alignment = align === "center" ? "text-center" : "text-left";
  const stack = align === "center" ? "items-center" : "items-start";

  return (
    <th scope="col" aria-sort={ariaSort} className={`${HEADING} ${alignment} ${className ?? ""}`}>
      <span className={`inline-flex flex-col gap-0.5 ${stack}`}>
        <button
          type="button"
          onClick={() => onSort(sortKey)}
          aria-label={sortHint(label, state)}
          className="group/header inline-flex items-center gap-1 whitespace-nowrap rounded-sm transition-colors hover:text-foreground"
        >
          {visual ?? label}
          <SortIndicator state={state} />
        </button>
        {sublabel !== undefined ? (
          <span className="whitespace-nowrap text-xs font-normal leading-none text-muted">
            {sublabel}
          </span>
        ) : null}
      </span>
    </th>
  );
}

/**
 * Orden de la clasificación en pantallas estrechas.
 *
 * Por debajo de `lg` la tabla completa se sustituye por tarjetas, así que sus
 * cabeceras ordenables no están; este control reproduce el mismo ciclo de tres
 * estados (ascendente, descendente y sin orden) sobre todos los campos. Se pinta
 * dentro del panel "Ordenar" de `MobileStandingsControls`, que es su única puerta
 * en móvil; a partir de `lg` desaparece y el orden vuelve a las cabeceras.
 */
function SortControls({
  sort,
  onSort,
}: {
  sort: SortState;
  onSort: (key: SortKey) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Ordenar la clasificación"
      className="flex flex-wrap items-center gap-1.5"
    >
      <span aria-hidden="true" className="text-xs text-muted">
        Ordenar
      </span>
      {SORT_FIELDS.map((field) => {
        const state: "none" | "asc" | "desc" =
          sort?.key === field.key ? sort.dir : "none";

        return (
          <button
            key={field.key}
            type="button"
            aria-label={sortHint(field.label, state)}
            onClick={() => onSort(field.key)}
            className={`inline-flex h-10 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors ${
              state === "none"
                ? "border-line bg-surface text-muted hover:bg-surface-raised hover:text-foreground"
                : "border-accent/50 bg-accent/10 text-accent"
            }`}
          >
            {field.visual ?? field.label}
            {state === "none" ? null : <SortIndicator state={state} />}
          </button>
        );
      })}
    </div>
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
  // La bandera es la marca de país del borde derecho de la fila; sin país
  // resoluble no se pinta.
  const flagSvg = countryFlagSvgUrl(row.country);

  return (
    <tbody className="group">
      <tr>
        <td
          className={`${CELL} ${
            objectivesExpanded ? "rounded-tl-lg" : "rounded-l-lg"
          } text-center font-semibold tabular-nums text-muted`}
        >
          {isPodium(row.rank) ? (
            <>
              <span className="sr-only">Puesto {row.rank}</span>
              <span className="inline-flex items-center justify-center">
                <MedalIcon rank={row.rank} className="size-6" />
              </span>
            </>
          ) : (
            row.rank
          )}
        </td>

        <td className={CELL}>
          <div className="relative z-[1] flex items-center gap-3">
            {/* El avatar responde a "quién es"; el podio lo marca la medalla de la
                columna de puesto. */}
            <PlayerAvatar
              name={row.name}
              avatarUrl={row.avatarUrl}
              className="size-9 text-xs"
              shape="circle"
            />
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
              <PlayerName row={row} />
              <PlayerChips
                row={row}
                objectivesExpanded={objectivesExpanded}
                objectivesPanelId={objectivesPanelId}
                onToggleObjectives={onToggleObjectives}
              />
            </div>
          </div>
        </td>

        <td className={`${CELL} text-center`}>
          <span className="relative z-[1] tabular-nums text-muted">
            {row.wins + row.losses}
          </span>
        </td>

        <td className={`${CELL} text-center`}>
          {/* Total dominante con su desglose debajo: las tres cifras se leen
              sin hover, y el total conserva el peso del dato principal. La
              leyenda del desglose vive en la cabecera de la columna. */}
          <div className="relative z-[1] flex flex-col items-center gap-0.5">
            <span className="font-semibold tabular-nums text-foreground">
              {row.points}
            </span>
            <span className="whitespace-nowrap text-xs leading-none tabular-nums text-muted">
              {row.pointsByWins}
              <span aria-hidden="true"> / </span>
              {row.pointsByObjectives}
            </span>
          </div>
        </td>

        <td className={`${CELL} text-center`}>
          <span className="relative z-[1] inline-flex items-center justify-center gap-1.5 tabular-nums text-foreground">
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

        <td
          className={`${CELL} whitespace-nowrap text-center tabular-nums`}
        >
          <span className="relative z-[1]">
            <span className="text-win">{row.wins}</span>
            <span className="text-muted"> - </span>
            <span className="text-loss">{row.losses}</span>
          </span>
        </td>

        <td className={`${CELL} text-center tabular-nums`}>
          <span className="relative z-[1]">
            <StreakValue streak={row.streak} />
          </span>
        </td>

        <td
          className={`${CELL} relative ${
            objectivesExpanded ? "rounded-tr-lg" : "rounded-r-lg"
          } text-center`}
        >
          {flagSvg !== null ? (
            <>
              {/* El tinte desborda la celda hacia la izquierda para prolongar los
                  colores de la bandera; los textos de las celdas que cruza van un
                  nivel por encima para quedar legibles sobre él. */}
              <span
                aria-hidden="true"
                className="pointer-events-none absolute inset-y-0 right-full z-0 w-[36rem] opacity-25"
                style={flagTintStyle(flagSvg)}
              />
              <span
                aria-hidden="true"
                className={`pointer-events-none absolute inset-0 z-0 opacity-25 ${
                  objectivesExpanded ? "rounded-tr-lg" : "rounded-r-lg"
                }`}
                style={flagStyle(flagSvg)}
              />
            </>
          ) : null}
          {row.country !== null ? (
            <span className="sr-only">País: {row.country}</span>
          ) : null}
          <span className="relative z-10 inline-flex">
            <ObjectivesLink profileId={row.profileId} name={row.name} />
          </span>
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
 * Fila de la clasificación como tarjeta, para pantallas estrechas.
 *
 * Es la misma información que la fila de la tabla, pero apilada: el puesto y el
 * avatar a la izquierda, la identidad y las cifras en el centro y el total de
 * puntos a la derecha, con los objetivos plegados justo debajo. Solo se pinta por
 * debajo de `lg`; a partir de ahí manda la tabla.
 */
function StandingsCard({
  row,
  objectivesExpanded,
  onToggleObjectives,
}: {
  row: StandingRow;
  objectivesExpanded: boolean;
  onToggleObjectives: (profileId: number) => void;
}) {
  const objectivesPanelId = `objetivos-movil-${row.profileId}`;
  // La bandera es la marca de país de la tarjeta. Se estira a todo el ancho en
  // vez de quedarse en el borde derecho: en una tarjeta estrecha una franja
  // lateral solo cubriría media fila. Sin país resoluble no se pinta.
  const flagSvg = countryFlagSvgUrl(row.country);

  return (
    <li className="relative overflow-hidden rounded-lg border border-line bg-surface p-3 transition-colors">
      {flagSvg !== null ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-0 opacity-40"
          style={flagStyle(flagSvg)}
        />
      ) : null}
      <div className="relative z-10 flex items-start gap-3">
        <RankBadge rank={row.rank} />
        {/* El avatar responde a "quién es"; el podio lo marca la medalla del
            distintivo de puesto. */}
        <PlayerAvatar
          name={row.name}
          avatarUrl={row.avatarUrl}
          className="size-9 text-xs"
          shape="circle"
        />

        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <PlayerName row={row} />
            <PlayerChips
              row={row}
              objectivesExpanded={objectivesExpanded}
              objectivesPanelId={objectivesPanelId}
              onToggleObjectives={onToggleObjectives}
            />
          </div>
          <CompactStats row={row} />
          <CompactPointsBreakdown row={row} />
        </div>

        <div className="shrink-0 text-right">
          {row.country !== null ? (
            <span className="sr-only">País: {row.country}</span>
          ) : null}
          <span className="block font-semibold tabular-nums text-foreground">
            {row.points}
          </span>
          {/* En la tabla de escritorio el desglose se explica con el subtítulo de
              la columna; aquí, sin columna, hace falta el rótulo. */}
          <span className="block text-xs font-medium uppercase tracking-wide text-muted">
            Puntos
          </span>
        </div>
      </div>

      {objectivesExpanded ? (
        <div id={objectivesPanelId} className="relative z-10 mt-3 border-t border-line pt-3">
          <ObjectivesDetail objectives={row.objectives} />
        </div>
      ) : null}
    </li>
  );
}

/**
 * Señales de estado del jugador en la fila: en partida, los canales de directo y
 * el desplegable de objetivos.
 *
 * Las tres plataformas se pintan con `ChannelLinks`, que resuelve el icono, la URL
 * y el color de cada una, y solo aparece la plataforma que tiene canal. La plataforma
 * que está emitiendo se ilumina con su color, así que si alguien emite a la vez por
 * dos, se ven las dos iluminadas, que es lo que está pasando.
 *
 * Vive aparte porque la fila de la tabla y la tarjeta de móvil comparten
 * exactamente los mismos indicadores; solo cambia a qué panel de objetivos apunta el
 * botón.
 */
function PlayerChips({
  row,
  objectivesExpanded,
  objectivesPanelId,
  onToggleObjectives,
}: {
  row: StandingRow;
  objectivesExpanded: boolean;
  objectivesPanelId: string;
  onToggleObjectives: (profileId: number) => void;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      {row.isPlaying ? (
        <span title="En partida ahora mismo" className="inline-flex">
          <LiveDot />
          <span className="sr-only">En partida ahora mismo</span>
        </span>
      ) : null}
      <ChannelLinks
        name={row.name}
        twitch={
          row.twitchChannel === null
            ? null
            : { channel: row.twitchChannel, isLive: row.twitchIsLive }
        }
        youtube={
          row.youtubeChannel === null
            ? null
            : { channel: row.youtubeChannel, isLive: row.youtubeIsLive }
        }
        kick={
          row.kickChannel === null
            ? null
            : { channel: row.kickChannel, isLive: row.kickIsLive }
        }
      />
      {row.objectives.length > 0 ? (
        <ObjectivesToggle
          count={row.objectives.length}
          expanded={objectivesExpanded}
          controls={objectivesPanelId}
          onClick={() => onToggleObjectives(row.profileId)}
        />
      ) : null}
    </div>
  );
}

/**
 * Cifras secundarias del jugador por debajo de `lg`.
 *
 * La tarjeta de móvil no tiene las columnas de partidas, elo, victorias-derrotas
 * ni racha, así que esas cifras se leen aquí, en el mismo orden que en la tabla,
 * y no se pierde ningún dato.
 */
function CompactStats({ row }: { row: StandingRow }) {
  const league = rankLevelToLeague(row.rankLevel);
  const matches = row.wins + row.losses;

  // Rejilla fija de dos columnas en lugar de una fila con `flex-wrap`. Al
  // repartirse, el alto de la tarjeta dependía del ancho del nombre del jugador
  // (medido entre 98 y 134 px para el mismo componente), y con alturas
  // distintas las tarjetas no se comparan de una a otra: el ojo necesita que
  // cada cifra ocupe siempre la misma celda.
  //
  // En cada celda la cifra va encima de su rótulo, y no al lado: en una tarjeta
  // de 320 px la columna central ronda los 115 px, y con el par en línea
  // "Partidas 56" el número quedaba recortado. Con la cifra arriba, lo que no
  // se recorta nunca es el dato, que es lo que se compara.
  return (
    <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
      <div className="min-w-0">
        <dd className="truncate text-sm font-medium tabular-nums text-foreground">
          {matches}
        </dd>
        <dt className="truncate text-muted">Partidas</dt>
      </div>
      <div className="min-w-0">
        <dd className="truncate text-sm font-medium tabular-nums">
          <span className="text-win">{row.wins}</span>
          <span aria-hidden="true" className="text-muted">
            {" "}
            -{" "}
          </span>
          <span className="text-loss">{row.losses}</span>
        </dd>
        <dt className="truncate text-muted">V - D</dt>
      </div>
      <div className="min-w-0">
        <dd className="flex min-w-0 items-baseline gap-1 text-sm font-medium tabular-nums text-foreground">
          <span className="min-w-0 truncate">{row.elo === null ? "-" : row.elo}</span>
          {league !== null ? (
            <span
              title={league.label}
              className="inline-flex shrink-0"
              style={{ color: divisionColor(league.division) }}
            >
              <LeagueIcon rank={league} label={league.label} className="h-5 w-3.5" />
            </span>
          ) : null}
        </dd>
        <dt className="truncate text-muted">Elo</dt>
      </div>
      <div className="min-w-0">
        <dd className="truncate text-sm font-medium">
          <StreakValue streak={row.streak} />
        </dd>
        <dt className="truncate text-muted">Racha</dt>
      </div>
    </dl>
  );
}

/**
 * Desglose del total de puntos por debajo de `lg`.
 *
 * En la tabla lo explica el subtítulo de la columna; en la tarjeta, sin columna,
 * hace falta el rótulo. Es texto explicativo y no una cifra que se compare de
 * una tarjeta a otra, así que puede partirse en varias líneas: lo que no puede
 * es recortarse. Comparte fila con el enlace a la ficha de objetivos, que en
 * móvil es la única puerta a esa página (la tabla y su columna de acción no se
 * pintan aquí).
 */
function CompactPointsBreakdown({ row }: { row: StandingRow }) {
  return (
    <p className="mt-2.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 border-t border-line pt-2 text-xs text-muted">
      <span>{row.pointsByWins} de victorias</span>
      <span aria-hidden="true">+</span>
      <span>{row.pointsByObjectives} de objetivos</span>
      <ObjectivesLink
        profileId={row.profileId}
        name={row.name}
        showLabel
        className="ml-auto"
      />
    </p>
  );
}

/**
 * Enlace a la ficha de objetivos de un jugador.
 *
 * Es la única acción de navegación de la fila, aparte del nombre: lleva a
 * `/objetivos/<profileId>`, la página que desarrolla el avance del participante
 * en los 82 objetivos. El icono (una diana) es el mismo en escritorio y en la
 * tarjeta de móvil, donde además se acompaña del texto para que no dependa de
 * que se reconozca el glifo. Siempre lleva `aria-label` con el nombre, porque en
 * la tabla el enlace es solo el icono.
 */
function ObjectivesLink({
  profileId,
  name,
  showLabel = false,
  className = "",
}: {
  profileId: number;
  name: string;
  /** Pinta el texto "Ver objetivos" junto al icono (tarjeta de móvil). */
  showLabel?: boolean;
  className?: string;
}) {
  return (
    <Link
      href={`/objetivos/${profileId}`}
      aria-label={`Ver los objetivos de ${name}`}
      title={`Ver los objetivos de ${name}`}
      className={`inline-flex items-center rounded-md text-muted underline-offset-4 transition-colors hover:text-accent focus-visible:text-accent ${
        showLabel
          ? "gap-1.5 py-1 text-xs font-medium"
          : "size-9 justify-center hover:bg-surface-raised"
      } ${className}`}
    >
      <TargetIcon className="size-4 shrink-0" />
      {showLabel ? <span>Ver objetivos</span> : null}
    </Link>
  );
}

/** Diana: el glifo de "objetivos", concéntrico y con las cuatro marcas. */
function TargetIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      aria-hidden="true"
      className={className}
    >
      <circle cx="12" cy="12" r="7.5" />
      <circle cx="12" cy="12" r="3.25" />
      <path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22" />
    </svg>
  );
}

/**
 * Medalla del podio. Ocupa el puesto de las tres primeras plazas —la celda de la
 * tabla y el distintivo de la tarjeta— y el mismo glifo vale para el oro, la
 * plata y el bronce: el metal lo pone `MEDAL_CLASS`, así que la forma es una y el
 * color la distingue. Es decorativa —el puesto va en un `sr-only` al lado—, por
 * eso no lleva texto alternativo. Vive aquí y no en un fichero propio porque solo
 * la usa la clasificación, igual que `TargetIcon` o `Chevron`; los iconos que
 * comparten varias páginas sí tienen su módulo.
 */
function MedalIcon({ rank, className }: { rank: number; className?: string }) {
  const color = MEDAL_CLASS[rank];

  if (color === undefined) {
    return null;
  }

  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`${className ?? ""} shrink-0 ${color}`}
    >
      <path d="M8.5 2.5 12 9l3.5-6.5" />
      <circle cx="12" cy="14.5" r="5.5" />
      <path
        d="M12 11.3 12.8 13.4 15 13.5 13.3 14.9 13.9 17.1 12 15.9 10.1 17.1 10.7 14.9 9 13.5 11.2 13.4Z"
        fill="currentColor"
        stroke="none"
      />
    </svg>
  );
}

/**
 * Control del desplegable de objetivos: un botón de texto, en el mismo registro
 * discreto que los controles en texto de la tabla ("Quitar filtros"), con un
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
      className={`-my-3.5 inline-flex shrink-0 items-center gap-1 rounded-sm py-3.5 text-xs font-medium underline-offset-4 transition-colors hover:underline ${
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
 * Todo el bloque enlaza con el perfil de AoE4World, así que la fila de la tabla
 * y la tarjeta de móvil comparten el enlace en la propia identidad.
 */
function PlayerName({ row }: { row: StandingRow }) {
  const officialName =
    row.aoe4WorldName !== null && row.aoe4WorldName !== row.name
      ? row.aoe4WorldName
      : null;

  return (
    <a
      href={row.profileUrl}
      target="_blank"
      rel="noopener noreferrer"
      // El relleno vertical amplía el área de pulsación del enlace, que sin él
      // se quedaba en la altura de la línea de texto; los márgenes negativos lo
      // compensan para que la tarjeta no crezca por debajo de `lg`.
      className="group/name -my-3 flex min-w-0 flex-col rounded-sm py-3"
    >
      <span
        title={row.name}
        className="max-w-[21rem] truncate font-medium text-foreground underline-offset-4 transition-colors group-hover/name:text-accent group-hover/name:underline"
      >
        {row.name}
      </span>
      {officialName !== null ? (
        <span
          title={officialName}
          className="max-w-[21rem] truncate text-xs text-muted underline-offset-4 transition-colors group-hover/name:text-accent group-hover/name:underline"
        >
          {officialName}
        </span>
      ) : null}
      <span className="sr-only">(se abre en una pestaña nueva)</span>
    </a>
  );
}

/**
 * Puesto del jugador como distintivo de la tarjeta de móvil. Neutro para todas
 * las plazas salvo el podio, donde el número deja su sitio a la medalla de oro,
 * plata o bronce; la caja y su tamaño se mantienen para que la columna no se
 * descoloque entre filas. El puesto sigue anunciándose en texto para lectores de
 * pantalla, porque la medalla es decorativa.
 */
function RankBadge({ rank }: { rank: number }) {
  return (
    <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-md border border-line bg-surface-raised text-sm font-semibold tabular-nums text-muted">
      <span className="sr-only">Puesto {rank}</span>
      {isPodium(rank) ? (
        <MedalIcon rank={rank} className="size-5" />
      ) : (
        <span aria-hidden="true">{rank}</span>
      )}
    </span>
  );
}

/**
 * Color de la racha en dos tonos: negativa o positiva. El signo `+` y la cifra
 * ya dicen el dato; el color es solo refuerzo.
 */
const STREAK_CLASS = {
  down: "text-streak-down",
  up: "text-streak-up",
} as const;

function streakTone(streak: number): string {
  return streak < 0 ? STREAK_CLASS.down : STREAK_CLASS.up;
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