import { timingSafeEqual } from "node:crypto";
import { readAuthenticatedUser } from "@/lib/auth";
import { syncApprovedPlayers } from "@/lib/aoe4world/sync";

/**
 * Punto de entrada del worker de sincronización.
 *
 * Se puede invocar a mano con la sesión de un admin o con `CRON_SECRET`, que es
 * lo que necesita un cron externo (Vercel Cron solo manda peticiones GET sin
 * cookies). Es el mismo trabajo en los dos casos: una pasada por todos los
 * jugadores aprobados.
 */

export const maxDuration = 300;

function safeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);

  if (left.length !== right.length) {
    return false;
  }

  return timingSafeEqual(left, right);
}

/** `Authorization: Bearer <CRON_SECRET>`. Si no hay secreto configurado, nunca se acepta. */
function hasValidCronSecret(request: Request): boolean {
  const secret = process.env.CRON_SECRET;

  if (secret === undefined || secret === "") {
    return false;
  }

  const header = request.headers.get("authorization");

  if (header === null || !header.startsWith("Bearer ")) {
    return false;
  }

  return safeEquals(header.slice("Bearer ".length).trim(), secret);
}

async function isAuthorized(request: Request): Promise<boolean> {
  if (hasValidCronSecret(request)) {
    return true;
  }

  return (await readAuthenticatedUser()) !== null;
}

async function handleSync(request: Request): Promise<Response> {
  if (!(await isAuthorized(request))) {
    return Response.json(
      { error: "No autorizado. Hace falta sesión de admin o el header Bearer de CRON_SECRET." },
      { status: 401 },
    );
  }

  const summary = await syncApprovedPlayers();

  return Response.json(summary, {
    status: summary.playersFailed > 0 ? 207 : 200,
  });
}

export async function POST(request: Request): Promise<Response> {
  return handleSync(request);
}

/** Vercel Cron solo emite peticiones GET, de ahí el alias. */
export async function GET(request: Request): Promise<Response> {
  return handleSync(request);
}
