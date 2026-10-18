import { isRecord } from "@/lib/json";
import { runWithDeadline } from "./http";
import { mockGameSummaryPayload } from "./mock/summary";

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
 * (`LigaHispanaAOE4/0.1 (sync AoE4World)`) responde 200 JSON. El sitio es estricto
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
 *                      "finished": [120], "constructed": [110], "destroyed": [900] }]
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
 * Los `pbgid` de cada unidad que cuenta como aldeano, y por qué son conjuntos.
 *
 * Un `pbgid` identifica una **variación** concreta (una civilización, una mejora
 * o una variante de DLC), no un tipo genérico: el aldeano de la liga tiene 22, y
 * los de las dos civilizaciones con aldeano propio son uno más cada uno. La lista
 * está contrastada contra `github.com/aoe4world/data` (`units/unified/*.json`,
 * campo `variations[].pbgid`). Un DLC que añada una civilización con aldeano
 * nuevo dejará su id fuera hasta que se actualice esta lista, y eso solo puede
 * **infravalorar** las pérdidas: ningún id de aquí es de otra unidad.
 */
export const VILLAGER_PBGIDS: ReadonlySet<number> = new Set([
  129272, 132227, 133491, 134753, 136078, 137283, 166425, 199747, 2046469, 2359463, 2803786,
  3729183, 3989658, 5000017, 5000197, 5786526, 6094899, 7287301, 7761185, 7788969, 9001047,
  9003964,
]);

/** El aldeano dorado: aldeano propio de su civilización, que se cuenta aparte. */
export const GILDED_VILLAGER_PBGID = 2513732;

/** El aldeano montado, de la civilización nómada, que se cuenta aparte. */
export const MOUNTED_VILLAGER_PBGID = 9004039;

/**
 * Tope de summaries pedidos por pasada del worker.
 *
 * Es un presupuesto y no una cifra de ritmo: cada summary es una petición al sitio
 * de AoE4World, así que la primera pasada —con todo el torneo sin métricas— tiene
 * que ir poco a poco igual que `HISTORY_CHECK_MAX_PER_RUN`. Veinte por pasada y un
 * cron de diez minutos dan 2.880 summaries al día, de sobra para el torneo vivo y
 * con el histórico rellenándose por detrás.
 */
export const SUMMARY_MAX_PER_RUN = 20;

/**
 * Cuánto se espera antes de reintentar una partida **sin métricas**.
 *
 * Un `failure` (timeout, 5xx, red) no escribe nada, así que su partida sigue
 * siendo candidata; sin este margen volvería a ser la primera de la cola en la
 * pasada siguiente, gastando el presupuesto entero en la misma partida. Una hora
 * es de sobra para que un bache de AoE4World haya pasado: el resumen de una
 * partida no mejora por preguntarlo dos veces seguidas.
 */
export const SUMMARY_RETRY_DELAY_HOURS = 1;
export const SUMMARY_RETRY_DELAY_MS = SUMMARY_RETRY_DELAY_HOURS * 3_600_000;

/**
 * Hasta cuándo se reintenta una partida sin métricas, en horas.
 *
 * Pasado este plazo la partida **no se vuelve a intentar nunca**: la API ya no
 * publica el summary de un juego tan viejo (o no lo publicará nunca), y dejar la
 * puerta abierta llenaría la cola —que va de la más nueva a la más vieja— de
 * partidas irresolubles. Es el mismo criterio que la regla "abandonada" del
 * sincronizador: lo que la API no publica a tiempo no cuenta.
 *
 * Lo aplica la **consulta** de `sync-summaries.ts` (basta con acotar el conjunto) y
 * no el planificador puro, porque es un filtro de la base y no una regla de orden.
 */
export const SUMMARY_RETRY_WINDOW_HOURS = 24;

/** Un `gameId` que no sea un entero daría un 404 que se leería como "no hay". */
const NUMERIC_GAME_ID = /^\d+$/;

