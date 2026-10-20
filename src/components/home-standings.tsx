"use client";

import { Fragment, useMemo, useState, type CSSProperties } from "react";
import Link from "next/link";
import Image from "next/image";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ArrowDown } from "@phosphor-icons/react/dist/csr/ArrowDown";
import { ArrowUp } from "@phosphor-icons/react/dist/csr/ArrowUp";
import { ArrowUpRight } from "@phosphor-icons/react/dist/csr/ArrowUpRight";
import { CaretDown } from "@phosphor-icons/react/dist/csr/CaretDown";
import { MagnifyingGlass } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { Trophy } from "@phosphor-icons/react/dist/csr/Trophy";
import { Medal } from "@phosphor-icons/react/dist/csr/Medal";
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
import { PlayerAvatar } from "@/components/player-avatar";
import { countryFlagSvgUrl, countryFlagUrl } from "@/lib/flag";
import { HomeDivisionFilter } from "@/components/home-division-filter";
import { HomeObjectiveHelp } from "@/components/home-objective-help";
import { paginateRows } from "@/lib/pagination";
import { useHomeTableGlow } from "@/components/use-home-table-glow";
import { useHomeRowReveal } from "@/components/use-home-row-reveal";

type SortKey =
  | "rank"
  | "name"
  | "points"
  | "matches"
  | "elo"
  | "record"
  | "streak";
const sortOptions: { key: SortKey; label: string }[] = [
  { key: "rank", label: "Puesto" },
  { key: "name", label: "Jugador" },
  { key: "points", label: "Puntos" },
  { key: "matches", label: "Partidas" },
  { key: "elo", label: "Elo" },
  { key: "record", label: "Victorias − derrotas" },
  { key: "streak", label: "Racha" },
];
const normalize = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
const number = (value: number) => value.toLocaleString("es-ES");

function Identity({ row }: { row: StandingRow }) {
  const flag = row.country ? countryFlagUrl(row.country) : null;
  return (
    <div className="home-player">
      <span className="home-avatar-frame">
        <PlayerAvatar
          name={row.name}
          avatarUrl={row.avatarUrl}
          className="size-10 text-xs"
          shape="square"
        />
        {row.isPlaying ? (
          <span
            className="home-playing-indicator"
            role="img"
            aria-label="En partida"
            title="En partida"
          />
        ) : null}
      </span>
      <div className="home-player-copy">
        <div className="home-player-name">
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
              style={{ height: "auto" }}
              unoptimized
            />
          ) : null}
        </div>
        <div className="home-player-meta">
          {row.aoe4WorldName ? (
            <span className="home-official-name">{row.aoe4WorldName}</span>
          ) : null}
          <ChannelLinks
            animateLive
            className="home-channel-links"
            name={row.name}
            twitch={
              row.twitchChannel
                ? { channel: row.twitchChannel, isLive: row.twitchIsLive }
                : null
            }
            youtube={
              row.youtubeChannel
                ? { channel: row.youtubeChannel, isLive: row.youtubeIsLive }
                : null
            }
            kick={
              row.kickChannel
                ? { channel: row.kickChannel, isLive: row.kickIsLive }
                : null
            }
          />
        </div>
      </div>
    </div>
  );
}

