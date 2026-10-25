/**
 * La frontera HTTP de las interacciones de Discord (issue 119).
 *
 * ## Qué hay aquí y qué no
 *
 * Esta pieza es la única del proyecto que recibe peticiones **de** Discord, y por
 * eso lo que hace es lo que no puede dejar de hacerse: comprobar que la petición la
 * firmó la aplicación, comprobar que es de ahora, leer el cuerpo y decir qué
 * interacción es. Nada de base de datos ni de decisiones de negocio: eso es
 * `verification-resolve.ts`, que sí conoce `Player`.
 *
 * ## La firma
 *
 * Discord firma `timestamp + cuerpo` con la clave privada Ed25519 de la aplicación
 * y manda la firma y el instante en dos cabeceras. La clave pública
 * (`DISCORD_PUBLIC_KEY`, 32 bytes en hexadecimal) está en el portal de Discord y no
 * es un secreto: lo que prueba es que **la aplicación** emitió la interacción, no
 * que quien la manda sea de confianza. La verificación se hace con WebCrypto y no
 * con una dependencia: `crypto.subtle` está en Node y en Cloudflare Workers, y
 * añadir un paquete para una sola llamada sería más superficie que ayuda.
 *
 * **El cuerpo se firma tal cual llega**, no un JSON reserializado: un cambio de
 * espacios o de orden de claves invalida la firma. Por eso el Route Handler lee
 * `request.text()` y le pasa ese mismo texto aquí; volver a montar el objeto y
 * serializarlo otra vez sería la forma más fácil de que el endpoint no validara
 * nunca.
 *
 * ## El instante
 *
 * Una firma válida de hace un año sigue siendo válida, así que se exige que el
 * `timestamp` esté dentro de **cinco minutos** del reloj del servidor: es la misma
 * ventana que documenta Discord y la que impide que una petición capturada se pueda
 * reenviar más tarde. El reloj se recibe por parámetro (`now`) para que el test no
 * dependa de la hora real.
 *
 * ## Por qué es puro
 *
 * No importa `server-only`, no lee variables de entorno y no hace red: recibe la
 * clave, las cabeceras y el cuerpo, y devuelve un veredicto. Eso es lo que permite
 * probarlo con un par de claves generado en el propio test.
 */

/* -------------------------------------------------------------------------- */
/* Constantes                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Cabecera con la firma Ed25519, en hexadecimal (64 bytes = 128 caracteres).
 *
 * El nombre va en minúsculas porque `Headers.get()` no distingue caja; la
 * comparación se hace con esa forma para no depender de cómo llegue.
 */
export const DISCORD_SIGNATURE_HEADER = "x-signature-ed25519";

/** Cabecera con el instante de la firma, en segundos desde la época (texto). */
export const DISCORD_TIMESTAMP_HEADER = "x-signature-timestamp";

/**
 * Margen admitido entre el `timestamp` de la firma y el reloj del servidor.
 *
 * Cinco minutos, el valor que documenta Discord. Más margen alarga la vida de una
 * petición capturada; menos empieza a rechazar peticiones legítimas con el reloj un
 * poco adelantado.
 */
export const DISCORD_TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

/** `type` de la interacción de comprobación que manda Discord al configurar la URL. */
export const DISCORD_INTERACTION_PING = 1;

/** `type` de una pulsación de botón (MESSAGE_COMPONENT). */
export const DISCORD_INTERACTION_MESSAGE_COMPONENT = 3;

/** `type` de la respuesta a un PING. */
export const DISCORD_RESPONSE_PONG = 1;

/** `type` de una respuesta que **edita** el mensaje del componente. */
export const DISCORD_RESPONSE_UPDATE_MESSAGE = 7;

/** `type` de una respuesta efímera (solo la ve quien pulsó). */
export const DISCORD_RESPONSE_CHANNEL_MESSAGE = 4;

/** Bit de `flags` que hace efímera una respuesta de tipo 4. */
export const DISCORD_MESSAGE_FLAG_EPHEMERAL = 64;

/* -------------------------------------------------------------------------- */
/* Firma                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Lo que se puede concluir de las dos cabeceras de firma.
 *
 * - `ok`: firma válida, reciente y de esta configuración.
 * - `missing`: falta alguna de las dos cabeceras. No es un intento de falsificar:
 *   es una petición que no viene de Discord.
 * - `malformed`: la clave, la firma o el instante no tienen la forma esperada.
 * - `stale`: la firma es (o puede ser) buena pero de fuera de la ventana.
 * - `invalid`: la firma no cuadra con el cuerpo y la clave.
 */
