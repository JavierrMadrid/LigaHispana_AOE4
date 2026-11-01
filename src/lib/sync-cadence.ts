/**
 * Cada cuánto puede despertar el sincronizador, según lo que costó la última pasada.
 *
 * El reloj de `pg_cron` dispara cada minuto (`scripts/db-cron.ts`), pero quien decide
 * si hay pasada es el candado global de `src/lib/manual-sync.ts`, y su ventana sale de
 * aquí. La idea es no gastar cuota de AoE4World ni CPU del plan Free cuando no hace
 * falta, y acercarse al minuto cuando la pasada es pequeña.
 *
 * ## De dónde salen los tres frenos
 *
 * - **45 peticiones por minuto.** Es el presupuesto medido, no una estimación: con ~136
 *   jugadores ya se vieron respuestas `429` con una pasada cada 3 minutos. Una pasada
 *   que gasta más de 45 peticiones por minuto de espera está pidiendo demasiado.
 * - **15 jugadores por minuto.** Las peticiones crecen con el roster (masivo, ladder,
 *   perfil y relleno), así que el tamaño del torneo acota la cadencia aunque el conteo
 *   de peticiones de la última pasada salga bajo.
 * - **3× la duración de la pasada.** Deja al menos dos pasadas de margen entre inicios:
 *   si un disparo llega cuando la anterior aún corre, el candado no la ve terminada y
 *   lo que se apila es trabajo contra la API.
 *
 * El resultado se acota entre 1 y 3 minutos. **Un minuto solo cuando la pasada es
 * pequeña** en las tres cuentas. Con un torneo de verdad (50-60 jugadores) la cuenta
 * de jugadores sola ya pide 3 minutos: 60 / 15 = 4 → 240 s, recortado a 180. El minuto
 * queda para torneos pequeños o para el arranque; la medida de 13 jugadores, 15,9 s y
 * ~20 peticiones que hay hoy en producción da 60 s, no es el caso normal. **Un `429`
 * fuerza 3 minutos**: si la API ya dijo que no, lo último que hay que hacer es
 * insistir, y el freno es automático aunque el resto de cuentas dijeran que se puede ir
 * más rápido.
 *
 * Es deliberadamente **puro**: sin base de datos, sin red y sin reloj. Lo que lee el
 * rastro es `readSyncCadence()` en `src/lib/manual-sync.ts`, y así esta decisión se
 * puede probar con números y no con infraestructura.
 */

/** Cadencia más rápida que se permite, en segundos. */
export const SYNC_INTERVAL_MIN_SECONDS = 60;

/** Cadencia más lenta que se permite, en segundos. */
export const SYNC_INTERVAL_MAX_SECONDS = 180;

/** Jugadores por minuto de espera que se considera sostenible. */
export const SYNC_PLAYERS_PER_MINUTE = 15;

/** Peticiones por minuto de espera que se considera sostenible (el 429 de ~136). */
export const SYNC_REQUESTS_PER_MINUTE = 45;

/**
 * Margen entre el plazo de una pasada y el siguiente disparo, en segundos.
 *
 * El plazo que se le da a la pasada es la ventana del candado menos esto: si la
 * ventana son 60 s, la pasada tiene 50 s para terminar antes de que el minuto
 * siguiente pueda abrir el candado.
 */
export const SYNC_INTERVAL_SAFETY_SECONDS = 10;

/** Plazo mínimo de una pasada, en ms. Por debajo, mejor no lanzarla. */
const SYNC_PASS_MIN_TIMEOUT_MS = 30_000;

/**
 * Lo que deja la última pasada y basta para decidir la siguiente.
 *
 * Es un subconjunto de `SyncRunTrace` (`src/lib/settings.ts`) a propósito: este
 * módulo no importa nada del servidor, así que quien lee el rastro lo reduce a estos
 * cuatro números.
 */
export type SyncCadenceTrace = {
  /** Jugadores aprobados que entraron en la pasada. */
  playersTotal: number;
  /** Peticiones hechas a la API de AoE4World. */
  apiRequests: number;
  /** Lo que tardó la pasada entera, en ms. */
  durationMs: number;
  /** Cuántas respuestas `429` se comió la pasada. */
  rateLimitResponses: number;
};

/**
 * Segundos que deben pasar entre dos inicios de pasada.
 *
 * Sin rastro (primer arranque, o rastro ilegible) se va al máximo: no hay ninguna
 * medida que justifique apretar, y equivocarse hacia arriba solo cuesta frescura.
 */
export function nextSyncIntervalSeconds(trace: SyncCadenceTrace | null): number {
  if (trace === null) {
    return SYNC_INTERVAL_MAX_SECONDS;
  }

  // Un 429 es la propia API diciendo que no: se insiste al mínimo ritmo, sin mirar
  // el resto de cuentas (que pueden salir bajas justo porque la pasada se cortó).
  if (trace.rateLimitResponses > 0) {
    return SYNC_INTERVAL_MAX_SECONDS;
  }

  // Sin jugadores aprobados no hay nada que traer: despertar cada minuto solo gasta
  // invocaciones del Worker y lecturas de la base.
  if (trace.playersTotal <= 0) {
    return SYNC_INTERVAL_MAX_SECONDS;
  }

  const byPlayers = Math.ceil(trace.playersTotal / SYNC_PLAYERS_PER_MINUTE) * 60;
  const byRequests =
    trace.apiRequests > 0 ? Math.ceil(trace.apiRequests / SYNC_REQUESTS_PER_MINUTE) * 60 : 0;
  const byDuration = Math.ceil((trace.durationMs / 1000) * 3);

  return Math.min(
    SYNC_INTERVAL_MAX_SECONDS,
    Math.max(SYNC_INTERVAL_MIN_SECONDS, byPlayers, byRequests, byDuration),
  );
}

/**
 * Plazo que se le pasa a la pasada para que termine antes del siguiente disparo.
 *
 * Se descuenta el margen de seguridad y se pone un suelo de 30 s: una ventana de 60 s
 * deja 50 s de plazo, que con el torneo medido (15,9 s) sobra. Si la pasada se pasa de
 * plazo, lo que queda a medias se marca como cancelado en el rastro y la siguiente
 * pasada lo recoge.
 */
export function syncPassTimeoutMs(intervalSeconds: number): number {
  return Math.max(
    SYNC_PASS_MIN_TIMEOUT_MS,
    (intervalSeconds - SYNC_INTERVAL_SAFETY_SECONDS) * 1000,
  );
}