export function HomeLeaders({ rows }: { rows: StandingRow[] }) {
  if (!rows.length) return null;
  return (
    <section className="home-leaders" aria-label="Líderes de la clasificación">
      {rows.slice(0, 3).map((row) => (
        <article key={row.profileId}>
          <span className="home-leader-rank">
            <Trophy size={18} aria-hidden="true" />
            {row.rank}.º puesto
          </span>
          <Identity row={row} />
          <div className="home-leader-score">
            {number(row.points)}
            <span>puntos</span>
          </div>
        </article>
      ))}
    </section>
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
  const boardRef = useHomeTableGlow(reduceMotion);
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState("");
  const [division, setDivision] = useState<DivisionId | "">("");
  const [playing, setPlaying] = useState(false);
  const [live, setLive] = useState(false);
  const [key, setKey] = useState<SortKey>("rank");
  const [descending, setDescending] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const filtered = useMemo(() => {
    const needle = normalize(query.trim());
    return rows
      .filter(
        (row) =>
          (!playing || row.isPlaying) &&
          (!live || row.twitchIsLive || row.youtubeIsLive || row.kickIsLive) &&
          (!division || row.division === division) &&
          normalize(
            `${row.name} ${row.aoe4WorldName ?? ""} ${
              row.twitchChannel ?? ""
            } ${row.youtubeChannel ?? ""} ${row.kickChannel ?? ""}`
          ).includes(needle)
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
  useHomeRowReveal(
    boardRef,
    pagination.rows.map((row) => row.profileId).join(","),
    reduceMotion
  );
  const active = query.trim() !== "" || division !== "" || playing || live;
  function clear() {
    setPage(1);
    setQuery("");
    setDivision("");
    setPlaying(false);
    setLive(false);
  }
  function sort(field: SortKey) {
    setPage(1);
    if (key === field && descending) {
      setKey("rank");
      setDescending(false);
    } else if (key === field) setDescending(true);
    else {
      setKey(field);
      setDescending(false);
    }
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
    <section
      ref={boardRef}
      className="home-board home-focus-command home-table-glow"
      aria-labelledby="standings-heading"
    >
      <h2 id="standings-heading" className="sr-only">
        Clasificación general
      </h2>
      {rows.length > 0 ? (
        <>
          <div className="home-toolbar">
            <label className="home-field">
              <span id="home-search-label" className="home-field-label">
                Buscar jugador o canal
              </span>
              <span className="home-search">
                <MagnifyingGlass size={19} aria-hidden="true" />
                <input
                  aria-labelledby="home-search-label"
                  value={query}
                  onChange={(event) => {
                    setPage(1);
                    setQuery(event.target.value);
                  }}
                  placeholder="Buscar jugador o canal…"
                />
                {query ? (
                  <button
                    onClick={() => {
                      setPage(1);
                      setQuery("");
                    }}
                    aria-label="Borrar búsqueda"
                  >
                    <X size={16} aria-hidden="true" />
                  </button>
                ) : null}
              </span>
            </label>
            <HomeDivisionFilter
              value={division}
              onChange={(value) => {
                setPage(1);
                setDivision(value);
              }}
            />
            <fieldset className="home-status-field">
              <legend className="home-field-label">
                <Funnel size={14} aria-hidden="true" />
                Filtros de estado
              </legend>
              <div className="home-status-filters">
                <button
                  aria-pressed={playing}
                  onClick={() => {
                    setPage(1);
                    setPlaying(!playing);
                  }}
                >
                  <Sword size={17} weight="regular" aria-hidden="true" />
                  En partida
                  {playing ? <Check size={14} aria-hidden="true" /> : null}
                </button>
                <button
                  aria-pressed={live}
                  onClick={() => {
                    setPage(1);
                    setLive(!live);
                  }}
                >
                  <Broadcast size={17} weight="regular" aria-hidden="true" />
                  En directo
                  {live ? <Check size={14} aria-hidden="true" /> : null}
                </button>
              </div>
            </fieldset>
          </div>
          <div className="home-table-summary">
            <p role="status">
              {pagination.start}–{pagination.end} de {pagination.total}{" "}
              {pagination.total === 1 ? "jugador" : "jugadores"}
              {active ? (
                <button onClick={clear}>
                  Quitar filtros
                  <X size={13} aria-hidden="true" />
                </button>
              ) : null}
            </p>
            <div className="home-sort">
              <label>
                <span>Ordenar por</span>
                <span className="home-sort-select">
                  <select
                    value={key}
                    onChange={(event) => sort(event.target.value as SortKey)}
                  >
                    {sortOptions.map((option) => (
                      <option key={option.key} value={option.key}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <CaretDown size={14} aria-hidden="true" />
                </span>
              </label>
              <button
                onClick={() => {
                  setPage(1);
                  setDescending(!descending);
                }}
                aria-label={`Orden ${
                  descending
                    ? "descendente; cambiar a ascendente"
                    : "ascendente; cambiar a descendente"
                }`}
              >
                {descending ? <ArrowDown size={16} /> : <ArrowUp size={16} />}
              </button>
            </div>
          </div>
          {filtered.length ? (
            <table className="home-table">
              <caption className="sr-only">
                Clasificación del torneo. Los nombres abren AoE4World y los
                objetivos se pueden desplegar.
              </caption>
              <thead>
                <tr>
                  {[
                    { field: "rank", label: "Puesto" },
                    { field: "name", label: "Jugador" },
                    { field: "points", label: "Puntos" },
                    { field: "matches", label: "Partidas" },
                    { field: "elo", label: "Elo" },
                    { field: "record", label: "V − D" },
                    { field: "streak", label: "Racha" },
                  ].map(({ field, label }) => (
                    <th
                      key={field}
                      scope="col"
                      aria-sort={
                        key === field
                          ? descending
                            ? "descending"
                            : "ascending"
                          : "none"
                      }
                    >
                      <button onClick={() => sort(field as SortKey)}>
                        {field === "record" ? (
                          <>
                            <span className="home-win">V</span>
                            <span>−</span>
                            <span className="home-loss">D</span>
                          </>
                        ) : (
                          label
                        )}
                        {key === field ? (
                          descending ? (
                            <ArrowDown size={12} aria-hidden="true" />
                          ) : (
                            <ArrowUp size={12} aria-hidden="true" />
                          )
                        ) : null}
                      </button>
                    </th>
                  ))}
                  <th scope="col">Objetivos</th>
                </tr>
              </thead>
              <tbody>
                <AnimatePresence>
                  {pagination.rows.map((row) => (
                    <Fragment key={row.profileId}>
                      <tr
                        data-rank={row.rank}
                        className={`home-standing ${
                          row.rank === 1 ? "home-first" : ""
                        }`}
                      >
                        <td className="home-rank" data-label="Puesto">
                          <span className="home-row-glow" aria-hidden="true" />
                          <span
                            className="home-row-outline"
                            aria-hidden="true"
                          />
                          {countryFlagSvgUrl(row.country) ? (
                            <span
                              aria-hidden="true"
                              className="home-row-flag"
                              style={
                                {
                                  "--flag-source": `url("${countryFlagSvgUrl(
                                    row.country
                                  )}")`,
                                } as CSSProperties
                              }
                            >
                              <span className="home-row-flag-art">
                                {/* El tamaño natural evita deformar el SVG al cambiar la altura de la ficha. */}
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img
                                  src={
                                    countryFlagSvgUrl(row.country) ?? undefined
                                  }
                                  alt=""
                                  loading="lazy"
                                  decoding="async"
                                />
                              </span>
                            </span>
                          ) : null}
                          <span
                            className={`home-rank-badge${
                              row.rank >= 1000 ? " home-rank-wide" : ""
                            }`}
                          >
                            {row.rank === 1 ? (
                              <Trophy size={19} aria-hidden="true" />
                            ) : row.rank <= 3 ? (
                              <Medal size={19} aria-hidden="true" />
                            ) : null}
                            <span>{row.rank.toString().padStart(2, "0")}</span>
                          </span>
                        </td>
                        <td className="home-identity">
                          <Identity row={row} />
                        </td>
                        <td className="home-points" data-label="Puntos">
                          <strong>{number(row.points)}</strong>
                          <span
                            aria-label={`${row.pointsByWins} puntos por victorias y ${row.pointsByObjectives} puntos por objetivos`}
                            title="Puntos por victorias / puntos por objetivos"
                          >
                            <span>
                              {number(row.pointsByWins)}{" "}
                              <span className="home-score-label">vict.</span>
                            </span>
                            <span className="home-score-divider"> · </span>
                            <span>
                              {number(row.pointsByObjectives)}{" "}
                              <span className="home-score-label">obj.</span>
                            </span>
                          </span>
                        </td>
                        <td className="home-matches" data-label="Partidas">
                          {row.wins + row.losses}
                        </td>
                        <td className="home-elo" data-label="Elo">
                          <span>
                            <span className="home-elo-badge-slot">
                              <RankArtwork row={row} />
                            </span>
                            <span className="home-elo-value">
                              {row.elo === null ? "—" : number(row.elo)}
                              <small>
                                {row.division
                                  ? divisionLabel(row.division)
                                  : "Sin clasificar"}
                              </small>
                            </span>
                          </span>
                        </td>
                        <td className="home-record" data-label="V − D">
                          <span className="home-win">{row.wins}</span>
                          <span className="home-separator"> − </span>
                          <span
                            className={row.losses > 0 ? "home-loss" : undefined}
                          >
                            {row.losses}
                          </span>
                        </td>
                        <td className="home-streak" data-label="Racha">
                          <span
                            className={
                              row.streak !== null && row.streak > 0
                                ? "home-win"
                                : row.streak !== null && row.streak < 0
                                ? "home-loss"
                                : ""
                            }
                          >
                            {row.streak === null
                              ? "—"
                              : row.streak > 0
                              ? `+${row.streak}`
                              : row.streak}
                          </span>
                        </td>
                        <td className="home-objectives">
                          <button
                            onClick={() => toggle(row.profileId)}
                            aria-expanded={expanded.has(row.profileId)}
                            aria-controls={`home-objectives-${row.profileId}`}
                            aria-label={`${
                              expanded.has(row.profileId) ? "Ocultar" : "Ver"
                            } objetivos de ${row.name}`}
                          >
                            <TargetMark />
                            {row.objectives.length}
                            <span className="home-objective-label">
                              objetivos
                            </span>
                            <CaretDown size={13} aria-hidden="true" />
                          </button>
                        </td>
                      </tr>
                      <AnimatePresence initial={false}>
                        {expanded.has(row.profileId) ? (
                          <motion.tr
                            initial={reduceMotion ? false : { opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            transition={{ duration: reduceMotion ? 0 : 0.2 }}
                            id={`home-objectives-${row.profileId}`}
                            className="home-objective-detail"
                          >
                            <td colSpan={8}>
                              <motion.div
                                initial={
                                  reduceMotion
                                    ? false
                                    : { height: 0, opacity: 0 }
                                }
                                animate={{ height: "auto", opacity: 1 }}
                                exit={{ height: 0, opacity: 0 }}
                                transition={{
                                  duration: reduceMotion ? 0 : 0.25,
                                }}
                                className="home-objective-content"
                              >
                                <h3>Objetivos de {row.name}</h3>
                                {row.objectives.length ? (
                                  <ul>
                                    {row.objectives.map((objective) => (
                                      <li key={objective.id}>
                                        <HomeObjectiveHelp
                                          description={
                                            objectiveDescriptions[
                                              objective.id
                                            ] ?? objective.label
                                          }
                                        >
                                          <span className="home-objective-emblem">
                                            <ObjectiveIcon
                                              option={objective}
                                              className="size-7"
                                            />
                                          </span>
                                          <span>{objective.label}</span>
                                          <strong>
                                            +{objective.points} pts
                                          </strong>
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
                              </motion.div>
                            </td>
                          </motion.tr>
                        ) : null}
                      </AnimatePresence>
                    </Fragment>
                  ))}
                </AnimatePresence>
              </tbody>
            </table>
          ) : (
            <div className="home-empty">
              <MagnifyingGlass size={32} aria-hidden="true" />
              <h3>Ningún jugador coincide</h3>
              <p>
                Prueba otro nombre o quita los filtros para volver a la
                clasificación.
              </p>
              <button className="home-primary" onClick={clear}>
                Quitar filtros
              </button>
            </div>
          )}
        </>
      ) : (
        <div className="home-empty">
          <Trophy size={32} aria-hidden="true" />
          <h3>La competición empieza con sus jugadores</h3>
          <p>
            Los participantes aprobados aparecerán aquí, incluso antes de jugar
            su primera partida.
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
        </div>
      )}
      {pagination.pageCount > 1 ? (
        <nav
          className="home-pagination"
          aria-label="Páginas de la clasificación"
        >
          <p aria-live="polite">
            Página {pagination.page} de {pagination.pageCount}
          </p>
          <div>
            <button
              disabled={pagination.page === 1}
              onClick={() => setPage(1)}
              aria-label="Primera página"
            >
              Primera
            </button>
            <button
              disabled={pagination.page === 1}
              onClick={() => setPage(pagination.page - 1)}
              aria-label="Página anterior"
            >
              Anterior
            </button>
            <button
              disabled={pagination.page === pagination.pageCount}
              onClick={() => setPage(pagination.page + 1)}
              aria-label="Página siguiente"
            >
              Siguiente
            </button>
            <button
              disabled={pagination.page === pagination.pageCount}
              onClick={() => setPage(pagination.pageCount)}
              aria-label="Última página"
            >
              Última
            </button>
          </div>
        </nav>
      ) : null}
      <div className="home-board-footnote">
        Puntos: victorias / objetivos. Elo: clasificación de AoE4World.
        <Link target="_blank" rel="noopener noreferrer" href="/objetivos">
          Explorar objetivos
          <ArrowUpRight size={14} aria-hidden="true" />
        </Link>
      </div>
    </section>
  );
}

function TargetMark() {
  return <Trophy size={15} aria-hidden="true" />;
}

export function HomeReload() {
  return (
    <button className="home-primary" onClick={() => window.location.reload()}>
      Volver a cargar
      <ArrowUpRight size={16} aria-hidden="true" />
    </button>
  );
}

function RankArtwork({ row }: { row: StandingRow }) {
  const rank = rankLevelToLeague(row.rankLevel);
  return rank ? (
    <LeagueIcon rank={rank} className="home-division-emblem shrink-0" />
  ) : row.division ? (
    <DivisionIcon
      division={row.division}
      className="home-division-emblem shrink-0"
    />
  ) : null;
}
