/**
 * Pool de mapas del objetivo `por-tierra-y-agua`.
 *
 * La lista es **configuración** y vive en `Setting["scoring.mapPool"]`, que es lo
 * que lee el motor de objetivos. Desde que el worker lo refresca, esa clave la
 * escribe la sincronización a partir del **pool activo de AoE4World** (ver
 * `src/lib/aoe4world/map-pool.ts`), una vez al día; la organización puede seguir
 * reescribiéndola a mano. Aquí está el valor por defecto, que es el que se aplica
 * mientras la clave no exista o no sea válida.
 *
 * Los nombres tienen que ser **exactamente** los que publica AoE4World en
 * `Match.map` (`"Dry Arabia"`, con mayúsculas y espacios), porque el cruce es por
 * igualdad de texto: un nombre mal escrito deja el mapa fuera del objetivo sin que
 * nada avise.
 *
 * Este módulo es puro (no toca la base ni `server-only`): lo leen el motor de
 * objetivos, la capa de `Setting` y el parser del homepage de AoE4World.
 */

import { isRecord } from "@/lib/json";

/** Clave de `Setting` donde vive el pool activo. */
export const MAP_POOL_KEY = "scoring.mapPool";

/**
 * Clave de `Setting` con la contabilidad del refresco: cuándo se escribió el pool y
 * qué metadatos publicó AoE4World (`startedAt`, `nextRefresh`). Va aparte de
 * `scoring.mapPool` porque el motor espera una **lista de textos** y no un objeto,
 * y porque así el último valor bueno sobrevive a un fallo del parseo sin ambigüedad.
 */
export const MAP_POOL_SYNC_KEY = "scoring.mapPoolSync";

/**
 * Los 9 mapas del pool de la Season 14, tal cual los publica AoE4World. Es el
 * respaldo: se usa cuando la clave `scoring.mapPool` no existe o no es legible, y
 * el worker lo reemplaza por el pool que lea del homepage de AoE4World.
 */
export const DEFAULT_MAP_POOL: readonly string[] = [
  "Atacama",
  "Baltic",
  "Dry Arabia",
  "Flankwoods",
  "Golden Heights",
  "Himeyama",
  "King of the Hill",
  "Lipany",
  "The Pit",
];

/**
 * Normaliza el valor guardado en `Setting` a una lista de mapas utilizable.
 *
 * Nunca lanza: un valor que no es una lista de textos no vacíos se descarta y se
 * usa `DEFAULT_MAP_POOL`, igual que hace `parseWindow` con la ventana, para que una
 * edición a mano defectuosa no deje `por-tierra-y-agua` sin pool (ni, peor, con un
 * pool vacío, que lo daría por cumplido a todo el mundo). Se recortan los espacios
 * y se quitan duplicados conservando el orden; una lista vacía cae al valor por
 * defecto por el mismo motivo.
 */
export function parseMapPool(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [...DEFAULT_MAP_POOL];
  }

  const seen = new Set<string>();
  const pool: string[] = [];

  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }

    const name = item.trim();

    if (name === "" || seen.has(name)) {
      continue;
    }

    seen.add(name);
    pool.push(name);
  }

  return pool.length === 0 ? [...DEFAULT_MAP_POOL] : pool;
}

/* -------------------------------------------------------------------------- */
/* Contabilidad del refresco                                                    */
/* -------------------------------------------------------------------------- */

/** Cada cuánto se vuelve a pedir el pool a AoE4World. Rota una vez al mes. */
export const MAP_POOL_REFRESH_INTERVAL_HOURS = 24;

/** El mismo intervalo en milisegundos, que es como se compara con un `Date`. */
export const MAP_POOL_REFRESH_INTERVAL_MS = MAP_POOL_REFRESH_INTERVAL_HOURS * 3_600_000;

/** Lo que el worker guarda en `Setting["scoring.mapPoolSync"]` al refrescar. */
export type MapPoolSyncState = {
  /** Cuándo se escribió este pool (ISO). */
  fetchedAt: string;
  /** `startedAt` de la rotación en curso que publica AoE4World, si llegó. */
  startedAt: string | null;
  /** `nextRefresh` de la rotación en curso que publica AoE4World, si llegó. */
  nextRefresh: string | null;
  /** Los mapas que se guardaron, en el orden de AoE4World. */
  maps: string[];
};

function readOptionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * Lee la contabilidad del refresco.
 *
 * Devuelve `null` si falta cualquier cosa que haga falta para decidir: sin
 * `fetchedAt` legible no se puede saber si toca refrescar, y sin una lista de mapas
 * no hay nada que conservar. Un `null` hace que el refresco toque, que es el lado
 * seguro.
 */
export function parseMapPoolSync(value: unknown): MapPoolSyncState | null {
  if (!isRecord(value)) {
    return null;
  }

  const fetchedAt = readOptionalText(value["fetchedAt"]);

  if (fetchedAt === null || Number.isNaN(Date.parse(fetchedAt))) {
    return null;
  }

  const rawMaps = value["maps"];

  if (!Array.isArray(rawMaps) || rawMaps.length === 0) {
    return null;
  }

  const maps: string[] = [];

  for (const item of rawMaps) {
    if (typeof item !== "string" || item.trim() === "") {
      return null;
    }

    maps.push(item.trim());
  }

  return {
    fetchedAt,
    startedAt: readOptionalText(value["startedAt"]),
    nextRefresh: readOptionalText(value["nextRefresh"]),
    maps,
  };
}

/**
 * ¿Toca volver a pedir el pool a AoE4World?
 *
 * Sí cuando no hay contabilidad, cuando no se puede leer o cuando el último refresco
 * es más viejo que `MAP_POOL_REFRESH_INTERVAL_HOURS`. La rotación es mensual, así que
 * una cadencia diaria detecta el cambio de temporada con holgura sin castigar al
 * sitio con una petición por pasada (el worker corre cada 5 minutos).
 */
export function mapPoolRefreshDue(
  state: MapPoolSyncState | null,
  now: Date,
  intervalMs: number = MAP_POOL_REFRESH_INTERVAL_MS,
): boolean {
  if (state === null) {
    return true;
  }

  const fetched = Date.parse(state.fetchedAt);

  if (Number.isNaN(fetched)) {
    return true;
  }

  return now.getTime() - fetched >= intervalMs;
}
