import { isRecord } from "@/lib/json";

/**
 * Lo que el *summary* de una partida dice de **cómo se jugó**, no de lo que se
 * logró.
 *
 * ## Qué problema resuelve
 *
 * `parseGameSummary()` (`summary.ts`) saca las métricas que cobran los objetivos:
 * APM, edades y aldeanos perdidos. Detectar un comportamiento sospechoso necesita
 * otra cosa: cuándo se creó el **primer aldeano**, cuánto tiempo estuvo la
 * puntuación militar sin subir y cuánto tiempo pasó la economía sin recolectar
 * nada. Son series temporales que vienen en el mismo payload del summary
 * (`resources.timestamps` y sus series paralelas) y que no se guardan enteras: lo
 * que se guarda es la **evidencia compacta** (`Match.summaryAnomalies`), que es lo
 * único que el motor de alertas necesita.
 *
 * ## Módulo puro, y por qué no puede tocar lo de al lado
 *
 * No importa `server-only`, ni `summary.ts` (que arrastra el cliente HTTP y la
 * fixture del mock) ni `env.ts`: lo usan el lector del payload y el motor puro de
 * alertas, que se prueba con secuencias sintéticas y sin red. La única dependencia
 * es `@/lib/json`.
 *
 * ## La forma del payload que se lee
 *
 * ```jsonc
 * {
 *   "duration": 2400,
 *   "players": [{
 *     "profileId": 21050396,
 *     "buildOrder": [{ "pbgid": 129272, "finished": [0, 21, 41], "destroyed": [900] }],
 *     "resources": {
 *       "timestamps": [0, 20, 40, …],     // segundos de partida, cada 20 s
 *       "military": [13, 13, 15, …],      // **puntuación**, no existencias
 *       "foodGathered": [0, 12, 40, …],   // **acumulados**
 *       "woodGathered": [0, 8, 30, …],
 *       "goldGathered": [0, 0, 5, …],
 *       "stoneGathered": [0, 0, 0, …]
 *     }
 *   }]
 * }
 * ```
 *
 * **`military` es una puntuación y los `*Gathered` son acumulados.** No se usa
 * `resources.food` (ni `wood`, `gold`, `stone`): esos son las **existencias** del
 * momento, que suben y bajan con cada gasto, así que un tramo plano en ellos no
 * significa "no recolectó", sino "no acumuló". Lo que mide la regla es el
 * acumulado, que solo puede quedarse quieto si no entra nada.
 *
 * ## `null` no es cero
 *
 * Como en todo el resto de la frontera de confianza del proyecto: un dato que no
 * se puede leer es `null` y quien lo use decide. Aquí es especialmente importante,
 * porque "no creó aldeanos" y "no se pudo leer el `buildOrder`" no son lo mismo, y
 * confundirlos acusaría a una partida de la que no sabemos nada.
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
 *
 * Vive en este módulo y `summary.ts` los **re-exporta** para no romper los
 * imports existentes: los usan el recuento de pérdidas y el lector de anomalías, y
 * son el mismo dato.
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

/** Las cuatro series de recursos **recolectados** cuya suma mide la economía. */
const GATHERED_KEYS = ["foodGathered", "woodGathered", "goldGathered", "stoneGathered"] as const;

/**
 * Tope de tramos militares que se guardan por partida.
 *
 * Se guardan de mayor a menor, así que recortar aquí es quedarse con los que más
 * posibilidades tienen de superar la gracia y el umbral. Diez es más de lo que tiene
 * un partido normal y evita que una serie rara (un sierra con decenas de mesetas)
 * haga crecer el JSON de `Match` sin límite.
 */
const MAX_MILITARY_WINDOWS = 10;

/**
 * ¿Ese `pbgid` es un aldeano de cualquier tipo?
 *
 * El dorado y el montado van en sus propios conjuntos porque las pérdidas se
 * cuentan por separado (`defensor-del-pueblo` los exige así), pero para "creó
 * aldeanos" los tres son aldeanos.
 */
function isVillagerPbgid(pbgid: number): boolean {
  return (
    VILLAGER_PBGIDS.has(pbgid) ||
    pbgid === GILDED_VILLAGER_PBGID ||
    pbgid === MOUNTED_VILLAGER_PBGID
  );
}

