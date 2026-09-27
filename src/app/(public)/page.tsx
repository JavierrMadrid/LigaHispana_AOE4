import type { Metadata } from "next";
import Link from "next/link";
import { LiveDot } from "@/components/live-dot";
import { PageHead } from "@/components/page-head";
import { StandingsTable } from "@/components/standings-table";
import { getLiveMatches, getStandings } from "@/lib/public";

export const metadata: Metadata = {
  title: "Clasificación general",
  description:
    "Posiciones de la Liga Hispana de Age of Empires IV ordenadas por puntos. Un punto por cada victoria en partida clasificatoria.",
};

// La clasificación se lee de la base de datos en cada petición. Sin esto la
// página se generaría en el `next build` y la tabla se quedaría congelada para
// siempre aunque el worker recalculara los puntos cada pocos minutos.
export const dynamic = "force-dynamic";

export default async function StandingsPage() {
  const [rows, liveMatches] = await Promise.all([getStandings(), getLiveMatches()]);

  // En un 2v2 entran dos filas con el mismo `gameId`: para contar partidas, no
  // filas, hay que quedarse con los identificadores distintos.
  const liveGames = new Set(liveMatches.map((match) => match.gameId)).size;

  const counters = [
    { label: "Jugadores", value: rows.length },
    {
      label: "Partidas clasificatorias",
      value: rows.reduce((total, row) => total + row.wins + row.losses, 0),
    },
    { label: "Puntos repartidos", value: rows.reduce((total, row) => total + row.points, 0) },
  ];

  return (
    <div className="flex flex-col gap-10">
      <PageHead
        title="Clasificación general"
        lead="Torneo individual: cada jugador compite por su cuenta en la ladder ranked y suma un punto por cada victoria clasificatoria. Gana quien termine con más puntos."
        aside={
          liveGames > 0 ? (
            <Link
              href="/partidas"
              className="inline-flex items-center gap-2 rounded-full border border-accent/40 bg-accent/10 px-3 py-1.5 text-sm text-accent transition-colors hover:bg-accent/15"
            >
              <LiveDot />
              {liveGames === 1 ? "1 partida en directo" : `${liveGames} partidas en directo`}
            </Link>
          ) : null
        }
      />

      <dl className="grid gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-3">
        {counters.map((counter) => (
          <div key={counter.label} className="bg-surface px-5 py-4">
            <dt className="text-xs text-muted">{counter.label}</dt>
            <dd className="mt-1 text-2xl font-semibold tabular-nums text-foreground">
              {counter.value}
            </dd>
          </div>
        ))}
      </dl>

      <section aria-label="Clasificación">
        <StandingsTable rows={rows} />
      </section>

      <section aria-labelledby="puntuacion" className="border-t border-line pt-6">
        <h2
          id="puntuacion"
          className="font-display text-lg font-semibold text-foreground"
        >
          Cómo se puntúa ahora mismo
        </h2>
        <p className="mt-2 max-w-[62ch] text-sm leading-relaxed text-muted">
          Una victoria en partida clasificatoria vale 1 punto. Las derrotas no suman
          ni restan, y las partidas abandonadas o sin resolver no cuentan. El
          reglamento definitivo se está definiendo con la comunidad, así que esta
          regla es provisional: cuando se cierre, la clasificación se recalcula
          entera sin perder los resultados ya obtenidos.
        </p>
        <Link
          href="/reglas"
          className="mt-4 inline-block text-sm text-accent underline underline-offset-4 hover:text-accent-strong"
        >
          Leer las reglas completas
        </Link>
      </section>
    </div>
  );
}