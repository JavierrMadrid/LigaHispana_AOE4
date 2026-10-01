import "server-only";

import { isRecord } from "@/lib/json";
import { getStreamsConfig, type StreamsConfig } from "./env";

/**
 * Único punto de salida HTTP hacia YouTube y Kick.
 *
 * Misma disciplina que `src/lib/aoe4world/http.ts` —timeout, separación mínima
 * entre peticiones, *backoff* exponencial con jitter, respeto de `Retry-After`— y
 * un módulo aparte por lo que dice el docblock de `env.ts`: son servicios
 * distintos, con claves distintas y límites distintos, y mezclarlos haría que el
 * ritmo de uno gobernara al otro.
 *
 * ## Dos diferencias con el cliente de AoE4World, y por qué
 *
 * 1. **La URL la construye quien llama**, no este módulo. Aquí no hay un prefijo
 *    común ni un `path` interno: YouTube es `…/youtube/v3/search` y Kick es
 *    `kick.com/api/v2/channels/<slug>`, y montar las dos con la misma firma
 *    obligaría a inventar un enrutado que no existe.
 * 2. **La clave se manda como parámetro de la petición, no en la URL del error.**
 *    La Data API de YouTube la espera en `key=`, así que viaja en la query como la
 *    de AoE4World, pero `redactUrl()` la borra antes de que un mensaje de error
 *    llegue a un log. Un `console.error` con la clave dentro acabaría en el log del
 *    Worker, que es un sitio donde un secreto se escapa.
 *
 * ## Timeout corto a propósito
 *
 * `STREAMS_TIMEOUT_MS` (5 s por defecto) es mucho más corto que el de AoE4World
 * porque esto corre **al final** de una pasada que ya ha hecho su trabajo: las
 * partidas están guardadas y la clasificación está recalculada. Esperar quince
 * segundos a una plataforma externa para poner un icono no compensa, y en el plan
 * Free de Cloudflare cada segundo de más es presupuesto de CPU de una invocación
 * que ya va justa. Pasado el timeout, el canal se queda en su estado anterior y el
 * motivo va al rastro.
 */

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Techo de la espera que el propio servicio impone, para no quedarnos colgados. */
const MAX_SERVER_WAIT_MS = 30_000;

export type StreamsClientStats = {
  requests: number;
  retries: number;
  rateLimitResponses: number;
  rateLimitPausesMs: number;
};

export type StreamsRequestOptions = {
  signal?: AbortSignal;
};

/**
 * Error de una petición a YouTube o Kick.
 *
 * `retryable` decide si `fetchJson()` reintenta; `fatal` marca los casos en los que
 * no tiene sentido seguir con **esa** plataforma en **esta** pasada (por ejemplo
 * `403` con "quotaExceeded", o un `404` que ya no va a cambiar), para que el
 * llamante pueda saltarse el resto de esa plataforma sin tragarse el error.
 */
export class StreamsError extends Error {
  readonly status: number | null;
  readonly retryable: boolean;
  /** `true` cuando no tiene sentido reintentar ni seguir con esta plataforma. */
  readonly fatal: boolean;
  readonly serverWaitMs: number | null;

  constructor(
    message: string,
    options: {
      status?: number | null;
      retryable?: boolean;
      fatal?: boolean;
      serverWaitMs?: number | null;
    } = {},
  ) {
    super(message);
    this.name = "StreamsError";
    this.status = options.status ?? null;
    this.retryable = options.retryable ?? false;
    this.fatal = options.fatal ?? false;
    this.serverWaitMs = options.serverWaitMs ?? null;
  }
}

export type StreamsHttpClient = {
  /** Hace la petición y devuelve el JSON ya leído, sin validar. */
  fetchJson(url: URL, options?: StreamsRequestOptions): Promise<unknown>;
  readonly stats: StreamsClientStats;
  /** Espera a que no quede ninguna petición en vuelo. */
  drain(): Promise<void>;
};

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Petición cancelada."));
    };

    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }

      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/**
 * *Backoff* exponencial con jitter.
 *
 * El jitter no es un detalle: sin él, dos canales que reciben un 429 a la vez
 * reintentarían en el mismo milisegundo y volverían a chocar contra el mismo
 * límite.
 */
