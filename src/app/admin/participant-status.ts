import type { PlayerStatus } from "@/generated/prisma/enums";

/**
 * Rótulos y colores del estado de un jugador.
 *
 * Viven en un solo módulo porque los usan la cola de pendientes (servidor) y el
 * listado con filtros (cliente), y un estado no puede llamarse de dos formas
 * distintas según la parte de la pantalla que lo pinte.
 *
 * El color refuerza la palabra, no la sustituye: aprobado en verde de victoria,
 * pendiente en el oro de la liga y rechazado en el rojo de derrota. Los tokens
 * son los de `globals.css`, no valores sueltos.
 */
export const PLAYER_STATUS_LABELS: Record<PlayerStatus, string> = {
  APPROVED: "Aprobado",
  PENDING: "Pendiente",
  REJECTED: "Rechazado",
  BANNED: "Expulsado",
};

export const PLAYER_STATUS_STYLES: Record<PlayerStatus, string> = {
  APPROVED: "border-win/40 text-win",
  PENDING: "border-accent/40 text-accent",
  REJECTED: "border-loss/40 text-loss",
  // El rojo de la casa, pero con relleno: una expulsión no es un rechazo de solicitud
  // y tiene que leerse como un estado distinto a un vistazo.
  BANNED: "border-loss bg-loss/10 text-loss",
};
