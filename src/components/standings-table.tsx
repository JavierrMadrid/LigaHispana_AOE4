"use client";

import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import Link from "next/link";
import type {
  DivisionId,
  ObjectiveGroup,
  StandingObjective,
  StandingRow,
} from "@/lib/public";
import { countryFlagSvgUrl, countryFlagUrl } from "@/lib/flag";
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
const OBJECTIVE_COLUMNS = 7;

/**
 * Las dos mitades del total de puntos, explicadas.
 *
 * Van en `title` nativo, que es el apoyo discreto que ya usa la tabla para lo
 * que no cabe en la celda (el nombre de la liga, "en partida ahora mismo"): el
 * rótulo de la columna nombra las dos partes y lo demás se lee al pasar el
 * ratón, sin glifos ni notas fijas que ensucien la tabla.
 */
const POINTS_HINTS = {
  permanent: "Permanentes: victorias y logros ya conseguidos, que no se pierden.",
  temporary:
    "Temporales: competiciones, que se deciden al cierre y pueden cambiar de dueño.",
} as const;

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
 * ascendente como en descendente. Así un jugador que todavía no ha jugado —sin
 * elo ni racha— no encabeza la tabla al ordenar por elo o racha en un sentido o
 * en el otro.
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
 * selección múltiple de divisiones —ninguna marcada significa todas—, todo
 * combinado con AND. El orden por defecto es el del servidor (puesto
 * ascendente) y las cabeceras alternan ascendente, descendente y vuelta al
 * orden original.
 */
