import type { Prisma } from "@/generated/prisma/client";
import { windowBounds, type ScoringWindow } from "@/lib/ranked-match";

/**
 * El filtro de edición de las lecturas de `Alert`: solo la ventana activa.
 *
 * Las alertas son el último historial que se leía entero. El resto ya se acota por
 * edición —las partidas por la ventana, los logros se reconcilian y los liderazgos se
 * filtran por cohorte—, así que la pestaña y el informe dejan de publicar las filas de
 * una edición anterior para que el panel no mezcle avisos de dos torneos.
 *
 * ## Solo hay cota inferior
 *
 * El suelo es `window.from`: al avanzar la ventana al empezar una edición nueva, las
 * alertas de la anterior dejan de mostrarse sin tocar la base, que es el ciclo que se
 * busca ("mantener hasta el inicio del siguiente torneo").
 *
 * No hay tope superior, y no es un olvido: las alertas de cierre de torneo
 * (`STREAK_AT_TOURNAMENT_END`) se crean **después** de `window.to`, porque son el
 * resultado de mirar la edición cuando ya ha terminado. Un `createdAt <= window.to` las
 * ocultaría justo cuando más falta hacen.
 *
 * ## No borra nada
 *
 * `Alert` es *append-only*: las filas antiguas siguen en la tabla y esta función solo
 * recorta lo que se lee. No hay borrado manual, así que una edición anterior se puede
 * volver a consultar cambiando la ventana, y ninguna alerta se pierde por reiniciar la
 * vista.
 *
 * Vive fuera de `admin.ts` para que el panel y el informe usen **el mismo** `where`: dos
 * copias del filtro acabarían enseñando cosas distintas en la pestaña y en el fichero
 * descargado.
 */
export function alertEditionWhere(window: ScoringWindow): Prisma.AlertWhereInput {
  return { createdAt: { gte: windowBounds(window).from } };
}
