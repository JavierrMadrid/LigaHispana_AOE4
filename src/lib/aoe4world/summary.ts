import { isRecord } from "@/lib/json";
import { runWithDeadline } from "./http";
import { mockGameSummaryPayload } from "./mock/summary";
import {
  GILDED_VILLAGER_PBGID,
  MOUNTED_VILLAGER_PBGID,
  VILLAGER_PBGIDS,
  parseSummaryAnomalies,
  readInteger,
  type SummaryAnomalies,
} from "./summary-anomalies";

export {
  GILDED_VILLAGER_PBGID,
  MOUNTED_VILLAGER_PBGID,
  VILLAGER_PBGIDS,
} from "./summary-anomalies";

/**
 * El *summary* de una partida: lo que pasó dentro, no solo el resultado.
 *
 * ## Qué problema resuelve
 *
 * El listado de partidas de AoE4World dice quién ganó, con qué civilización y en
 * qué mapa, pero **no dice nada de lo que ocurrió dentro**: los APM, el minuto al
 * que cada jugador pasó de edad, o cuántos aldeanos perdió. Los objetivos
 * `ansioso`, los tres `avance-relampago-*` y `defensor-del-pueblo`
 * (`docs/OBJETIVOS.md`) se cobran justo con eso, y el único sitio donde está es el
 * endpoint de summary de cada partida.
 *
 * ## Por qué no es la API
 *
 * Porque vive en el **sitio**, no en `/api/v0`:
 *
 * ```
 * GET https://aoe4world.com/players/{profileId}/games/{gameId}/summary?camelize=true
 * ```
 *
 * Comprobado contra producción el 2026-10-17: con el `User-Agent` del proyecto
 * (que identifica el repositorio y el uso) responde 200 JSON. El sitio es estricto
 * con quién pregunta —la misma ruta de la partida sin `/summary` responde 429 a un
 * `curl/8.x` sin identificar y 403 a un `User-Agent` de navegador—, así que aquí se
 * manda el mismo identificador del cliente de la API, que es lo que la documentación
 * de AoE4World pide para las llamadas automáticas. De ahí que este módulo tenga su
 * **propia** llamada y no pase por `client.ts`: `http.ts` añade el prefijo `/api/v0`
 * y aquí no lo hay, y el mock de la API no cubre esta ruta (por eso la fixture de
 * `mock/summary.ts` se resuelve aquí, explícitamente).
 *
 * ## La forma del payload, y cómo se lee
 *
 * (Con `camelize=true`; el árbol real es el de la API, lo que cambia es el nombre
 * de las claves.)
 *
 * ```jsonc
 * {
 *   "gameId": 9123456,
 *   "duration": 2400,
 *   "players": [{
 *     "profileId": 21050396, "name": "…", "civilization": "english",
 *     "team": 1, "apm": 137, "result": "win",
 *     "actions": { "feudalAge": [215], "castleAge": [512], "imperialAge": [1180] },
 *     "buildOrder": [{ "id": "...", "pbgid": 129272, "type": "unit",
 *                      "finished": [120], "constructed": [110], "destroyed": [900] }],
 *     "resources": { "timestamps": [0, 20, …], "military": [13, 13, …],
 *                    "foodGathered": [0, 12, …], … }
 *   }]
 * }
 * ```
 *
 * **Las edades son listas de segundos y gana el primer instante**: un jugador
 * puede volver a pasar de edad tras perder el edificio, y lo que mide el objetivo
 * es cuándo llegó, así que se toma el mínimo.
 *
 * **Las pérdidas salen de `buildOrder`**, cruzando el `pbgid` de cada entrada con
 * los conjuntos de `PBR_*` de abajo. Ojo con `destroyed`: puede traer el mismo
 * instante repetido (un aldeano destruido dos veces en el mismo segundo), así que
 * el recuento es `array.length` y no un `Set`.
 *
 * **La evidencia de comportamiento sale de `buildOrder` y de `resources`** y la
 * lee `parseSummaryAnomalies()` (`summary-anomalies.ts`): no se guarda el payload,
 * sino los cuatro datos que el motor de alertas necesita.
 *
 * El payload se lee **sin `as`**, como el resto de la frontera de confianza
 * (`parse.ts`): un campo con la forma inesperada devuelve `null` y quien llama
 * decide. Un `null` aquí no significa "cero", significa "no lo sé": los títulos de
 * "hubo summary" y "no lo hubo" son distintos, y confundirlos contaría como
 * partida sin pérdidas una que nunca se llegó a leer.
 */

