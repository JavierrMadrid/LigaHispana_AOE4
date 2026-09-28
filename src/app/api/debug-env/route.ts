import { db } from "@/lib/db";

/**
 * Diagnóstico temporal del entorno del Worker.
 *
 * **Tocar y borrar**: no debe quedar en producción. Solo lee; no escribe nada.
 *
 * Devuelve tres cosas y ninguna es un secreto:
 * - `keys`: los NOMBRES de las variables que el Worker ve. Nunca sus valores.
 * - `has`: si las variables esperadas existen.
 * - `db`: el resultado de un `count` a la base, con el nombre y el mensaje del
 *   error si falla. Es lo que en la traza del panel no se ve.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const expected = [
    "DATABASE_URL",
    "CRON_SECRET",
    "RATE_LIMIT_SALT",
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    "NEXT_PUBLIC_TURNSTILE_SITE_KEY",
    "TURNSTILE_SECRET_KEY",
  ];

  const keys = Object.keys(process.env).sort();
  const has: Record<string, boolean> = {};

  for (const name of expected) {
    has[name] = Object.hasOwn(process.env, name) && process.env[name] !== "";
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

  return Response.json({ nodeEnv: process.env.NODE_ENV ?? null, keys, has, db: dbResult });
}