/* -------------------------------------------------------------------------- */
/* Lectura de números                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Un entero del payload, aceptando la cadena numérica.
 *
 * La API manda números, pero la frontera de confianza del proyecto no se fía del
 * tipo y acepta `"150"` donde espera `150`; lo que nunca acepta es un decimal, un
 * `NaN` ni un texto. Compartido con `summary.ts`, que lee con el mismo criterio.
 */
export function readInteger(value: unknown): number | null {
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
 * Una serie del summary, solo si se puede leer **entera**.
 *
 * Un punto ilegible invalida la serie: una serie a la que le falta un punto no
 * dice "no creció en ese hueco", dice "no sabemos qué pasó", y rellenar el hueco
 * con el valor anterior inventaría un silencio. Se exigen al menos dos puntos:
 * con uno no hay tramo que medir.
 */
function readSeries(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length < 2) {
    return null;
  }

  const series: number[] = [];

  for (const entry of value) {
    const parsed = readInteger(entry);

    if (parsed === null || parsed < 0) {
      return null;
    }

    series.push(parsed);
  }

  return series;
}

/* -------------------------------------------------------------------------- */
/* Las anomalías                                                               */
/* -------------------------------------------------------------------------- */

/** Un tramo de la partida, en segundos desde su inicio. */
export type SummaryAnomalyWindow = {
  fromSeconds: number;
  toSeconds: number;
};

/**
 * La evidencia compacta que se guarda de un summary (`Match.summaryAnomalies`).
 *
 * Se guarda esto y no el payload entero porque lo que el motor de alertas necesita
 * son exactamente estos cuatro datos, y el payload del summary no está en
 * `rawJson` (viene de otra ruta, ver `summary.ts`).
 */
export type SummaryAnomalies = {
  /**
   * ¿El `buildOrder` era una lista? Si no lo era, no hay forma de saber cuándo se
   * creó el primer aldeano y la regla de aldeanos **no se evalúa**: `false` no
   * significa "no creó ninguno".
   */
  buildOrderReadable: boolean;
  /**
   * Primer instante en que **terminó** un aldeano con `finished > 0`, de cualquier
   * tipo, o `null` si la lista es legible y no hay ninguno.
   *
   * Los aldeanos iniciales terminan a `0` y no cuentan: todas las partidas los
   * tienen, así que contarlos haría que la regla no disparase nunca.
   */
  firstVillagerSeconds: number | null;
  /**
   * Los tramos en que la puntuación militar **no superó** el valor con el que
   * empezaba cada uno (no hizo un máximo nuevo), con longitud positiva y de mayor a
   * menor. `null` si la serie no se pudo leer; lista vacía si se leyó y no hay
   * ninguno.
   *
   * Es una **lista** y no solo el tramo más largo porque la gracia inicial se
   * descuenta después: el tramo más largo puede empezar antes de la gracia y dejar
   * pocos segundos útiles, mientras que otro tramo posterior, más corto, cuenta
   * entero. Se guardan como mucho los 10 más largos, que es más de lo que tiene un
   * partido normal y evita que el JSON crezca sin control.
   */
  militaryNoGrowth: SummaryAnomalyWindow[] | null;
  /**
   * El tramo más largo en que la suma de recursos recolectados no superó el valor
   * con el que empezó. `null` si la serie no se pudo leer.
   */
  noResourceGain: SummaryAnomalyWindow | null;
};

/**
 * El primer aldeano que **terminó** pasados los iniciales.
 *
 * `finished` es una lista de segundos (como las edades: puede traer varios
 * instantes) y los iniciales vienen a `0`. Se toma el mínimo **mayor que cero** de
 * todos los aldeanos, sean del tipo que sean.
 */
function firstVillagerSeconds(buildOrder: readonly unknown[]): number | null {
  let earliest: number | null = null;

  for (const item of buildOrder) {
    if (!isRecord(item)) {
      continue;
    }

    const pbgid = readInteger(item.pbgid);

    if (pbgid === null || !isVillagerPbgid(pbgid) || !Array.isArray(item.finished)) {
      continue;
    }

    for (const mark of item.finished) {
      const seconds = readInteger(mark);

      if (seconds === null || seconds <= 0) {
        continue;
      }

      if (earliest === null || seconds < earliest) {
        earliest = seconds;
      }
    }
  }

  return earliest;
}

