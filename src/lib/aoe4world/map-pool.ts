import "server-only";

import { getAoe4WorldConfig, type Aoe4WorldConfig } from "@/lib/aoe4world/env";
import { runWithDeadline } from "@/lib/aoe4world/http";
import { isRecord } from "@/lib/json";
import { readMapPoolSync, writeMapPool } from "@/lib/settings";
import {
  DEFAULT_MAP_POOL,
  mapPoolRefreshDue,
  type MapPoolSyncState,
} from "@/lib/map-pool";

/**
 * El pool de mapas activo de AoE4World, del homepage y no de la API.
 *
 * ## Por qué del homepage
 *
 * La API pública (`/api/v0/...`) **no expone el pool**: `/stats/rm_solo/maps` es el
 * catálogo de mapas con estadísticas, no la rotación en curso. El pool vive en el
 * estado inicial que la web incrusta en su portada, sin autenticación ni JavaScript:
 * un elemento `<home-leaderboard :initial-state="{...}">` con el JSON **escapado
 * como HTML** (`&quot;`), y dentro `initialState["rm_solo"].mappool.maps[]`, cada
 * item `{ id, name, imageUrl }`. El objeto `mappool` trae además `startedAt` y
 * `nextRefresh` (la rotación es mensual).
 *
 * ## Parseo frágil, a propósito contenido
 *
 * Esto depende del HTML de otra web y puede cambiar sin avisar. Por eso el parseo
 * vive aparte, es una función pura (`parseMapPoolHomepage`) y **nunca lanza**: si el
 * elemento, el atributo o el JSON no están, devuelve `null`, y quien llama conserva
 * el último pool bueno que haya en `Setting`. Un `null` aquí **no** vacía el pool ni
 * deja el motor sin mapas.
 *
 * ## Dónde se usa y cada cuánto
 *
 * `refreshMapPool()` lo llama el worker de sincronización antes del recálculo, y
 * solo cuando el último refresco tiene más de `MAP_POOL_REFRESH_INTERVAL_HOURS`
 * (24 h, ver `src/lib/map-pool.ts`): la rotación es mensual y el worker corre cada
 * 5 minutos, así que una petición al día sobra. Con `AOE4WORLD_MOCK` activo no se
 * sale a la red (igual que el sondeo del historial): no hay fixture para el
 * homepage y preguntar por el sitio real desde una simulación no tiene sentido.
 */

/* -------------------------------------------------------------------------- */
/* Parseo del HTML (puro)                                                       */
/* -------------------------------------------------------------------------- */

/** El pool tal como lo publica AoE4World para `rm_solo`. */
export type Aoe4WorldMapPool = {
  /** Nombres de mapa, en el orden de AoE4World. */
  maps: string[];
  /** Inicio de la rotación en curso (ISO), si el JSON lo trae. */
  startedAt: string | null;
  /** Próxima rotación (ISO), si el JSON lo trae. */
  nextRefresh: string | null;
};

const LEADERBOARD_TAG = "<home-leaderboard";
const INITIAL_STATE_ATTR = ":initial-state=";

/**
 * Las cinco entidades que puede meter el escapado de HTML del atributo.
 *
 * El orden importa: `&amp;` se decodifica **el último**, o un `&amp;quot;` literal
 * (un `&quot;` dentro de un nombre de mapa) se convertiría en una comilla de más y
 * rompería el JSON. El resto de entidades no las produce el escapado de atributos,
 * pero se resuelven por si el nombre de un mapa las trae.
 */
function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&#x0*27;/gi, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** El valor del atributo `:initial-state` del `<home-leaderboard>`, sin desescapar. */
function extractInitialState(html: string): string | null {
  const tagIndex = html.indexOf(LEADERBOARD_TAG);

  if (tagIndex === -1) {
    return null;
  }

  const attrIndex = html.indexOf(INITIAL_STATE_ATTR, tagIndex);

  if (attrIndex === -1) {
    return null;
  }

  const valueStart = attrIndex + INITIAL_STATE_ATTR.length;
  const quote = html[valueStart];

  if (quote !== '"' && quote !== "'") {
    return null;
  }

  // El JSON va escapado, así que no contiene la comilla de cierre en crudo: la
  // primera comilla igual a la de apertura cierra el atributo.
  const valueEnd = html.indexOf(quote, valueStart + 1);

  if (valueEnd === -1) {
    return null;
  }

  return html.slice(valueStart + 1, valueEnd);
}

function readOptionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * Convierte el HTML del homepage en el pool de `rm_solo`, o `null` si no se puede.
 *
 * **Puro y sin red**: el `fetch` y el parseo del JSON viven en `refreshMapPool()`.
 * No lanza nunca —devuelve `null`, que quien llama interpreta como "no toques
 * nada"—, ni siquiera con un HTML mutilado: `JSON.parse` va envuelto.
 *
 * Se acepta cualquier item de `maps` que tenga un `name` no vacío y se ignoran los
 * que no (un item futuro con otra forma no rompe la lista entera). Si no queda
 * ninguno, `null`: un pool vacío daría `por-tierra-y-agua` por cumplido a todo el
 * mundo, que es peor que no actualizar.
 */
export function parseMapPoolHomepage(html: string): Aoe4WorldMapPool | null {
  const attribute = extractInitialState(html);

  if (attribute === null) {
    return null;
  }

  let state: unknown;

  try {
    state = JSON.parse(decodeHtmlEntities(attribute));
  } catch {
    return null;
  }

  if (!isRecord(state)) {
    return null;
  }

  const rmSolo = state["rm_solo"];

  if (!isRecord(rmSolo)) {
    return null;
  }

  const mappool = rmSolo["mappool"];

  if (!isRecord(mappool)) {
    return null;
  }

  const rawMaps = mappool["maps"];

  if (!Array.isArray(rawMaps)) {
    return null;
  }

  const maps: string[] = [];

  for (const item of rawMaps) {
    if (!isRecord(item)) {
      continue;
    }

    const name = item["name"];

    if (typeof name !== "string" || name.trim() === "") {
      continue;
    }

    maps.push(name.trim());
  }

  if (maps.length === 0) {
    return null;
  }

  return {
    maps,
    startedAt: readOptionalText(mappool["startedAt"]),
    nextRefresh: readOptionalText(mappool["nextRefresh"]),
  };
}

/* -------------------------------------------------------------------------- */
/* La llamada al sitio                                                          */
/* -------------------------------------------------------------------------- */

export type MapPoolFetchResult =
  | { kind: "ok"; pool: Aoe4WorldMapPool }
  /** No se ha intentado: mock activo. No es un fallo. */
  | { kind: "skipped"; warning: string }
  /** Se ha intentado y no ha salido: red, HTTP o formato. */
  | { kind: "failed"; warning: string };

export type MapPoolFetchOptions = {
  config?: Aoe4WorldConfig;
  signal?: AbortSignal;
  /** `fetch` inyectable, para comprobarlo con una respuesta falsa en los tests. */
  fetch?: typeof globalThis.fetch;
};

/**
 * Pide el homepage y extrae el pool. **Nunca lanza.**
 *
 * Usa el mismo plazo y `User-Agent` que el resto del cliente de AoE4World
 * (`runWithDeadline`, `Aoe4WorldConfig`), pero va directo a `apiBase + "/"` y no por
 * el cliente de la API, que solo sabe hablar JSON en `/api/v0`. La petición es una
 * al día, así que no entra en la cola de rate limit del worker ni la necesita.
 *
 * Un `404`, un `5xx` o un cuerpo sin el elemento son "no ha salido": se devuelve el
 * motivo y quien llama deja `Setting` como estaba.
 */