/* -------------------------------------------------------------------------- */
/* Lectura del payload                                                         */
/* -------------------------------------------------------------------------- */

function readInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && Number.isInteger(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);

    return Number.isInteger(parsed) ? parsed : null;
  }

  return null;
}

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
 * - `summary`: se ha leído. Es el único desenlace que escribe métricas.
 * - `none`: la partida **no tiene** summary (un 404 del sitio). Es una respuesta
 *   válida y concluyente: se apunta que se comprobó y no se vuelve a preguntar.
 * - `failure`: no se ha podido saber (timeout, 5xx, red, una respuesta que no se
 *   entiende). **No se escribe nada**: ni métricas ni la marca de comprobado.
 */
export type SummaryOutcome =
  | { kind: "summary"; metrics: GameSummaryMetrics }
  | { kind: "none"; reason: string | null }
  | { kind: "failure"; reason: string };

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
    };
  }

  // El mock se resuelve aquí y no en `http.ts` porque esta ruta no pasa por el
  // cliente de la API (ver el docblock del módulo). La fixture saca las métricas de
  // la misma forma que la API, así que el lector se ejercita de verdad.
  if (options.mock === true) {
    const metrics = parseGameSummary(mockGameSummaryPayload(profileId, gameId), profileId);

    return metrics === null
      ? { kind: "failure", reason: "el mock del summary no ha dado un payload legible" }
      : { kind: "summary", metrics };
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
        return { status: response.status, payload: null as unknown };
      }

      return { status: response.status, payload: await response.json() };
    });

    if (outcome.kind === "failed") {
      const reason = outcome.timedOut
        ? `AoE4World no respondió a ${url} en ${options.timeoutMs} ms`
        : outcome.cancelled
          ? `cancelado antes de responder ${url}`
          : `fallo al pedir ${url}: ${
              outcome.error instanceof Error ? outcome.error.message : String(outcome.error)
            }`;

      return { kind: "failure", reason };
    }

    const { status, payload } = outcome.value;

    // Un 404 es la respuesta del sitio para "esta partida no tiene summary": es
    // concluyente y se apunta como `none`.
    if (status === 404) {
      return { kind: "none", reason: null };
    }

    if (status !== 200) {
      return { kind: "failure", reason: `AoE4World respondió ${status} a ${url}` };
    }

    const metrics = parseGameSummary(payload, profileId);

    // Un 200 que no se entiende es un `failure`, no un `none`: no se sabe si la
    // partida tiene summary o no.
    return metrics === null
      ? { kind: "failure", reason: `la respuesta de ${url} no se ha podido leer` }
      : { kind: "summary", metrics };
  } catch (error) {
    return {
      kind: "failure",
      reason: `fallo al leer ${url}: ${error instanceof Error ? error.message : String(error)}`,
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
  /** Última vez que se intentó; `null` = nunca. */
  summaryCheckedAt: Date | null;
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
 * Solo se reintenta —es decir, una fila ya intentada solo vuelve a la cola— si han
 * pasado `retryDelayMs` desde su último intento. Un `failure` no escribe nada, así
 * que su partida seguiría siendo la primera de la cola y se llevaría el
 * presupuesto entero: el margen es lo que deja pasar al resto.
 *
 * Lo que **no** hace: filtrar por `finishedAt` reciente. Eso es un acotado de la
 * consulta (ver `SUMMARY_RETRY_WINDOW_HOURS`) y no una regla de orden; aqui una
 * fila que llegue es una fila que se puede pedir.
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
      if (candidate.summaryCheckedAt === null) {
        return true;
      }

      return nowMs - candidate.summaryCheckedAt.getTime() >= retryDelayMs;
    })
    .sort(
      (a, b) =>
        b.finishedAt.getTime() - a.finishedAt.getTime() ||
        (a.gameId < b.gameId ? -1 : a.gameId > b.gameId ? 1 : 0) ||
        (a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0),
    )
    .slice(0, budget);
}