export function StandingsTable({ rows }: { rows: StandingRow[] }) {
  const [query, setQuery] = useState("");
  const [playingOnly, setPlayingOnly] = useState(false);
  const [liveOnly, setLiveOnly] = useState(false);
  const [divisions, setDivisions] = useState<DivisionId[]>([]);
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

      if (
        divisions.length > 0 &&
        (row.division === null || !divisions.includes(row.division))
      ) {
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
  }, [rows, query, playingOnly, liveOnly, divisions]);

  // La ordenación se aplica sobre el resultado ya filtrado: primero se decide
  // quién entra y después en qué orden se muestra.
  const sorted = useMemo(() => {
    if (sort === null) {
      return filtered;
    }

    return [...filtered].sort((a, b) => compareRows(a, b, sort));
  }, [filtered, sort]);

  const hasFilters =
    query.trim() !== "" || playingOnly || liveOnly || divisions.length > 0;
  // Solo los controles plegables: la búsqueda está a la vista, así que no entra
  // en el contador del botón "Filtros". La selección de divisiones cuenta como
  // un filtro, no como uno por división: el contador dice cuántos filtros hay
  // puestos, no cuántos botones están encendidos.
  const activeFilterCount =
    (playingOnly ? 1 : 0) + (liveOnly ? 1 : 0) + (divisions.length > 0 ? 1 : 0);

  function clearFilters() {
    setQuery("");
    setPlayingOnly(false);
    setLiveOnly(false);
    setDivisions([]);
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
        body="Aparecen todos los participantes aprobados, aunque todavía no hayan jugado ninguna partida clasificatoria: salen con 0 puntos y 0 partidas hasta que cierren una de las que cuentan. Si la tabla sigue vacía, es que aún no hay ningún participante aprobado o que la clasificación no se ha recalculado."
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
        divisions={divisions}
        onDivisionsChange={setDivisions}
      />

      <MobileStandingsControls
        query={query}
        onQueryChange={setQuery}
        playingOnly={playingOnly}
        onPlayingOnlyChange={setPlayingOnly}
        liveOnly={liveOnly}
        onLiveOnlyChange={setLiveOnly}
        divisions={divisions}
        onDivisionsChange={setDivisions}
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
                  puntos totales con su desglose en permanentes (victorias y
                  logros) y temporales (competiciones), elo, victorias y derrotas
                  y racha. El nombre de cada jugador enlaza con su perfil de
                  AoE4World y sus puntos abren el resumen de objetivos.
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
                      sublabel="permanentes / temporales"
                      sublabelHint={`${POINTS_HINTS.permanent} ${POINTS_HINTS.temporary}`}
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
                    {/* Última columna de la tabla: además del dato lleva la
                        bandera del país, que se cuelga del borde derecho de la
                        fila. */}
                    <SortableHeader
                      label="Racha"
                      sortKey="streak"
                      sort={sort}
                      onSort={toggleSort}
                      className="w-20"
                    />
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
  divisions,
  onDivisionsChange,
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
  divisions: readonly DivisionId[];
  onDivisionsChange: (value: DivisionId[]) => void;
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
            <DivisionFilterButtons divisions={divisions} onDivisionsChange={onDivisionsChange} />
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
  sublabelHint,
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
  /**
   * Aclaración de la leyenda, como `title` nativo. El sitio no tiene notas fijas
   * en la tabla: lo que no cabe se cuenta al pasar el ratón.
   */
  sublabelHint?: string;
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
          <span
            title={sublabelHint}
            className="whitespace-nowrap text-xs font-normal leading-none text-muted"
          >
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
              <PlayerChips row={row} />
            </div>
          </div>
        </td>

        <td className={`${CELL} text-center`}>
          <span className="relative z-[1] tabular-nums text-muted">
            {row.wins + row.losses}
          </span>
        </td>

        <td className={`${CELL} text-center`}>
          <PointsDisclosure
            row={row}
            expanded={objectivesExpanded}
            panelId={objectivesPanelId}
            onToggle={onToggleObjectives}
            align="center"
            className="relative z-[1]"
            sublabel={
              // Los permanentes van en el tono del dato y los temporales en el
              // de la leyenda: la parte sólida del total y la que puede cambiar
              // de dueño se distinguen de un vistazo, y cada cifra se explica
              // en su `title`.
              <span className="whitespace-nowrap text-xs leading-none tabular-nums">
                <span title={POINTS_HINTS.permanent} className="text-foreground">
                  {row.pointsByWins + row.pointsByAchievements}
                </span>
                <span aria-hidden="true" className="text-muted">
                  {" / "}
                </span>
                <span title={POINTS_HINTS.temporary} className="text-muted">
                  {row.pointsByCompetitions}
                </span>
              </span>
            }
          />
        </td>

        <td className={`${CELL} text-center`}>
          <span className="relative z-[1] inline-flex items-center justify-center gap-1.5 tabular-nums text-foreground">
            {league !== null ? (
              <span
                title={league.label}
                className="inline-flex"
                style={{ color: divisionColor(league.division) }}
              >
                <LeagueIcon rank={league} label={league.label} className="h-6 w-4" />
              </span>
            ) : null}
            {row.elo === null ? <span className="text-muted">-</span> : row.elo}
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

        <td
          className={`${CELL} relative ${
            objectivesExpanded ? "rounded-tr-lg" : "rounded-r-lg"
          } text-center tabular-nums`}
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
          <span className="relative z-[1]">
            <StreakValue streak={row.streak} />
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
              <ObjectivesDetail row={row} />
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
  // La bandera de la tarjeta es un icono junto a la identidad, no un fondo a
  // toda la fila: en una tarjeta estrecha el fondo ensuciaba la lectura. Sin
  // país resoluble no se pinta.
  const flagUrl = countryFlagUrl(row.country);

  return (
    <li className="relative overflow-hidden rounded-lg border border-line bg-surface p-3 transition-colors">
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
            {flagUrl !== null ? (
              // eslint-disable-next-line @next/next/no-img-element -- las banderas vienen de flagcdn.com; next/image exigiría declarar el host remoto.
              <img
                src={flagUrl}
                alt=""
                loading="lazy"
                className="h-4 w-6 shrink-0 rounded-sm object-cover ring-1 ring-line"
              />
            ) : null}
            {row.country !== null ? (
              <span className="sr-only">País: {row.country}</span>
            ) : null}
            <PlayerChips row={row} />
          </div>
          <CompactStats row={row} />
          <CompactPointsBreakdown row={row} />
        </div>

        <PointsDisclosure
          row={row}
          expanded={objectivesExpanded}
          panelId={objectivesPanelId}
          onToggle={onToggleObjectives}
          align="end"
          sublabel={
            // En la tabla de escritorio el desglose se explica con el subtítulo
            // de la columna; aquí, sin columna, hace falta el rótulo.
            <span className="text-xs font-medium uppercase tracking-wide text-muted">
              Puntos
            </span>
          }
        />
      </div>

      {objectivesExpanded ? (
        <div id={objectivesPanelId} className="relative z-10 mt-3 border-t border-line pt-3">
          <ObjectivesDetail row={row} />
        </div>
      ) : null}
    </li>
  );
}