/* -------------------------------------------------------------------------- */
/* Constantes                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Los conjuntos de `pbgid` de los aldeanos viven en `summary-anomalies.ts` y se
 * re-exportan desde aquí: los usan el recuento de pérdidas de este módulo y el
 * lector de "creó aldeanos" del otro, y son el mismo dato. Ver el docblock de
 * allí para el criterio con el que se mantienen.
 */

/**
 * Tope de summaries pedidos por pasada del worker.
 *
 * Es un presupuesto y no una cifra de ritmo: cada summary es una petición al sitio
 * de AoE4World, así que la primera pasada —con todo el torneo sin métricas— tiene
 * que ir poco a poco igual que `HISTORY_CHECK_MAX_PER_RUN`. Diez por pasada, dos
 * segundos entre peticiones y un cron de diez minutos dan 1.440 summaries al día,
 * de sobra para el torneo vivo y con el histórico rellenándose por detrás.
 *
 * Es el valor por defecto: el worker pasa el suyo (`AOE4WORLD_SUMMARY_MAX_PER_RUN`,
 * ver `env.ts`), que es lo que permite bajarlo sin desplegar.
 */
export const SUMMARY_MAX_PER_RUN = 10;

/**
 * Cuánto se espera antes de reintentar una partida **sin respuesta concluyente**.
 *
 * Un `failure` (timeout, 5xx, red, 429) no escribe métricas, así que su partida
 * sigue pendiente; lo que sí escribe es `summaryLastAttemptAt`, y sin este margen
 * volvería a ser la primera de la cola en la pasada siguiente, gastando el
 * presupuesto entero en la misma partida. Una hora es de sobra para que un bache de
 * AoE4World haya pasado: el resumen de una partida no mejora por preguntarlo dos
 * veces seguidas.
 */
export const SUMMARY_RETRY_DELAY_HOURS = 1;
export const SUMMARY_RETRY_DELAY_MS = SUMMARY_RETRY_DELAY_HOURS * 3_600_000;

/**
 * Hasta cuándo se intenta una partida sin respuesta concluyente, en horas.
 *
 * Pasado este plazo la partida **no se vuelve a intentar nunca**: la API ya no
 * publica el summary de un juego tan viejo (o no lo publicará nunca), y dejar la
 * puerta abierta llenaría la cola —que va de la más nueva a la más vieja— de
 * partidas irresolubles. Es el mismo criterio que la regla "abandonada" del
 * sincronizador: lo que la API no publica a tiempo no cuenta.
 *
 * Lo aplica la **consulta** de `sync-summaries.ts` (basta con acotar el conjunto) y
 * no el planificador puro, porque es un filtro de la base y no una regla de orden.
 * Lo que quedó fuera sin resolverse no se pierde: es lo que cuenta
 * `SUMMARY_NOT_REVIEWED` y avisa a quien tiene que mirarlo.
 */
export const SUMMARY_RETRY_WINDOW_HOURS = 24;

/** Un `gameId` que no sea un entero daría un 404 que se leería como "no hay". */
const NUMERIC_GAME_ID = /^\d+$/;

/** Techo de la espera que pide la API, el mismo que aplica `http.ts`. */
const MAX_SERVER_WAIT_MS = 120_000;

/** `Retry-After`: segundos o una fecha HTTP. */
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

/** `X-RateLimit-Reset`: epoch en segundos que marca cuándo hay cupo. */
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

