import type { Metadata } from "next";
import { EmptyState } from "@/components/empty-state";
import { LiveDot } from "@/components/live-dot";
import { LiveMatchCard } from "@/components/live-match-card";
import { LiveRefresh } from "@/components/live-refresh";
import { PageHead } from "@/components/page-head";
import { getLiveMatches } from "@/lib/public";
import type { LiveMatchRow } from "@/lib/public";

export const metadata: Metadata = {
  title: "Partidas en directo",
  description:
    "Partidas de ladder ranked en curso en las que participa algún jugador de la Liga Hispana de Age of Empires IV.",
};

export const dynamic = "force-dynamic";

/**
 * `getLiveMatches()` devuelve una fila por jugador y partida, así que en un 2v2
 * entran dos filas con el mismo `gameId`. Agrupar por partida evita ensuciar la
 * lista con duplicados que el lector interpretaría como dos partidas distintas.
 */
function groupByGame(rows: LiveMatchRow[]): [string, LiveMatchRow[]][] {
  const groups = new Map<string, LiveMatchRow[]>();

  for (const row of rows) {
    const group = groups.get(row.gameId);

    if (group === undefined) {
      groups.set(row.gameId, [row]);
    } else {
      group.push(row);
    }
  }

  return [...groups.entries()];
}

export default async function LiveMatchesPage() {
  const matches = await getLiveMatches();
  const groups = groupByGame(matches);
  const now = new Date();

  return (
    <div className="flex flex-col gap-8">
      <PageHead
        title="Partidas en directo"
        lead="Partidas de ladder ranked que la API todavía no ha resuelto. Incluye 1vs1 y partidas por equipos, y solo cuenta si participa algún jugador de la liga."
        aside={
          <>
            {groups.length > 0 ? (
              <span className="flex items-center gap-2 text-sm text-muted">
                <LiveDot />
                {groups.length === 1 ? "1 en curso" : `${groups.length} en curso`}
              </span>
            ) : null}
            <LiveRefresh />
          </>
        }
      />

      {groups.length === 0 ? (
        <EmptyState
          title="Ninguna partida en directo ahora mismo"
          body="No significa que la liga esté parada: significa que en este momento ningún jugador de la liga tiene una partida de ranked en curso. En cuanto alguien juegue una, aparecerá aquí sola."
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {groups.map(([gameId, rows]) => (
            <LiveMatchCard key={gameId} rows={rows} now={now} />
          ))}
        </ul>
      )}

      <p className="max-w-[68ch] border-t border-line pt-6 text-xs leading-relaxed text-muted">
        Una partida abandonada no se queda colgada: el sincronizador la borra en
        cuanto confirma que ya no se va a resolver. En una partida por equipos solo
        se registra la victoria del jugador de la liga, y el rival que aparece es el
        primer jugador del equipo contrario.
      </p>
    </div>
  );
}