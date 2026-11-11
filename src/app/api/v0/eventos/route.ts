import type { NextRequest } from "next/server";

import { logDatabaseFailure } from "@/lib/db-errors";
import {
  OVERLAY_EVENTS_DEFAULT_LIMIT,
  loadOverlayEvents,
  overlayError,
  overlayJson,
  overlayPreflight,
  readOverlayLimit,
  readOverlayProfileId,
} from "@/lib/overlay-api";

/**
 * `GET /api/v0/eventos?id=<profileId>[&limite=<1..20>]` — los últimos objetivos
 * cumplidos o progresados de un participante.
 *
 * El `id` es **obligatorio**: el feed es de alguien y sin alguien no hay feed; un
 * id ausente o ilegible es 400, igual que en `/clasificacion`. `limite` es
 * opcional, vale 3 por defecto y se acota a 20 para que una URL no pueda pedir la
 * historia entera de una edición.
 *
 * Un participante que no existe o no está aprobado da 404, y uno sin eventos da
 * `200 []`: son dos cosas distintas y el overlay necesita distinguirlas para no
 * tratar "no ha hecho nada todavía" como un error.
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

  const limite = readOverlayLimit(request.nextUrl.searchParams.get("limite"));

  if (limite.status === "invalid") {
    return overlayError(
      "parametro_invalido",
      "El límite de eventos no es válido: debe ser un entero entre 1 y 20.",
      400,
    );
  }

  try {
    const eventos = await loadOverlayEvents(
      id.value,
      limite.status === "ok" ? limite.value : OVERLAY_EVENTS_DEFAULT_LIMIT,
    );

    if (eventos === null) {
      return overlayError(
        "participante_no_encontrado",
        "No se encontró un participante con el identificador indicado.",
        404,
      );
    }

    return overlayJson(eventos);
  } catch (error) {
    logDatabaseFailure("api/v0/eventos", error);

    return overlayError("servicio_no_disponible", "La base de datos no responde.", 503);
  }
}

/** `preflight` de CORS: el overlay corre en otro origen. */
export function OPTIONS(): Response {
  return overlayPreflight();
}