export type DiscordSignatureCheck = "ok" | "missing" | "malformed" | "stale" | "invalid";

/** Un hexadecimal de longitud par, sin espacios, o `null`. */
export function hexToBytes(hex: string): Uint8Array<ArrayBuffer> | null {
  const limpio = hex.trim();
  const patron = /^[0-9a-fA-F]+$/;

  if (limpio.length === 0 || limpio.length % 2 !== 0 || !patron.test(limpio)) {
    return null;
  }

  // Un `ArrayBuffer` explícito y no el que crea el constructor: WebCrypto exige
  // `BufferSource` sobre un `ArrayBuffer` (no un `SharedArrayBuffer`), y el tipo por
  // defecto de `Uint8Array` es `ArrayBufferLike`, que no vale para `subtle.verify`.
  const bytes = new Uint8Array(new ArrayBuffer(limpio.length / 2));

  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(limpio.slice(i * 2, i * 2 + 2), 16);
  }

  return bytes;
}

/** El instante de la cabecera, en segundos, o `null` si no es un entero. */
function readTimestampSeconds(raw: string): number | null {
  const texto = raw.trim();

  if (!/^-?\d+$/.test(texto)) {
    return null;
  }

  return Number.parseInt(texto, 10);
}

/**
 * Verifica una petición de Discord.
 *
 * El orden de las comprobaciones es el de coste y el de información: primero que
 * estén las cabeceras, después que se puedan leer, después que sean recientes y
 * solo entonces la firma (que es la única que hace criptografía). Una petición sin
 * firma no llega a importar la clave, y una firma vieja no gasta una verificación.
 *
 * La clave pública se espera en **hexadecimal de 32 bytes** (64 caracteres), que es
 * el formato del portal de Discord. Un valor de otra longitud sale como
 * `malformed`, que el endpoint traduce a `401`: con una clave mal configurada no se
 * puede verificar nada, y aceptar "por si acaso" sería justo lo contrario de lo que
 * este módulo existe para hacer.
 */
export async function verifyDiscordSignature(input: {
  publicKey: string;
  signature: string | null;
  timestamp: string | null;
  body: string;
  now: Date;
  toleranceSeconds?: number;
}): Promise<DiscordSignatureCheck> {
  if (input.signature === null || input.timestamp === null) {
    return "missing";
  }

  const keyBytes = hexToBytes(input.publicKey);
  const signatureBytes = hexToBytes(input.signature);
  const timestamp = readTimestampSeconds(input.timestamp);

  if (
    keyBytes === null ||
    keyBytes.length !== 32 ||
    signatureBytes === null ||
    signatureBytes.length !== 64 ||
    timestamp === null
  ) {
    return "malformed";
  }

  const tolerance = input.toleranceSeconds ?? DISCORD_TIMESTAMP_TOLERANCE_SECONDS;
  const ahoraSegundos = Math.floor(input.now.getTime() / 1000);

  if (Math.abs(ahoraSegundos - timestamp) > tolerance) {
    return "stale";
  }

  let key: CryptoKey;

  try {
    key = await crypto.subtle.importKey("raw", keyBytes, { name: "Ed25519" }, false, [
      "verify",
    ]);
  } catch {
    // Un runtime sin Ed25519 no puede verificar la firma, y no verificarla es
    // rechazarla. No se acepta la petición por no poder comprobarla.
    return "invalid";
  }

  const cuerpo = new TextEncoder().encode(`${input.timestamp}${input.body}`);

  try {
    const valida = await crypto.subtle.verify("Ed25519", key, signatureBytes, cuerpo);

    return valida ? "ok" : "invalid";
  } catch {
    return "invalid";
  }
}

/* -------------------------------------------------------------------------- */
/* Parseo                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Una interacción de Discord, ya reducida a lo que el endpoint necesita.
 *
 * `applicationId` va en las tres formas porque la comprobación de que la petición
 * es para **esta** aplicación se hace antes de decidir nada: una firma válida con
 * el `application_id` de otra aplicación no puede tocar nuestras filas, y el
 * `clientId` configurado es la única referencia que tenemos.
 */
