import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { EmptyState } from "@/components/empty-state";
import { PageHead } from "@/components/page-head";
import { ParticipantObjectivesView } from "@/components/participant-objectives";
import {
  OBJECTIVE_GROUP_LABELS,
  getParticipantObjectives,
} from "@/lib/public";

const GENERIC_METADATA: Metadata = {
  title: "Objetivos del participante",
  description:
    "El avance de un participante en los objetivos especiales de la Liga Hispana de Age of Empires IV: qué ha conseguido, en cuáles está al alcance y cuánto le falta para el primer puesto.",
};

// El avance de un jugador sale de la misma foto que la clasificación, que el
// worker recalcula cada pocos minutos. Sin esto la ficha se generaría en el
// `next build` y se quedaría congelada.
export const dynamic = "force-dynamic";

/**
 * Metadatos de la ficha, con el nombre del jugador cuando se le puede leer.
 *
 * `getParticipantObjectives` está cacheado por petición, así que esta segunda
 * lectura no vuelve a la base. Si el `profileId` no es válido, el jugador no
 * existe o la base no responde, se cae a los metadatos genéricos: no se inventa
 * un nombre que la página pueda no llegar a pintar.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ profileId: string }>;
}): Promise<Metadata> {
  const { profileId } = await params;
  const id = Number(profileId);

  if (!Number.isInteger(id) || id <= 0) {
    return GENERIC_METADATA;
  }

  const read = await getParticipantObjectives(id);

  if (read.status !== "ok" || read.data === null) {
    return GENERIC_METADATA;
  }

  const { name } = read.data.player;

  return {
    title: `Objetivos de ${name}`,
    description: `El avance de ${name} en los objetivos especiales de la Liga Hispana de Age of Empires IV: qué ha conseguido, en cuáles está al alcance y cuánto le falta para el primer puesto.`,
  };
}

/**
 * Ficha pública de objetivos de un participante.
 *
 * Es la vista de detalle de la columna "Objetivos" de la clasificación. La
 * página lee la base y resuelve los tres estados; el marcado vive en
 * `ParticipantObjectivesView`, que es cliente porque reutiliza `ObjectiveIcon`.
 * Los rótulos de grupo se pasan como prop: su mapa vive en un módulo
 * `server-only`, igual que en `/objetivos`.
 */
export default async function ParticipantObjectivesPage({
  params,
}: {
  params: Promise<{ profileId: string }>;
}) {
  const { profileId } = await params;
  // Entero positivo o nada: un `profileId` no numérico no identifica a nadie.
  const id = Number(profileId);

  if (!Number.isInteger(id) || id <= 0) {
    notFound();
  }

  const read = await getParticipantObjectives(id);

  // La base puede no responder (`degraded`), que no es lo mismo que "este
  // jugador no existe" (`ok` con `data: null`, que va a `notFound`). Decir que
  // alguien no existe cuando lo que pasa es que Postgres no contesta sería
  // mentir sobre la persona.
  if (read.status === "degraded") {
    return (
      <div className="flex flex-col gap-8">
        <PageHead title="Objetivos del participante" />
        <EmptyState
          title="No se han podido cargar los objetivos"
          body="La base de datos no ha respondido, así que no se sabe cómo va este participante en los objetivos. No es lo mismo que no tener ninguno. Vuelve a cargar la página en unos minutos."
          action={
            <nav className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
              <Link
                href="/"
                className="text-accent underline underline-offset-4 hover:text-accent-strong"
              >
                Volver a la clasificación
              </Link>
              <Link
                href="/objetivos"
                className="text-muted transition-colors hover:text-accent"
              >
                Ver todos los objetivos
              </Link>
            </nav>
          }
        />
      </div>
    );
  }

  if (read.data === null) {
    notFound();
  }

  // Se fija en una constante tras descartar el `null`: dentro del callback de
  // `map` TypeScript ya no estrecha una propiedad, pero sí una variable.
  const data = read.data;

  return (
    <ParticipantObjectivesView data={data} groupLabels={OBJECTIVE_GROUP_LABELS} />
  );
}
