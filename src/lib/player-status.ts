import type { PlayerStatus } from "@/generated/prisma/enums";

/**
 * Reglas **puras** del estado de un participante, compartidas por el panel, la
 * inscripción pública y el motor de puntuación.
 *
 * Existe por una decisión de producto: al empezar una edición nueva **nadie pasa a
 * la siguiente sin consentirlo**. Los `APPROVED` y los `PENDING` se desactivan, y
 * para volver a la liga hay que reinscribirse por `/participar` y pasar por la
 * aprobación de siempre.
 *
 * El módulo no importa `server-only` ni toca la base: es la regla, no la consulta,
 * y así se puede probar entera sin nada alrededor. Quien escribe es
 * `writeScoringRuleset()` (desactivación) y `registerPlayer()` (reinscripción).
 */

/**
 * Los estados que se desactivan al empezar una edición nueva.
 *
 * Un `APPROVED` estaba dentro y un `PENDING` había pedido entrar: los dos participan
 * del consentimiento de la edición que termina, no de la que empieza. Los `BANNED`
 * ya están fuera, los `INACTIVE` ya lo están y los `REJECTED` nunca entraron, así
 * que no hay nada que desactivar en ellos.
 */
export const DEACTIVATABLE_PLAYER_STATUSES = ["APPROVED", "PENDING"] as const;

/** Los estados desde los que el formulario público admite una reinscripción. */
export const RESUBMITTABLE_PLAYER_STATUSES = ["REJECTED", "INACTIVE"] as const;

const DEACTIVATABLE: ReadonlySet<string> = new Set(DEACTIVATABLE_PLAYER_STATUSES);
const RESUBMITTABLE: ReadonlySet<string> = new Set(RESUBMITTABLE_PLAYER_STATUSES);

/**
 * ¿Este estado se desactiva al empezar una edición nueva?
 *
 * Se pregunta por una fila concreta, no por el enum entero: el `updateMany` que hace
 * la desactivación usa la constante de arriba para que la lista no se pueda escribir
 * de dos maneras.
 */
export function isDeactivatablePlayerStatus(status: PlayerStatus): boolean {
  return DEACTIVATABLE.has(status);
}

/**
 * ¿Se puede reinscribir desde este estado?
 *
 * Sí desde `REJECTED` (comportamiento de siempre: su solicitud se descartó y puede
 * volver a mandarla) y desde `INACTIVE` (la edición nueva lo dejó fuera y ahora
 * consiente la siguiente). `APPROVED` y `PENDING` bloquean porque su solicitud ya
 * está dentro o en la cola, y `BANNED` porque una expulsión no se salta por el
 * formulario público.
 */
export function canResubmitRegistration(status: PlayerStatus): boolean {
  return RESUBMITTABLE.has(status);
}

/**
 * ¿La reinscripción reescribe `registeredAt` con el instante del envío?
 *
 * Solo desde `INACTIVE`: es una **inscripción nueva** y la fecha marca el corte de
 * partidas que le cuentan (`scoringCutoff()`), así que las de la edición anterior no
 * pueden seguir sumando. Un `REJECTED` conserva la fecha del primer envío, que es el
 * comportamiento de siempre: quien se apuntó a tiempo no pierde sus partidas porque
 * la organización mirase su solicitud más tarde.
 */
export function resubmissionResetsRegisteredAt(status: PlayerStatus): boolean {
  return status === "INACTIVE";
}