/**
 * Señales de estado del jugador en la fila: en partida y los canales de directo.
 *
 * Las tres plataformas se pintan con `ChannelLinks`, que resuelve el icono, la URL
 * y el color de cada una, y solo aparece la plataforma que tiene canal. La plataforma
 * que está emitiendo se ilumina con su color, así que si alguien emite a la vez por
 * dos, se ven las dos iluminadas, que es lo que está pasando.
 *
 * Vive aparte porque la fila de la tabla y la tarjeta de móvil comparten
 * exactamente los mismos indicadores: son las señales del nombre, no de la fila.
 */
function PlayerChips({ row }: { row: StandingRow }) {
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
        <dd className="flex min-w-0 items-center gap-1 text-sm font-medium tabular-nums text-foreground">
          {league !== null ? (
            <span
              title={league.label}
              className="inline-flex shrink-0"
              style={{ color: divisionColor(league.division) }}
            >
              <LeagueIcon rank={league} label={league.label} className="h-5 w-3.5" />
            </span>
          ) : null}
          <span className="min-w-0 truncate">{row.elo === null ? "-" : row.elo}</span>
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
 * hace falta la leyenda, aquí con las palabras enteras: la tarjeta tiene sitio y
 * los dos términos ("permanentes", "temporales") son los que hay que aprender
 * para leer la tabla. Los permanentes van en el tono del dato y los temporales
 * en el de la leyenda, la misma distinción que en la columna Puntos. Es texto
 * explicativo y no una cifra que se compare de una tarjeta a otra, así que puede
 * partirse en varias líneas: lo que no puede es recortarse.
 */
function CompactPointsBreakdown({ row }: { row: StandingRow }) {
  return (
    <p className="mt-2.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 border-t border-line pt-2 text-xs">
      <span title={POINTS_HINTS.permanent} className="text-foreground">
        {row.pointsByWins + row.pointsByAchievements} de permanentes
      </span>
      <span aria-hidden="true" className="text-muted">
        +
      </span>
      <span title={POINTS_HINTS.temporary} className="text-muted">
        {row.pointsByCompetitions} de temporales
      </span>
    </p>
  );
}

/**
 * Desglose del total de puntos de una fila y mando del resumen de objetivos.
 *
 * El total manda y debajo van sus dos mitades, que el jugador lee sin hover:
 * los puntos permanentes (victorias y logros ya conseguidos) y los temporales
 * (competiciones, que se deciden al cierre y pueden cambiar de dueño). La
 * aclaración de cada cifra va en su `title`, el apoyo discreto que ya usa la
 * tabla para lo que no cabe en la celda.
 *
 * El resumen de objetivos se abre desde aquí, que es lo que era informativo: si
 * el jugador tiene objetivos el bloque entero es un botón con
 * `aria-expanded`/`aria-controls` —la afordancia es el chevron, y el color del
 * total al pasar el ratón—, y si no tiene ninguno se queda como estaba, sin un
 * control que no haría nada.
 *
 * ## La misma pieza en dos sitios, con la misma geometría en los dos
 *
 * `align` es lo único que cambia: `center` en la celda de la tabla, `end` en la
 * tarjeta. La **forma del bloque no depende de si hay control**: el botón y el
 * texto comparten las mismas clases de disposición, y en la celda llevan
 * `w-full`, que es la única manera de que el botón mida como el bloque de nivel
 * bloque y la cifra quede centrada igual en todas las filas. Sin ese ancho, el
 * navegador da al botón el ancho de su contenido y la columna se ve centrada en
 * unas filas y pegada a la izquierda en otras.
 *
 * ## Por qué el chevron de la celda va colgado del número
 *
 * Centrar el grupo "cifra + chevron" dejaría la cifra media marca a la
 * izquierda del centro, y las filas sin objetivos —que no tienen chevron— la
 * dejarían centrada. Colgándolo con posición absoluta del número, el chevron no
 * ocupa hueco: la cifra queda exactamente en el mismo sitio con y sin
 * objetivos, y el mando se lee igual. En la tarjeta no se cuelga porque el
 * bloque está alineado a la derecha y el chevron se saldría del borde, que
 * además recorta: ahí va en línea y alinea el borde derecho del rótulo.
 */
function PointsDisclosure({
  row,
  expanded,
  panelId,
  onToggle,
  sublabel,
  align,
  className = "",
}: {
  row: StandingRow;
  expanded: boolean;
  panelId: string;
  onToggle: (profileId: number) => void;
  /** Leyenda bajo el total: el desglose en la tabla, el rótulo en la tarjeta. */
  sublabel: ReactNode;
  /** `center`: celda de la tabla. `end`: bloque de la tarjeta, a su derecha. */
  align: "center" | "end";
  /** Clases de posición del host, como el nivel de apilado sobre la bandera. */
  className?: string;
}) {
  const hasObjectives = row.objectives.length > 0;
  const layout =
    align === "center"
      ? "w-full items-center"
      : "shrink-0 items-end text-right";
  const chevron = (
    <Chevron
      expanded={expanded}
      className={
        expanded ? "text-accent" : "text-muted group-hover/points:text-accent"
      }
    />
  );
  const content = (
    <>
      <span className="relative inline-flex items-center gap-1">
        <span className="font-semibold tabular-nums text-foreground transition-colors group-hover/points:text-accent">
          {row.points}
        </span>
        {hasObjectives
          ? align === "center"
            ? // Colgado del número: así el chevron no cuenta como ancho y la
              // cifra no se mueve respecto a las filas que no lo tienen.
              <span className="absolute left-full top-1/2 ml-1.5 -translate-y-1/2">
                {chevron}
              </span>
            : chevron
          : null}
      </span>
      {sublabel}
    </>
  );

  if (!hasObjectives) {
    return <div className={`flex flex-col gap-0.5 ${layout} ${className}`}>{content}</div>;
  }

  return (
    <button
      type="button"
      aria-expanded={expanded}
      aria-controls={panelId}
      onClick={() => onToggle(row.profileId)}
      title={expanded ? "Ocultar el resumen de objetivos" : "Ver el resumen de objetivos"}
      className={`group/points flex flex-col gap-0.5 rounded-md ${layout} ${className}`}
    >
      {content}
      {/* El chevron es decorativo y el `title` no llega a un lector de pantalla,
          así que la acción se nombra aquí: el nombre accesible del botón es el
          total con su desglose más esto. */}
      <span className="sr-only">
        {expanded ? "Ocultar" : "Ver"} los objetivos de {row.name}
      </span>
    </button>
  );
}

/**
 * Enlace a la ficha de objetivos de un jugador.
 *
 * Es la acción que hacía la antigua columna de objetivos, que ya no existe, y
 * vive en la columna derecha del resumen desplegable, que es donde se pide:
 * quien abre los objetivos de un jugador es quien quiere el detalle. El texto
 * encabeza esa columna —el mismo registro que los rótulos de grupo ("Actividad",
 * "Racha")— y debajo va la diana, centrada, que es el glifo que identificaba la
 * columna; el conjunto se centra en vertical en el alto del panel (ver
 * `ObjectivesDetail`). A `size-6` (24 px) mide lo mismo que los iconos de
 * objetivo de las tarjetas del catálogo (`ObjectiveIcon`) y conserva el trazo de
 * 1.5 de todos los glifos del sitio. No lleva relleno vertical: el área de
 * pulsación ya la dan las dos líneas.
 */
function ObjectivesLink({
  profileId,
  name,
  label,
}: {
  profileId: number;
  name: string;
  /** Texto visible del enlace (la cabecera de la columna). */
  label: string;
}) {
  // El texto accesible no repite la etiqueta visible —que encabeza la columna—
  // sino que nombra la acción entera y a quién pertenece el avance.
  const hint = `Ver detalle del avance de objetivos de ${name}`;

  return (
    <Link
      href={`/objetivos/${profileId}`}
      aria-label={hint}
      title={hint}
      className="inline-flex flex-col items-center gap-1.5 rounded-md text-xs font-medium text-muted underline-offset-4 transition-colors hover:text-accent focus-visible:text-accent"
    >
      <span>{label}</span>
      <TargetIcon className="size-6 shrink-0" />
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
 * Chevron del desplegable: hacia abajo cerrado, girado hacia arriba abierto. El
 * color entra por `className`, porque el mismo glifo marca el mando de los
 * objetivos y hereda el estado del botón que lo contiene.
 */
function Chevron({ expanded, className = "" }: { expanded: boolean; className?: string }) {
  return (
    <svg
      viewBox="0 0 12 12"
      aria-hidden="true"
      className={`size-3 shrink-0 transition-transform motion-reduce:transition-none ${
        expanded ? "rotate-180" : ""
      } ${className}`}
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
 * tono de la fila, y su `title` —la regla del objetivo en una frase, del
 * catálogo— responde al "¿esto cómo se consigue?" sin cargar la ficha.
 *
 * ## El enlace en su propia columna
 *
 * A la derecha del bloque de familias vive el enlace a la ficha del jugador, que
 * es el detalle completo: es la acción del panel entero y no de un grupo, así
 * que va separado por un filete y no como una ficha más. El filete se estira al
 * alto del bloque (`sm:self-stretch`) y el enlace se centra en la columna
 * (`sm:items-center`): su texto es la cabecera de esa columna —con el registro
 * de los rótulos de grupo— y la diana va debajo, en el centro, como emblema. Por
 * debajo de `sm` la columna no cabría sin apretar los chips, así que el bloque
 * se apila y el enlace queda debajo alineado a la derecha, el mismo lado que
 * ocupa cuando hay sitio: la tarjeta de móvil usa este mismo componente.
 */
function ObjectivesDetail({ row }: { row: StandingRow }) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:gap-4">
      <div className="flex min-w-0 flex-1 flex-wrap gap-x-6 gap-y-3">
        {groupObjectives(row.objectives).map(([group, groupItems]) => (
          <div key={group} className="flex flex-col gap-1.5">
            <p className="text-xs font-medium text-muted">{GROUP_LABELS[group]}</p>
            <ul className="flex flex-wrap gap-1.5">
              {groupItems.map((objective) => (
                <li
                  key={objective.id}
                  title={objective.description}
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
      <div className="flex justify-end sm:items-center sm:border-l sm:border-line sm:pl-4 sm:self-stretch">
        <ObjectivesLink profileId={row.profileId} name={row.name} label="Ver avance" />
      </div>
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
 * Pero su sitio se reserva siempre, para que la identidad mida lo mismo tenga
 * o no nombre oficial y ninguna fila crezca respecto a sus vecinas.
 *
 * Cuando no hay nombre oficial, el alto que se reserva se reparte en dos mitades,
 * una encima y otra debajo del nombre, en lugar de dejarlo entero debajo: así el
 * nombre de una línea queda centrado en el bloque —alineado con el avatar y los
 * chips, que se centran contra él— en vez de pegado arriba con el hueco vacío
 * debajo. Se reparte en dos y no se centra con `justify-center` porque el bloque
 * mide lo que mide su contenido: sin el hueco, no hay alto que repartir. Las dos
 * mitades suman el mismo alto que la línea que sustituyen, así que el bloque
 * sigue midiendo igual en la tabla y en la tarjeta, donde el nombre tiene otro
 * tamaño de letra.
 *
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
      {officialName === null ? (
        <span aria-hidden="true" className="h-2 shrink-0" />
      ) : null}
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
      ) : (
        // La otra mitad del alto reservado. Es el de una línea de `text-xs`, que
        // es el registro del nombre oficial: 8 px arriba y 8 px abajo.
        <span aria-hidden="true" className="h-2 shrink-0" />
      )}
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