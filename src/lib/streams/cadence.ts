/**
 * Cada cuánto se puede volver a preguntar por el estado de directo.
 *
 * El sync de partidas puede correr cada 1-3 minutos (ver `src/lib/sync-cadence.ts`),
 * pero YouTube cobra cuota **por llamada** y una comprobación de 12 canales son 24
 * unidades: repetirla en cada pasada agotaría el fondo diario de 10 000 unidades y
 * dejaría el estado de los directos congelado. Por eso este paso tiene su propio
 * reloj, independiente del de las partidas.
 *
 * La marca vive en `Setting["streams.lastRun"]` y la escribe el sincronizador. La
 * decisión es pura para poder probarla sin base, sin red y sin reloj.
 */

/** Minutos mínimos entre dos comprobaciones del estado de directo. */
export const STREAMS_MIN_INTERVAL_MINUTES = 10;

/**
 * ¿Toca comprobar el estado de directo?
 *
 * Sin marca previa sí: es la primera pasada o la marca no se pudo leer. Una marca en
 * el futuro (reloj adelantado) **no** adelanta la comprobación: se espera a que pase,
 * que es la opción que no gasta cuota.
 */
export function shouldRefreshStreams(
  lastRun: Date | null,
  now: Date,
  intervalMinutes: number = STREAMS_MIN_INTERVAL_MINUTES,
): boolean {
  if (lastRun === null) {
    return true;
  }

  return now.getTime() - lastRun.getTime() >= intervalMinutes * 60_000;
}
