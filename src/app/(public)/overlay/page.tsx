import type { Metadata } from "next";
import Link from "next/link";
import { EmptyState } from "@/components/empty-state";
import { OverlayConfigurator } from "@/components/overlay/overlay-configurator";
import { PageHead } from "@/components/page-head";
import { overlayConfiguratorParticipants } from "@/lib/overlay-view";
import { getStandings } from "@/lib/public";
import { readPublicOrigin } from "@/lib/site-url";

export const metadata: Metadata = {
  title: "Overlay",
  description:
    "El overlay del directo de la Liga Hispana de Age of Empires IV: elige un participante y ajusta la posición, el tamaño, las secciones y las animaciones. Copia la URL y añádelo a OBS.",
};

// La lista de participantes sale de la clasificación publicada, que el worker
// recalcula cada pocos minutos.
export const dynamic = "force-dynamic";

export default async function OverlayConfiguratorPage() {
  const read = await getStandings();
  const standings = read.status === "ok" ? read.data : null;
  const siteOrigin = readPublicOrigin();
  const participants =
    standings === null ? [] : overlayConfiguratorParticipants(standings.rows);

  return (
    <div className="flex flex-col gap-8">
      <PageHead title="Overlay" />

      {standings === null ? (
        <EmptyState
          title="No se han podido cargar los participantes"
          body="El configurador del overlay lee la clasificación publicada, y ahora mismo la base de datos no ha respondido. Vuelve a cargar la página en unos minutos."
        />
      ) : participants.length === 0 ? (
        <EmptyState
          title="Todavía no hay participantes"
          body="El overlay se genera por participante. Cuando haya jugadores aprobados en la clasificación, aparecerán aquí para elegir su URL."
          action={
            <Link
              href="/participar"
              className="inline-flex min-h-10 items-center rounded-md border border-accent/60 bg-accent/10 px-4 text-sm font-semibold text-accent transition-colors hover:bg-accent/20"
            >
              Inscríbete
            </Link>
          }
        />
      ) : (
        <>
          <p className="max-w-2xl text-sm leading-relaxed text-muted">
            Elige un participante y ajusta la tarjeta: posición, tamaño, secciones
            y animaciones. La URL que copias lleva esa configuración.
          </p>
          <OverlayConfigurator
            participants={participants}
            siteOrigin={siteOrigin}
          />
        </>
      )}
    </div>
  );
}
