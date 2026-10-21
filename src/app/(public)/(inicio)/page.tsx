import type { Metadata } from "next";
import Link from "next/link";
import Image from "next/image";
import { ArrowUpRight } from "@phosphor-icons/react/dist/ssr/ArrowUpRight";
import { Users } from "@phosphor-icons/react/dist/ssr/Users";
import { LiveDot } from "@/components/live-dot";
import {
  HomeLeaders,
  HomeStandings,
  HomeReload,
} from "@/components/home-standings";
import { LiveRefresh } from "@/components/live-refresh";
import { TournamentCountdown } from "@/components/tournament-countdown";
import Loading from "./loading";
import { createHomeStressRows } from "@/lib/home-preview";
import { HOME_OBJECTIVE_DESCRIPTIONS } from "@/lib/home-objective-descriptions";
import {
  getLastSyncFinishedAt,
  getLiveMatches,
  getStandings,
  getTournamentWindow,
} from "@/lib/public";

export const metadata: Metadata = {
  title: "Clasificación general",
  description:
    "Posiciones de la Liga Hispana de Age of Empires IV ordenadas por puntos: 2 por cada victoria clasificatoria más los puntos de los objetivos especiales.",
};
export const dynamic = "force-dynamic";

export default async function StandingsPage({
  searchParams,
}: {
  searchParams: Promise<{ concept?: string; preview?: string }>;
}) {
  const params = await searchParams;
  const preview =
    process.env.NODE_ENV === "development" ? params.preview : undefined;
  if (preview === "loading") return <Loading />;
  const stress = preview === "stress";
  const [standings, liveMatches, tournamentWindow, lastSync] = stress
    ? ([
        { status: "ok", data: [] },
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
  const statusWindow = stress
    ? {
        from: new Date(nowMs - 24 * 60 * 60_000).toISOString(),
        to: new Date(nowMs + (9 * 24 * 60 + 7 * 60 + 22) * 60_000).toISOString(),
      }
    : tournamentWindow.status === "ok"
      ? tournamentWindow.data
      : null;
  const statusUpdatedAt = stress
    ? new Date(nowMs - 2 * 60_000).toISOString()
    : lastSync.status === "ok"
      ? lastSync.data
      : null;
  const degraded =
    !stress &&
    (standings.status === "degraded" ||
      liveMatches.status === "degraded" ||
      preview === "unavailable");
  const rows = stress
    ? createHomeStressRows()
    : preview === "empty"
    ? []
    : (standings.data ?? []).map((row, index) =>
        preview === "live" && index === 0
          ? {
              ...row,
              isPlaying: true,
              twitchIsLive: row.twitchChannel !== null,
            }
          : row
      );
  const liveGames = stress
    ? 3
    : preview === "live"
      ? 1
      : liveMatches.data?.length ?? 0;
  const hub =
    process.env.NODE_ENV === "development" && params.concept === "hub";

  return (
    <div>
      <section className="home-intro home-heraldic-frame" aria-labelledby="home-title">
        <Image
          src="/imagenes/portada/aoe4-delhi-banner.webp"
          alt=""
          fill
          sizes="(max-width: 640px) calc(100vw - 32px), (max-width: 1440px) calc(100vw - 80px), 1360px"
          className="home-banner-art"
        />
        <div className="home-hero-identity">
          <Image
            src="/imagenes/portada/escudo-liga-hispana.webp"
            alt=""
            width={960}
            height={804}
            preload
            sizes="(max-width: 640px) 172px, 234px"
            className="home-hero-emblem"
          />
          <div className="home-hero-copy">
            <h1 id="home-title">{hub ? "La liga se juega aquí." : "Liga Hispana"}</h1>
            <p className="home-hero-game">Age of Empires IV</p>
            <p className="home-hero-description">Clasificación y partidas en directo</p>
          </div>
        </div>
      </section>
      {degraded ? (
        <section className="home-error">
          <h2>La clasificación no está disponible</h2>
          <p>
            No se ha podido leer la clasificación ni las partidas en juego.
            Vuelve a cargar la página en unos minutos para consultar las
            posiciones.
          </p>
          <HomeReload />
        </section>
      ) : (
        <>
          <div className="home-status">
            <div className="home-status-main">
              {liveGames > 0 ? <LiveDot /> : null}
              <div>
                {liveGames > 0 ? (
                  <Link
                    target="_blank"
                    rel="noopener noreferrer"
                    href="/partidas"
                  >
                    <strong>
                      {liveGames === 1
                        ? "1 Partida en juego ahora"
                        : `${liveGames} Partidas en juego ahora`}
                      <ArrowUpRight
                        size={14}
                        className="inline ml-2"
                        aria-hidden="true"
                      />
                    </strong>
                  </Link>
                ) : (
                  <>
                    <strong>Sin partidas en juego ahora mismo</strong>
                  </>
                )}
              </div>
            </div>
            <div className="home-status-meta">
              <span className="home-participants">
                <Users size={16} aria-hidden="true" />
                <strong>{rows.length}</strong>{" "}
                {rows.length === 1 ? "participante" : "participantes"}
              </span>
              {statusWindow ? (
                <TournamentCountdown
                  from={statusWindow.from}
                  to={statusWindow.to}
                  serverNow={now}
                />
              ) : null}
              <LiveRefresh showStatus dataUpdatedAt={statusUpdatedAt} />
            </div>
          </div>
          {hub ? <HomeLeaders rows={rows} /> : null}
          <HomeStandings
            rows={rows}
            objectiveDescriptions={HOME_OBJECTIVE_DESCRIPTIONS}
          />
        </>
      )}
    </div>
  );
}