export async function fetchMapPoolFromHomepage(
  options: MapPoolFetchOptions = {},
): Promise<MapPoolFetchResult> {
  const config = options.config ?? getAoe4WorldConfig();

  if (config.mock) {
    return {
      kind: "skipped",
      warning:
        "AOE4WORLD_MOCK está activo: el pool de mapas no se lee del sitio y se conserva el último valor",
    };
  }

  const url = `${config.apiBase}/`;
  const doFetch = options.fetch ?? globalThis.fetch;

  const outcome = await runWithDeadline(config.timeoutMs, options.signal, async (signal) => {
    const response = await doFetch(url, {
      method: "GET",
      // Es una página, no la API: no pedimos JSON. El `User-Agent` es el mismo de
      // siempre porque el sitio es del mismo dueño y un Worker no se disfraza.
      headers: { Accept: "text/html", "User-Agent": config.userAgent },
      signal,
      // Una portada cacheada sería un pool de ayer: justo lo que este refresco no
      // quiere guardar como si fuera de ahora.
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error(`el homepage respondió ${response.status}`);
    }

    return await response.text();
  });

  if (outcome.kind === "failed") {
    const warning = outcome.timedOut
      ? `el homepage de AoE4World no respondió en ${config.timeoutMs} ms`
      : outcome.cancelled
        ? "cancelado antes de leer el homepage de AoE4World"
        : `fallo al pedir el homepage de AoE4World: ${
            outcome.error instanceof Error ? outcome.error.message : String(outcome.error)
          }`;

    return { kind: "failed", warning };
  }

  const pool = parseMapPoolHomepage(outcome.value);

  if (pool === null) {
    return {
      kind: "failed",
      warning:
        "el homepage de AoE4World no trae un pool de mapas legible (¿ha cambiado el formato?)",
    };
  }

  return { kind: "ok", pool };
}

/* -------------------------------------------------------------------------- */
/* Refresco con persistencia                                                    */
/* -------------------------------------------------------------------------- */

export type MapPoolRefreshStatus = "updated" | "skipped" | "failed";

export type MapPoolRefreshResult = {
  status: MapPoolRefreshStatus;
  /** Mapas vigentes al terminar: los nuevos o los que ya había. */
  mapCount: number;
  /** Por qué no se actualizó (mock, plazo no vencido o fallo); `null` si se hizo. */
  warning: string | null;
};

export type MapPoolRefreshOptions = MapPoolFetchOptions & {
  /** Reloj inyectable: el mismo que usa el worker para decidir el plazo. */
  now?: Date;
};

/**
 * Refresca `Setting["scoring.mapPool"]` desde AoE4World, si toca.
 *
 * Es el único punto que **escribe** el pool. Reglas:
 *
 * - **Como mucho una vez al día** (`mapPoolRefreshDue`): el pool rota una vez al
 *   mes y el worker corre cada 5 minutos.
 * - Con el mock activo **no sale a la red** y no es un fallo (`skipped`).
 * - Un fallo de red, HTTP o formato devuelve `failed` y **no toca `Setting`**: el
 *   motor sigue leyendo el último pool bueno (o el de por defecto si nunca se
 *   guardó). Este módulo es el que materializa el "un parseo roto no rompe el motor".
 * - Al guardar, `scoring.mapPool` (lo que lee el motor) y `scoring.mapPoolSync` (la
 *   contabilidad) se escriben en la misma transacción: nunca queda el pool nuevo con
 *   la fecha vieja ni al revés.
 *
 * Quien llama (el worker) lo trata como un paso tolerante: un `failed` va al rastro
 * y **no** mueve `lastSuccessAt`, porque no se refresque el pool no ha parado ni una
 * partida.
 */
export async function refreshMapPool(
  options: MapPoolRefreshOptions = {},
): Promise<MapPoolRefreshResult> {
  const now = options.now ?? new Date();
  const previous = await readMapPoolSync();
  const currentCount = previous?.maps.length ?? DEFAULT_MAP_POOL.length;

  if (!mapPoolRefreshDue(previous, now)) {
    return { status: "skipped", mapCount: currentCount, warning: null };
  }

  const fetched = await fetchMapPoolFromHomepage(options);

  if (fetched.kind === "skipped") {
    return { status: "skipped", mapCount: currentCount, warning: fetched.warning };
  }

  if (fetched.kind === "failed") {
    return { status: "failed", mapCount: currentCount, warning: fetched.warning };
  }

  const state: MapPoolSyncState = {
    fetchedAt: now.toISOString(),
    startedAt: fetched.pool.startedAt,
    nextRefresh: fetched.pool.nextRefresh,
    maps: fetched.pool.maps,
  };

  await writeMapPool(state);

  return { status: "updated", mapCount: state.maps.length, warning: null };
}
