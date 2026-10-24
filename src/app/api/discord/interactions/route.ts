import { NextResponse } from "next/server";

import { getDiscordConfig, isDiscordVerificationConfigured } from "@/lib/discord/env";
import {
  DISCORD_SIGNATURE_HEADER,
  DISCORD_TIMESTAMP_HEADER,
  ephemeralResponse,
  parseDiscordInteraction,
  pongResponse,
  updateMessageResponse,
  verifyDiscordSignature,
} from "@/lib/discord/interactions";
import {
  parseVerificationCustomId,
  verificationStaleText,
} from "@/lib/discord/verification";
import { handleVerificationClick } from "@/lib/discord/verification-resolve";

/**
 * Endpoint de interacciones de Discord: los dos botones del privado de verificación.
 *
 * ## Público, y por eso lo primero es la firma
 *
 * Esta ruta no tiene sesión ni `requireAdmin()`: la llama Discord, no una persona, y
 * su autenticación es la firma Ed25519 de la cabecera. Se verifica con la clave
 * pública (`DISCORD_PUBLIC_KEY`) **y el cuerpo crudo** antes de mirar nada más; lo
 * que no firma la aplicación no llega a tocar la base.
 *
 * ## Qué contesta, y por qué esos códigos
 *
 * | Situación | Respuesta |
 * |---|---|
 * | Falta configuración (clave pública, client id o bot) | `503` |
 * | Firma ausente, ilegible, vieja o inválida | `401` |
 * | Cuerpo que no es JSON, no es objeto o no trae `type` | `400` |
 * | `application_id` distinto del `DISCORD_CLIENT_ID` | `401` |
 * | `PING` | `200` con `{ "type": 1 }` |
 * | Botón resuelto | `200` con `{ "type": 7 }` (edita el privado y quita los botones) |
 * | Botón que ya no vale | `200` con `{ "type": 7 }` y un texto genérico |
 * | Componente ajeno | `200` con un mensaje efímero |
 *
 * Los tres primeros son los que documenta Discord; los de componente no pueden ser
 * un error HTTP, porque Discord reintenta y el botón se queda girando. La ruta está
 * fuera del `matcher` del Proxy (`src/proxy.ts` solo cubre `/admin` y `/login`), así
 * que no pasa por la sesión de Supabase.
 *
 * ## Sin gateway ni proceso residente
 *
 * Esta es la única pieza nueva de Discord: no hay conexión persistente que escuche
 * eventos, y Discord llama aquí cuando alguien pulsa. El endpoint no calcula
 * puntuación ni roles; deja la fila aprobada o rechazada y el worker de siempre la
 * recoge en la siguiente pasada.
 *
 * ## El cuerpo se lee una vez, como texto
 *
 * La firma es sobre los bytes exactos, así que se lee `request.text()` y se pasa ese
 * mismo texto a la verificación y al parseo. Cualquier reserialización invalidaría
 * la firma.
 */

function jsonError(status: number, error: string): NextResponse {
  return NextResponse.json({ error }, { status });
}

export async function POST(request: Request): Promise<NextResponse> {
  const config = getDiscordConfig();

  if (!isDiscordVerificationConfigured(config)) {
    return jsonError(503, "La verificación de altas no está configurada.");
  }

  const body = await request.text();

  const firma = await verifyDiscordSignature({
    publicKey: config.publicKey,
    signature: request.headers.get(DISCORD_SIGNATURE_HEADER),
    timestamp: request.headers.get(DISCORD_TIMESTAMP_HEADER),
    body,
    now: new Date(),
  });

  if (firma !== "ok") {
    // El motivo concreto se queda en el log: quien llama no es una persona y una
    // firma inválida no puede recibir detalles de por qué no vale.
    console.warn(`[discord-interactions] Firma rechazada: ${firma}.`);

    return jsonError(401, "Firma inválida.");
  }

  const parsed = parseDiscordInteraction(body);

  if (!parsed.ok) {
    return jsonError(400, "Interacción mal formada.");
  }

  const interaction = parsed.interaction;

  // Una firma válida con el `application_id` de otra aplicación no puede tocar
  // nuestras filas: es la comprobación que ata la petición a **este** bot.
  if (interaction.applicationId !== config.clientId) {
    console.warn("[discord-interactions] Interacción de otra aplicación.");

    return jsonError(401, "Aplicación desconocida.");
  }

  if (interaction.kind === "ping") {
    return NextResponse.json(pongResponse());
  }

  if (interaction.kind === "unsupported") {
    return NextResponse.json(
      ephemeralResponse("Esta interacción no está disponible en el torneo."),
    );
  }

  const componente = parseVerificationCustomId(interaction.customId);

  if (componente === null) {
    return NextResponse.json(ephemeralResponse(verificationStaleText()));
  }

  const resultado = await handleVerificationClick({
    decision: componente.decision,
    token: componente.token,
    userId: interaction.userId,
  });

  return NextResponse.json(updateMessageResponse(resultado.text));
}