function computeBackoffMs(attempt: number, config: StreamsConfig): number {
  const exponential = Math.min(config.retryMaxMs, config.retryBaseMs * 2 ** attempt);

  return Math.round(exponential * (0.5 + Math.random() * 0.5));
}

/** `Retry-After` admite segundos o una fecha HTTP. */
function parseRetryAfter(value: string | null): number | null {
  if (value === null) {
    return null;
  }

  const seconds = Number(value);

  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(MAX_SERVER_WAIT_MS, Math.round(seconds * 1000));
  }

  const timestamp = Date.parse(value);

  if (Number.isNaN(timestamp)) {
    return null;
  }

  return Math.min(MAX_SERVER_WAIT_MS, Math.max(0, timestamp - Date.now()));
}

/**
 * Quita la clave de la API de la URL antes de que aparezca en un mensaje.
 *
 * Es lo mismo que hace `redactUrl()` en el cliente de AoE4World y por el mismo
 * motivo: el mensaje de error acaba en `console.error`, y el log del Worker es un
 * sitio donde un secreto se escapa. `key` es el nombre que usa la Data API de
 * YouTube; `api_key` el de AoE4World, por si algún día alguien reutiliza el patrón.
 */
function redactUrl(url: URL): string {
  const redacted = new URL(url.toString());

  redacted.searchParams.delete("key");
  redacted.searchParams.delete("api_key");

  return redacted.toString();
}

/**
 * El detalle del fallo cuando el servicio lo explica en el cuerpo.
 *
 * Se entiende el formato de YouTube (`error.errors[]`, con el `reason` que decide si
 * reintentar tiene sentido), que es el único de los dos que **documenta** su error;
 * con el payload de Kick, que no tiene contrato, sale vacío y el mensaje se queda en
 * el código y el estado, que es lo único que de verdad sabemos.
 */
function readApiErrorDetail(value: unknown): { message: string; reason: string | null } {
  if (!isRecord(value)) {
    return { message: "", reason: null };
  }

  const error = value.error;

  if (!isRecord(error)) {
    return { message: "", reason: null };
  }

  const errors = Array.isArray(error.errors) ? error.errors.filter(isRecord) : [];
  const reason = typeof errors[0]?.reason === "string" ? errors[0].reason : null;
  const detail = typeof errors[0]?.message === "string" ? errors[0].message : "";
  const summary = typeof error.message === "string" ? error.message : "";

  return { message: `${summary}${detail === "" ? "" : ` (${detail})`}`.slice(0, 200), reason };
}