export type DiscordInteraction =
  | { kind: "ping"; applicationId: string | null }
  | {
      kind: "component";
      applicationId: string | null;
      customId: string;
      /** `interaction.user.id`: en un DM el usuario va en `user`, no en `member`. */
      userId: string | null;
    }
  | { kind: "unsupported"; applicationId: string | null; type: number };

export type DiscordInteractionParseResult =
  | { ok: true; interaction: DiscordInteraction }
  | { ok: false; reason: "invalid-json" | "not-an-object" | "missing-type" };

function readString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Lee el cuerpo de una interacción.
 *
 * El JSON se lee **una sola vez** y sin `as`: cada campo se comprueba por su tipo y
 * lo que no encaja se devuelve como ausente. Un cuerpo que no es JSON, que no es un
 * objeto o que no trae un `type` numérico es `400` en el endpoint; un `type` que sí
 * es número pero que no manejamos (un modal, un comando) es `unsupported` y se
 * contesta con un mensaje genérico, que es lo que Discord espera para no reintentar
 * en bucle.
 */
export function parseDiscordInteraction(body: string): DiscordInteractionParseResult {
  let payload: unknown;

  try {
    payload = JSON.parse(body);
  } catch {
    return { ok: false, reason: "invalid-json" };
  }

  if (!isRecord(payload)) {
    return { ok: false, reason: "not-an-object" };
  }

  const type = payload["type"];

  if (typeof type !== "number") {
    return { ok: false, reason: "missing-type" };
  }

  const applicationId = readString(payload["application_id"]);

  if (type === DISCORD_INTERACTION_PING) {
    return { ok: true, interaction: { kind: "ping", applicationId } };
  }

  if (type === DISCORD_INTERACTION_MESSAGE_COMPONENT) {
    const data = isRecord(payload["data"]) ? payload["data"] : null;
    const user = isRecord(payload["user"]) ? payload["user"] : null;
    const member = isRecord(payload["member"]) ? payload["member"] : null;
    const memberUser = member !== null && isRecord(member["user"]) ? member["user"] : null;

    return {
      ok: true,
      interaction: {
        kind: "component",
        applicationId,
        customId: data === null ? "" : (readString(data["custom_id"]) ?? ""),
        // En un DM el usuario está en `user`; en un servidor, en `member.user`.
        // Se leen los dos porque el botón puede acabar en un canal de servidor si
        // alguien reenvía el privado, y entonces el id tiene que salir igualmente.
        userId:
          user !== null ? readString(user["id"]) : memberUser === null ? null : readString(memberUser["id"]),
      },
    };
  }

  return { ok: true, interaction: { kind: "unsupported", applicationId, type } };
}

/** `isRecord` local: este módulo no importa nada, ni siquiera `@/lib/json`. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/* -------------------------------------------------------------------------- */
/* Respuestas                                                                  */
/* -------------------------------------------------------------------------- */

/** La respuesta a un `PING`: Discord solo comprueba que se contesta `type: 1`. */
export function pongResponse(): { type: 1 } {
  return { type: DISCORD_RESPONSE_PONG };
}

/**
 * Edita el privado en el sitio y le quita los botones.
 *
 * Es lo que se manda al resolver una pulsación: la persona ve el resultado donde
 * pulsó y nadie puede volver a pulsar un botón que ya se gastó. `components: []`
 * no es cosmético: los componentes son lo que se puede volver a pulsar.
 */
export function updateMessageResponse(content: string): {
  type: 7;
  data: { content: string; components: [] };
} {
  return {
    type: DISCORD_RESPONSE_UPDATE_MESSAGE,
    data: { content, components: [] },
  };
}

/**
 * Una respuesta efímera, solo para quien pulsó.
 *
 * Se usa cuando el componente no es nuestro (`custom_id` desconocido): editar el
 * mensaje de otra aplicación sería tocar algo que no es de este torneo, y dejarlo
 * sin contestar hace que Discord muestre "la interacción ha fallado".
 */
export function ephemeralResponse(content: string): {
  type: 4;
  data: { content: string; flags: number };
} {
  return {
    type: DISCORD_RESPONSE_CHANNEL_MESSAGE,
    data: { content, flags: DISCORD_MESSAGE_FLAG_EPHEMERAL },
  };
}
