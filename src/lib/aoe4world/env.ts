import "server-only";

/**
 * Configuración del cliente de AoE4World.
 *
 * Todo se lee de variables de entorno con valores por defecto razonables: el
 * proyecto debe funcionar sin configurar nada, pero las cifras que afectan al
 * ritmo de peticiones (intervalo mínimo, reintentos, tamaño de página) se
 * pueden ajustar por entorno para afinar el consumo de la API.
 *
 * La única excepción es `AOE4WORLD_MOCK`: no cambia ninguna cifra, solo decide
 * si las peticiones salen a la red o se resuelven con las fixtures locales de
 * `mock/`, y solo puede activarse fuera de producción.
 */

const DEFAULT_API_BASE = "https://aoe4world.com";
const DEFAULT_USER_AGENT = "LigaHispanaAOE4/0.1 (sync AoE4World)";

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];

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
  const raw = process.env[name];

  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }

  const value = Number(raw);

  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} debe ser un número mayor o igual que 0 (valor recibido: "${raw}").`);
  }

  return Math.floor(value);
}

function readString(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw !== undefined && raw.trim() !== "" ? raw.trim() : fallback;
}

function readBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];

  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }

  const value = raw.trim().toLowerCase();

  if (value === "1" || value === "true" || value === "yes" || value === "on") {
    return true;
  }

  if (value === "0" || value === "false" || value === "no" || value === "off") {
    return false;
  }

  throw new Error(
    `${name} debe ser un valor booleano (1/0, true/false, yes/no, on/off; valor recibido: "${raw}").`,
  );
}

export type Aoe4WorldConfig = {
  /** Base sin barra final, p. ej. `https://aoe4world.com`. */
  apiBase: string;
  /** Timeout por petición, en milisegundos. */
  timeoutMs: number;
  userAgent: string;
  /** Token opcional para partidas privadas. Nunca se escribe en los logs. */
  apiKey: string | null;
  /** Máximo de reintentos por petición (además del intento inicial). */
  maxRetries: number;
  /** Base del backoff exponencial, en milisegundos. */
  retryBaseMs: number;
  /** Techo del backoff, en milisegundos. */
  retryMaxMs: number;
  /** Separación mínima entre dos peticiones consecutivas, en milisegundos. */
  minRequestIntervalMs: number;
  /** Jugadores sincronizados a la vez. */
  syncConcurrency: number;
  /** Partidas por página en el histórico (la API no devuelve más de 50). */
  syncPageSize: number;
  /** Páginas máximas por sincronización (tope del histórico inicial). */
  syncMaxPages: number;
  /** Plazo global de una sincronización, en milisegundos. */
  syncDeadlineMs: number;
  /**
   * `true` si `AOE4WORLD_MOCK` está activo: las peticiones se resuelven con las
   * fixtures locales de `mock/` y no se sale a la red. Imposible en producción
   * (ver `getAoe4WorldConfig`).
   */
  mock: boolean;
};

export function getAoe4WorldConfig(): Aoe4WorldConfig {
  const apiKey = readString("AOE4WORLD_API_KEY", "");
  const mock = readBoolean("AOE4WORLD_MOCK", false);

  if (mock && process.env.NODE_ENV === "production") {
    throw new Error(
      'AOE4WORLD_MOCK está activo con NODE_ENV="production": el mock de AoE4World solo puede usarse fuera de producción. Desactiva AOE4WORLD_MOCK.',
    );
  }

  return {
    apiBase: readString("AOE4WORLD_API_BASE", DEFAULT_API_BASE).replace(/\/+$/, ""),
    timeoutMs: readPositiveInt("AOE4WORLD_TIMEOUT_MS", 15_000),
    userAgent: readString("AOE4WORLD_USER_AGENT", DEFAULT_USER_AGENT),
    apiKey: apiKey === "" ? null : apiKey,
    maxRetries: readNonNegativeInt("AOE4WORLD_MAX_RETRIES", 3),
    retryBaseMs: readPositiveInt("AOE4WORLD_RETRY_BASE_MS", 500),
    retryMaxMs: readPositiveInt("AOE4WORLD_RETRY_MAX_MS", 15_000),
    minRequestIntervalMs: readNonNegativeInt("AOE4WORLD_MIN_REQUEST_INTERVAL_MS", 300),
    syncConcurrency: readPositiveInt("AOE4WORLD_SYNC_CONCURRENCY", 3),
    syncPageSize: readPositiveInt("AOE4WORLD_SYNC_PAGE_SIZE", 50),
    syncMaxPages: readPositiveInt("AOE4WORLD_SYNC_MAX_PAGES", 10),
    syncDeadlineMs: readPositiveInt("AOE4WORLD_SYNC_DEADLINE_MS", 240_000),
    mock,
  };
}
