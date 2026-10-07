import type { Metadata } from "next";
import Link from "next/link";
import { EmptyState } from "@/components/empty-state";
import { LiveDot } from "@/components/live-dot";
import { PageHead } from "@/components/page-head";
import { StandingsTable } from "@/components/standings-table";
import { TournamentCountdown } from "@/components/tournament-countdown";
import { getLiveMatches, getStandings, getTournamentWindow } from "@/lib/public";

export const metadata: Metadata = {
  title: "Clasificación general",
  description:
    "Posiciones de la Liga Hispana de Age of Empires IV ordenadas por puntos: 10 por cada victoria clasificatoria más los puntos de los objetivos especiales.",
};

// La clasificación se lee de la base de datos en cada petición. Sin esto la
// página se generaría en el `next build` y la tabla se quedaría congelada para
// siempre aunque el worker recalculara los puntos cada pocos minutos.
export const dynamic = "force-dynamic";

export default async function StandingsPage() {
  const [standings, liveMatches, tournamentWindow] = await Promise.all([
    getStandings(),
    getLiveMatches(),
    getTournamentWindow(),
  ]);

  // `data` es `null` cuando la base de datos no ha podido leer. No se sustituye
  // por una lista vacía a propósito: un vacío aquí se leería como "no hay
  // participantes" y "no hay ninguna partida en juego", que es mentira. Cuando
  // la lectura falla se sustituye la página entera por el aviso, incluida la
  // banda de recuento, que si no diría un cero falso.
  const degraded = standings.status === "degraded" || liveMatches.status === "degraded";
  const rows = standings.data ?? [];
  // `getLiveMatches()` ya agrupa por partida: cuenta partidas, no filas, así que
  // el tamaño de la lista es directamente el número de partidas en juego.
  const liveGames = liveMatches.data?.length ?? 0;

  return (
    <div className="flex flex-col gap-6">
      <PageHead title="Clasificación general" />

      {degraded ? (
        <EmptyState
          title="La clasificación no está disponible"
          body="No se ha podido leer la clasificación ahora mismo, así que no se sabe qué puesto ocupa nadie ni si hay partidas en juego. No significa que la liga esté vacía. Vuelve a cargar la página en unos minutos."
        />
      ) : (
        <>
          {/* Cabecera del torneo: estado de emisión y tamaño de la tabla en una
              sola banda. No es un titular (el `h1` sigue oculto por convención):
              es el marcador de la sala, y por eso el número del recuento va en la
              tipografía de display mientras el resto se queda en texto corrido. */}
          <div className="thread-top relative overflow-hidden rounded-lg border border-line bg-surface px-5 py-4">
            <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
              {liveGames > 0 ? (
                <Link
                  href="/partidas"
                  className="group inline-flex items-center gap-2 text-sm font-medium text-live-soft transition-colors hover:text-live"
                >
                  <LiveDot />
                  {liveGames === 1 ? "1 partida en juego" : `${liveGames} partidas en juego`}
                  <span className="text-muted transition-colors group-hover:text-live-soft">
                    Ver partidas
                  </span>
                </Link>
              ) : (
                <span className="inline-flex items-center gap-2 text-sm text-muted">
                  <span
                    aria-hidden="true"
                    className="size-2 shrink-0 rounded-full border border-line-strong"
                  />
                  Sin partidas en juego ahora mismo
                </span>
              )}

              <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-muted">
                <p>
                  <span className="font-display text-base tabular-nums text-foreground">
                    {rows.length}
                  </span>{" "}
                  {rows.length === 1 ? "participante" : "participantes"}
                </p>
                {tournamentWindow.status === "ok" && tournamentWindow.data.to !== null ? (
                  <TournamentCountdown
                    to={tournamentWindow.data.to}
                    serverNow={new Date().toISOString()}
                  />
                ) : null}
                <Link
                  href="/puntuacion"
                  className="text-accent underline-offset-4 transition-colors hover:text-accent-strong hover:underline"
                >
                  Cómo se puntúa
                </Link>
              </div>
            </div>
          </div>

          <section aria-label="Clasificación">
            <StandingsTable rows={rows} />
          </section>
        </>
      )}
    </div>
  );
}
