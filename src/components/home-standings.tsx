"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ArrowDown } from "@phosphor-icons/react/dist/csr/ArrowDown";
import { ArrowUp } from "@phosphor-icons/react/dist/csr/ArrowUp";
import { ArrowUpRight } from "@phosphor-icons/react/dist/csr/ArrowUpRight";
import { CaretDown } from "@phosphor-icons/react/dist/csr/CaretDown";
import { MagnifyingGlass } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { Trophy } from "@phosphor-icons/react/dist/csr/Trophy";
import { X } from "@phosphor-icons/react/dist/csr/X";
import { Sword } from "@phosphor-icons/react/dist/csr/Sword";
import { Broadcast } from "@phosphor-icons/react/dist/csr/Broadcast";
import { Funnel } from "@phosphor-icons/react/dist/csr/Funnel";
import { Check } from "@phosphor-icons/react/dist/csr/Check";
import type { DivisionId, StandingRow } from "@/lib/public";
import { ChannelLinks } from "@/components/channel-links";
import { DivisionIcon, divisionLabel } from "@/components/division-icon";
import { LeagueIcon, rankLevelToLeague } from "@/components/league-icon";
import { ObjectiveIcon } from "@/components/objective-icon";
import { countryFlagUrl } from "@/lib/flag";
import { normalizeSearchText as normalize } from "@/lib/format";
import { HomeDivisionFilter } from "@/components/home-division-filter";
import { HomeObjectiveHelp } from "@/components/home-objective-help";
import { paginateRows } from "@/lib/pagination";

type SortKey =
  "rank" | "name" | "points" | "matches" | "elo" | "record" | "streak";
const sortOptions: { key: SortKey; label: string }[] = [
  { key: "rank", label: "Puesto" },
  { key: "name", label: "Jugador" },
  { key: "points", label: "Puntos" },
  { key: "matches", label: "Partidas" },
  { key: "elo", label: "Elo" },
  { key: "record", label: "Victorias − derrotas" },
  { key: "streak", label: "Racha" },
];
const tableFields: SortKey[] = ["rank", "name", "points", "record", "elo"];
const number = (value: number) => value.toLocaleString("es-ES");

export function HomePlayerChannels({
  row,
  liveOnly = false,
}: {
  row: StandingRow;
  liveOnly?: boolean;
}) {
  return (
    <ChannelLinks
      animateLive
      className="home-channel-links"
      name={row.name}
      twitch={
        row.twitchChannel && (!liveOnly || row.twitchIsLive)
          ? { channel: row.twitchChannel, isLive: row.twitchIsLive }
          : null
      }
      youtube={
        row.youtubeChannel && (!liveOnly || row.youtubeIsLive)
          ? { channel: row.youtubeChannel, isLive: row.youtubeIsLive }
          : null
      }
      kick={
        row.kickChannel && (!liveOnly || row.kickIsLive)
          ? { channel: row.kickChannel, isLive: row.kickIsLive }
          : null
      }
    />
  );
}

function Identity({ row }: { row: StandingRow }) {
  const flag = row.country ? countryFlagUrl(row.country) : null;
  return (
    <div className="home-player">
      <a
        href={row.profileUrl}
        target="_blank"
        rel="noopener noreferrer"
        title={`${row.name} en AoE4World (abre otra pestaña)`}
      >
        {row.name}
      </a>
      {flag ? (
        <Image
          src={flag}
          alt={row.country ?? ""}
          className="home-flag"
          width={18}
          height={12}
          unoptimized
        />
      ) : null}
      {row.isPlaying ? (
        <HomeObjectiveHelp
          description="En partida"
          className="home-playing-indicator"
          ariaLabel={`${row.name}, en partida`}
          compact
        >
          <span className="home-playing-dot" aria-hidden="true" />
        </HomeObjectiveHelp>
      ) : null}
      <HomePlayerChannels row={row} liveOnly />
    </div>
  );
}

