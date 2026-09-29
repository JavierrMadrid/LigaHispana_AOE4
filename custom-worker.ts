/**
 * Punto de entrada del Worker.
 *
 * El worker que genera `@opennextjs/cloudflare` solo exporta el `fetch` de
 * Next, así que para tener un **Cron Trigger** de Cloudflare hace falta un
 * entrypoint propio que reenvíe ese `fetch` y añada el `scheduled`. Es el
 * patrón que documenta OpenNext ("Custom Worker"):
 * https://opennext.js.org/cloudflare/howtos/custom-worker
 *
 * El `scheduled` no llama al motor de sincronización directamente; hace una
 * petición al propio Worker por el binding `WORKER_SELF_REFERENCE`, que es el
 * mismo endpoint `POST /api/cron/sync` que ya existe. A propósito:
 *
 * - Llamar a `syncApprovedPlayers()` desde aquí obligaría a importar `src/lib`,
 *   que arrastra `server-only` (que lanza fuera del entorno de Next) y el
 *   cliente de Prisma generado. Entrar por el endpoint deja que Next monte su
 *   ámbito de petición como en cualquier otra petición, y `src/lib/db.ts`
 *   encuentra el contexto de Cloudflare y abre un cliente por invocación.
 * - Se reutiliza la autenticación que ya tiene el endpoint (`Bearer
 *   CRON_SECRET`), sin duplicar la lógica de autorización.
 *
 * El binding de servicio va a este mismo Worker, no a una URL pública, así que
 * la petición no sale a Internet y no hay ningún dominio que mantener aquí.
 */

// `.open-next/worker.js` lo genera `opennextjs-cloudflare build` antes de que
// wrangler empaquete esto, así que en un árbol recién clonado no existe y la
// línea del import falla; en uno ya construido resuelve y no hay error. Por eso
// va `@ts-ignore` y no `@ts-expect-error`: el segundo daría "directiva sin usar"
// en el caso en que el fichero ya está generado.
// @ts-ignore: módulo generado en el build, no versionado.
import openNextHandler from "./.open-next/worker.js";

// Los Durable Objects que genera OpenNext se siguen reexportando: hoy las tres
// cachés van en `"dummy"` y no se usan, pero `wrangler.jsonc` las declara y
// dejar de reexportarlas rompería el día que se activen.
// @ts-ignore: mismo módulo generado que el import de arriba.
export { DOQueueHandler, DOShardedTagCache, BucketCachePurge } from "./.open-next/worker.js";

/** Lo justo del entorno del Worker que necesita el `scheduled`. */
type ScheduledEnv = {
  readonly CRON_SECRET?: string;
  readonly WORKER_SELF_REFERENCE?: {
    fetch(request: Request): Promise<Response>;
  };
};

/** El contexto de la invocación: solo se usa `waitUntil`. */
type ScheduledContext = {
  waitUntil(promise: Promise<unknown>): void;
};

/** El endpoint de siempre, por el binding de servicio. El host es interno. */
const SYNC_URL = "https://worker.internal/api/cron/sync";

/** La parte del resumen del sync que se saca al log. */
type SyncSummary = {
  durationMs?: number;
  playersTotal?: number;
  playersOk?: number;
  playersFailed?: number;
  newMatches?: number;
};

/**
 * Una pasada del sincronizador, a través del endpoint.
 *
 * Deja una sola línea en el log con el resultado, para que el Cron Trigger se
 * pueda comprobar en Workers Logs sin abrir el detalle. El resumen completo
 * (con un objeto por jugador) no se vuelca: sería ruido.
 */
async function runScheduledSync(env: ScheduledEnv): Promise<void> {
  const secret = env.CRON_SECRET?.trim() ?? "";
  const self = env.WORKER_SELF_REFERENCE;

  if (secret === "" || self === undefined) {
    console.error(
      "[cron] Falta CRON_SECRET o el binding WORKER_SELF_REFERENCE; no se lanza el sync.",
    );

    return;
  }

  const response = await self.fetch(
    new Request(SYNC_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
    }),
  );

  if (!response.ok) {
    const detail = await response.text().catch(() => "");

    console.error(`[cron] El sync respondió ${response.status}: ${detail.slice(0, 300)}`);

    return;
  }

  const summary = (await response.json().catch(() => null)) as SyncSummary | null;

  if (summary === null) {
    console.log("[cron] Sync terminado (el resumen no era JSON legible).");

    return;
  }

  console.log(
    `[cron] Sync terminado en ${summary.durationMs ?? "?"} ms: ` +
      `${summary.playersOk ?? "?"}/${summary.playersTotal ?? "?"} jugadores, ` +
      `${summary.newMatches ?? "?"} partidas nuevas, ${summary.playersFailed ?? "?"} fallos.`,
  );
}

const worker = {
  fetch: (request: Request, env: unknown, ctx: unknown) => openNextHandler.fetch(request, env, ctx),
  scheduled: (_controller: unknown, env: ScheduledEnv, ctx: ScheduledContext): void => {
    // `waitUntil` es lo que mantiene la invocación viva hasta que la pasada
    // termina (hasta 15 minutos) sin bloquear la devolución del handler.
    ctx.waitUntil(runScheduledSync(env));
  },
};

export default worker;
