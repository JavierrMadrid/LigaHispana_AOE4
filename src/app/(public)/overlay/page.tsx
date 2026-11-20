import type { Metadata } from "next";
import Link from "next/link";
import { EmptyState } from "@/components/empty-state";
import { OverlayConfigurator } from "@/components/overlay/overlay-configurator";
import { PageHead } from "@/components/page-head";
import { ObjectKind } from "@/generated/prisma/enums";
import { OBJECT_CATALOG } from "@/lib/objects";
import type { OverlayObjetoEvento, OverlayObjetoEventoTipo } from "@/lib/overlay-api";
import {
  overlayConfiguratorParticipants,
  type OverlayConfiguratorParticipant,
  type OverlayObjetoDemo,
} from "@/lib/overlay-view";
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

/** El objeto de cada demo, para que las tres tarjetas enseñen los tres glifos. */
const DEMO_OBJECT_KIND: Readonly<Record<OverlayObjetoEventoTipo, ObjectKind>> = {
  recibido: ObjectKind.MONEDA,
  lanzado: ObjectKind.RELIQUIA,
  devuelto: ObjectKind.MONUMENTO,
};

/**
 * Un evento de objeto de ejemplo, armado desde el catálogo real.
 *
 * El cliente no repite nombres ni desventajas: recibe el evento ya resuelto con
 * la misma forma que publica `/api/v0/objetos`, así que la demo pasa por el
 * mismo camino de validación que un mensaje cualquiera del configurador.
 */
function demoObjeto(
  tipo: OverlayObjetoEventoTipo,
  contrario: OverlayObjetoEvento["contrario"],
  fechahora: string,
): OverlayObjetoEvento {
  const definition = OBJECT_CATALOG[DEMO_OBJECT_KIND[tipo]];

  return {
    id: `demo:${tipo}`,
    tipo,
    fechahora,
    // El contrato publica el enum del schema en minúsculas.
    objeto: { id: definition.kind.toLowerCase(), nombre: definition.name },
    desventaja: definition.penalties[0]?.text ?? "",
    contrario,
  };
}

/**
 * Los tres eventos de ejemplo del configurador.
 *
 * El contrario es el primer participante de la lista —un alias real, nunca
 * inventado— y el configurador lo cambia al pulsar si coincidiera con el jugador
 * retransmitido. Sin participantes se queda en `null` y el `recibido` se lee
 * como el premio del día.
 */
function overlayObjetoDemos(
  participants: readonly OverlayConfiguratorParticipant[],
): OverlayObjetoDemo {
  const first = participants[0];
  const contrario =
    first === undefined ? null : { alias: first.alias, pais: first.pais };
  const fechahora = new Date().toISOString();

  return {
    recibido: demoObjeto("recibido", contrario, fechahora),
    lanzado: demoObjeto("lanzado", contrario, fechahora),
    devuelto: demoObjeto("devuelto", contrario, fechahora),
  };
}

export default async function OverlayConfiguratorPage() {
  const read = await getStandings();
  const standings = read.status === "ok" ? read.data : null;
  const siteOrigin = readPublicOrigin();
  const participants =
    standings === null ? [] : overlayConfiguratorParticipants(standings.rows);
  const objetosDemo = overlayObjetoDemos(participants);

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
            objetosDemo={objetosDemo}
          />
        </>
      )}
    </div>
  );
}