/** Cuánto hay que esperar por un 429, si la respuesta da alguna pista. */
function readServerRequestedWait(headers: Headers): number | null {
  return (
    parseRetryAfter(headers.get("retry-after")) ??
    parseRateLimitReset(headers.get("x-ratelimit-reset"))
  );
}

/* -------------------------------------------------------------------------- */
/* Lectura del payload                                                         */
/* -------------------------------------------------------------------------- */

/**
 * El **primer** instante de una lista de marcas, en segundos.
 *
 * `null` si no es una lista o si no trae ningún número: "no llegó a esa edad" y
 * "no lo sé" comparten valor, y para los objetivos da igual —lo que se cobra es
 * haber llegado pronto, y sin marca no se ha llegado pronto—.
 */
function earliestSeconds(value: unknown): number | null {
  if (!Array.isArray(value)) {
    return null;
  }

  let earliest: number | null = null;

  for (const entry of value) {
    const seconds = readInteger(entry);

    if (seconds !== null && (earliest === null || seconds < earliest)) {
      earliest = seconds;
    }
  }

  return earliest;
}

/** Las pérdidas por unidad, de las entradas de `buildOrder`. */
type LossCounts = {
  villagers: number;
  gildedVillagers: number;
  mountedVillagers: number;
};

/**
 * Cruza `buildOrder` con los conjuntos de `pbgid` y cuenta lo destruido.
 *
 * `destroyed` trae un instante por unidad destruida y **puede repetir**: el
 * recuento es la longitud de la lista. Una entrada sin `destroyed` (una unidad que
 * sobrevivió) cuenta cero, y una lista que no sea lista también: lo que no se ha
 * destruido es lo normal, y una entrada ilegible en ese campo no puede contar como
 * una pérdida que no se sabe.
 */
function countLostUnits(entry: Record<string, unknown>): LossCounts {
  const counts: LossCounts = { villagers: 0, gildedVillagers: 0, mountedVillagers: 0 };
  const pbgid = readInteger(entry["pbgid"]);
  const destroyed = entry["destroyed"];

  if (pbgid === null || !Array.isArray(destroyed) || destroyed.length === 0) {
    return counts;
  }

  if (pbgid === GILDED_VILLAGER_PBGID) {
    counts.gildedVillagers = destroyed.length;
  } else if (pbgid === MOUNTED_VILLAGER_PBGID) {
    counts.mountedVillagers = destroyed.length;
  } else if (VILLAGER_PBGIDS.has(pbgid)) {
    counts.villagers = destroyed.length;
  }

  return counts;
}

/** Las métricas de una partida que el motor de objetivos necesita. */
export type GameSummaryMetrics = {
  /**
   * Acciones por minuto del jugador. **Es la marca de "hubo summary"**: el resto
   * de campos puede faltar legítimamente (no se llegó al feudal, no se perdió
   * ningún aldeano), así que el motor decide "esta partida tiene summary" por
   * `apm !== null` y no por "alguna columna tiene valor".
   */
  apm: number | null;
  feudalAgeSeconds: number | null;
  castleAgeSeconds: number | null;
  imperialAgeSeconds: number | null;
  /** Aldeanos perdidos; `null` si el `buildOrder` no se pudo leer. */
  villagersLost: number | null;
  gildedVillagersLost: number | null;
  mountedVillagersLost: number | null;
};

/**
 * El summary de **un** jugador dentro de la partida. `null` si el payload no dice
 * nada utilizable (no es un objeto, no trae `players` o no aparece ese jugador).
 */
