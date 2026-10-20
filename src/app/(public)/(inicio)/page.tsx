import type { Metadata } from "next";
import Link from "next/link";
import Image from "next/image";
import { ArrowUpRight } from "@phosphor-icons/react/dist/ssr/ArrowUpRight";
import { Broadcast } from "@phosphor-icons/react/dist/ssr/Broadcast";
import { Users } from "@phosphor-icons/react/dist/ssr/Users";
import { Sword } from "@phosphor-icons/react/dist/ssr/Sword";
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
  const liveGames = preview === "live" ? 1 : liveMatches.data?.length ?? 0;
  const hub =
    process.env.NODE_ENV === "development" && params.concept === "hub";

  return (
    <div>
      <div className="home-intro home-heraldic-frame">
        <Image
          src="/imagenes/portada/aoe4-delhi-banner.webp"
          alt=""
          fill
          preload
          sizes="(max-width: 1400px) 100vw, 1320px"
          className="home-banner-art"
        />
        <div className="home-hero-identity">
          <Image
            src="/imagenes/marca/emblema-256.png"
            alt=""
            width={144}
            height={144}
            className="home-hero-emblem"
          />
          <div className="home-hero-copy">
            <p className="home-hero-kicker">
              Competición de la comunidad hispanohablante
            </p>
            <h1>{hub ? "La liga se juega aquí." : "Liga Hispana"}</h1>
            <p className="home-hero-game">Age of Empires IV</p>
          </div>
        </div>
        {hub ? (
          <div className="home-intro-aside">
            <Broadcast size={16} aria-hidden="true" />
            Seguimiento del torneo
          </div>
        ) : null}
      </div>
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
              <span className="home-status-icon">
                <Sword size={22} weight="regular" aria-hidden="true" />
              </span>
              <div>
                {!stress && liveGames > 0 ? (
                  <Link
                    target="_blank"
                    rel="noopener noreferrer"
                    href="/partidas"
                  >
                    <strong>
                      {liveGames === 1
                        ? "1 partida en juego"
                        : `${liveGames} partidas en juego`}
                      <ArrowUpRight
                        size={14}
                        className="inline ml-2"
                        aria-hidden="true"
                      />
                    </strong>
                    <small>Ver quién está jugando ahora</small>
                  </Link>
                ) : (
                  <>
                    <strong>Estado del torneo</strong>
                    <small>
                      {stress
                        ? "Clasificación general de participantes"
                        : "Sin partidas en juego ahora mismo"}
                    </small>
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
              {!stress && tournamentWindow.status === "ok" ? (
                <TournamentCountdown
                  from={tournamentWindow.data.from}
                  to={tournamentWindow.data.to}
                  serverNow={now}
                />
              ) : null}
              {!stress ? (
                <LiveRefresh
                  showStatus
                  dataUpdatedAt={
                    lastSync.status === "ok" ? lastSync.data : null
                  }
                />
              ) : null}
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
