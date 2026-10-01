import "server-only";

import { consumeRateLimit } from "@/lib/rate-limit";

/**
 * Candado global de las pasadas de sincronización a mano.
 *
 * Vive aquí, y no dentro del endpoint, porque hay **dos** consumidores: el disparo
 * del cron de Supabase (`POST /api/sync`, programado en `scripts/db-cron.ts`) y la
 * acción manual de `/admin` (`syncNow` en `src/app/admin/actions.ts`). Si cada uno
 * trajera su propia clave y su propia ventana, dejarían de coordinarse, y basta con
 * que uno se adelante para que las dos pasadas se apilen contra la API de AoE4World.
 * Que la clave y la ventana estén en un solo sitio es justo lo que evita esa
 * divergencia.
 *
 * ## Por qué es global y no por IP
 *
 * Lo que se protege no es "que un visitante no abuse" sino la API de AoE4World, y la
 * pasada es un trabajo único para todo el sitio: si dos personas pulsan a la vez, no
 * hay razón para hacer dos pasadas. El cubo es `global` y la clave es fija, sin nada
 * que salga de la petición ni de quien la hace. El contador vive en Postgres y su
 * incremento es una sola sentencia, así que dos pulsaciones simultáneas no se cuelan
 * (ver `src/lib/rate-limit.ts`).
 *
 * Que ahora lo use también un admin, que sí está autenticado, **no** cambia el
 * criterio: el candado protege la API, no la interfaz. Sigue siendo global porque lo
 * que se mide es cuántas veces sale el Worker a por partidas, y eso no depende de
 * quién lo pida.
 *
 * ## Por qué 5 minutos y no menos
 *
 * Es el **plan Free de Cloudflare**, no una manía: cada invocación tiene 10 ms de CPU
 * y una pasada del sync gasta ~500 ms, así que el *isolate* solo lo tolera si es
 * esporádico. Insistir es justo lo que hace que Cloudflare empiece a matar pasadas con
 * `Worker exceeded CPU time limit` (error 1102). Ver docs/OPERACION.md, "El límite de CPU del
 * plan Free".
 *
 * De ahí que el cron de Supabase reutilice este mismo candado en vez de tener el suyo:
 * es el precio de no llevar un secreto en la base de datos, y significa que la cadencia
 * real del sync queda entre 5 y 10 minutos.
 */

/**
 * Clave del candado: fija, global. Dice "manual" porque así empezó —la vía que tenía
 * detrás era el botón de `/partidas`—, no porque sea la única: el cron de Supabase
 * entra por el mismo candado.
 */
export const MANUAL_SYNC_LOCK_KEY = "public/manual-sync";

/**
 * Lo que hay que esperar entre dos pasadas a mano. El cron de Supabase dispara cada 5
 * minutos y **comparte** este valor, así que también es su ventana.
 */
export const MANUAL_SYNC_COOLDOWN_SECONDS = 300;

/**
 * Antigüedad a partir de la cual la fila del contador se considera caducada.
 *
 * Solo afecta a la limpieza de filas viejas (`purgeStaleCounters`), no a la ventana:
 * `bumpCounter()` reinicia el contador por sí solo en cuanto la ventana expira. Una
 * hora es muy superior a la de 5 minutos para que la fila siga ahí —y se pueda mirar
 * en la tabla— cuando alguien va a comprobar si el candado está haciendo su trabajo.
 */
const MANUAL_SYNC_STALE_SECONDS = 3_600;

/** Lo que decide `consumeManualSyncLock()`: si se pasa ahora, y cuánto queda. */
export type ManualSyncLock = {
  /** Si se puede lanzar la pasada ahora mismo. */
  allowed: boolean;
  /** Cuánto queda para que la ventana se reinicie, en segundos. */
  retryAfterSeconds: number;
};

/**
 * Cuenta un intento contra el candado global y decide si se puede pasar.
 *
 * **Lanza** si no se puede comprobar el candado (base caída, contador que no
 * responde), y es deliberado: quien llama tiene que poder distinguir "todavía no" de
 * "no se sabe", y en el segundo caso **no** debe lanzar la pasada. Un `allowed: false`
 * de verdad sería indistinguible de un fallo, y el fallo que se tragaría una pasada sin
 * candado es justo el que hay que evitar.
 *
* Los dos consumidores lo tratan por eso igual: `catch` para registrar el motivo y
 * responder "ahora no se puede", sin pasar. Y consume el intento **antes** de lanzar la
 * pasada, no después: al revés, dos pulsaciones simultáneas pasarían las dos antes de
 * que ninguna hubiera escrito en el contador.
 */
export async function consumeManualSyncLock(): Promise<ManualSyncLock> {
  const limit = await consumeRateLimit(MANUAL_SYNC_LOCK_KEY, "global", {
    maxAttempts: 1,
    windowSeconds: MANUAL_SYNC_COOLDOWN_SECONDS,
    staleSeconds: MANUAL_SYNC_STALE_SECONDS,
  });

  return { allowed: limit.allowed, retryAfterSeconds: limit.retryAfterSeconds };
}