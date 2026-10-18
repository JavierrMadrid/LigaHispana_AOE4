import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageHead } from "@/components/page-head";
import { ParticipantObjectivesView } from "@/components/participant-objectives";
import { OBJECTIVE_GROUP_LABELS } from "@/lib/public";
import { readParticipant } from "./data";

const GENERIC_METADATA: Metadata = {
  title: "Objetivos del participante",
  description:
    "El avance de un participante en los objetivos especiales de la Liga Hispana de Age of Empires IV: qué ha conseguido, en cuáles está al alcance y cuánto le falta para el primer puesto.",
};

/**
 * Metadatos de la pestaña de objetivos, con el nombre del jugador cuando se le
 * puede leer.
 *
 * `getParticipantObjectives` está cacheado por petición y el layout ya la ha
 * leído, así que esta segunda lectura no vuelve a la base. Si el `profileId` no
 * es válido, el jugador no existe o la base no responde, se cae a los metadatos
 * genéricos: no se inventa un nombre que la página pueda no llegar a pintar.
 */
export async function generateMetadata({
  params,
}: PageProps<"/detalle-jugador/[profileId]">): Promise<Metadata> {
  const { profileId } = await params;
  const read = await readParticipant(profileId);

  if (read === null || read.status !== "ok" || read.data === null) {
    return GENERIC_METADATA;
  }

  const { name } = read.data.player;

  return {
    title: `Objetivos de ${name}`,
    description: `El avance de ${name} en los objetivos especiales de la Liga Hispana de Age of Empires IV: qué ha conseguido, en cuáles está al alcance y cuánto le falta para el primer puesto.`,
  };
}

/**
 * Pestaña de objetivos del detalle de un participante.
 *
 * El marcado vive en `ParticipantObjectivesView`, que es cliente porque
 * reutiliza `ObjectiveIcon` y abre la clasificación de un objetivo en una
 * ventana. Los rótulos de grupo se pasan como prop: su mapa vive en un módulo
 * `server-only`, igual que en `/objetivos`.
 *
 * El "no existe", el `profileId` inválido, el degradado y la cabecera del
 * jugador los resuelve el layout; aquí solo se leen los datos —de la misma
 * lectura cacheada— para pintar la pestaña.
 */
export default async function ParticipantObjectivesTab({
  params,
}: PageProps<"/detalle-jugador/[profileId]">) {
  const { profileId } = await params;
  const read = await readParticipant(profileId);

  // El layout ya ha resuelto los tres desenlaces; esto solo estrecha el tipo para
  // no pintar con datos que no están.
  if (read === null || read.status !== "ok" || read.data === null) {
    notFound();
  }

  const data = read.data;

  return (
    <>
      <PageHead title={`Objetivos de ${data.player.name}`} />
      <ParticipantObjectivesView data={data} groupLabels={OBJECTIVE_GROUP_LABELS} />
    </>
  );
}
