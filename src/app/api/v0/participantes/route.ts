import type { NextRequest } from "next/server";

import { logDatabaseFailure } from "@/lib/db-errors";
import {
  loadOverlayParticipants,
  overlayError,
  overlayJson,
  overlayPreflight,
  readOverlayProfileId,
  type OverlayParticipante,
} from "@/lib/overlay-api";

/**
 * `GET /api/v0/participantes` — los participantes aprobados del torneo.
 *
 * Dos formas, por el `?id=`:
 *
 * - **sin `id`**: la lista completa, ordenada por `profileId`;
 * - **con `id`**: ese participante, o 404 si no está aprobado.
 *
 * Un `id` que no es un entero positivo se rechaza con 400 antes de tocar la base:
 * es un error de quien llama, no un "no encontrado", y merece un código distinto
 * para que el overlay sepa si el problema es su URL o la lista.
 *
 * El `try` cubre **solo** la lectura. Lo que se decide después —qué se responde
 * con la lista— no puede fallar por la base, y meterlo dentro convertiría
 * cualquier fallo de programación en un 503 que esconde el error.
 *
 * La ruta es pública y no está en el `matcher` del Proxy: no pide sesión.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const id = readOverlayProfileId(request.nextUrl.searchParams.get("id"));

  if (id.status === "invalid") {
    return overlayError(
      "parametro_invalido",
      "El identificador del participante no es válido.",
      400,
    );
  }

  let participantes: OverlayParticipante[];

  try {
    participantes = await loadOverlayParticipants(id.status === "ok" ? id.value : undefined);
  } catch (error) {
    logDatabaseFailure("api/v0/participantes", error);

    return overlayError("servicio_no_disponible", "La base de datos no responde.", 503);
  }

  if (id.status === "ok" && participantes.length === 0) {
    return overlayError(
      "participante_no_encontrado",
      "No se encontró un participante con el identificador indicado.",
      404,
    );
  }

  return overlayJson(participantes);
}

/** `preflight` de CORS: el overlay corre en otro origen. */
export function OPTIONS(): Response {
  return overlayPreflight();
}
