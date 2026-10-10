/**
 * Único punto de salida HTTP hacia AoE4World.
 *
 * Toda la política vive aquí: timeout, cancelación, separación mínima entre
 * peticiones, *backoff* exponencial con jitter y respeto de las cabeceras de
 * rate limit que mande la API. Los endpoints de `client.ts` no llaman a `fetch`
 * directamente, así que no hay forma de saltarse estas reglas por accidente.
 *
 * Es también el único punto en el que se puede salir a la red, así que es
 * también el interruptor del mock: con `AOE4WORLD_MOCK` activo (solo posible
 * fuera de producción, lo garantiza `env.ts`) las peticiones se resuelven con
 * las fixtures locales de `mock/` sin tocar `fetch`. Los contadores de `stats`
 * se siguen incrementando, para que el resumen del worker refleje el mismo
 * volumen de trabajo que reflejaría contra la API real.
 *
 * Las respuestas de AoE4World (Cloudflare por delante) no siempre traen
 * `X-RateLimit-*`, así que la política es *best effort*: espaciamos por
 * defecto y reaccionamos a lo que llegue.
 */

import { isRecord } from "@/lib/json";
import { getAoe4WorldConfig, type Aoe4WorldConfig } from "./env";
import { resolveMockAoe4WorldRequest } from "./mock";

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

/* -------------------------------------------------------------------------- */
/* Plazo y cancelación                                                         */
/* -------------------------------------------------------------------------- */

/** Lo que pasó al ejecutar una operación con plazo. */
export type DeadlineOutcome<T> =
  | { kind: "value"; value: T }
  | {
      /** La operación lanzó. El error va **tal cual**, sin interpretar. */
      kind: "failed";
      error: unknown;
      /** `true` si el plazo propio se agotó mientras corría. */
      timedOut: boolean;
      /** `true` si quien llamó canceló mientras corría. */
      cancelled: boolean;
    };

/**
 * Ejecuta `operation` con un plazo propio y, si el llamante pasa su señal, bajo su
 * cancelación.
 *
 * ## Por qué un helper y no un `AbortSignal.timeout`
 *
 * Porque "tardó demasiado" y "el worker canceló" son fallos distintos y este módulo
 * los reporta distinto: el primero es reintentable (`Aoe4WorldTimeoutError`) y el
 * segundo se propaga tal cual, sin marcarlo como avería de la API. Con
 * `AbortSignal.timeout` no hay forma de saber cuál de los dos abortó la señal.
 *
 * ## Por qué envuelve toda la operación
 *
 * No solo el `fetch`: el plazo cubre también la **lectura del cuerpo**, que es donde
 * una respuesta grande se queda colgada. Por eso el temporizador se limpia en el
 * `finally` de la `operation` completa y no al terminar la respuesta.
 *
 * ## Por qué **no** decide, y por eso devuelve el error sin interpretar
 *
 * Aquí es donde el error propio de la operación y el flag de plazo vencido llegan al
 * mismo sitio, y el orden en que se miran **no es un detalle**. Si el plazo ganara, un
 * `404` de AoE4World —que lanza `Aoe4WorldNotFoundError` y significa "el perfil no
 * existe"— se reintentaría como si fuera un problema de red, y el worker dejaría de
 * tratar ese jugador como perfil inexistente.
 *
 * El helper es genérico y **no puede decidir**: no sabe qué errores son del dominio de
 * quien llama. Lo que hace es devolver los tres hechos por separado —el error, si venció
 * el plazo y si se canceló— para que sea quien llama el que aplique **su** precedencia
 * (`error instanceof Aoe4WorldError` → plazo → cancelación → red), que es la que tenía
 * `performRequest()` antes de que este helper existiera.
 *
 * Se exporta porque hay una segunda llamada a AoE4World que no es de la API: el
 * sondeo de si un jugador tiene el historial de partidas abierto, que va al sitio
 * con un `HEAD` (`src/lib/history-visibility.ts`). Comparte el plazo y el
 * `User-Agent` con el cliente, y no vale la pena tener dos implementaciones de lo
 * mismo que solo se distinguen en dónde viven.
 */
export async function runWithDeadline<T>(
  timeoutMs: number,
  signal: AbortSignal | undefined,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<DeadlineOutcome<T>> {
  const controller = new AbortController();
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const abortFromCaller = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abortFromCaller, { once: true });

  try {
    return { kind: "value", value: await operation(controller.signal) };
  } catch (error) {
    // El error se devuelve **siempre**, también cuando además venció el plazo o se
    // canceló: son hechos que le importan a quien llama, no razones para tapar el
    // error. Interpretarlos es cosa de quien llama (ver el docblock).
    return { kind: "failed", error, timedOut, cancelled: signal?.aborted === true };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abortFromCaller);
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
    parseRetryAfter(headers.get("retry-after")) ??
    parseRateLimitReset(headers.get("x-ratelimit-reset"))
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
    // Interruptor del mock: se resuelve todo aquí, antes de montar la URL y el
    // timeout, pero contando la petición como cualquier otra para que el
    // resumen del worker siga siendo verosímil. `options` no se usa: sin red
    // no hay qué cancelar (la señal ya se ha comprobado en `fetchJson`).
    if (config.mock) {
      stats.requests += 1;

      const mocked = resolveMockAoe4WorldRequest(path, searchParams);

      if (mocked.kind === "not-found") {
        throw new Aoe4WorldNotFoundError(path);
      }

      return mocked.payload;
    }

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

    // `runWithDeadline` no sabe qué errores son de AoE4World, así que devuelve el
    // error tal cual y los dos hechos (plazo vencido, cancelación). El orden en que se
    // miran es de aquí, y es el que tenía antes de que existiera el helper: **el
    // error propio gana**, porque un `404` o un `429` explícitos de la API son más
    // precisos que "tardó demasiado" y se reintentan o no según lo que digan.
    const callerSignal = options?.signal;

    stats.requests += 1;

    const outcome = await runWithDeadline(config.timeoutMs, callerSignal, async (signal) => {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "User-Agent": config.userAgent,
        },
        signal,
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
          {
            status: response.status,
            retryable: RETRYABLE_STATUS.has(response.status),
            serverWaitMs,
          },
        );
      }

      return (await response.json()) as unknown;
    });

    if (outcome.kind === "value") {
      return outcome.value;
    }

    if (outcome.error instanceof Aoe4WorldError) {
      throw outcome.error;
    }

    if (outcome.timedOut) {
      throw new Aoe4WorldTimeoutError(safeUrl, config.timeoutMs);
    }

    if (outcome.cancelled) {
      throw outcome.error;
    }

    // Lo que llega aquí no es un error de AoE4World: fallo de red (DNS, TLS,
    // conexión cortada) o una respuesta que no se ha podido leer. Reintentable.
    throw new Aoe4WorldError(
      `Fallo de red al pedir ${safeUrl}: ${
        outcome.error instanceof Error ? outcome.error.message : "causa desconocida"
      }`,
      { retryable: true },
    );
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
