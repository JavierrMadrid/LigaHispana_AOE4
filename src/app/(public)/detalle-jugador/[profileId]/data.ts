import { getParticipantObjectives, type ParticipantObjectives, type PublicRead } from "@/lib/public";

/**
 * El `profileId` de la ruta como entero positivo, o `null` si no identifica a nadie.
 *
 * Es el único sitio donde se decide qué `profileId` vale: un valor no numérico, un
 * cero o un negativo no son un participante. Lo llaman las tres piezas del detalle
 * —el layout, la pestaña de objetivos y la de historial—, que tienen que leer la
 * ruta de la misma manera.
 */
export function readProfileId(profileId: string): number | null {
  const id = Number(profileId);

  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * La ficha de un participante, tal cual la devuelve el DAL.
 *
 * `null` cuando el `profileId` de la ruta no identifica a nadie; en el resto de los
 * casos llega la lectura entera, que puede ser `degraded` —la base no ha
 * respondido— o traer `data: null` —no hay ningún participante aprobado con ese
 * id—. Los tres desenlaces los pinta el layout, que es quien puede distinguirlos
 * (ver `ParticipantFrame`): las pestañas solo necesitan saber si hay datos.
 *
 * La lectura va cacheada por petición (`getParticipantObjectives`), así que el
 * layout y las dos pestañas la comparten sin volver a la base.
 */
export async function readParticipant(
  profileId: string,
): Promise<PublicRead<ParticipantObjectives | null> | null> {
  const id = readProfileId(profileId);

  return id === null ? null : getParticipantObjectives(id);
}
