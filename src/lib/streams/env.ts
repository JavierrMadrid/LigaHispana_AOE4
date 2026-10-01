import "server-only";

import { readRuntimeEnv } from "@/lib/runtime-env";

/**
 * Configuración de la detección de directos en YouTube y Kick.
 *
 * Es un módulo propio y no una ampliación de `aoe4world/env.ts` por dos motivos
 * que no son de gusto sino de arquitectura:
 *
 * - **Son APIs distintas, con su propia autenticación y sus propios límites.** La
 *   de YouTube es la Data API v3, con clave de cuota diaria; la de Kick no tiene
 *   API pública ni clave (ver `kick.ts`). Meterlas en el cliente de AoE4World
 *   haría que su ritmo, sus reintentos y su presupuesto de peticiones fueran los de
 *   otra API, y un 429 de cualquiera de las dos frenaría a las tres.
 * - **La credencial es de otra plataforma.** `AOE4WORLD_API_KEY` no debe poder
 *   valer para YouTube ni al revés, y un error de configuración tiene que poder
 *   decir qué variable falta y en qué servicio.
 *
 * Todas las lecturas van por `readRuntimeEnv` (bindings de Cloudflare y
 * `process.env`), nunca con `process.env` directo: en el Worker el binding es lo
 * único fiable (ver `src/lib/runtime-env.ts`).
 *
 * ## La degradación por defecto
 *
 * **Sin `YOUTUBE_API_KEY` la detección de YouTube no se hace**, y el estado se
 * queda en `false` con un aviso en el rastro de la pasada. Es el mismo espíritu que
 * el captcha (`src/lib/turnstile.ts`): el proyecto tiene que arrancar y funcionar
 * sin configurar nada nuevo, y una funcionalidad que depende de una credencial se
 * apaga sola en lugar de romper lo que ya funciona. Kick, en cambio, **no necesita
 * nada**: si el endpoint no responde, el estado se queda en `false` y sale un aviso.
 */

const DEFAULT_YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3";
const DEFAULT_KICK_API_BASE = "https://kick.com";
const DEFAULT_TIMEOUT_MS = 5_000;

export type StreamsConfig = {
  /** Clave de la Data API de YouTube; `null` = no hay detección de YouTube. */
  youtubeApiKey: string | null;
  /** Base de la Data API de YouTube, sin barra final. */
  youtubeApiBase: string;
  /** Base del sitio de Kick, sin barra final. */
  kickApiBase: string;
  /** Timeout por petición, en milisegundos. Corto a propósito: ver `http.ts`. */
  timeoutMs: number;
  userAgent: string;
  /** Máximo de reintentos por petición, además del intento inicial. */
  maxRetries: number;
  /** Base del *backoff* exponencial con jitter, en milisegundos. */
  retryBaseMs: number;
  /** Techo del *backoff*, en milisegundos. */
  retryMaxMs: number;
  /**
   * Separación mínima entre dos peticiones consecutive, en milisegundos.
   *
   * Va por petición y no solo por pasada porque son **dos** servicios: YouTube
   * tiene cuota diaria y Kick no, pero un pico de peticiones a cualquiera de los dos
   * es justo lo que provoca un bloqueo. Con el tope de comprobaciones por pasada de
   * `maxChecksPerRun` y este intervalo, la cadencia real queda acotada y conocida.
   */
  minRequestIntervalMs: number;
  /**
   * Tope de comprobaciones por pasada.
   *
   * Es el presupuesto duro: una comprobación es preguntarle a una plataforma por
   * un canal, con lo que el máximo es `2 × participantes con canal`. El tope está
   * para que un torneo con muchos canales no convierta la detección de directos en
   * la parte cara de la pasada, que es lo que manda en el plan Free de Cloudflare
   * (ver README, "El límite de CPU del plan Free"). Los que se quedan fuera salen
   * en el resumen como `skipped`, nunca como un error.
   */
  maxChecksPerRun: number;
};

function readString(name: string, fallback: string): string {
  const raw = readRuntimeEnv(name);

  return raw !== undefined && raw.trim() !== "" ? raw.trim() : fallback;
}

function readPositiveInt(name: string, fallback: number): number {
  const raw = readRuntimeEnv(name);

  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }

  const value = Number(raw);

  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} debe ser un número positivo (valor recibido: "${raw}").`);
  }

  return Math.floor(value);
}

function readNonNegativeInt(name: string, fallback: number): number {
  const raw = readRuntimeEnv(name);

  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }

  const value = Number(raw);

  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} debe ser un número mayor o igual que 0 (valor recibido: "${raw}").`);
  }

  return Math.floor(value);
}

export function getStreamsConfig(): StreamsConfig {
  const apiKey = readString("YOUTUBE_API_KEY", "");

  return {
    youtubeApiKey: apiKey === "" ? null : apiKey,
    youtubeApiBase: readString("YOUTUBE_API_BASE", DEFAULT_YOUTUBE_API_BASE).replace(/\/+$/, ""),
    kickApiBase: readString("KICK_API_BASE", DEFAULT_KICK_API_BASE).replace(/\/+$/, ""),
    timeoutMs: readPositiveInt("STREAMS_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
    userAgent: readString("STREAMS_USER_AGENT", "LigaHispanaAOE4/0.1 (streams YouTube/Kick)"),
    maxRetries: readNonNegativeInt("STREAMS_MAX_RETRIES", 2),
    retryBaseMs: readPositiveInt("STREAMS_RETRY_BASE_MS", 400),
    retryMaxMs: readPositiveInt("STREAMS_RETRY_MAX_MS", 8_000),
    minRequestIntervalMs: readNonNegativeInt("STREAMS_MIN_REQUEST_INTERVAL_MS", 200),
    // 24 comprobaciones = 12 participantes con las dos plataformas. El torneo tiene
    // decenas de participantes y casi ninguno con canal en las dos, así que el tope
    // solo muerde cuando la lista crece de verdad, y es configurable.
    maxChecksPerRun: readPositiveInt("STREAMS_MAX_CHECKS_PER_RUN", 24),
  };
}

/** ¿Hay detección de YouTube configurada? Sin clave, no se pregunta nada. */
export function isYoutubeConfigured(config: StreamsConfig = getStreamsConfig()): boolean {
  return config.youtubeApiKey !== null;
}