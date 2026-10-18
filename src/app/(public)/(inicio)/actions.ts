"use server";

import { getObjectives, type ObjectiveOption } from "@/lib/public";

/**
 * Longitud máxima del identificador que acepta `loadObjectiveOption()`.
 *
 * Es un endpoint público, así que el argumento llega de la red tal cual y no hay
 * tipos que valgan: nada impide llamar con una cadena de un mega. Los ids del
 * catálogo son slugs cortos (`loco-por-ganar`, `rey-1v1`, `por-tierra-y-agua`),
 * así que 120 deja holgura de sobra y sigue siendo un tope.
 */
const MAX_OBJECTIVE_ID_LENGTH = 120;

/**
 * El catálogo de objetivos, con su clasificación, en una sola entrada.
 *
 * Es la acción que pide la clasificación de la portada cuando alguien pulsa un chip
 * del resumen desplegable de un participante.
 *
 * ## Por qué se pide bajo demanda y no viene en las props de la página
 *
 * `StandingsTable` es cliente y recibe `StandingRow[]`, y los objetivos de una fila
 * (`StandingRow.objectives`) son **solo los que ese jugador ya cobró**: no llevan
 * ranking, así que con ellos no se puede pintar la clasificación de un objetivo. La
 * alternativa sería publicar el snapshot entero (`getObjectives()`) en las props de
 * la página: son todos los objetivos del catálogo con **todos** sus contendientes, y
 * eso viaja en el *payload* de RSC de la portada aunque nadie abra un diálogo —la
 * web se paga entera por lo que casi nadie mira—. Pidiendo el objetivo concreto al
 * abrirlo, la portada solo manda sus filas y el coste lo paga quien pulsa el chip, y
 * solo por el objetivo que ha pulsado.
 *
 * No se cachea nada: la acción reutiliza la lectura que ya existe (`getObjectives`)
 * y sirve datos frescos, igual que el resto de las pantallas públicas.
 *
 * ## Por qué `null` y no un estado de error
 *
 * Devuelve `null` cuando la lectura está **degradada**, y eso se lee como "aquí no
 * hay nada que pintar". El diálogo se abre encima de una tabla que la página ya ha
 * publicado, así que no hay un segundo estado que enseñar: quien está mirando ve la
 * clasificación general y, si la de ese objetivo no se ha podido leer, no se le
 * pinta. Distinguirlo de "ese objetivo no existe" no le sirve de nada —no hay nada
 * que pueda hacer con la diferencia— y el motivo del fallo de base de datos no se
 * pierde: `getObjectives()` ya lo deja en el log del servidor con el prefijo `[db]`.
 *
 * Un `id` que no es una cadena utilizable ni llega a la base de datos: se responde
 * `null` sin leer.
 */
export async function loadObjectiveOption(id: string): Promise<ObjectiveOption | null> {
  // El `typeof` no es paranoia de tipos: la firma promete `string`, pero esto es un
  // endpoint público y el argumento llega deserializado de la red.
  if (typeof id !== "string" || id.length === 0 || id.length > MAX_OBJECTIVE_ID_LENGTH) {
    return null;
  }

  const read = await getObjectives();

  if (read.status !== "ok") {
    return null;
  }

  return read.data.options.find((option) => option.id === id) ?? null;
}