export function parseGameSummary(value: unknown, profileId: number): GameSummaryMetrics | null {
  if (!isRecord(value) || !Array.isArray(value.players)) {
    return null;
  }

  const entry = value.players.find(
    (candidate) => isRecord(candidate) && readInteger(candidate.profileId) === profileId,
  );

  if (entry === undefined || !isRecord(entry)) {
    return null;
  }

  const actions = isRecord(entry.actions) ? entry.actions : null;

  // `buildOrder` ausente deja los tres recuentos a `null` (no a cero): una partida
  // cuyo interior no se ha podido leer no puede pasar por "no perdió aldeanos".
  const buildOrder = Array.isArray(entry.buildOrder) ? entry.buildOrder : null;
  const totals: LossCounts = { villagers: 0, gildedVillagers: 0, mountedVillagers: 0 };

  if (buildOrder !== null) {
    for (const item of buildOrder) {
      if (!isRecord(item)) {
        continue;
      }

      const lost = countLostUnits(item);
      totals.villagers += lost.villagers;
      totals.gildedVillagers += lost.gildedVillagers;
      totals.mountedVillagers += lost.mountedVillagers;
    }
  }

  return {
    apm: readInteger(entry.apm),
    feudalAgeSeconds: earliestSeconds(actions?.feudalAge),
    castleAgeSeconds: earliestSeconds(actions?.castleAge),
    imperialAgeSeconds: earliestSeconds(actions?.imperialAge),
    villagersLost: buildOrder === null ? null : totals.villagers,
    gildedVillagersLost: buildOrder === null ? null : totals.gildedVillagers,
    mountedVillagersLost: buildOrder === null ? null : totals.mountedVillagers,
  };
}

/* -------------------------------------------------------------------------- */
/* La llamada                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * La URL del summary de una partida.
 *
 * `camelize=true` no es un adorno: sin él las claves salen en `snake_case` y el
 * lector de arriba no encontraría nada. El `profileId` va entero (la ruta del
 * sitio admite sufijos tras el prefijo numérico, pero aquí no hay nada que
 * añadir).
 */
export function gameSummaryUrl(apiBase: string, profileId: number, gameId: string): string {
  return `${apiBase.replace(/\/+$/, "")}/players/${profileId}/games/${gameId}/summary?camelize=true`;
}

export type SummaryFetchOptions = {
  /** Base del sitio; la misma que usa el cliente de la API (`AOE4WORLD_API_BASE`). */
  apiBase: string;
  /** `User-Agent` del cliente; el sitio lo exige (un UA de navegador da 429). */
  userAgent: string;
  /** Plazo por petición, el del cliente. */
  timeoutMs: number;
  /** Plazo global de la pasada del worker. */
  signal?: AbortSignal;
  /** `fetch` inyectable, para comprobarlo con una respuesta falsa. */
  fetch?: typeof globalThis.fetch;
  /** `true` con `AOE4WORLD_MOCK`: se sirve la fixture local y no se sale a la red. */
  mock?: boolean;
};

/**
 * Qué se ha podido sacar de pedir el summary de una partida.
 *
 * - `summary`: se ha leído. Es el único desenlace que escribe métricas, y trae
 *   también la evidencia de comportamiento (`anomalies`), que puede ser `null` si el
 *   payload no se pudo leer para anomalías aunque las métricas sí.
 * - `none`: la partida **no tiene** summary (un 404 del sitio). Es una respuesta
 *   válida y concluyente: se apunta que se comprobó y no se vuelve a preguntar.
 * - `failure`: no se ha podido saber (timeout, 5xx, red, una respuesta que no se
 *   entiende). **No se escriben métricas**, pero sí el intento: la partida vuelve a
 *   la cola pasada la hora.
 *
 * `throttled` distingue el 429 del resto de fallos: no es un bache, es la API
 * pidiendo que paremos, así que el worker **corta la pasada** en vez de seguir con
 * la siguiente partida. `retryAfterMs` es lo que la propia API pidió esperar
 * (`Retry-After` o `X-RateLimit-Reset`), con el mismo techo de 120 s que `http.ts`,
 * y `null` si no lo dijo.
 */
export type SummaryOutcome =
  | { kind: "summary"; metrics: GameSummaryMetrics; anomalies: SummaryAnomalies | null }
  | { kind: "none"; reason: string | null }
  | { kind: "failure"; reason: string; throttled: boolean; retryAfterMs: number | null };

