import type { Metadata } from "next";
import { EmptyState } from "@/components/empty-state";
import { LiveDot } from "@/components/live-dot";
import { LiveMatchesBrowser } from "@/components/live-matches-browser";
import { LiveRefresh } from "@/components/live-refresh";
import { PageHead } from "@/components/page-head";
import { getLiveMatches } from "@/lib/public";

export const metadata: Metadata = {
  title: "Partidas en juego",
  description:
    "Partidas de ladder ranked que se están jugando ahora mismo y en las que participa algún jugador de la Liga Hispana de Age of Empires IV, con el mapa, el tipo de partida y la alineación completa.",
};

export const dynamic = "force-dynamic";

export default async function LiveMatchesPage() {
  const read = await getLiveMatches();

  // `data` es `null` cuando la base de datos no ha podido leer, y no una lista
  // vacía: un vacío se leería como "ninguna partida en juego ahora mismo", que
  // es justo lo que no sabemos. El estado degradado lo pinta la interfaz.
  const degraded = read.status === "degraded";
  const matches = read.data ?? [];

  return (
    <div className="flex flex-col gap-6">
      <PageHead
        title="Partidas en juego"
        aside={
          <>
            {matches.length > 0 ? (
              <span className="inline-flex items-center gap-2 text-sm font-medium text-live-soft">
                <LiveDot />
                {matches.length === 1 ? "1 en juego" : `${matches.length} en juego`}
              </span>
            ) : null}
            <LiveRefresh />
          </>
        }
      />

      {degraded ? (
        <EmptyState
          title="No se han podido cargar las partidas"
          body="La base de datos no ha respondido, así que no se sabe si hay partidas en juego. No es lo mismo que no haber ninguna. Vuelve a cargar la página en unos minutos."
        />
      ) : matches.length === 0 ? (
        <EmptyState
          title="Ninguna partida en juego ahora mismo"
          body="No significa que la liga esté parada: significa que en este momento ningún jugador de la liga tiene una partida de ranked en juego. En cuanto alguien juegue una, aparecerá aquí sola."
        />
      ) : (
        <LiveMatchesBrowser matches={matches} />
      )}

      <p className="max-w-[68ch] border-t border-line pt-6 text-xs leading-relaxed text-muted">
        Una partida abandonada no se queda colgada: el sincronizador la borra en
        cuanto confirma que ya no se va a resolver. En las partidas por equipos se
        ve la alineación completa, con el compañero y los rivales; solo los
        jugadores de la liga llevan su división junto al nombre.
      </p>
    </div>
  );
}
