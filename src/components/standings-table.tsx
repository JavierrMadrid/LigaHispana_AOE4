"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { DivisionId, StandingRow } from "@/lib/public";
import { DivisionIcon, divisionColor, divisionLabel } from "@/components/division-icon";
import { LiveDot } from "@/components/live-dot";
import { StandingsFilters } from "@/components/standings-filters";
import { TwitchIcon } from "@/components/twitch-icon";

const HEADING = "px-3 pb-2 text-xs font-medium text-muted";
const CELL = "bg-surface px-3 py-2.5 transition-colors group-hover:bg-surface-raised";

/** Podio: el oro, la plata y el bronce de la casa. */
const RANK_CLASS: Record<number, string> = {
  1: "text-accent",
  2: "text-[#aeb6bf]",
  3: "text-[#b07a45]",
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

/**
 * Clasificación con filtros en cliente. El servidor le pasa las filas ya
 * resueltas y aquí solo se filtra y se pinta: búsqueda por nombre o canal,
 * toggles de "en partida" y "en directo" y selección única de división, todo
 * combinado con AND.
 */
export function StandingsTable({ rows }: { rows: StandingRow[] }) {
  const [query, setQuery] = useState("");
  const [playingOnly, setPlayingOnly] = useState(false);
  const [liveOnly, setLiveOnly] = useState(false);
  const [division, setDivision] = useState<DivisionId | null>(null);

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
        const haystack = normalize(`${row.name} ${row.twitchChannel ?? ""}`);

        if (!haystack.includes(needle)) {
          return false;
        }
      }

      return true;
    });
  }, [rows, query, playingOnly, liveOnly, division]);

  const hasFilters = query.trim() !== "" || playingOnly || liveOnly || division !== null;

  function clearFilters() {
    setQuery("");
    setPlayingOnly(false);
    setLiveOnly(false);
    setDivision(null);
  }

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-line bg-surface p-8 sm:p-10">
        <h2 className="font-display text-lg font-semibold text-foreground">
          Todavía no hay nadie en la clasificación
        </h2>
        <p className="mt-2 max-w-[58ch] text-sm leading-relaxed text-muted">
          Solo tienen fila los jugadores aprobados que ya han terminado al menos
          una partida clasificatoria. En cuanto alguien cierre su primera partida
          de ranked, aparecerá aquí.
        </p>
        <Link
          href="/reglas"
          className="mt-5 inline-block text-sm text-accent underline underline-offset-4 hover:text-accent-strong"
        >
          Ver qué cuenta como partida clasificatoria
        </Link>
      </div>
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
        <p role="status" className="text-xs text-muted">
          {filtered.length === 1
            ? "1 jugador coincide con los filtros"
            : `${filtered.length} jugadores coinciden con los filtros`}
        </p>
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
            className="mt-5 inline-flex h-9 items-center rounded-md bg-accent px-3 text-sm font-semibold text-accent-ink transition-colors hover:bg-accent-strong"
          >
            Quitar filtros
          </button>
        </div>
      ) : (
        <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          <table className="w-full min-w-[760px] border-separate border-spacing-y-1.5 text-sm">
            <caption className="sr-only">
              Clasificación de la liga: puesto, jugador, puntos, elo, victorias y
              derrotas, racha y enlace al perfil de AoE4World.
            </caption>
            <thead>
              <tr>
                <th scope="col" className={`${HEADING} w-14 text-center`}>
                  Puesto
                </th>
                <th scope="col" className={`${HEADING} text-left`}>
                  Jugador
                </th>
                <th scope="col" className={`${HEADING} w-20 text-center`}>
                  Puntos
                </th>
                <th scope="col" className={`${HEADING} w-24 text-center`}>
                  Elo
                </th>
                <th scope="col" className={`${HEADING} w-24 text-center`}>
                  V - D
                </th>
                <th scope="col" className={`${HEADING} w-20 text-center`}>
                  Racha
                </th>
                <th scope="col" className={`${HEADING} w-20 text-center`}>
                  Stats
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => (
                <StandingsRow key={row.profileId} row={row} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function StandingsRow({ row }: { row: StandingRow }) {
  return (
    <tr className="group">
      <td
        className={`${CELL} rounded-l-lg text-center font-semibold tabular-nums ${
          RANK_CLASS[row.rank] ?? "text-muted"
        }`}
      >
        {row.rank}
      </td>

      <td className={CELL}>
        <div className="flex items-center gap-3">
          <PlayerAvatar row={row} />
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="max-w-[16rem] truncate font-medium text-foreground">
              {row.name}
            </span>
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
          </div>
        </div>
      </td>

      <td className={`${CELL} text-center`}>
        <span
          className={`font-semibold tabular-nums ${
            row.rank === 1 ? "text-accent" : "text-foreground"
          }`}
        >
          {row.points}
        </span>
      </td>

      <td className={`${CELL} text-center`}>
        <span className="inline-flex items-center justify-center gap-1.5 tabular-nums text-foreground">
          {row.elo === null ? <span className="text-muted">-</span> : row.elo}
          {row.division !== null ? (
            <span
              title={divisionLabel(row.division)}
              className="inline-flex"
              style={{ color: divisionColor(row.division) }}
            >
              <DivisionIcon division={row.division} className="size-4" />
              <span className="sr-only">División {divisionLabel(row.division)}</span>
            </span>
          ) : null}
        </span>
      </td>

      <td className={`${CELL} text-center tabular-nums`}>
        <span className="text-foreground">{row.wins}</span>
        <span className="text-muted"> - </span>
        <span className="text-muted">{row.losses}</span>
      </td>

      <td className={`${CELL} text-center tabular-nums`}>
        <StreakValue streak={row.streak} />
      </td>

      <td className={`${CELL} rounded-r-lg text-center`}>
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
        live ? "text-twitch hover:opacity-80" : "text-muted/60 hover:text-muted"
      }`}
    >
      <TwitchIcon className="size-3.5" />
    </a>
  );
}

function StreakValue({ streak }: { streak: number | null }) {
  if (streak === null) {
    return <span className="text-muted">-</span>;
  }

  if (streak > 0) {
    return <span className="font-medium text-accent">+{streak}</span>;
  }

  return <span className="text-muted">{streak}</span>;
}