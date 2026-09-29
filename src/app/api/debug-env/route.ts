import { db } from "@/lib/db";
import { listRuntimeBindings, lookupRuntimeEnv, type RuntimeEnvSource } from "@/lib/runtime-env";

/**
 * Diagnóstico temporal del entorno del Worker.
 *
 * **Tocar y borrar**: no debe quedar en producción. Solo lee; no escribe nada.
 *
 * Devuelve, y nada de esto es un secreto (solo nombres y booleanos):
 * - `bindings`: NOMBRES de los *bindings* de Cloudflare del Worker.
 * - `processEnvKeys`: NOMBRES de lo que hay en `process.env`.
 * - `env`: por cada variable esperada, si está, de dónde sale (`binding`,
 *   `process` o `null`) y cuál de las dos capas la tiene.
 * - `db`: el resultado de un `count` a la base, con el nombre y el mensaje del
 *   error si falla. Es lo que en la traza del panel no se ve.
 *
 * Lo que hay que mirar para decidir si el arreglo funciona está en la nota de
 * `src/lib/runtime-env.ts` y en el README.
 */
export const dynamic = "force-dynamic";

const EXPECTED_VARS = [
  "DATABASE_URL",
  "CRON_SECRET",
  "RATE_LIMIT_SALT",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "NEXT_PUBLIC_TURNSTILE_SITE_KEY",
  "TURNSTILE_SECRET_KEY",
] as const;

type EnvReport = {
  /** La variable está disponible para la app (en alguna de las dos capas). */
  resolved: boolean;
  /** De qué capa sale el valor que usa la app. */
  source: RuntimeEnvSource | null;
  /** Está en los bindings de Cloudflare. */
  inBinding: boolean;
  /** Está en `process.env`. */
  inProcessEnv: boolean;
};

export async function GET() {
  const env: Record<string, EnvReport> = {};

  for (const name of EXPECTED_VARS) {
    const lookup = lookupRuntimeEnv(name);

    env[name] = {
      resolved: lookup.source !== null,
      source: lookup.source,
      inBinding: lookup.source === "binding",
      inProcessEnv: Object.hasOwn(process.env, name) && process.env[name] !== "",
    };
  }

  let dbResult: unknown;

  try {
    dbResult = { ok: true, players: await db.player.count() };
  } catch (error) {
    dbResult = {
      ok: false,
      name: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  // Sin contexto de Cloudflare (`next dev`, `next build`, Node) esta lista sale
  // vacía: es la señal de que no hay bindings con los que trabajar.
  const bindings = listRuntimeBindings();

  let nodeOs: string;

  try {
    const os = await import("node:os");
    nodeOs = `ok (platform ${os.platform()})`;
  } catch (error) {
    nodeOs = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }

  return Response.json({
    nodeEnv: process.env.NODE_ENV ?? null,
    nodeVersion: process.versions?.node ?? null,
    nodeOs,
    workerd: typeof globalThis.navigator !== "undefined",
    bindings,
    processEnvKeys: Object.keys(process.env).sort(),
    env,
    db: dbResult,
  });
}