export function createStreamsHttpClient(
  config: StreamsConfig = getStreamsConfig(),
): StreamsHttpClient {
  const stats: StreamsClientStats = {
    requests: 0,
    retries: 0,
    rateLimitResponses: 0,
    rateLimitPausesMs: 0,
  };

  // El estado de la política vive en la instancia y no en el módulo: cada pasada
  // del worker lleva su propio ritmo y sus propios contadores.
  let cooldownUntil = 0;
  let lastRequestAt = 0;
  let queue: Promise<void> = Promise.resolve();

  /**
   * Serializa las peticiones y las separa en el tiempo. Sin esto, comprobar veinte
   * canales de golpe dispararía un pico de peticiones casi idénticas a dos servicios
   * que no perdonan los picos.
   */
  function acquireSlot(): Promise<void> {
    const granted = queue.then(async () => {
      const earliest = Math.max(cooldownUntil, lastRequestAt + config.minRequestIntervalMs);
      const waitMs = earliest - Date.now();

      if (waitMs > 0) {
        await sleep(waitMs);
      }

      lastRequestAt = Date.now();
    });

    queue = granted.catch(() => undefined);

    return granted;
  }

  function pause(ms: number) {
    if (ms <= 0) {
      return;
    }

    cooldownUntil = Math.max(cooldownUntil, Date.now() + ms);
    stats.rateLimitPausesMs += ms;
  }

  async function performRequest(url: URL, options: StreamsRequestOptions | undefined) {
    const safeUrl = redactUrl(url);

    // Timeout propio en lugar de `AbortSignal.timeout` para poder distinguir "tardó
    // demasiado" de "el worker canceló", que son fallos distintos.
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, config.timeoutMs);

    const callerSignal = options?.signal;
    const abortFromCaller = () => controller.abort(callerSignal?.reason);
    callerSignal?.addEventListener("abort", abortFromCaller, { once: true });

    stats.requests += 1;

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "User-Agent": config.userAgent,
        },
        signal: controller.signal,
        // Se pregunta por el estado de emisión de ahora mismo: una respuesta
        // cacheada por el runtime sería un "en directo" viejo, que es justo lo que
        // este módulo existe para no contar.
        cache: "no-store",
      });

      const serverWaitMs = parseRetryAfter(response.headers.get("retry-after"));

      // Un `429` es cuota agotada en las dos plataformas; un `403` lo es en YouTube
      // y en Kick suele ser "te he detectado", que tampoco mejora insistiendo. Los
      // dos frenan al cliente entero y no solo a esta petición, porque lo que viene
      // detrás es más de lo mismo.
      if (response.status === 429 || response.status === 403) {
        stats.rateLimitResponses += 1;
        pause(serverWaitMs ?? config.retryBaseMs);
      }

      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        const detail = readApiErrorDetail(payload);

        throw new StreamsError(
          `${url.hostname} respondió ${response.status} a ${safeUrl}${
            detail.message === "" ? "." : `: ${detail.message}`
          }`,
          {
            status: response.status,
            retryable: RETRYABLE_STATUS.has(response.status),
            // Un 4xx que no es de cuota (401, 403 por clave inválida, 404) no mejora
            // con un reintento ni con otro canal: se pierde la plataforma entera
            // en esta pasada en lugar de gastar el resto del presupuesto en
            // llamadas que van a fallar igual.
            fatal: !RETRYABLE_STATUS.has(response.status),
            serverWaitMs,
          },
        );
      }

      if (payload === null) {
        throw new StreamsError(`${url.hostname} devolvió algo que no es JSON (${safeUrl}).`, {
          retryable: true,
        });
      }

      return payload;
    } catch (error) {
      if (error instanceof StreamsError) {
        throw error;
      }

      if (timedOut) {
        throw new StreamsError(
          `${url.hostname} no respondió en ${safeUrl} tras ${config.timeoutMs} ms.`,
          { retryable: true },
        );
      }

      if (callerSignal?.aborted) {
        throw error;
      }

      // Fallo de red (DNS, TLS, conexión cortada): reintentable, y con un motivo que
      // no nombra la clave ni la URL completa.
      throw new StreamsError(
        `Fallo de red al pedir ${safeUrl}: ${
          error instanceof Error ? error.message : "causa desconocida"
        }`,
        { retryable: true },
      );
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", abortFromCaller);
    }
  }

  async function fetchJson(url: URL, options?: StreamsRequestOptions): Promise<unknown> {
    for (let attempt = 0; ; attempt += 1) {
      await acquireSlot();
      options?.signal?.throwIfAborted();

      try {
        return await performRequest(url, options);
      } catch (error) {
        if (!(error instanceof StreamsError) || !error.retryable) {
          throw error;
        }

        if (attempt >= config.maxRetries) {
          throw error;
        }

        // Si el servicio nos dice cuánto esperar, gana sobre nuestro *backoff*.
        const waitMs = Math.max(computeBackoffMs(attempt, config), error.serverWaitMs ?? 0);

        pause(waitMs);
        stats.retries += 1;

        await sleep(waitMs, options?.signal);
      }
    }
  }

  return {
    fetchJson,
    stats,
    drain: async () => {
      await queue;
    },
  };
}