/**
 * Pide el summary de **una** partida y lo lee. **Nunca lanza.**
 *
 * El reparto de desenlaces es el de `probeGameSummary()` de `history-visibility.ts`,
 * y por el mismo motivo: un 5xx no puede convertirse en "esta partida no tiene
 * summary" ni en métricas inventadas. Lo que no se sabe se queda en `failure` y no
 * escribe nada, así que la partida vuelve a la cola en la siguiente pasada.
 */
export async function fetchGameSummary(
  profileId: number,
  gameId: string,
  options: SummaryFetchOptions,
): Promise<SummaryOutcome> {
  if (!NUMERIC_GAME_ID.test(gameId)) {
    return {
      kind: "failure",
      reason: `gameId "${gameId}" no es un entero: no se pregunta nada`,
      throttled: false,
      retryAfterMs: null,
    };
  }

  // El mock se resuelve aquí y no en `http.ts` porque esta ruta no pasa por el
  // cliente de la API (ver el docblock del módulo). La fixture saca las métricas de
  // la misma forma que la API, así que el lector se ejercita de verdad.
  if (options.mock === true) {
    const payload = mockGameSummaryPayload(profileId, gameId);
    const metrics = parseGameSummary(payload, profileId);

    return metrics === null
      ? {
          kind: "failure",
          reason: "el mock del summary no ha dado un payload legible",
          throttled: false,
          retryAfterMs: null,
        }
      : {
          kind: "summary",
          metrics,
          anomalies: parseSummaryAnomalies(payload, profileId),
        };
  }

  const url = gameSummaryUrl(options.apiBase, profileId, gameId);
  const doFetch = options.fetch ?? globalThis.fetch;

  try {
    const outcome = await runWithDeadline(options.timeoutMs, options.signal, async (signal) => {
      const response = await doFetch(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          // El sitio responde 429 a un UA de navegador ("not suitable for bots"):
          // manda el mismo identificador del cliente.
          "User-Agent": options.userAgent,
        },
        signal,
        cache: "no-store",
      });

      if (!response.ok) {
        return {
          status: response.status,
          payload: null as unknown,
          // Solo el 429 trae una pista de espera; se lee antes de descartar la
          // respuesta porque las cabeceras se van con ella.
          retryAfterMs: response.status === 429 ? readServerRequestedWait(response.headers) : null,
        };
      }

      return { status: response.status, payload: await response.json(), retryAfterMs: null };
    });

    if (outcome.kind === "failed") {
      const reason = outcome.timedOut
        ? `AoE4World no respondió a ${url} en ${options.timeoutMs} ms`
        : outcome.cancelled
          ? `cancelado antes de responder ${url}`
          : `fallo al pedir ${url}: ${
              outcome.error instanceof Error ? outcome.error.message : String(outcome.error)
            }`;

      return { kind: "failure", reason, throttled: false, retryAfterMs: null };
    }

    const { status, payload, retryAfterMs } = outcome.value;

    // Un 404 es la respuesta del sitio para "esta partida no tiene summary": es
    // concluyente y se apunta como `none`.
    if (status === 404) {
      return { kind: "none", reason: null };
    }

    // Un 429 no es un bache: es "has ido demasiado rápido". Se devuelve como fallo
    // marcado para que quien llama corte la pasada en vez de seguir pidiendo.
    if (status === 429) {
      return {
        kind: "failure",
        reason: `AoE4World pidió bajar el ritmo (429) a ${url}`,
        throttled: true,
        retryAfterMs,
      };
    }

    if (status !== 200) {
      return {
        kind: "failure",
        reason: `AoE4World respondió ${status} a ${url}`,
        throttled: false,
        retryAfterMs: null,
      };
    }

    const metrics = parseGameSummary(payload, profileId);

    // Un 200 que no se entiende es un `failure`, no un `none`: no se sabe si la
    // partida tiene summary o no.
    return metrics === null
      ? {
          kind: "failure",
          reason: `la respuesta de ${url} no se ha podido leer`,
          throttled: false,
          retryAfterMs: null,
        }
      : { kind: "summary", metrics, anomalies: parseSummaryAnomalies(payload, profileId) };
  } catch (error) {
    return {
      kind: "failure",
      reason: `fallo al leer ${url}: ${error instanceof Error ? error.message : String(error)}`,
      throttled: false,
      retryAfterMs: null,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Qué partidas toca pedir                                                     */
/* -------------------------------------------------------------------------- */

/** Una partida candidata a pedirle el summary. */
export type SummaryBackfillCandidate = {
  gameId: string;
  /** `Player.id` del dueño de la fila. */
  playerId: string;
  /** `Player.profileId` del dueño de la fila, que es con quien se pide. */
  profileId: number;
  /** Cuándo terminó; es el orden de la cola. */
  finishedAt: Date;
  /** `true` si ya hubo una respuesta **concluyente** (200 o 404) alguna vez. */
  summaryCheckedAt: Date | null;
  /** Última vez que se pidió, con cualquier desenlace; `null` = nunca. */
  summaryLastAttemptAt: Date | null;
};

export type SummaryBackfillPlanOptions = {
  now: Date;
  /** Cuántas como mucho; por defecto `SUMMARY_MAX_PER_RUN`. */
  budget?: number;
  /** Margen de reintento; por defecto `SUMMARY_RETRY_DELAY_MS`. */
  retryDelayMs?: number;
};

/**
 * Qué summaries pide esta pasada, **de la partida más nueva a la más vieja**.
 *
 * ## El orden
 *
 * De más nueva a más vieja, y el desempate es `gameId` (comparado como **cadena**,
 * que es como se guarda) y luego `playerId`, para que la cola no dependa del
 * planificador: dos participantes en la misma partida comparten `finishedAt`.
 *
 * Lo nuevo primero porque es lo que el torneo está viviendo: el summary de la
 * partida de ayer puntúa un objetivo de hoy, y el de una del primer día solo
 * rellena la tabla. La "cola de relleno" —el histórico que aún no se ha pedido— no
 * es una lista aparte: es lo que queda al final de este mismo orden, y va llegando
 * una pasada detrás de otra.
 *
 * ## Cuándo se reintenta
 *
 * Lo concluyente (`summaryCheckedAt !== null`: hubo summary o el sitio dijo que no
 * lo tiene) **nunca** vuelve a la cola. Lo demás se reintenta si han pasado
 * `retryDelayMs` desde su último intento (`summaryLastAttemptAt`); una partida
 * nunca intentada entra siempre.
 *
 * El margen se mide sobre el **intento** y no sobre la respuesta concluyente: un
 * fallo ya dejó su `summaryLastAttemptAt` escrito, así que su partida no vuelve a
 * ser la primera de la cola en la pasada siguiente y no se lleva el presupuesto
 * entero. Antes del margen lo que no se sabía no se escribía y la fila volvía
 * inmediatamente; ahora lo que se sabe es **cuándo se intentó**.
 *
 * Lo que **no** hace: filtrar por `finishedAt` reciente. Eso es un acotado de la
 * consulta (la ventana de revisión) y no una regla de orden; aquí una fila que
 * llegue es una fila que se puede pedir.
 */
export function planSummaryBackfill(
  candidates: readonly SummaryBackfillCandidate[],
  options: SummaryBackfillPlanOptions,
): SummaryBackfillCandidate[] {
  const budget = options.budget ?? SUMMARY_MAX_PER_RUN;
  const retryDelayMs = options.retryDelayMs ?? SUMMARY_RETRY_DELAY_MS;
  const nowMs = options.now.getTime();

  return [...candidates]
    .filter((candidate) => {
      // Una respuesta concluyente saca la partida de la cola para siempre.
      if (candidate.summaryCheckedAt !== null) {
        return false;
      }

      if (candidate.summaryLastAttemptAt === null) {
        return true;
      }

      return nowMs - candidate.summaryLastAttemptAt.getTime() >= retryDelayMs;
    })
    .sort(
      (a, b) =>
        b.finishedAt.getTime() - a.finishedAt.getTime() ||
        (a.gameId < b.gameId ? -1 : a.gameId > b.gameId ? 1 : 0) ||
        (a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0),
    )
    .slice(0, budget);
}
