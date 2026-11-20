import type { NextRequest } from "next/server";

import { logDatabaseFailure } from "@/lib/db-errors";
import {
  OVERLAY_OBJECTS_DEFAULT_LIMIT,
  loadOverlayObjectEvents,
  overlayError,
  overlayJson,
  overlayPreflight,
  readOverlayLimit,
  readOverlayProfileId,
} from "@/lib/overlay-api";

/**
 * `GET /api/v0/objetos?id=<profileId>[&limite=<1..20>]` — los últimos eventos de
 * objetos de un participante: los que recibió, los que lanzó y los que se le
 * devolvieron.
 *
 * Es lo que la tarjeta del overlay anima, así que la lista va en orden
 * **ascendente** y recortada a los últimos `limite` eventos: el stream reproduce
 * la secuencia de más antiguo a más reciente y lo que acaba de pasar es lo que
 * interesa. El orden y el recorte los resuelve el lector; la ruta solo valida.
 *
 * El `id` es **obligatorio**: el feed es de alguien y sin alguien no hay feed; un
 * id ausente o ilegible es 400, igual que en `/eventos`. `limite` es opcional,
 * vale 10 por defecto y comparte el rango 1..20 del resto de la API.
 *
 * Un participante que no existe o no está aprobado da 404, y uno sin eventos da
 * `200 []`: "todavía no le ha pasado nada" no es un error.
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
      "El límite de objetos no es válido: debe ser un entero entre 1 y 20.",
      400,
    );
  }

  try {
    const eventos = await loadOverlayObjectEvents(
      id.value,
      limite.status === "ok" ? limite.value : OVERLAY_OBJECTS_DEFAULT_LIMIT,
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
    logDatabaseFailure("api/v0/objetos", error);

    return overlayError("servicio_no_disponible", "La base de datos no responde.", 503);
  }
}

/** `preflight` de CORS: el overlay corre en otro origen. */
export function OPTIONS(): Response {
  return overlayPreflight();
}
