import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight } from "@phosphor-icons/react/dist/ssr/ArrowUpRight";
import { Sword } from "@phosphor-icons/react/dist/ssr/Sword";
import { ArrowClockwise } from "@phosphor-icons/react/dist/ssr/ArrowClockwise";
import { WarningCircle } from "@phosphor-icons/react/dist/ssr/WarningCircle";
import { LiveMatchesBrowser } from "@/components/live-matches-browser";
import { LiveRefresh } from "@/components/live-refresh";
import { participantIsLive } from "@/components/live-channels";
import { getLiveMatches } from "@/lib/public";
import Loading from "./loading";

export const metadata: Metadata = {
  title: "Partidas en juego",
  description:
    "Partidas clasificatorias en juego de la Liga Hispana de Age of Empires IV, con mapas, alineaciones completas y retransmisiones en directo.",
};
export const dynamic = "force-dynamic";

export default async function LiveMatchesPage({
  searchParams,
}: {
  searchParams: Promise<{ preview?: string | string[] }>;
}) {
  const params = await searchParams;
  const previewTools =
    process.env.NODE_ENV === "development"
      ? await import("@/lib/matches-preview")
      : null;
  const preview = previewTools?.parseMatchesPreview(params.preview) ?? null;
  if (preview === "loading") return <Loading />;
  const read =
    preview && previewTools
      ? preview === "unavailable"
        ? { status: "degraded" as const, data: null }
        : {
            status: "ok" as const,
            data:
              preview === "empty"
                ? []
                : previewTools.createMatchesPreview(
                    new Date(),
                    preview === "stress" ? "stress" : "live"
                  ),
          }
      : await getLiveMatches();
  const degraded = read.status === "degraded";
  const matches = read.data ?? [];
  const streams = matches.filter((match) =>
    match.participants.some(participantIsLive)
  ).length;
  const leaguePlayers = new Set(
    matches.flatMap((match) =>
      match.participants
        .filter((player) => player.isLeaguePlayer)
        .map((player) => player.profileId ?? player.name)
    )
  ).size;

  return (
    <div className="matches-layout">
      {!preview ? <LiveRefresh /> : null}
      <aside className="matches-context" aria-labelledby="matches-heading">
        <h1 id="matches-heading">Partidas en juego</h1>
        <p>
          La liga, sobre el mapa. Sigue a sus jugadores y encuentra qué ver
          ahora.
        </p>
        <dl className="matches-context-summary">
          <div>
            <dt>En juego</dt>
            <dd>{degraded ? "—" : matches.length}</dd>
          </div>
          <div>
            <dt>
              <span aria-hidden="true">En directo</span>
              <span className="sr-only">
                Partidas con alguna retransmisión en directo
              </span>
            </dt>
            <dd className="matches-broadcast-number">
              {degraded ? "—" : streams}
            </dd>
          </div>
          <div>
            <dt>
              <span aria-hidden="true">Total</span>
              <span className="sr-only">
                Total de jugadores de la liga en juego
              </span>
            </dt>
            <dd>{degraded ? "—" : leaguePlayers}</dd>
          </div>
        </dl>
        <nav className="matches-context-links" aria-label="Más de la liga">
          <Link href="/" target="_blank" rel="noopener noreferrer">
            Ver clasificación
            <ArrowUpRight size={14} aria-hidden="true" />
          </Link>
          <Link href="/puntuacion" target="_blank" rel="noopener noreferrer">
            Cómo se puntúa
            <ArrowUpRight size={14} aria-hidden="true" />
          </Link>
        </nav>
        {!preview ? (
          <div className="matches-refresh-note">
            <ArrowClockwise size={13} aria-hidden="true" />
            <span>
              Se actualiza automáticamente mientras estás en esta página.
            </span>
          </div>
        ) : null}
      </aside>
      {degraded ? (
        <section
          className="matches-empty"
          aria-labelledby="matches-state-heading"
        >
          <WarningCircle size={32} aria-hidden="true" />
          <h2 id="matches-state-heading">
            No se han podido cargar las partidas
          </h2>
          <p>
            No sabemos si hay partidas en juego ahora mismo. Vuelve a cargar la
            página en unos minutos.
          </p>
          <Link
            href="/partidas"
            target="_blank"
            rel="noopener noreferrer"
            className="home-primary"
          >
            Volver a cargar
            <ArrowUpRight size={15} aria-hidden="true" />
          </Link>
        </section>
      ) : matches.length === 0 ? (
        <section
          className="matches-empty"
          aria-labelledby="matches-state-heading"
        >
          <Sword size={32} aria-hidden="true" />
          <h2 id="matches-state-heading">
            Ninguna partida en juego ahora mismo
          </h2>
          <p>
            Cuando un participante de la liga empiece una partida
            clasificatoria, aparecerá aquí con su mapa, sus rivales y los
            directos disponibles.
          </p>
          <Link
            href="/"
            target="_blank"
            rel="noopener noreferrer"
            className="home-primary"
          >
            Ver clasificación
            <ArrowUpRight size={15} aria-hidden="true" />
          </Link>
        </section>
      ) : (
        <LiveMatchesBrowser
          matches={matches}
          previewThumbnails={preview === "live" || preview === "stress"}
        />
      )}
    </div>
  );
}
