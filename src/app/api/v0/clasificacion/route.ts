import type { NextRequest } from "next/server";

import { logDatabaseFailure } from "@/lib/db-errors";
import {
  loadOverlayClassification,
  overlayError,
  overlayJson,
  overlayPreflight,
  readOverlayDesde,
  readOverlayProfileId,
} from "@/lib/overlay-api";

/**
 * `GET /api/v0/clasificacion?id=<profileId>[&desde=<ISO 8601>]` — la posición de
 * un participante con sus vecinos.
 *
 * El `id` es **obligatorio** y ausente es un 400, no una lista: la respuesta es una
 * ventana alrededor de una fila, y sin fila no hay nada que enseñar. Un id que no
 * es un entero positivo también es 400, porque es un error de quien llama y no un
 * "no encontrado".
 *
 * `desde` es opcional y recorta el feed de objetivos: el overlay que se reconecta
 * pide solo lo que ha pasado desde la última vez. Sin él se publica el estado de la
 * edición entera, que es el mismo mapa de eventos (el último por objetivo).
 *
 * Un participante aprobado sin fila en la versión publicada da 404 con su propio
 * código: el overlay distingue así "este id no es del torneo" de "la base no
 * responde", que es el 503.
 *
 * La ruta es pública y no está en el `matcher` del Proxy: no pide sesión.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const id = readOverlayProfileId(request.nextUrl.searchParams.get("id"));

  if (id.status !== "ok") {
    return overlayError(
      "parametro_invalido",
      "El identificador del participante no es válido.",
      400,
    );
  }

  const desde = readOverlayDesde(request.nextUrl.searchParams.get("desde"));

  if (desde.status === "invalid") {
    return overlayError(
      "parametro_invalido",
      "La fecha `desde` no es una fecha ISO 8601 válida.",
      400,
    );
  }

  try {
    const rows = await loadOverlayClassification(
      id.value,
      desde.status === "ok" ? desde.value : null,
    );

    if (rows === null) {
      return overlayError(
        "participante_no_encontrado",
        "No se encontró un participante con el identificador indicado.",
        404,
      );
    }

    return overlayJson(rows);
  } catch (error) {
    logDatabaseFailure("api/v0/clasificacion", error);

    return overlayError("servicio_no_disponible", "La base de datos no responde.", 503);
  }
}

/** `preflight` de CORS: el overlay corre en otro origen. */
export function OPTIONS(): Response {
  return overlayPreflight();
}