export function HomeStandings({
  rows,
  objectiveDescriptions = {},
}: {
  rows: StandingRow[];
  objectiveDescriptions?: Readonly<Record<string, string>>;
}) {
  const reduceMotion = useReducedMotion();
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState("");
  const [division, setDivision] = useState<DivisionId | "">("");
  const [playing, setPlaying] = useState(false);
  const [live, setLive] = useState(false);
  const [key, setKey] = useState<SortKey>("rank");
  const [descending, setDescending] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filterDialog = useRef<HTMLDialogElement>(null);
  const filterTrigger = useRef<HTMLButtonElement>(null);
  const filtersActive =
    Number(Boolean(division)) + Number(playing) + Number(live);
  const active = query.trim() !== "" || filtersActive > 0;
  const canResetView =
    query !== "" ||
    filtersActive > 0 ||
    key !== "rank" ||
    descending ||
    page !== 1;
  function closeFilters() {
    setFiltersOpen(false);
    requestAnimationFrame(() => filterTrigger.current?.focus());
  }
  useEffect(() => {
    if (!filtersOpen) return;
    const dialog = filterDialog.current;
    const trigger = filterTrigger.current;
    if (!dialog || !trigger) return;
    const media = window.matchMedia("(max-width: 640px)");
    const previousOverflow = document.body.style.overflow;
    function position() {
      if (!dialog || !trigger) return;
      if (media.matches) {
        dialog.style.removeProperty("top");
        dialog.style.removeProperty("left");
      } else {
        const box = trigger.getBoundingClientRect();
        dialog.style.top = `${Math.max(8, Math.min(box.bottom + 8, window.innerHeight - 460))}px`;
        dialog.style.left = `${Math.max(12, Math.min(box.right - 320, window.innerWidth - 332))}px`;
      }
    }
    function show() {
      if (!dialog) return;
      if (dialog.open) dialog.close();
      if (dialog.matches(":popover-open")) dialog.hidePopover();
      if (media.matches) {
        dialog.removeAttribute("popover");
        dialog.showModal();
        document.body.style.overflow = "hidden";
      } else {
        dialog.setAttribute("popover", "manual");
        dialog.showPopover();
        document.body.style.overflow = previousOverflow;
        dialog.querySelector<HTMLButtonElement>("button")?.focus();
      }
      position();
    }
    function outside(event: PointerEvent) {
      if (
        !dialog?.contains(event.target as Node) &&
        !trigger?.contains(event.target as Node)
      ) {
        setFiltersOpen(false);
        trigger?.focus();
      }
    }
    show();
    media.addEventListener("change", show);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    document.addEventListener("pointerdown", outside);
    return () => {
      if (dialog.open) dialog.close();
      if (dialog.matches(":popover-open")) dialog.hidePopover();
      document.body.style.overflow = previousOverflow;
      media.removeEventListener("change", show);
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
      document.removeEventListener("pointerdown", outside);
    };
  }, [filtersOpen]);
  const filtered = useMemo(() => {
    const needle = normalize(query.trim());
    return rows
      .filter(
        (row) =>
          (!playing || row.isPlaying) &&
          (!live || row.twitchIsLive || row.youtubeIsLive || row.kickIsLive) &&
          (!division || row.division === division) &&
          normalize(
            `${row.name} ${row.aoe4WorldName ?? ""} ${row.twitchChannel ?? ""} ${row.youtubeChannel ?? ""} ${row.kickChannel ?? ""}`,
          ).includes(needle),
      )
      .sort((a, b) => {
        const direction = descending ? -1 : 1;
        if (key === "name")
          return (
            normalize(a.name).localeCompare(normalize(b.name), "es") *
              direction || a.rank - b.rank
          );
        if (key === "record")
          return (
            (a.wins - a.losses - (b.wins - b.losses)) * direction ||
            (a.wins - b.wins) * direction ||
            a.rank - b.rank
          );
        const av = key === "matches" ? a.wins + a.losses : a[key];
        const bv = key === "matches" ? b.wins + b.losses : b[key];
        if (av === null) return bv === null ? a.rank - b.rank : 1;
        if (bv === null) return -1;
        return (av - bv) * direction || a.rank - b.rank;
      });
  }, [rows, query, division, playing, live, key, descending]);
  const pagination = paginateRows(filtered, page, 25);
  function clearFilters() {
    setPage(1);
    setDivision("");
    setPlaying(false);
    setLive(false);
  }
  function clearAll() {
    clearFilters();
    setQuery("");
  }
  function resetView() {
    clearAll();
    setKey("rank");
    setDescending(false);
  }
  function sort(field: SortKey, toggleDirection = true) {
    setPage(1);
    setDescending(
      key === field && toggleDirection
        ? !descending
        : field !== "rank" && field !== "name",
    );
    setKey(field);
  }
  function toggle(id: number) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  return (
    <section className="home-board" aria-labelledby="standings-heading">
      <div className="home-toolbar">
        <h2 id="standings-heading">Clasificación</h2>
        {rows.length ? (
          <>
            <label className="home-search">
              <span className="sr-only">Buscar jugador o canal</span>
              <MagnifyingGlass size={17} aria-hidden="true" />
              <input
                value={query}
                onChange={(event) => {
                  setPage(1);
                  setQuery(event.target.value);
                }}
                placeholder="Buscar jugador o canal…"
              />
              {query ? (
                <button
                  type="button"
                  onClick={() => {
                    setPage(1);
                    setQuery("");
                  }}
                  aria-label="Borrar búsqueda"
                >
                  <X size={15} aria-hidden="true" />
                </button>
              ) : null}
            </label>
            <button
              type="button"
              ref={filterTrigger}
              className="home-filter-button"
              aria-haspopup="dialog"
              aria-controls="home-filters"
              aria-expanded={filtersOpen}
              onClick={() => setFiltersOpen(!filtersOpen)}
            >
              <Funnel size={16} aria-hidden="true" /> Filtros{" "}
              {filtersActive ? (
                <span className="home-filter-count">{filtersActive}</span>
              ) : null}
            </button>
          </>
        ) : null}
      </div>
      <dialog
        ref={filterDialog}
        id="home-filters"
        className="home-filters-panel"
        aria-labelledby="home-filter-heading"
        onCancel={(event) => {
          event.preventDefault();
          closeFilters();
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !event.defaultPrevented) {
            event.preventDefault();
            closeFilters();
          }
        }}
        onPointerDown={(event) => {
          if (event.target === event.currentTarget) {
            const rect = event.currentTarget.getBoundingClientRect();
            if (
              event.clientX < rect.left ||
              event.clientX > rect.right ||
              event.clientY < rect.top ||
              event.clientY > rect.bottom
            )
              closeFilters();
          }
        }}
      >
        <div className="home-filter-heading">
          <h3 id="home-filter-heading">Filtros y orden</h3>
          <button
            type="button"
            onClick={closeFilters}
            aria-label="Cerrar filtros"
          >
            <X size={19} aria-hidden="true" />
          </button>
        </div>
        <HomeDivisionFilter
          value={division}
          onChange={(value) => {
            setPage(1);
            setDivision(value);
          }}
        />
        <fieldset className="home-status-field">
          <legend className="home-field-label">Actividad</legend>
          <div className="home-status-filters">
            <button
              type="button"
              aria-pressed={playing}
              onClick={() => {
                setPage(1);
                setPlaying(!playing);
              }}
            >
              <Sword size={17} aria-hidden="true" /> En partida{" "}
              {playing ? <Check size={14} aria-hidden="true" /> : null}
            </button>
            <button
              type="button"
              aria-pressed={live}
              onClick={() => {
                setPage(1);
                setLive(!live);
              }}
            >
              <Broadcast size={17} aria-hidden="true" /> En directo{" "}
              {live ? <Check size={14} aria-hidden="true" /> : null}
            </button>
          </div>
        </fieldset>
        <div className="home-sort">
          <label htmlFor="home-sort">
            Ordenar por
            <select
              id="home-sort"
              value={key}
              onChange={(event) => sort(event.target.value as SortKey, false)}
            >
              {sortOptions.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => {
              setPage(1);
              setDescending(!descending);
            }}
            aria-label={`Orden ${descending ? "descendente; cambiar a ascendente" : "ascendente; cambiar a descendente"}`}
          >
            {descending ? (
              <ArrowDown size={18} aria-hidden="true" />
            ) : (
              <ArrowUp size={18} aria-hidden="true" />
            )}
          </button>
        </div>
        <button
          type="button"
          className="home-filter-reset"
          disabled={!canResetView}
          onClick={resetView}
        >
          Restablecer vista
        </button>
        <button
          type="button"
          className="home-primary home-filter-done"
          onClick={closeFilters}
        >
          Ver resultados
        </button>
      </dialog>
      {filtersActive ? (
        <div className="home-filter-chips" aria-label="Filtros activos">
          {division ? (
            <button
              type="button"
              onClick={() => {
                setDivision("");
                setPage(1);
              }}
              aria-label={`Quitar filtro ${divisionLabel(division)}`}
            >
              {divisionLabel(division)}
              <X size={12} aria-hidden="true" />
            </button>
          ) : null}
          {playing ? (
            <button
              type="button"
              onClick={() => {
                setPlaying(false);
                setPage(1);
              }}
              aria-label="Quitar filtro en partida"
            >
              En partida
              <X size={12} aria-hidden="true" />
            </button>
          ) : null}
          {live ? (
            <button
              type="button"
              onClick={() => {
                setLive(false);
                setPage(1);
              }}
              aria-label="Quitar filtro en directo"
            >
              En directo
              <X size={12} aria-hidden="true" />
            </button>
          ) : null}
          <button
            type="button"
            className="home-clear-filters"
            onClick={clearFilters}
          >
            Limpiar
          </button>
        </div>
      ) : null}
      {filtered.length ? (
        <table className="home-table">
          <caption className="sr-only">
            Clasificación del torneo. Los nombres abren AoE4World. Despliega
            cada jugador para ver sus puntos, estadísticas y objetivos.
          </caption>
          <thead>
            <tr>
              {tableFields.map((field) => (
                <th
                  key={field}
                  scope="col"
                  className={
                    field === "elo"
                      ? "home-elo"
                      : field === "record"
                        ? "home-record"
                        : undefined
                  }
                  aria-sort={
                    key === field
                      ? descending
                        ? "descending"
                        : "ascending"
                      : "none"
                  }
                >
                  <button
                    type="button"
                    onClick={() => sort(field)}
                    aria-label={
                      field === "record"
                        ? "Victorias y derrotas: ordenar por diferencia"
                        : undefined
                    }
                  >
                    {field === "record" ? (
                      <span aria-hidden="true">V / D</span>
                    ) : (
                      sortOptions.find((option) => option.key === field)?.label
                    )}
                    <span className="home-sort-arrow" aria-hidden="true">
                      {key === field ? (
                        descending ? (
                          <ArrowDown size={11} aria-hidden="true" />
                        ) : (
                          <ArrowUp size={11} aria-hidden="true" />
                        )
                      ) : null}
                    </span>
                  </button>
                </th>
              ))}
              <th scope="col" className="home-expand-heading">
                <span className="sr-only">Detalles</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {pagination.rows.map((row) => (
              <Fragment key={row.profileId}>
                <tr className="home-standing" data-rank={row.rank}>
                  <td className="home-rank">{row.rank}</td>
                  <td className="home-identity">
                    <Identity row={row} />
                  </td>
                  <td className="home-points">
                    <strong>{number(row.points)}</strong>
                  </td>
                  <td className="home-record">
                    <span
                      aria-label={`${row.wins} victorias, ${row.losses} derrotas`}
                    >
                      <span className="home-win">{row.wins}</span>
                      {" / "}
                      <span
                        className={row.losses > 0 ? "home-loss" : undefined}
                      >
                        {row.losses}
                      </span>
                    </span>
                  </td>
                  <td className="home-elo">
                    <Elo row={row} />
                  </td>
                  <td className="home-expand">
                    <button
                      type="button"
                      onClick={() => toggle(row.profileId)}
                      aria-expanded={expanded.has(row.profileId)}
                      aria-controls={`home-details-${row.profileId}`}
                      aria-label={`${expanded.has(row.profileId) ? "Ocultar" : "Ver"} detalles de ${row.name}`}
                    >
                      <CaretDown size={17} aria-hidden="true" />
                    </button>
                  </td>
                </tr>
                <AnimatePresence initial={false}>
                  {expanded.has(row.profileId) ? (
                    <motion.tr
                      initial={reduceMotion ? false : { opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: reduceMotion ? 0 : 0.15 }}
                      id={`home-details-${row.profileId}`}
                      className="home-objective-detail"
                    >
                      <td colSpan={6}>
                        <div className="home-objective-content">
                          <h3>Detalles de {row.name}</h3>
                          <dl className="home-detail-stats">
                            <div>
                              <dt>Acumulados</dt>
                              <dd>
                                {row.pointsAccumulated === null
                                  ? "—"
                                  : number(row.pointsAccumulated)}
                              </dd>
                            </div>
                            <div>
                              <dt>Por liderato</dt>
                              <dd>
                                {row.pointsByLeadership === null
                                  ? "—"
                                  : number(row.pointsByLeadership)}
                              </dd>
                            </div>
                            <div>
                              <dt>Partidas</dt>
                              <dd>{number(row.wins + row.losses)}</dd>
                            </div>
                            <div>
                              <dt>Victorias / derrotas</dt>
                              <dd>
                                <span className="home-win">{row.wins}</span> /{" "}
                                <span
                                  className={
                                    row.losses ? "home-loss" : undefined
                                  }
                                >
                                  {row.losses}
                                </span>
                              </dd>
                            </div>
                            <div>
                              <dt>Racha</dt>
                              <dd
                                className={
                                  row.streak !== null && row.streak < 0
                                    ? "home-loss"
                                    : undefined
                                }
                              >
                                {row.streak === null
                                  ? "—"
                                  : row.streak > 0
                                    ? `+${row.streak}`
                                    : row.streak}
                              </dd>
                            </div>
                            <div className="home-detail-elo">
                              <dt>Elo</dt>
                              <dd>
                                <Elo row={row} />
                              </dd>
                            </div>
                          </dl>
                          {row.pointsAccumulated === null ||
                          row.pointsByLeadership === null ? (
                            <p>Desglose no disponible</p>
                          ) : null}
                          <div className="home-detail-player">
                            {row.aoe4WorldName ? (
                              <span>AoE4World: {row.aoe4WorldName}</span>
                            ) : null}
                            <HomePlayerChannels row={row} />
                          </div>
                          <h4>
                            Objetivos <span>({row.objectives.length})</span>
                          </h4>
                          {row.objectives.length ? (
                            <ul>
                              {row.objectives.map((objective) => (
                                <li key={objective.id}>
                                  <HomeObjectiveHelp
                                    description={
                                      objectiveDescriptions[objective.id] ??
                                      objective.label
                                    }
                                  >
                                    <span className="home-objective-emblem">
                                      <ObjectiveIcon
                                        option={objective}
                                        className="size-7"
                                      />
                                    </span>
                                    <span>{objective.label}</span>
                                    <strong>+{objective.points} pts</strong>
                                  </HomeObjectiveHelp>
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <p>Todavía no posee objetivos especiales.</p>
                          )}
                          <Link
                            target="_blank"
                            rel="noopener noreferrer"
                            href={`/objetivos/${row.profileId}`}
                          >
                            Ver ficha de objetivos
                            <ArrowUpRight size={14} aria-hidden="true" />
                          </Link>
                        </div>
                      </td>
                    </motion.tr>
                  ) : null}
                </AnimatePresence>
              </Fragment>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="home-empty">
          {rows.length ? (
            <>
              <MagnifyingGlass size={28} aria-hidden="true" />
              <h3>Ningún jugador coincide</h3>
              <p>
                Prueba otro nombre o quita los filtros para volver a la
                clasificación.
              </p>
              <button type="button" className="home-primary" onClick={clearAll}>
                Limpiar búsqueda y filtros
              </button>
            </>
          ) : (
            <>
              <Trophy size={28} aria-hidden="true" />
              <h3>La competición empieza con sus jugadores</h3>
              <p>
                Los participantes aprobados aparecerán aquí, incluso antes de
                jugar su primera partida.
              </p>
              <Link
                target="_blank"
                rel="noopener noreferrer"
                href="/participar"
                className="home-primary"
              >
                Inscríbete
                <ArrowUpRight size={16} aria-hidden="true" />
              </Link>
            </>
          )}
        </div>
      )}
      {rows.length ? (
        <div className="home-table-footer">
          <p role="status">
            {pagination.start}–{pagination.end} de {pagination.total}{" "}
            {pagination.total === 1 ? "jugador" : "jugadores"}
            {active ? " · Resultados filtrados" : ""}
          </p>
          {pagination.pageCount > 1 ? (
            <nav
              className="home-pagination"
              aria-label="Páginas de la clasificación"
            >
              <button
                type="button"
                disabled={pagination.page === 1}
                onClick={() => setPage(1)}
                aria-label="Primera página"
              >
                Primera
              </button>
              <button
                type="button"
                disabled={pagination.page === 1}
                onClick={() => setPage(pagination.page - 1)}
                aria-label="Página anterior"
              >
                Anterior
              </button>
              <span>
                {pagination.page} / {pagination.pageCount}
              </span>
              <button
                type="button"
                disabled={pagination.page === pagination.pageCount}
                onClick={() => setPage(pagination.page + 1)}
                aria-label="Página siguiente"
              >
                Siguiente
              </button>
              <button
                type="button"
                disabled={pagination.page === pagination.pageCount}
                onClick={() => setPage(pagination.pageCount)}
                aria-label="Última página"
              >
                Última
              </button>
            </nav>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function Elo({ row }: { row: StandingRow }) {
  const rank = rankLevelToLeague(row.rankLevel);
  return (
    <span
      className="home-elo-value"
      title={row.division ? divisionLabel(row.division) : "Sin clasificar"}
    >
      {rank ? (
        <LeagueIcon rank={rank} className="home-division-emblem" />
      ) : row.division ? (
        <DivisionIcon
          division={row.division}
          className="home-division-emblem"
        />
      ) : (
        <span className="home-division-emblem" />
      )}
      <span>{row.elo === null ? "—" : number(row.elo)}</span>
    </span>
  );
}

export function HomeReload() {
  return (
    <button
      type="button"
      className="home-primary"
      onClick={() => window.location.reload()}
    >
      Volver a cargar
      <ArrowUpRight size={16} aria-hidden="true" />
    </button>
  );
}