/**
 * El último instante de un tramo que llega al final de la serie.
 *
 * Si la serie termina **pegada al final de la partida** (`duration - último <= 60
 * s`), el tramo se cierra en `duration`: la partida acabó con el jugador así, y
 * ese último minuto es silencio de verdad. Si la serie termina antes, se cierra en
 * su último punto: lo que venga después no lo hemos visto, y alargarlo hasta el
 * final inventaría un silencio que puede ser una eliminación (el jugador dejó de
 * jugar porque perdió, no porque no hiciera nada).
 */
function closeAtEndOfSeries(
  lastTimestamp: number,
  durationSeconds: number | null,
): number {
  if (
    durationSeconds !== null &&
    durationSeconds > lastTimestamp &&
    durationSeconds - lastTimestamp <= 60
  ) {
    return durationSeconds;
  }

  return lastTimestamp;
}

/**
 * Todos los tramos maximales en que la serie **no supera** el valor con el que
 * empezó cada uno, con longitud positiva y de mayor a menor.
 *
 * El criterio es "no hace un máximo nuevo", no "baja": en cuanto el valor supera
 * el listón con el que arrancó el tramo, el tramo se cierra y empieza otro con el
 * nuevo listón. Así una serie que oscila por debajo del nivel inicial cuenta como
 * un solo silencio —que es lo que se quiere medir— y una que sube y baja sin
 * superarse a sí misma no se parte en trozos.
 *
 * **No se queda con el más largo**: el militar necesita todos, porque la gracia
 * inicial se descuenta después y un tramo corto que empieza tarde puede ser el único
 * que cuenta (uno de 400 s al principio deja 100 s tras la gracia; otro de 350 s a
 * mitad de partida cuenta entero). Para los recursos sí basta el primero.
 *
 * Un tramo de longitud cero —un único punto— no es un tramo: no hay silencio que
 * medir. Y si hay empate, el orden es el cronológico, porque el `sort` de JS es
 * estable y dos tramos iguales valen lo mismo.
 */
function nonRisingWindows(
  timestamps: readonly number[],
  series: readonly number[],
  durationSeconds: number | null,
): SummaryAnomalyWindow[] {
  const length = Math.min(timestamps.length, series.length);

  if (length < 2) {
    return [];
  }

  const windows: SummaryAnomalyWindow[] = [];

  const consider = (from: number, to: number) => {
    if (to > from) {
      windows.push({ fromSeconds: from, toSeconds: to });
    }
  };

  let startIndex = 0;
  let reference = series[0] ?? 0;

  for (let index = 1; index < length; index += 1) {
    const value = series[index] ?? 0;

    if (value <= reference) {
      continue;
    }

    // El valor superó el listón: el tramo se cierra en el punto anterior.
    consider(timestamps[startIndex] ?? 0, timestamps[index - 1] ?? 0);
    startIndex = index;
    reference = value;
  }

  // El último tramo llega al final de la serie; solo ese puede cerrarse en el
  // final de la partida.
  consider(
    timestamps[startIndex] ?? 0,
    closeAtEndOfSeries(timestamps[length - 1] ?? 0, durationSeconds),
  );

  return windows.sort(
    (a, b) => b.toSeconds - b.fromSeconds - (a.toSeconds - a.fromSeconds),
  );
}

/**
 * Lee la evidencia de comportamiento de un summary. `null` si no hay nada que leer.
 *
 * Mismo criterio que `parseGameSummary()`: el payload tiene que ser un objeto con
 * `players` y tiene que aparecer el jugador que se pide. A partir de ahí cada dato
 * es independiente: un `buildOrder` que no se puede leer deja
 * `buildOrderReadable: false`, y una serie de recursos que no se puede leer deja su
 * tramo a `null`, sin arrastrar a los demás.
 */
