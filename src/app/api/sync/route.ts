import type { ManualSyncLock } from "@/lib/manual-sync";
import { syncApprovedPlayers } from "@/lib/aoe4world/sync";
import { consumeManualSyncLock } from "@/lib/manual-sync";

/**
 * Disparo periódico del sync desde la propia base de datos: Supabase Cron
 * (`pg_cron` + `pg_net`) llama a este endpoint cada 5 minutos. El job está escrito y
 * versionado en `scripts/db-cron.ts`.
 *
 * Hace exactamente el mismo trabajo que `/api/cron/sync`, por la misma función, pero
 * **sin secreto**: lo llama la base de datos y no lleva ni sesión ni `Authorization`.
 * Por eso sigue siendo un endpoint público, y por eso no puede perder las dos
 * condiciones que lo cierran (ver el cuerpo del `POST`): el `content-type` de JSON y
 * un candado global de una pasada cada 5 minutos.
 *
 * El candado es el mismo que usa la llamada manual del panel de admin
 * (`syncNow` en `src/app/admin/actions.ts`, sobre `src/lib/manual-sync.ts`), así que
 * las dos vías se coordinan: si un admin sincronizó hace nada, el cron recibe
 * `{"status":"cooldown"}` con 200 y no duplica trabajo, y al revés.
 *
 * Ya no hay ningún botón público detrás —la llamada manual es la Server Action del
 * panel de admin—, pero **no se cierra**: es el reloj del torneo, y el plan Free de
 * Cloudflare es lo que impide traer el disparo a un Cron Trigger nativo.
 */

export const maxDuration = 300;

/**
 * Resumen reducido: quien dispara solo necesita saber si fue bien. No se devuelve el
 * detalle por jugador, que no aporta nada aquí y engorda la respuesta.
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

  let lock: ManualSyncLock;

  try {
    lock = await consumeManualSyncLock();
  } catch (error) {
    // Si no se puede comprobar el candado, **no** se lanza la pasada: sin el
    // candado el endpoint quedaría abierto a cualquiera que lo machaque.
    console.error(
      "[sync] No se ha podido comprobar el candado del sync manual:",
      error instanceof Error ? error.message : String(error),
    );

    return json({ status: "unavailable" }, 503);
  }

  if (!lock.allowed) {
    // No es un error para quien dispara: la pasada se hizo hace nada. Se responde
    // 200 para no ensuciar la consola ni pedir que se reintente.
    return json({ status: "cooldown", retryAfterSeconds: lock.retryAfterSeconds });
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
