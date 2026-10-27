import type { NextRequest } from "next/server";

import { logDatabaseFailure } from "@/lib/db-errors";
import { loadOverlayObjectives, overlayError, overlayJson, overlayPreflight } from "@/lib/overlay-api";

/**
 * `GET /api/v0/objetivos` — el catálogo de objetivos con la regla activa.
 *
 * No tiene parámetros: el catálogo es el mismo para todo el torneo y lo que
 * cambia con la edición —los puntos por victoria, los overrides, los objetivos
 * desactivados y el pool de mapas— lo resuelve el lector. El overlay no tiene que
 * saber qué configuración está activa.
 *
 * Las URLs de los iconos se componen con el **origen de la petición**, así que
 * funcionan igual en producción que en un preview o en `next dev` sin tener que
 * configurar un dominio.
 *
 * El `try` cubre la lectura entera (ruleset y pool de mapas): las dos son base de
 * datos, y si falla una la respuesta estaría mintiendo.
 */
export async function GET(request: NextRequest): Promise<Response> {
  try {
    const objetivos = await loadOverlayObjectives(request.nextUrl.origin);

    return overlayJson(objetivos);
  } catch (error) {
    logDatabaseFailure("api/v0/objetivos", error);

    return overlayError("servicio_no_disponible", "La base de datos no responde.", 503);
  }
}

/** `preflight` de CORS: el overlay corre en otro origen. */
export function OPTIONS(): Response {
  return overlayPreflight();
}
