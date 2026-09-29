import { syncApprovedPlayers } from "@/lib/aoe4world/sync";
import { consumeRateLimit } from "@/lib/rate-limit";

/**
 * Disparo manual del sync, detrás del botón "Actualizar" de `/partidas`.
 *
 * Hace exactamente el mismo trabajo que `/api/cron/sync`, por la misma función,
 * pero sin secreto: lo llama el navegador de cualquiera que esté mirando las
 * partidas en juego. Como es público y cada pasada son ~15 peticiones a la API
 * de AoE4World, lleva **un único candado**: un sync cada {@link COOLDOWN_SECONDS},
 * global para todo el sitio.
 *
 * El candado es global a propósito, no por IP. Lo que se protege no es "que un
 * visitante no abuse" sino la API de AoE4World, y la pasada es un trabajo único
 * para todos: si dos personas pulsan a la vez, no hay razón para hacer dos
 * pasadas. El contador vive en Postgres y su incremento es una sola sentencia,
 * así que dos pulsaciones simultáneas no se cuelan (ver `src/lib/rate-limit.ts`).
 *
 * Por qué no basta con el Cron Trigger: entre pasada y pasada de 5 minutos, la
 * lista puede quedar desfasada. El botón es "quiero verlo ahora".
 */

export const maxDuration = 300;

/** Lo que hay que esperar entre dos pasadas manuales (y con el cron, no se coordina). */
const COOLDOWN_SECONDS = 60;

/** Clave del candado global: fija, no sale de la petición. */
const COOLDOWN_KEY = "public/manual-sync";

/**
 * Resumen reducido: el cliente solo necesita saber si fue bien. No se devuelve
 * el detalle por jugador, que no aporta nada aquí y engorda la respuesta.
 */
type ManualSyncPayload = {
  status: "ok" | "cooldown" | "rejected" | "unavailable" | "error";
  retryAfterSeconds?: number;
  playersTotal?: number;
  playersOk?: number;
  playersFailed?: number;
  newMatches?: number;
  durationMs?: number;
};

function json(payload: ManualSyncPayload, status = 200): Response {
  return Response.json(payload, { status });
}

export async function POST(request: Request): Promise<Response> {
  // Un `fetch` de la propia página manda `application/json`; un formulario de
  // otro sitio no puede (tendría que ser un tipo "simple", y este no lo es), y
  // con un `fetch` cruzado el navegador exigiría un preflight que este endpoint
  // no contesta. Es lo que descarta el CSRF: sin esto, cualquier web podría
  // gastar la cuota de la API de AoE4World a costa nuestra.
  const contentType = request.headers.get("content-type") ?? "";

  if (!contentType.includes("application/json")) {
    return json({ status: "rejected" }, 415);
  }

  let allowed: boolean;
  let retryAfterSeconds = 0;

  try {
    const limit = await consumeRateLimit(COOLDOWN_KEY, "global", {
      maxAttempts: 1,
      windowSeconds: COOLDOWN_SECONDS,
      staleSeconds: 3_600,
    });

    allowed = limit.allowed;
    retryAfterSeconds = limit.retryAfterSeconds;
  } catch (error) {
    // Si no se puede comprobar el candado, **no** se lanza la pasada: sin el
    // candado el endpoint quedaría abierto a cualquiera que lo machaque.
    console.error(
      "[sync] No se ha podido comprobar el candado del sync manual:",
      error instanceof Error ? error.message : String(error),
    );

    return json({ status: "unavailable" }, 503);
  }

  if (!allowed) {
    // No es un error para quien mira: la pasada se hizo hace nada. Se responde
    // 200 para no ensuciar la consola del navegador ni pedirle que reintente.
    return json({ status: "cooldown", retryAfterSeconds });
  }

  try {
    const summary = await syncApprovedPlayers();

    return json({
      status: "ok",
      playersTotal: summary.playersTotal,
      playersOk: summary.playersOk,
      playersFailed: summary.playersFailed,
      newMatches: summary.newMatches,
      durationMs: summary.durationMs,
    });
  } catch (error) {
    console.error(
      "[sync] La pasada manual ha fallado:",
      error instanceof Error ? error.message : String(error),
    );

    return json({ status: "error" }, 500);
  }
}
