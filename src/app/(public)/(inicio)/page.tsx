import type { Metadata } from "next";
import Link from "next/link";
import Image from "next/image";
import { ArrowUpRight } from "@phosphor-icons/react/dist/ssr/ArrowUpRight";
import { Users } from "@phosphor-icons/react/dist/ssr/Users";
import { LiveDot } from "@/components/live-dot";
import {
  HomeStandings,
  HomeReload,
  HomePlayerChannels,
} from "@/components/home-standings";
import { LiveRefresh } from "@/components/live-refresh";
import { TournamentCountdown } from "@/components/tournament-countdown";
import Loading from "./loading";
import { createHomeStressRows } from "@/lib/home-preview";
import {
  getLastSyncFinishedAt,
  getLiveMatches,
  getStandings,
  getTournamentWindow,
} from "@/lib/public";

export const metadata: Metadata = {
  title: "Clasificación general",
  description:
    "Posiciones de la Liga Hispana de Age of Empires IV ordenadas por puntos: puntos por victorias clasificatorias, logros y objetivos competitivos.",
};
export const dynamic = "force-dynamic";

export default async function StandingsPage({
  searchParams,
}: {
  searchParams: Promise<{ preview?: string }>;
}) {
  const params = await searchParams;
  const preview =
    process.env.NODE_ENV === "development" ? params.preview : undefined;
  if (preview === "loading") return <Loading />;
  const stress = preview === "stress";
  const mocked =
    stress ||
    preview === "empty" ||
    preview === "live" ||
    preview === "unavailable";
  const [standings, liveMatches, tournamentWindow, lastSync] = mocked
    ? ([
        {
          status: "ok",
          data: { rows: [], ruleSetVersion: 0, pendingRuleSetVersion: null },
        },
        { status: "ok", data: [] },
        { status: "degraded", data: null },
        { status: "degraded", data: null },
      ] as const)
    : await Promise.all([
        getStandings(),
        getLiveMatches(),
        getTournamentWindow(),
        getLastSyncFinishedAt(),
      ]);
  const now = new Date().toISOString();
  const nowMs = new Date(now).getTime();
  const statusWindow =
    mocked && preview !== "unavailable"
      ? {
          from: new Date(nowMs - 24 * 60 * 60_000).toISOString(),
          to: new Date(
            nowMs + (9 * 24 * 60 + 7 * 60 + 22) * 60_000,
          ).toISOString(),
        }
      : tournamentWindow.status === "ok"
        ? tournamentWindow.data
        : null;
  const statusUpdatedAt =
    mocked && preview !== "unavailable"
      ? new Date(nowMs - 2 * 60_000).toISOString()
      : lastSync.status === "ok"
        ? lastSync.data
        : null;
  const degraded =
    (!mocked &&
      (standings.status === "degraded" || liveMatches.status === "degraded")) ||
    preview === "unavailable";
  const rows = stress
    ? createHomeStressRows()
    : preview === "live"
      ? createHomeStressRows().slice(0, 12)
      : preview === "empty" || preview === "unavailable"
        ? []
        : [...(standings.data?.rows ?? [])];
  const pendingRuleSetVersion = mocked
    ? null
    : (standings.data?.pendingRuleSetVersion ?? null);
  const liveGames =
    stress || preview === "live" ? 3 : (liveMatches.data?.length ?? 0);
  const streaming = rows
    .filter(
      (row) =>
        (row.twitchChannel && row.twitchIsLive) ||
        (row.youtubeChannel && row.youtubeIsLive) ||
        (row.kickChannel && row.kickIsLive),
    )
    .slice(0, 3);
  const phase = !statusWindow
    ? null
    : nowMs < new Date(statusWindow.from).getTime()
      ? "Próximamente"
      : statusWindow.to && nowMs >= new Date(statusWindow.to).getTime()
        ? "Liga finalizada"
        : "Liga en marcha";

  return (
    <div className="home-layout">
      <section className="home-overview" aria-labelledby="home-title">
        <div className="home-identity-art">
          <Image
            src="/imagenes/portada/escudo-liga-hispana.webp"
            alt=""
            width={960}
            height={804}
            preload
            sizes="(min-width: 1440px) 176px, 64px"
            className="home-hero-emblem"
          />
          <div className="home-hero-copy">
            <h1 id="home-title">Liga Hispana</h1>
            <p>Age of Empires IV</p>
          </div>
        </div>
        <div className="home-tournament-status">
          {phase ? <p className="home-tournament-phase">{phase}</p> : null}
          {!degraded ? (
            <span className="home-participants">
              <Users size={15} aria-hidden="true" />
              <strong>{rows.length.toLocaleString("es-ES")}</strong>{" "}
              {rows.length === 1 ? "participante" : "participantes"}
            </span>
          ) : null}
        </div>
      </section>
      {degraded ? (
        <section className="home-error" role="status">
          <h2>La clasificación no está disponible</h2>
          <p>
            No se ha podido leer la clasificación ni las partidas en juego.
            Vuelve a cargar la página en unos minutos para consultar las
            posiciones.
          </p>
          <HomeReload />
        </section>
      ) : (
        <HomeStandings
          rows={rows}
          pendingRuleSetVersion={pendingRuleSetVersion}
        />
      )}
      <aside className="home-activity" aria-label="Actividad del torneo">
        {!degraded && streaming.length ? (
          <section
            className="home-streams"
            aria-labelledby="home-streams-heading"
          >
            <h2 id="home-streams-heading">
              <LiveDot />
              En directo ahora
            </h2>
            <ul>
              {streaming.map((row) => (
                <li key={row.profileId}>
                  <a
                    href={row.profileUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={row.name}
                  >
                    {row.name}
                  </a>
                  <HomePlayerChannels row={row} liveOnly />
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        <section
          className="home-live-games"
          aria-labelledby="home-games-heading"
        >
          <h2 id="home-games-heading">Partidas en juego</h2>
          {degraded ? (
            <p>Actividad no disponible</p>
          ) : liveGames > 0 ? (
            <p className="home-game-count">
              <LiveDot />
              <strong>
                {liveGames}{" "}
                {liveGames === 1 ? "partida en juego" : "partidas en juego"}{" "}
                ahora
              </strong>
            </p>
          ) : (
            <p>No hay partidas en juego ahora.</p>
          )}
          <Link href="/partidas" target="_blank" rel="noopener noreferrer">
            Ver partidas
            <ArrowUpRight size={14} aria-hidden="true" />
          </Link>
        </section>
      </aside>
      <div className="home-tournament-timing">
        {statusWindow ? (
          <TournamentCountdown
            from={statusWindow.from}
            to={statusWindow.to}
            serverNow={now}
          />
        ) : null}
        <LiveRefresh showStatus dataUpdatedAt={statusUpdatedAt} />
      </div>
      <aside className="home-scoring" aria-labelledby="home-scoring-heading">
        <h2 id="home-scoring-heading">Cómo sumar puntos</h2>
        <dl>
          <div>
            <dt>Por victorias</dt>
            <dd>
              Suma puntos con cada victoria clasificatoria y los bonos de los
              eventos activos.
            </dd>
          </div>
          <div>
            <dt>Por objetivos</dt>
            <dd>Completa logros o lidera retos para sumar puntos extra.</dd>
          </div>
        </dl>
        <Link href="/puntuacion" target="_blank" rel="noopener noreferrer">
          Ver puntuación
          <ArrowUpRight size={14} aria-hidden="true" />
        </Link>
        <Link href="/objetivos" target="_blank" rel="noopener noreferrer">
          Explorar objetivos
          <ArrowUpRight size={14} aria-hidden="true" />
        </Link>
      </aside>
    </div>
  );
}
