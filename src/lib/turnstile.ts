import "server-only";

import { readRuntimeEnv } from "@/lib/runtime-env";
import { TURNSTILE_RESPONSE_FIELD } from "@/lib/turnstile-contract";

/**
 * Verificación del captcha de Cloudflare Turnstile para la inscripción pública de
 * `/participar`.
 *
 * Cierra el hueco que dejaba el límite de frecuencia: detrás de un proxy que
 * reenvía un `x-forwarded-for` puesto por el cliente, un atacante puede abrir un
 * cubo nuevo en cada envío. El captcha no se puede esquivar rotando una cabecera,
 * porque el token lo ha emitido Cloudflare para este sitio.
 *
 * Tres decisiones que sostienen el módulo:
 *
 * 1. **Se desactiva solo si no hay secret key.** Sin `TURNSTILE_SECRET_KEY` la
 *    comprobación devuelve `skipped: true, ok: true` y el formulario funciona
 *    exactamente igual que antes. Es el precio de que el proyecto arranque sin
 *    configurar nada (igual que el mock de la API o la sal de reserva del
 *    límite), y por eso el mismo motivo obliga a **definirla en producción**:
 *    sin ella el formulario público queda sin captcha.
 * 2. **Falla cerrado.** Solo hay dos salidas: Cloudflare dice que el token es
 *    válido, o no se acepta el envío. Un token vacío, una respuesta que no se
 *    sabe leer, un 5xx o un timeout devuelven todos `ok: false`. Abrir la puerta
 *    "por si el captcha está teniendo problemas" dejaría el formulario
 *    indefenso justo cuando se está cayendo, que es cuando más bot hay.
 * 3. **La razón se queda aquí.** `reason` es para el log del servidor y nunca
 *    vuelve al formulario, que solo recibe un mensaje sin detalles internos.
 *
 * `fetch` y `secret` son inyectables para poder verificar el módulo entero sin
 * salir a la red y sin tocar el entorno.
 */

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/**
 * Presupuesto de la comprobación.
 *
 * Cloudflare es rápido (es una verificación de un token ya emitido) y quien está
 * mirando el formulario solo tiene que esperar esta llamada, así que un tope
 * corto es lo correcto: si no llega a tiempo, sale el mensaje de reintentar
 * antes de que nadie piense que el formulario está roto.
 */
const DEFAULT_TIMEOUT_MS = 5_000;

export type TurnstileResult = {
  /** `true` solo si se ha verificado el token o si el captcha está desactivado. */
  ok: boolean;
  /** `true` = no hay secret key configurado, así que no se ha comprobado nada. */
  skipped: boolean;
  /** Motivo interno, solo para el log del servidor. Nunca va al formulario. */
  reason?: string;
};

export type VerifyTurnstileOptions = {
  /** IP del cliente, para que Cloudflare la asocie a la verificación. */
  ip?: string | null;
  /** `fetch` alternativo, para verificar sin red. */
  fetch?: typeof fetch;
  /** Presupuesto de la comprobación, en milisegundos. */
  timeoutMs?: number;
  /** Secret alternativo, para verificar sin tocar el entorno. */
  secret?: string;
};

function readSecret(explicit?: string): string {
  const raw = explicit ?? readRuntimeEnv("TURNSTILE_SECRET_KEY") ?? "";

  return raw.trim();
}

function readTimeoutMs(explicit?: number): number {
  if (explicit !== undefined && Number.isFinite(explicit) && explicit > 0) {
    return Math.floor(explicit);
  }

  const raw = readRuntimeEnv("TURNSTILE_TIMEOUT_MS")?.trim() ?? "";

  if (raw === "") {
    return DEFAULT_TIMEOUT_MS;
  }

  const value = Number(raw);

  if (!Number.isFinite(value) || value <= 0) {
    console.warn(
      `[turnstile] TURNSTILE_TIMEOUT_MS no es un número positivo (valor recibido: "${raw}"): ` +
        `se usa ${DEFAULT_TIMEOUT_MS}.`,
    );
    return DEFAULT_TIMEOUT_MS;
  }

  return Math.floor(value);
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** ¿Hay captcha activo? Es decir, ¿está definido el secret key? */
export function isTurnstileConfigured(): boolean {
  return readSecret() !== "";
}

/** Lee el token del `FormData`. Vacío y ausente son lo mismo: no hay token. */
export function readTurnstileToken(formData: FormData): string {
  return String(formData.get(TURNSTILE_RESPONSE_FIELD) ?? "").trim();
}

/** Forma de la respuesta de `siteverify`, en la parte que se comprueba aquí. */
type SiteVerifyPayload = {
  success?: unknown;
  "error-codes"?: unknown;
};

/**
 * Comprueba el token del captcha contra Cloudflare.
 *
 * Nunca lanza: cualquier fallo (red, timeout, respuesta rara) sale como
 * `ok: false`, porque la decisión de qué hacer con un captcha que no se ha podido
 * comprobar la toma quien llama y siempre es la misma: no dejar pasar el envío.
 */
export async function verifyTurnstile(
  token: string,
  options: VerifyTurnstileOptions = {},
): Promise<TurnstileResult> {
  const secret = readSecret(options.secret);

  if (secret === "") {
    return { ok: true, skipped: true, reason: "sin TURNSTILE_SECRET_KEY: captcha desactivado" };
  }

  const response = token.trim();

  if (response === "") {
    // Con el captcha activo, la ausencia de token no es un caso raro que se pueda
    // tratar como "no importa": es exactamente lo que mandaría un bot que no ha
    // resuelto el desafío, y no se va a la red a preguntar para enterarse.
    return { ok: false, skipped: false, reason: "el formulario no trae token" };
  }

  const doFetch = options.fetch ?? fetch;
  const body = new URLSearchParams({ secret, response });

  if (typeof options.ip === "string" && options.ip !== "") {
    body.set("remoteip", options.ip);
  }

  try {
    const result = await doFetch(VERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(readTimeoutMs(options.timeoutMs)),
    });

    if (!result.ok) {
      return { ok: false, skipped: false, reason: `siteverify respondió ${result.status}` };
    }

    const payload: SiteVerifyPayload | null = await result.json().catch(() => null);

    if (payload === null || typeof payload !== "object") {
      return { ok: false, skipped: false, reason: "siteverify devolvió algo que no se lee" };
    }

    if (payload.success !== true) {
      const codes = Array.isArray(payload["error-codes"])
        ? payload["error-codes"].filter((code): code is string => typeof code === "string")
        : [];

      return {
        ok: false,
        skipped: false,
        reason: codes.length > 0 ? `token rechazado (${codes.join(", ")})` : "token rechazado",
      };
    }

    return { ok: true, skipped: false };
  } catch (error) {
    // Red caída, timeout, respuesta que no es JSON. Todo cierra en falso, y el
    // motivo se queda en el log: el formulario no puede decir si Cloudflare está
    // falling ni qué le ha dicho.
    return { ok: false, skipped: false, reason: describe(error) };
  }
}