export function parseSummaryAnomalies(
  value: unknown,
  profileId: number,
): SummaryAnomalies | null {
  if (!isRecord(value) || !Array.isArray(value.players)) {
    return null;
  }

  const entry = value.players.find(
    (candidate) => isRecord(candidate) && readInteger(candidate.profileId) === profileId,
  );

  if (entry === undefined || !isRecord(entry)) {
    return null;
  }

  const buildOrder = Array.isArray(entry.buildOrder) ? entry.buildOrder : null;
  const durationSeconds = readInteger(value.duration);
  const resources = isRecord(entry.resources) ? entry.resources : null;
  const timestamps = readSeries(resources?.timestamps);
  const military = readSeries(resources?.military);

  // La suma solo se puede calcular punto a punto si **todas** las series se leen y
  // llegan tan lejos como los timestamps: con una que falte no se puede decir que no
  // se recolectara nada, solo que ese recurso no se vio.
  const gathered: number[][] = [];

  if (timestamps !== null) {
    for (const key of GATHERED_KEYS) {
      const series = readSeries(resources?.[key]);

      if (series === null || series.length < timestamps.length) {
        gathered.length = 0;
        break;
      }

      gathered.push(series);
    }
  }

  const totals =
    timestamps !== null && gathered.length === GATHERED_KEYS.length
      ? timestamps.map((_, index) => gathered.reduce((sum, series) => sum + (series[index] ?? 0), 0))
      : null;

  return {
    buildOrderReadable: buildOrder !== null,
    firstVillagerSeconds: buildOrder === null ? null : firstVillagerSeconds(buildOrder),
    militaryNoGrowth:
      timestamps === null || military === null
        ? null
        : nonRisingWindows(timestamps, military, durationSeconds).slice(0, MAX_MILITARY_WINDOWS),
    noResourceGain:
      timestamps === null || totals === null
        ? null
        : (nonRisingWindows(timestamps, totals, durationSeconds)[0] ?? null),
  };
}

/* -------------------------------------------------------------------------- */
/* Lectura de lo guardado                                                      */
/* -------------------------------------------------------------------------- */

/** Un entero no negativo que puede ser `null`; `undefined` si no tiene la forma. */
function readOptionalInteger(value: unknown): number | null | undefined {
  if (value === null || value === undefined) {
    return value === undefined ? undefined : null;
  }

  const parsed = readInteger(value);

  return parsed !== null && parsed >= 0 ? parsed : undefined;
}

/** Un tramo válido (`to >= from`, ambos no negativos) o `null`; `undefined` si no. */
function readOptionalWindow(value: unknown): SummaryAnomalyWindow | null | undefined {
  if (value === null) {
    return null;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  const from = readInteger(value.fromSeconds);
  const to = readInteger(value.toSeconds);

  if (from === null || to === null || from < 0 || to < from) {
    return undefined;
  }

  return { fromSeconds: from, toSeconds: to };
}

/**
 * Una lista de tramos válidos, `null` si el valor es `null`; `undefined` si no.
 *
 * Un solo elemento inválido invalida la lista entera: media lista de silencios es
 * peor que ninguna, porque quien evalúa creería haber visto todos los tramos de la
 * partida cuando le falta alguno.
 */
function readOptionalWindows(value: unknown): SummaryAnomalyWindow[] | null | undefined {
  if (value === null) {
    return null;
  }

  if (!Array.isArray(value)) {
    return undefined;
  }

  const windows: SummaryAnomalyWindow[] = [];

  for (const entry of value) {
    const window = readOptionalWindow(entry);

    if (window === null || window === undefined) {
      return undefined;
    }

    windows.push(window);
  }

  return windows;
}

/**
 * Valida el JSON que hay en `Match.summaryAnomalies`.
 *
 * Es la frontera de lo guardado: lo escribe el worker con la forma de
 * `SummaryAnomalies`, pero el motor de alertas **no se fía** de que siga intacto
 * (una fila escrita por una versión anterior, un `update` a mano). Si la forma no
 * es exacta devuelve `null`, que para quien evalúa significa "desconocido" y no
 * genera ninguna alerta: ante la duda no se acusa a nadie.
 */
export function readSummaryAnomalies(value: unknown): SummaryAnomalies | null {
  if (!isRecord(value) || typeof value.buildOrderReadable !== "boolean") {
    return null;
  }

  const firstVillager = readOptionalInteger(value.firstVillagerSeconds);

  if (firstVillager === undefined) {
    return null;
  }

  const militaryNoGrowth = readOptionalWindows(value.militaryNoGrowth);

  if (militaryNoGrowth === undefined) {
    return null;
  }

  const noResourceGain = readOptionalWindow(value.noResourceGain);

  if (noResourceGain === undefined) {
    return null;
  }

  return {
    buildOrderReadable: value.buildOrderReadable,
    firstVillagerSeconds: firstVillager,
    militaryNoGrowth,
    noResourceGain,
  };
}
