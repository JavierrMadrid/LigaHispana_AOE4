/**
 * Único punto de salida HTTP hacia AoE4World.
 *
 * Toda la política vive aquí: timeout, cancelación, separación mínima entre
 * peticiones, *backoff* exponencial con jitter y respeto de las cabeceras de
 * rate limit que mande la API. Los endpoints de `client.ts` no llaman a `fetch`
 * directamente, así que no hay forma de saltarse estas reglas por accidente.
 *
 * Las respuestas de AoE4World (Cloudflare por delante) no siempre traen
 * `X-RateLimit-*`, así que la política es *best effort*: espaciamos por
 * defecto y reaccionamos a lo que llegue.
 */

import { isRecord } from "@/lib/json";
import { getAoe4WorldConfig, type Aoe4WorldConfig } from "./env";

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Techo de la espera que imposed la API, para no quedarnos colgados. */
const MAX_SERVER_WAIT_MS = 120_000;

export type Aoe4WorldClientStats = {
  requests: number;
  retries: number;
  rateLimitResponses: number;
  rateLimitPausesMs: number;
};

export type Aoe4WorldRequestOptions = {
  signal?: AbortSignal;
};

export class Aoe4WorldError extends Error {
  readonly status: number | null;
  readonly retryable: boolean;
  /** Espera que la propia API pidió (`Retry-After` o `X-RateLimit-Reset`). */
  readonly serverWaitMs: number | null;

  constructor(
    message: string,
    options: { status?: number | null; retryable?: boolean; serverWaitMs?: number | null } = {},
  ) {
    super(message);
    this.name = "Aoe4WorldError";
    this.status = options.status ?? null;
    this.retryable = options.retryable ?? false;
    this.serverWaitMs = options.serverWaitMs ?? null;
  }
}

export class Aoe4WorldNotFoundError extends Aoe4WorldError {
  constructor(path: string) {
    super(`AoE4World no conoce el recurso solicitado: ${path}`, { status: 404 });
    this.name = "Aoe4WorldNotFoundError";
  }
}

export class Aoe4WorldTimeoutError extends Aoe4WorldError {
  constructor(url: string, timeoutMs: number) {
    super(`AoE4World no respondió en ${url} tras ${timeoutMs} ms.`, { retryable: true });
    this.name = "Aoe4WorldTimeoutError";
  }
}

export class Aoe4WorldRateLimitError extends Aoe4WorldError {
  constructor(url: string) {
    super(
      `AoE4WorldApplyRateLimitError: se agotaron los reintentos pidiendo ${url}. Ralentiza el worker (AOE4WORLD_MIN_REQUEST_INTERVAL_MS).`,
      { status: 429, retryable: true },
    );
    this.name = "Aoe4WorldRateLimitError";
  }
}

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
 * Backoff exponencial con jitter: sin el jitter, varios jugadores que reciben
 * un 429 a la vez reintentarían en el mismo milisegundo y volverían a chocar
 * contra el límite.
 */
function computeBackoffMs(attempt: number, config: Aoe4WorldConfig): number {
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

/** `X-RateLimit-Reset` es un epoch en segundos que marca cuándo hay cupo. */
function parseRateLimitReset(value: string | null): number | null {
  if (value === null) {
    return null;
  }

  const epochSeconds = Number(value);

  if (!Number.isFinite(epochSeconds) || epochSeconds <= 0) {
    return null;
  }

  const waitMs = epochSeconds * 1000 - Date.now();

  return waitMs <= 0 ? 0 : Math.min(MAX_SERVER_WAIT_MS, Math.round(waitMs));
}

/** Cuánto hay que esperar por un 429, si la API da alguna pista. */
function readServerRequestedWait(headers: Headers): number | null {
  return (
    parseRetryAfter(headers.get("retry-after")) ?? parseRateLimitReset(headers.get("x-ratelimit-reset"))
  );
}

/** El token viaja en la query (así lo documenta la API), nunca en un log. */
function redactUrl(url: URL): string {
  const redacted = new URL(url.toString());
  redacted.searchParams.delete("api_key");

  return redacted.toString();
}

function readErrorDetail(text: string): string {
  const trimmed = text.trim();

  if (trimmed === "") {
    return "";
  }

  // La API devuelve el error en varios formatos; sacamos un resumen corto para
  // que el mensaje final sea legible sin depender de su esquema.
  try {
    const payload: unknown = JSON.parse(trimmed);

    if (isRecord(payload)) {
      const message = payload.message ?? payload.error ?? payload.detail;

      if (typeof message === "string" && message.trim() !== "") {
        return message.trim().slice(0, 200);
      }
    }
  } catch {
    // No es JSON: usamos el texto recortado.
  }

  return trimmed.slice(0, 200);
}

export type Aoe4WorldHttpClient = {
  fetchJson(
    path: string,
    searchParams?: URLSearchParams,
    options?: Aoe4WorldRequestOptions,
  ): Promise<unknown>;
  readonly stats: Aoe4WorldClientStats;
  /** Espera a que no quede ninguna petición en vuelo. */
  drain(): Promise<void>;
};

export function createAoe4WorldHttpClient(
  config: Aoe4WorldConfig = getAoe4WorldConfig(),
): Aoe4WorldHttpClient {
  const stats: Aoe4WorldClientStats = {
    requests: 0,
    retries: 0,
    rateLimitResponses: 0,
    rateLimitPausesMs: 0,
  };

  // El estado de la política vive en la instancia y no en el módulo: cada
  // ejecución del worker lleva su propio ritmo y sus propios contadores.
  let cooldownUntil = 0;
  let lastRequestAt = 0;
  let queue: Promise<void> = Promise.resolve();

  /**
   * Serializa las peticiones y las separa en el tiempo. Sin esto, sincronizar
   * varios jugadores a la vez dispararía un pico de peticiones casi idénticas.
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

    // La cadena no debe romperse si una espera lanza.
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

  /** Si una respuesta correcta dice que ya no queda cupo, esperamos a la.reset. */
  function rememberRateLimitHeaders(headers: Headers) {
    if (headers.get("x-ratelimit-remaining")?.trim() !== "0") {
      return;
    }

    const waitMs = parseRateLimitReset(headers.get("x-ratelimit-reset"));

    if (waitMs !== null && waitMs > 0) {
      pause(waitMs);
    }
  }

  async function performRequest(
    path: string,
    searchParams: URLSearchParams | undefined,
    options: Aoe4WorldRequestOptions | undefined,
  ): Promise<unknown> {
    const url = new URL(`${config.apiBase}/api/v0${path}`);

    if (searchParams) {
      for (const [key, value] of searchParams) {
        url.searchParams.append(key, value);
      }
    }

    if (config.apiKey !== null) {
      url.searchParams.set("api_key", config.apiKey);
    }

    const safeUrl = redactUrl(url);

    // Timeout propio en lugar de `AbortSignal.timeout` para poder distinguir
    // "tardó demasiado" de "el worker canceló", que son fallos distintos.
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
        // El worker pregunta por partidas nuevas en cada pasada: nunca queremos
        // que el framework le sirva una respuesta cacheada de la API.
        cache: "no-store",
      });

      rememberRateLimitHeaders(response.headers);

      if (response.status === 404) {
        throw new Aoe4WorldNotFoundError(path);
      }

      if (!response.ok) {
        const detail = readErrorDetail(await response.text());
        const serverWaitMs =
          response.status === 429 ? readServerRequestedWait(response.headers) : null;

        if (response.status === 429) {
          // Un 429 significa "has ido demasiado rápido", diga lo que diga el
          // reintento: hay que frenar al worker entero, no solo a esta petición.
          // Si no queda margen de reintento, sin esta pausa el siguiente
          // jugador volvería a chocar contra el límite un milisegundo después.
          stats.rateLimitResponses += 1;
          pause(serverWaitMs ?? config.retryBaseMs);
        }

        throw new Aoe4WorldError(
          `AoE4World respondió ${response.status} a ${safeUrl}${detail === "" ? "." : `: ${detail}`}`,
          { status: response.status, retryable: RETRYABLE_STATUS.has(response.status), serverWaitMs },
        );
      }

      return (await response.json()) as unknown;
    } catch (error) {
      if (error instanceof Aoe4WorldError) {
        throw error;
      }

      if (timedOut) {
        throw new Aoe4WorldTimeoutError(safeUrl, config.timeoutMs);
      }

      if (callerSignal?.aborted) {
        throw error;
      }

      // Fallo de red (DNS, TLS, conexión cortada): reintentable.
      throw new Aoe4WorldError(
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

  async function fetchJson(
    path: string,
    searchParams?: URLSearchParams,
    options?: Aoe4WorldRequestOptions,
  ): Promise<unknown> {
    // `path` nunca lleva secretos (la URL completa sí, por eso se redacta al
    // construir el mensaje de error), así que se puede citar tal cual.
    for (let attempt = 0; ; attempt += 1) {
      await acquireSlot();
      options?.signal?.throwIfAborted();

      try {
        return await performRequest(path, searchParams, options);
      } catch (error) {
        if (!(error instanceof Aoe4WorldError) || !error.retryable) {
          throw error;
        }

        if (attempt >= config.maxRetries) {
          if (error.status === 429) {
            throw new Aoe4WorldRateLimitError(path);
          }

          throw error;
        }

        // Si la API nos dice cuánto esperar, gana sobre nuestro backoff.
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
