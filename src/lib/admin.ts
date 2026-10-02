import "server-only";

import { Prisma } from "@/generated/prisma/client";
import { AdminActionType, AlertKind, AlertRule, MatchResult, PlayerStatus } from "@/generated/prisma/enums";
import { ALERT_RULE_LABELS, readAlertsRuleset, type AlertsThresholds } from "@/lib/alerts";
import { db } from "@/lib/db";
import { readFromDatabase, type PublicRead } from "@/lib/db-errors";
import { describeTeamSize, formatRelativeTime, teamSizesFromRawJson } from "@/lib/format";
import { isRecord } from "@/lib/json";
import { resolveObjective } from "@/lib/objective-events";
import type { ObjectiveGroup, ObjectiveMetric } from "@/lib/objectives";
import { classificatoryWhere, readInstant, type ScoringWindow } from "@/lib/ranked-match";
import { RULESET_VERSION, readRuleset, type ScoringRuleset } from "@/lib/scoring";
import { isSyncTraceStale, readSyncRunTrace, type SyncRunTrace } from "@/lib/settings";

/**
 * Capa de lectura del panel de administración.
 *
 * Es la puerta de entrada a la base de datos de las pestañas del panel, con la
 * misma disciplina que `src/lib/public.ts` y por las mismas razones: tipos
 * explícitos, `select` cerrado y ninguna forma de tabla llegando a la interfaz. Lo
 * que se publica aquí viene ya con los nombres del torneo resueltos y con los
 * parámetros de la URL validados, de modo que quien pinta no puede interpretar mal
 * un filtro.
 *
 * ## Por qué `PublicRead<T>` y no el dato pelado
 *
 * Igual que en las páginas públicas. `/admin` no es la web del torneo, así que no
 * hace falta que siga contestando, pero el contrato es el mismo porque es el que ya
 * conoce el proyecto: un `degraded` se pinta como "no se ha podido leer" y no como
 * "no hay participantes", que es una afirmación falsa.
 *
 * ## Lo que hay de alertas
 *
 * La pestaña de alertas ya no es un *placeholder*: `getAdminAlerts()` publica las
 * alertas disparadas, de la más reciente a la más antigua, y `getAdminAlertRules()`
 * publica los **umbrales vivos** del ruleset (`Setting["alerts.ruleset"]`) junto con la
 * ventana del torneo. Los umbrales se leen del ruleset efectivo y no de una constante
 * del código porque la organización puede retocarlos sin desplegar: un texto de reglas
 * escrito a mano en la interfaz acabaría mintiendo en cuanto eso pasara, que es el mismo
 * pendiente que tienen `/reglas` y `/objetivos` con los números del ruleset de puntos.
 *
 * El **informe descargable** no vive aquí: es un fichero entero que se genera con la
 * comprobación completa del motor por delante, y eso es `src/lib/alerts/report.ts`, que
 * además no degrada a medias.
 *
 * Lo que sí es salud del sistema y no una alerta de jugador sigue fuera de la pestaña:
 * el estado del sincronizador, que vive en `getSyncHealth()` y en el aviso de `/admin`.
 *
 * ## El orden y los filtros de las listas
 *
 * Las tres listas que **se paginan en servidor** (participantes no: se filtra y pagina en
 * cliente) comparten el mismo patrón de estado: **la URL es la fuente de verdad**.
 * `page`, `pageSize`, los filtros y el orden viajan en los parámetros, con el mismo
 * criterio que ya tenía el historial: la vista es compartible y la recarga no la
 * pierde, así que quien pinte no necesita estado propio para la tabla.
 *
 * Tres reglas rigen el contrato, y las tres son del módulo desde antes:
 *
 * - **Un valor que no se entiende es ausencia, no error.** `?sort=inventado`,
 *   `?dir=arriba`, `?playerId=noSoyUnCuid` o `?to=2026-13-45` se comportan como si no
 *   estuvieran escritos. Una URL manipulada no rompe la página y, sobre todo, no hace
 *   creer que un filtro deja cero filas cuando en realidad no está filtrando nada.
 * - **El orden que se publica es el que se ha aplicado.** Cada lectura devuelve su
 *   `sort` ya validado —`AdminAlertsSort`, `AdminHistorySort`, `AdminActionsSort`—, no
 *   el `sort` crudo de la URL. Quien pinte el `aria-sort` y el chevron no lo deduce de
 *   los parámetros, porque en cuanto uno sea inválido se equivocaría.
 * - **Todo orden es total.** Cada uno acaba en una columna única —`id`, o la clave
 *   propia de cada clase de fila en el historial mezclado—, porque sin desempate dos
 *   filas del mismo instante pueden salir en cualquier orden entre sí y una página
 *   puede repetir o perder filas de la anterior. Es la misma exigencia que ya tenía el
 *   orden por fecha de las tres listas, y la razón por la que el orden por resultado del
 *   feed mezclado no puede ser un `orderBy` cualquiera: cambia el eje del merge y obliga
 *   a que el comparador y los dos `orderBy` digan exactamente lo mismo.
 */

/* -------------------------------------------------------------------------- */
/* Parámetros de la URL                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Un valor de `searchParams`, tal como lo entrega Next.
 *
 * Es `string | string[] | undefined` porque `?playerId=a&playerId=b` es una URL
 * válida, así que el tipo solo no basta: todo lo que llega de aquí se valida antes
 * de tocar la base de datos.
 */
export type AdminQueryParam = string | string[] | null | undefined;

/** Paginación de las lecturas del panel, con los valores aún sin validar. */
export type AdminPageQuery = {
  page?: AdminQueryParam;
  pageSize?: AdminQueryParam;
};

/**
 * Ordenación de una lectura paginada, con los valores aún sin validar.
 *
 * `sort` es el nombre de la columna —en español, y solo de las que cada lista
 * admite— y `dir` el sentido. Los dos viajan en la URL por lo mismo que los filtros:
 * el estado de la tabla es compartible y la recarga no lo pierde.
 *
 * Cualquier valor que no sea válido es **ausencia** y nunca error, por lo que dice
 * `readSingleParam`: un enlace puede llevar parámetros que esta versión de la tabla
 * todavía no entiende sin que la página se rompa ni aparezcan filas raras.
 */
export type AdminSortQuery = {
  sort?: AdminQueryParam;
  dir?: AdminQueryParam;
};

/**
 * Sentido de un orden.
 *
 * Deliberadamente los mismos dos literales que usa Prisma en `orderBy`, porque es lo
 * que viaja a la consulta sin traducción: un tipo propio con `"arriba"` y `"abajo"`
 * obligaría a convertirlo en cada consulta, y esa conversión es donde estos filtros
 * se suelen equivocar.
 */
export type AdminSortDir = "asc" | "desc";

/**
 * Filas de una lectura paginada, con la paginación y el orden ya resueltos.
 *
 * El segundo tipo es el del **orden efectivo**, y cada lista publica el suyo
 * (`AdminAlertsSort`, `AdminHistorySort`, `AdminActionsSort`) en lugar de un tipo
 * genérico con todas las columnas mezcladas. Va en el retorno y no se deja que la
 * interfaz lo deduzca de los parámetros, por una razón concreta: si lo dedujera, en
 * cuanto un valor fuera inválido pintaría un `aria-sort` y un chevron que no
 * corresponden con lo que la tabla está haciendo de verdad.
 */
export type AdminPage<T, S> = {
  rows: T[];
  /** Filas que cumplen el filtro, sin paginar: de ahí sale `pageCount`. */
  total: number;
  /** Página devuelta, acotada a `[1, pageCount]`. */
  page: number;
  pageSize: number;
  /** Páginas que hay con este filtro; `0` si no hay ninguna fila. */
  pageCount: number;
  /**
   * Orden con el que se ha consultado, ya validado: la columna que se está
   * ordenando y el sentido. Lo publica la lectura, no la interfaz.
   */
  sort: S;
};

/** Filas por página que se piden por defecto. */
const DEFAULT_PAGE_SIZE = 25;

/**
 * Tope de `pageSize`.
 *
 * El parámetro viene de la URL, así que sin tope un `?pageSize=100000` sería una
 * consulta que trae la tabla entera y la manda al navegador dentro del *payload* de
 * RSC. 100 filas dan de sobra para una tabla y dejan el histórico navegable.
 */
const MAX_PAGE_SIZE = 100;

/** Un día en milisegundos, para resolver el `to` de una fecha suelta. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Un parámetro de la URL, reducido a un único texto.
 *
 * Un parámetro repetido (`?playerId=a&playerId=b`) se queda con el primero en vez
 * de fallar la página: es una URL válida y descartar el segundo no cambia lo que
 * quien la escribió quería ver. Un vacío sí es ausencia de filtro.
 */
function readSingleParam(value: AdminQueryParam): string | null {
  if (Array.isArray(value)) {
    return readSingleParam(value[0]);
  }

  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();

  return trimmed === "" ? null : trimmed;
}

/** Entero de un parámetro, acotado a `[min, max]`; lo que no vale, es `fallback`. */
function readBoundedInt(
  value: AdminQueryParam,
  { min, max, fallback }: { min: number; max: number; fallback: number },
): number {
  const raw = readSingleParam(value);

  if (raw === null || !/^\d{1,6}$/.test(raw)) {
    return fallback;
  }

  const parsed = Number(raw);

  return Math.min(Math.max(parsed, min), max);
}

/**
 * Resuelve una página de un listado paginado.
 *
 * `load` hace **las dos** consultas en paralelo (filas y total) y devuelve la
 * `page` que se le pide. Encapsularlo aquí evita repetir el mismo cálculo en las
 * lecturas paginadas, y sobre todo evita el error de contar una página y traer las
 * filas de otra.
 *
 * `sort` viaja tal cual hacia el retorno: es el orden **efectivo** que la carga ha
 * aplicado, y por eso lo pasa quien llama ya validado y no se vuelve a leer de los
 * parámetros aquí.
 *
 * Se ajusta la página al rango real (una URL que pide la 7 con un filtro que solo
 * tiene dos páginas devuelve la última con filas): una tabla vacía con "página 7 de
 * 2" desconcierta más que devolver directamente lo que hay. El ajuste solo repite
 * la consulta cuando hace falta, porque el camino normal es una sola pasada.
 */
async function adminPage<T, S>(
  load: (page: number) => Promise<{ rows: T[]; total: number }>,
  page: number,
  pageSize: number,
  sort: S,
): Promise<AdminPage<T, S>> {
  const first = await load(page);
  const pageCount = Math.ceil(first.total / pageSize);
  const current = pageCount === 0 ? 1 : Math.min(page, pageCount);

  if (current !== page) {
    const last = await load(current);

    return { rows: last.rows, total: last.total, page: current, pageSize, pageCount, sort };
  }

  return { rows: first.rows, total: first.total, page: current, pageSize, pageCount, sort };
}

/* -------------------------------------------------------------------------- */
/* Filtros compartidos de la URL                                               */
/* -------------------------------------------------------------------------- */

/**
 * `Player.id` es un `cuid`, así que se valida la **forma** y no el valor: un id
 * manipulado no puede dar de sí nada, y comprobar el patrón evita pasar a Prisma
 * basura desde la URL.
 *
 * Un valor que no tiene la forma del id se trata como **ausencia de filtro**, no
 * como un filtro sin resultados: desde la interfaz, un filtro mal escrito se
 * parece más a "sin filtrar" que a "no hay ninguna partida con ese jugador", y lo
 * segundo sería una afirmación falsa sobre una URL manipulada.
 */
const PLAYER_ID_PATTERN = /^[a-z0-9]{1,64}$/;

/**
 * El filtro de jugador de la URL, ya validado.
 *
 * Lo comparten el historial y las alertas, que filtran por `Player.id` los dos, y por
 * eso vive aquí y no en la sección de ninguna de las dos listas: dos copias del mismo
 * patrón acabarían discrepando en cuanto una aceptara algo más que la otra.
 *
 * Exportado para `npm run verify:sync`, que lo comprueba sin base de datos: es una
 * función pura y es justo donde se decide qué hace una URL manipulada.
 */
export function readPlayerIdFilter(value: AdminQueryParam): string | null {
  const raw = readSingleParam(value);

  return raw !== null && PLAYER_ID_PATTERN.test(raw) ? raw : null;
}

/** Fecha suelta `YYYY-MM-DD`, que es lo que produce un `<input type="date">`. */
const DAY_PATTERN = /^(\d{4}-\d{2}-\d{2})$/;

/**
 * Un límite del filtro de fechas, ya resuelto a instante.
 *
 * Admite las dos formas que la interfaz tiene a mano: un instante con zona
 * explícita —el mismo criterio estricto que el ruleset, `readInstant`, que rechaza
 * `"2026-09-15T00:00:00"` porque se interpretaría en hora local— o una fecha suelta,
 * que se resuelve a medianoche UTC de ese día.
 *
 * La fecha suelta se resuelve distinto en cada borde, y es lo que hace que "del 1
 * al 30" incluya el día 30 entero:
 *
 * - `from`: las `00:00:00.000Z` de ese día, **inclusivo**.
 * - `to`: las `00:00:00.000Z` del día **siguiente**, con un filtro `< to`: el día
 *   que escribió quien filtró queda dentro y el siguiente, fuera.
 *
 * Un instante con zona se usa tal cual, sin desplazarlo. Cualquier otra cosa —un
 * `ayer`, un `2026-13-45`, un instante sin zona— se ignora y ese filtro no se
 * aplica: una URL manipulada se comporta como si el filtro no estuviera, en vez de
 * romper la página con un error que no sabe explicar nadie.
 */
function readDateBound(value: AdminQueryParam, bound: "from" | "to"): Date | null {
  const raw = readSingleParam(value);

  if (raw === null) {
    return null;
  }

  const instant = readInstant(raw);

  if (instant !== null) {
    return instant;
  }

  const day = DAY_PATTERN.exec(raw);

  if (day === null) {
    return null;
  }

  const inicio = readInstant(`${day[1]}T00:00:00.000Z`);

  // `Date.parse` no rechaza los días que no existen: `"2026-02-31T00:00:00.000Z"`
  // rueda a `2026-03-03`. La ida y la vuelta es lo que los descarta, y con ello un
  // filtro escrito a mano con una fecha imposible se trata como ausencia de filtro
  // en vez de como un rango desplazado tres días.
  if (inicio === null || inicio.toISOString().slice(0, 10) !== day[1]) {
    return null;
  }

  return bound === "from" ? inicio : new Date(inicio.getTime() + DAY_MS);
}

/**
 * Rango de fechas de un filtro, ya validado y listo para una columna `DateTime`.
 *
 * Es un tipo propio y no el `DateTimeFilter` de Prisma a propósito: lo que sale de
 * aquí son dos comparadores opcionales, y el filtro los mete dentro de la columna
 * concreta (`Match.startedAt`, `ObjectiveEvent.achievedAt` o `Alert.createdAt`) junto
 * con lo que ya traiga el resto de condiciones.
 *
 * Los dos límites son los **mismos** para las dos clases de fila del historial: el
 * filtro de la pantalla es un rango de fechas, no "fechas de partidas". Por eso se
 * resuelve una vez y se reparte.
 */
export type AdminDateRange = { gte?: Date; lt?: Date };

/**
 * El rango de fechas de un filtro, ya validado.
 *
 * Vive aquí porque lo comparten el historial y las alertas, con los **mismos** bordes
 * inclusivo y exclusivo: un `?to=2026-09-30` tiene que incluir el día 30 entero en
 * las dos tablas, y sería una sorpresa que en una significara algo distinto.
 */
function dateRangeWhere(from: AdminQueryParam, to: AdminQueryParam): AdminDateRange {
  const desde = readDateBound(from, "from");
  const hasta = readDateBound(to, "to");

  return {
    ...(desde === null ? {} : { gte: desde }),
    ...(hasta === null ? {} : { lt: hasta }),
  };
}

/**
 * ¿Ha quedado algún límite puesto?
 *
 * Para no meter `{ createdAt: {} }` en un `where`: un filtro de rango vacío no filtra
 * nada, pero obligaría a comprobar en cada sitio si un `DateTimeFilter` sin
 * comparadores significa "cualquier fecha" o es un error de Prisma.
 */
function hasDateBounds(rango: AdminDateRange): boolean {
  return rango.gte !== undefined || rango.lt !== undefined;
}

/* -------------------------------------------------------------------------- */
/* Ordenación                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Sentido por defecto de las tres listas, y en las tres es el mismo: **descendente**.
 *
 * Las tres se abren "de lo más reciente a lo más antiguo", que es el orden con el que se
 * lee un registro de un torneo en marcha. Un `sort` sin `dir` vale, por tanto, el
 * orden con el que ya se veía la tabla.
 */
const DEFAULT_SORT_DIR: AdminSortDir = "desc";

/** El `dir` de la URL, ya validado; lo que no vale, es el sentido por defecto. */
function readSortDir(value: AdminQueryParam): AdminSortDir {
  const raw = readSingleParam(value);

  return raw === "asc" || raw === "desc" ? raw : DEFAULT_SORT_DIR;
}

/**
 * Orden efectivo a partir de los dos parámetros de la URL.
 *
 * Genérico sobre la lista de columnas admitidas, y esa lista la pasa quien llama: no
 * hay forma de que `readSort` devuelva una columna que la lista no pinte, ni de que una
 * lista acepte por error el nombre de la columna de otra.
 *
 * Las cuatro reglas, y las cuatro son de "ausencia":
 *
 * - Una columna que no está en la lista admitida —o un `sort` vacío— es la columna por
 *   defecto de la lista. Una URL con `?sort=inventado` se lee como la tabla sin tocar,
 *   con el mismo criterio que un `playerId` mal formado.
 * - Un `dir` que no es `asc` ni `desc` es el sentido por defecto.
 * - **`dir` no necesita `sort`.** Son dos parámetros independientes y cada uno tiene su
 *   valor por defecto, así que `?dir=asc` quiere decir "la columna de por defecto en
 *   ascendente", no "nada": un enlace de "quitar orden" puede limitarse a borrar
 *   `sort` y dejar `dir=desc` sin que eso signifique un estado imposible.
 * - La comparación es **literal**: ni se ignoran mayúsculas ni se normalizan acentos.
 *   Al revés que en `parseCountry()`, que resuelve un país escrito por una persona; aquí
 *   los valores los escriben los enlaces de la propia tabla, y un valor en minúsculas o
 *   sin tilde ahí no es una forma de escribir la misma columna, es otra URL.
 */
function readSort<K extends string>(
  query: AdminSortQuery,
  admitidas: readonly K[],
  porDefecto: K,
): { key: K; dir: AdminSortDir } {
  const raw = readSingleParam(query.sort);
  const key = admitidas.find((columna) => columna === raw) ?? porDefecto;

  return { key, dir: readSortDir(query.dir) };
}

/**
 * Orden de la tabla de alertas.
 *
 * Las cinco columnas que se pueden ordenar y la columna de la tabla a la que va cada
 * una:
 *
 * | `key` | Se ordena por | Columna |
 * |---|---|---|
 * | `fecha` (por defecto) | `Alert.createdAt` | Fecha |
 * | `jugador` | el nombre del `join` con `Player` | Jugador |
 * | `regla` | `Alert.rule` | Regla |
 * | `sujeto` | `Alert.subjectName` | Sujeto |
 * | `conteo` | `Alert.count` | Conteo |
 *
 * ## Qué **no** se ordena, y por qué
 *
 * - **Detalle**: es `Alert.summary`, una frase redactada por el motor y escrita para
 *   leerse ("3 partidas seguidas contra Marta"). Ordenarla sería ordenarlas por la
 *   primera palabra de cada frase, que además empieza por un número ("3", "7", "12")
 *   y no por la información de la frase, así que el orden no significaría nada; además
 *   obligaría a traer la columna entera y ordenarla en memoria, porque el criterio no
 *   es una columna de la tabla.
 * - **Tipo de alerta** (`kind`): son tres valores, se filtran con `?tipo=` y ya se
 *   pintan como distintivo en cada fila. Ordenarlos no respondería a nada que alguien
 *   se pregunte ("¿cuántas rachas rotas hay y cuántas acumuladas?"), y el filtro cubre
 *   la necesidad real.
 *
 * ## El detalle de cada columna
 *
 * - `sujeto` usa los **nulos al final en los dos sentidos**, no solo en ascendente: las
 *   reglas sin sujeto (R1, R4 y R5) son `null`, y en descendente mezclarlas con los
 *   nombres sacaría las alertas sin sujeto por delante de todo.
 * - `regla` ordena por el **enum**, y en Postgres un enum se ordena por el orden de sus
 *   valores en el esquema, no alfabéticamente por la etiqueta. Aquí eso sale bien: el
 *   esquema los declara en el orden R1, R2, R3, R4 y R5, así que ordenar por regla
 *   agrupa por familia de reglas, que es como se explican.
 * - `jugador` ordena por el nombre y con la **intercalación de Postgres**, que puede no
 *   coincidir con cómo se lee el alfabeto español. No hay forma mejor sin arrastrar el
 *   nombre a la tabla de alertas o ordenarlo en memoria.
 * - Los índices que hay son `@@index([createdAt])` y `@@index([playerId, rule])`, así que
 *   solo el orden por fecha y el filtro por jugador + regla se apoyan en uno; el resto
 *   ordena en memoria el conjunto que ya ha filtrado el `where`. Con miles de alertas de
 *   un torneo largo sale igual de bien, y si algún día molestara, el arreglo es un índice
 *   compuesto (`[rule, createdAt]` y `[kind, createdAt]`), no un cambio en esta lectura.
 */
export type AdminAlertsSort = {
  key: "fecha" | "jugador" | "regla" | "sujeto" | "conteo";
  dir: AdminSortDir;
};

/** Las columnas ordenables de las alertas, con `satisfies` para que la lista no crezca sola. */
const ALERT_SORT_COLUMNS = [
  "fecha",
  "jugador",
  "regla",
  "sujeto",
  "conteo",
] as const satisfies readonly AdminAlertsSort["key"][];

/**
 * El orden efectivo de la tabla de alertas.
 *
 * Exportado para `npm run verify:sync`: es una función pura y es donde se decide qué
 * hace una URL manipulada (`?sort=inventado`, `?dir=arriba`, `?sort=sujeto` sin `dir`).
 */
export function readAlertsSort(query: AdminSortQuery): AdminAlertsSort {
  return readSort(query, ALERT_SORT_COLUMNS, "fecha");
}

/**
 * Orden de la tabla de alertas en `orderBy` de Prisma.
 *
 * Un `Record` con una función por columna, y no un `switch`, porque el `Record` con
 * las cinco claves **falla al compilar** si mañana se añade una columna a
 * `AdminAlertsSort` y aquí no se decide su criterio. Cada uno acaba en `{ id }`, el
 * desempate que necesita la paginación, y en el mismo sentido que el resto: `asc` es
 * el inverso exacto de `desc`.
 */
const ALERT_ORDER_BY: Record<
  AdminAlertsSort["key"],
  (dir: AdminSortDir) => Prisma.AlertOrderByWithRelationInput[]
> = {
  fecha: (dir) => [{ createdAt: dir }, { id: dir }],
  jugador: (dir) => [{ player: { name: dir } }, { id: dir }],
  regla: (dir) => [{ rule: dir }, { id: dir }],
  sujeto: (dir) => [{ subjectName: { sort: dir, nulls: "last" } }, { id: dir }],
  conteo: (dir) => [{ count: dir }, { id: dir }],
};

/**
 * Orden del historial de partidas: por fecha o por resultado.
 *
 * | `key` | Orden |
 * |---|---|
 * | `fecha` (por defecto) | `Match.startedAt` / `ObjectiveEvent.achievedAt` |
 * | `resultado` | objetivo, victoria o derrota; dentro de cada grupo, por fecha |
 *
 * La columna que se ordena por resultado es la que la interfaz pinta con tres
 * distintivos —"Objetivo", "Victoria", "Derrota"—, así que el orden no puede ser por el
 * enum de `Match.result`: en el feed no hay solo partidas. El criterio, y por qué, están
 * en `historyComparator()`.
 *
 * Exportado para `npm run verify:sync`, como el de las alertas.
 */
export type AdminHistorySort = {
  key: "fecha" | "resultado";
  dir: AdminSortDir;
};

/** Las columnas ordenables del historial. */
const HISTORY_SORT_COLUMNS = [
  "fecha",
  "resultado",
] as const satisfies readonly AdminHistorySort["key"][];

/**
 * El orden efectivo del historial.
 *
 * Convive con el **filtro** `?resultado=WIN|LOSS` y no se confunde con él: uno recorta
 * las filas (y deja fuera los objetivos, a propósito) y el otro las ordena. Viven en
 * parámetros distintos y en tipos distintos, y `npm run verify:sync` comprueba que los
 * dos se puedan usar a la vez sin que uno pise al otro.
 */
export function readHistorySort(query: AdminSortQuery): AdminHistorySort {
  return readSort(query, HISTORY_SORT_COLUMNS, "fecha");
}

/** Orden del historial de acciones: por fecha, por tipo o por admin. */
export type AdminActionsSort = {
  key: "fecha" | "tipo" | "admin";
  dir: AdminSortDir;
};

/** Las columnas ordenables del historial de acciones. */
const ACTION_SORT_COLUMNS = ["fecha", "tipo", "admin"] as const satisfies
  readonly AdminActionsSort["key"][];

/**
 * El orden efectivo del historial de acciones.
 *
 * `admin` ordena por `actorEmail` —la columna que muestra la tabla—, no por un
 * identificador de usuario que no existe: el rastro guarda el correo de quien hizo
 * cada acción y no hay nada más de esa persona en el modelo.
 *
 * Exportado para `npm run verify:sync`, como los otros dos.
 */
export function readActionsSort(query: AdminSortQuery): AdminActionsSort {
  return readSort(query, ACTION_SORT_COLUMNS, "fecha");
}

/**
 * Orden del historial de acciones en `orderBy` de Prisma.
 *
 * `tipo` ordena por el enum `AdminActionType`, que en Postgres se ordena por el orden
 * de sus valores en el esquema (altas, bajas y cambios de puntos) y no alfabéticamente
 * por la etiqueta. Es el mismo criterio que en la columna de regla de las alertas, y
 * con la misma garantía de desempate por `id`.
 */
const ACTION_ORDER_BY: Record<
  AdminActionsSort["key"],
  (dir: AdminSortDir) => Prisma.AdminActionOrderByWithRelationInput[]
> = {
  fecha: (dir) => [{ createdAt: dir }, { id: dir }],
  tipo: (dir) => [{ type: dir }, { id: dir }],
  admin: (dir) => [{ actorEmail: dir }, { id: dir }],
};

/* -------------------------------------------------------------------------- */
/* Participantes                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Una fila de la pestaña de participantes.
 *
 * `matchCount` y `points` vienen del mismo agregado y valen `null` cuando el
 * jugador no tiene fila en la clasificación: es el caso de cualquiera que no esté
 * aprobado, o que no tenga todavía ninguna partida clasificatoria.
 */
export type AdminParticipant = {
  /** `Player.id`: es lo que viajan los formularios de las acciones de admin. */
  id: string;
  profileId: number;
  /** Nombre de display: el que escribió quien se inscribió o el admin. */
  name: string;
  aoe4WorldName: string | null;
  twitchChannel: string | null;
  /**
   * Canales de YouTube y de Kick, tal cual están en la fila.
   *
   * Llega sin normalizar a propósito, igual que `twitchChannel`: el panel los
   * **muestra** y quien los escribió pasó por `parseYoutubeChannel()` /
   * `parseKickChannel()`, que ya guardan la forma canónica. Normalizarlos aquí
   * otra vez taparía un dato escrito a mano en la base sin avisar de nada.
   */
  youtubeChannel: string | null;
  kickChannel: string | null;
  contactEmail: string | null;
  /**
   * `Player.country`: el rótulo canónico de la lista admitida
   * (`Setting["registration.countries"]`), o `null` si el alta no lo trajo. El
   * panel no lo resuelve ni lo normaliza —lo hace `parseCountry()` al validarlo—,
   * así que aquí llega tal cual está en la fila y quien pinte puede compararlo
   * con la lista viva sin que las dos cosas puedan divergir.
   */
  country: string | null;
  status: PlayerStatus;
  avatarUrl: string | null;
  /** Partidas clasificatorias de las que tiene fila; `null` si no rankea. */
  matchCount: number | null;
  /** Puntos del torneo, los mismos que publica la clasificación; `null` si no rankea. */
  points: number | null;
};

const PARTICIPANT_SELECT = {
  id: true,
  profileId: true,
  name: true,
  aoe4WorldName: true,
  twitchChannel: true,
  youtubeChannel: true,
  kickChannel: true,
  contactEmail: true,
  country: true,
  status: true,
  avatarUrl: true,
} satisfies Prisma.PlayerSelect;

/**
 * Todos los jugadores, con su estado y sus números, para la pestaña de
 * participantes.
 *
 * **Todos los estados**, no solo los aprobados: la cola de `PENDING` es la mitad
 * del trabajo del panel. El buscador y el filtro por estado son de la interfaz (van
 * en cliente sobre esta lista), así que aquí no hay ni `where` ni paginación que los
 * condicionen: son decenas de filas.
 *
 * ## De dónde salen `matchCount` y `points`
 *
 * De `PlayerScore` del ruleset activo, no de un agregado sobre `Match`. Es una
 * decisión y no un atajo:
 *
 * - Es **el mismo número que ve el público** en la clasificación. Un agregado sobre
 *   `Match` tendría que replicar el filtro del ruleset (familias, ventana, partida
 *   revertida) y además sumar los objetivos, o el panel y la portada darían cifras
 *   distintas para el mismo jugador.
 * - Sale en **una** consulta. Con `_count` sobre la relación y un `groupBy` para
 *   sumar puntos serían dos, y el segundo agruparía decenas de miles de partidas
 *   para producir dos números por jugador.
 * - Sale con las reglas vigentes: si `pointsPerWin` cambia en `Setting` sin
 *   desplegar, el panel cambia con la clasificación.
 *
 * Lo que se paga es que un jugador sin fila sale con `null` en vez de `0`, y es lo
 * honesto: `0` puntos significaría "está en la clasificación y no tiene nada", y un
 * `PENDING` todavía no está en ninguna.
 *
 * El orden es el que ya tenía la tabla (`status` y después `name`): agrupar por
 * estado deja juntas las solicitudes pendientes, que es lo que se mira primero.
 */
export async function getAdminParticipants(): Promise<PublicRead<AdminParticipant[]>> {
  return readFromDatabase("admin/getAdminParticipants", async () => {
    const [players, scores] = await Promise.all([
      db.player.findMany({
        orderBy: [{ status: "asc" }, { name: "asc" }],
        select: PARTICIPANT_SELECT,
      }),
      // Solo la versión activa del ruleset: las filas de reglas anteriores se
      // conservan (P-02 del modelo de datos) y son historia, no lo que se muestra.
      db.playerScore.findMany({
        where: { ruleSetVersion: RULESET_VERSION },
        select: { playerId: true, matches: true, total: true },
      }),
    ]);

    const byPlayer = new Map(scores.map((score) => [score.playerId, score]));

    return players.map((player) => {
      const score = byPlayer.get(player.id);

      return {
        ...player,
        matchCount: score?.matches ?? null,
        points: score?.total ?? null,
      };
    });
  });
}

/* -------------------------------------------------------------------------- */
/* Salud del sincronizador                                                      */
/* -------------------------------------------------------------------------- */

/** Lo que la pestaña de alertas necesita saber del sincronizador. */
export type SyncHealth = {
  /**
   * Último rastro escrito, o `null` si nunca se ha escrito uno. No es lo mismo que
   * «todo bien»: quien lo pinte tiene que decir que no hay registro, no que el
   * sincronizador está sano.
   */
  lastRun: SyncRunTrace | null;
  /** Instante de la última pasada **entera**, aunque la de ahora no lo haya sido. */
  lastSuccessAt: string | null;
  /**
   * La última pasada es más vieja que `SYNC_STALE_MINUTES`. Detecta el caso que el
   * rastro por sí solo no ve: el Worker dejó de entrar y nadie escribe nada, así que
   * lo último que hay en la fila es viejo.
   */
  stale: boolean;
  /**
   * `true` solo si la última pasada no salió bien: algún jugador falló o se canceló,
   * la ladder no se refrescó o no se pudo recalcular la clasificación. Es el estado
   * en el que la web pública puede estar enseñando una clasificación vieja.
   */
  degraded: boolean;
  /**
   * Resumen de una frase para el aviso corto, ya decidedo en el servidor. Va aquí y
   * no en el componente para que el mismo criterio no se implemente dos veces: un
   * `—` aquí y un textoAML there acabarían discrepando.
   */
  headline: string;
};

/**
 * Estado del sincronizador para la pestaña de alertas.
 *
 * Antes de existir esto, un fallo del sincronizador era invisible: el cron dispara
 * por HTTP y descarta la respuesta, y el error por jugador solo iba a `console.error`.
 * La clasificación se quedaba congelada y parecía que todo iba bien. Esta lectura
 * es la que convierte el rastro en algo que se ve.
 */
export async function getSyncHealth(): Promise<PublicRead<SyncHealth>> {
  return readFromDatabase("admin/getSyncHealth", async () => {
    const trace = await readSyncRunTrace();
    const stale = isSyncTraceStale(trace);

    const degraded =
      trace !== null &&
      (trace.playersFailed > 0 ||
        trace.playersCancelled > 0 ||
        trace.ladderError !== null ||
        trace.scoringError !== null);

    return { lastRun: trace, lastSuccessAt: trace?.lastSuccessAt ?? null, stale, degraded, headline: syncHeadline(trace, stale) };
  });
}

/**
 * La frase del estado, en un solo sitio.
 *
 * El orden no es arbitrario: primero «nunca ha corrido» y «no ha corrido hace
 * rato», que son los dos estados en los que no hay nada que mirar, y después si la
 * última pasada salió bien. Un fallo de la última pasada solo se cuenta junto a una
 * pasada que sí ocurrió, así que los dos casos van juntos.
 */
function syncHeadline(trace: SyncRunTrace | null, stale: boolean): string {
  if (trace === null) {
    return "El sincronizador todavía no ha escrito ninguna pasada.";
  }

  if (stale) {
    return `La última pasada es de ${formatRelativeTime(new Date(trace.finishedAt))} y no se ha escrito ninguna desde entonces.`;
  }

  const fallidos = trace.playersFailed + trace.playersCancelled;

  if (fallidos === 0 && trace.ladderError === null && trace.scoringError === null) {
    return `La última pasada salió bien: ${trace.playersOk} de ${trace.playersTotal} jugadores y ${trace.newMatches} partidas nuevas.`;
  }

  const partes: string[] = [];

  if (fallidos > 0) {
    partes.push(
      `${fallidos} de ${trace.playersTotal} jugadores no se han podido sincronizar`,
    );
  }

  if (trace.ladderError !== null) {
    partes.push("la ladder no se ha refrescado");
  }

  if (trace.scoringError !== null) {
    partes.push("no se ha podido recalcular la clasificación");
  }

  return `La última pasada salió a medias: ${partes.join(", ")}.`;
}

/* -------------------------------------------------------------------------- */
/* Historial de partidas y objetivos                                            */
/* -------------------------------------------------------------------------- */

/**
 * Parámetros del historial de partidas, tal como llegan de la URL.
 *
 * Filtros y orden son parámetros **distintos** y con nombres distintos, aunque uno de
 * los dos se llame `resultado`: `?resultado=WIN` recorta las filas y `?sort=resultado`
 * las ordena. `npm run verify:sync` comprueba que se puedan usar juntos.
 */
export type AdminMatchHistoryQuery = AdminPageQuery &
  AdminSortQuery & {
    /** `Player.id` (no `profileId`): el mismo id que usan los formularios de admin. */
    playerId?: AdminQueryParam;
    /** Límite inferior **inclusivo** de fechas; en las partidas, sobre `startedAt`. */
    from?: AdminQueryParam;
    /** Límite superior **exclusivo** de fechas; en las partidas, sobre `startedAt`. */
    to?: AdminQueryParam;
    /** `WIN` o `LOSS`; cualquier otra cosa se trata como ausencia de filtro. */
    resultado?: AdminQueryParam;
  };

/**
 * El objetivo cumplido de una fila del historial, ya resuelto.
 *
 * Etiqueta, grupo y métrica salen del **catálogo** (`OBJECTIVE_DEFINITIONS`) y los
 * puntos del **ruleset activo**, con el mismo criterio que `objectiveLookup()` en
 * `src/lib/public.ts` (`ruleset.objectives[id] ?? definition.points`). La tabla
 * `ObjectiveEvent` no los guarda, y a propósito: una copia se quedaría vieja en
 * cuanto se retocara un punto en `Setting`. Es la fila de la interfaz la que tiene
 * todo resuelto, para que pintar un hito no obligue a mirar el catálogo.
 */
export type AdminObjectiveEvent = {
  /** `ObjectiveEvent.objectiveId`: id estable del objetivo (`masterizar-japanese`…). */
  id: string;
  /** Rótulo público del objetivo (`ObjectiveDefinition.label`). */
  label: string;
  /** Grupo del objetivo (`actividad`, `racha`, `division`, `formato`, `civilizacion`). */
  group: ObjectiveGroup;
  /**
   * Métrica que lo decide (`partidas`, `winrate`, `racha`, `victorias`).
   *
   * Viaja con `id` y `group` porque `ObjectiveIcon` —el mismo icono que usan
   * `/objetivos` y la clasificación— elige el glifo con los tres. Con esto la fila
   * se puede pintar sin mirar el catálogo.
   */
  metric: ObjectiveMetric;
  /** Puntos que otorga poseerlo con las reglas vigentes. Es el mismo número que `points` de la fila. */
  points: number;
};

/**
 * Una fila del historial de `/admin/historial`: **una partida o un objetivo cumplido**.
 *
 * ## Cómo se distinguen
 *
 * Por `objective`: `null` = fila de partida, no `null` = se cumplió un objetivo. No
 * hay un `kind` aparte a propósito: un segundo discriminante que nadie mantiene en
 * sincronía con el primero es una forma de que las dos clases de fila se contradigan.
 *
 * Los campos de partida (`gameId`, `opponentName`, `result`, `teamSize`, `mode`,
 * `leaderboard`, `map`, `revertedAt`) son `null` en una fila de objetivo porque no
 * existen ahí, no porque falten datos. Y al revés: una fila de objetivo **no lleva
 * acciones** (revertir o restaurar son de `Match`), así que la interfaz solo tiene
 * que comprobar `objective === null` para saber si puede ofrecer alguna.
 */
export type AdminMatchHistoryRow = {
  /**
   * `Match.id` en una fila de partida —es lo que viajan los formularios de revert y
   * restore— y `ObjectiveEvent.objectiveId` en una fila de objetivo, que también es
   * única. En los dos casos sirve como clave de la fila.
   */
  id: string;
  /**
   * La fecha de la fila, y por lo que se ordena y por lo que se filtra:
   * `Match.startedAt` en una partida y `ObjectiveEvent.achievedAt` en un objetivo
   * cumplido. En un objetivo es el instante de la hazaña en las carreras de
   * civilización y el **fin del torneo** en los que se resuelven en caliente (que no
   * se registran hasta que el torneo ha terminado).
   */
  startedAt: Date;
  playerId: string;
  playerName: string;
  playerProfileId: number;
  /** Puntos que aporta la fila con el ruleset activo: los de la partida o los del objetivo. */
  points: number;
  /** El objetivo cumplido, o `null` si la fila es una partida. Ver el tipo. */
  objective: AdminObjectiveEvent | null;

  /* ------------------------------- Solo partidas ------------------------------ */

  /** `gameId` de AoE4World; `null` en una fila de objetivo. */
  gameId: string | null;
  opponentName: string | null;
  opponentProfileId: number | null;
  result: MatchResult | null;
  /**
   * Tamaño real del partido («1vs1», «2v2», «3v3»…), leído de `rawJson.teams`
   * y solo si la partida tiene dos bandos del mismo tamaño.
   *
   * No se puede sacar de `mode`/`leaderboard`: un ranked por equipos llega con
   * `leaderboard: "rm_team"`, que no dice cuántos juegan. `null` cuando el payload no
   * lo permite (y también en una fila de objetivo), y entonces la interfaz cae en
   * `describeMode`.
   */
  teamSize: string | null;
  mode: string | null;
  /** Literal de AoE4World (`rm_solo`, `rm_2v2`…); el copy puede necesitarlo. */
  leaderboard: string | null;
  map: string | null;
  /** Instante del revert, o `null` si la partida cuenta (o si la fila no es de partida). */
  revertedAt: Date | null;
};

/**
 * El filtro de resultado de la URL, ya validado.
 *
 * Solo `WIN` y `LOSS` son válidos y cualquier otra cosa se trata como **ausencia de
 * filtro**, igual que el `playerId` mal formado: una URL manipulada con
 * `?resultado=TODAS` se comporta como si no filtrara, en vez de devolver cero filas y
 * hacer creer que ese jugador no tiene ninguna partida. El listado solo trae
 * clasificatorias resueltas (`classificatoryWhere` exige `result is not null`), así
 * que un `result` nulo nunca llega a la tabla: no hace falta un valor para "sin
 * resolver".
 */
function readResultFilter(value: AdminQueryParam): MatchResult | null {
  const raw = readSingleParam(value);

  return raw === MatchResult.WIN || raw === MatchResult.LOSS ? raw : null;
}

/**
 * Los filtros del historial, ya validados.
 *
 * Se resuelven en un sitio y se reparten entre las dos consultas del feed (las partidas
 * y los objetivos), y por eso son un tipo y no tres valores sueltos: es lo que hace
 * imposible que las dos mitadas del merge se filtren por cosas distintas.
 */
export type AdminHistoryFilters = {
  /** `Player.id` con forma de `cuid`, o `null` si no hay filtro. */
  playerId: string | null;
  /** Rango sobre `Match.startedAt` y, con los mismos límites, sobre `achievedAt`. */
  rango: AdminDateRange;
  /** `WIN`, `LOSS` o `null`. Cuando no es `null`, **excluye los objetivos**. */
  resultado: MatchResult | null;
};

/**
 * Los filtros del historial, ya validados y listos para sus dos consultas.
 *
 * El filtro de **resultado** no se propaga a los objetivos, y es a propósito: un hito no
 * es ni una victoria ni una derrota, y quien escribe `?resultado=WIN` está buscando las
 * victorias de alguien, no sus hitos. El filtro de **orden** por resultado no tiene nada
 * que ver con este y sí llega a las dos mitades.
 *
 * Exportado para `npm run verify:sync`: son funciones puras y son donde se decide qué
 * hace una URL manipulada.
 */
export function readHistoryFilters(query: AdminMatchHistoryQuery): AdminHistoryFilters {
  return {
    playerId: readPlayerIdFilter(query.playerId),
    rango: dateRangeWhere(query.from, query.to),
    resultado: readResultFilter(query.resultado),
  };
}

/**
 * Campos de `ObjectiveEvent` que se leen. `objectiveId` es la clave única de la fila
 * y a la vez el id del objetivo en el catálogo.
 */
const OBJECTIVE_EVENT_SELECT = {
  objectiveId: true,
  achievedAt: true,
  playerId: true,
  player: { select: { name: true, profileId: true } },
} satisfies Prisma.ObjectiveEventSelect;

/**
 * Rango de una fila dentro de la columna de resultado del historial: 0 objetivo,
 * 1 victoria, 2 derrota.
 *
 * El criterio es **de lo mejor a lo peor**, y es una decisión: la columna muestra tres
 * cosas distintas —"Objetivo", "Victoria", "Derrota"— y recorrerla en diagonal tiene que
 * enseñar primero lo que primero se busca. Los hitos son lo raro y lo que más información
 * da (≤ 38 en toda la vida del torneo, frente a decenas de miles de partidas), así que
 * van delante; detrás quedan victorias y derrotas, que ya son el grueso, y donde lo
 * útil es agrupar por signo —"¿cuántas ha perdido?"—, que es justo lo que hace la
 * segunda pulsación de la cabecera.
 *
 * El cuarto rango (3) es para una partida sin resultado, que **no llega nunca** al feed:
 * `classificatoryWhere()` exige `result is not null`. El tipo de la fila lo admite, y un
 * orden total tiene que decidir en vez de dejar un `undefined` en el comparador, así que
 * va al final en los dos sentidos, como los nulos del sujeto en las alertas.
 */
function historyResultRank(row: AdminMatchHistoryRow): number {
  if (row.objective !== null) {
    return 0;
  }

  if (row.result === "WIN") {
    return 1;
  }

  return row.result === "LOSS" ? 2 : 3;
}

/**
 * El comparador del feed mezclado, para el orden que se ha pedido.
 *
 * ## Todo orden es total
 *
 * Es lo que necesita la paginación, igual que lo necesitaba el orden por fecha: sin un
 * desempate único, dos filas del mismo instante pueden salir en cualquier orden entre sí
 * y una página puede repetir o perder filas de la anterior. Los dos órdenes terminan en
 * la **clave propia de cada clase** (`Match.id` y `ObjectiveEvent.objectiveId`), que es
 * única dentro de cada lista, así que no quedan dos filas empatadas.
 *
 * ## `dir` invierte el orden entero
 *
 * `asc` es el inverso exacto de `desc`, desempate y criterio de clase incluidos. Es lo que
 * espera quien pulsa por segunda vez una cabecera, y además es lo que garantiza que dos
 * páginas del mismo filtro no se solapen. Por eso **todos** los criterios se multiplican
 * por el mismo signo y ninguno se queda fuera: un criterio que no se invirtiera rompería
 * esa promesa sin ganar nada a cambio.
 *
 * ## Los criterios, en orden
 *
 * - **`resultado`**: el rango de resultado (objetivo, victoria, derrota), luego la fecha,
 *   luego la clase y la clave. El criterio de clase no decide nada aquí, porque dentro de
 *   un rango las dos clases de fila ya son la misma: el rango 0 es solo de objetivos y los
 *   otros dos, solo de partidas.
 * - **`fecha`** (por defecto): la fecha, luego **la partida antes que el objetivo** si
 *   comparten instante, luego la clave. Ese criterio de clase es el que completa el orden
 *   total y además el que mejor se lee en el orden por defecto, porque casi siempre la
 *   partida es la fila que explica el hito y así va delante.
 *
 * Exportado para `npm run verify:sync`, que lo comprueba con filas sintéticas: que sea un
 * orden **total**, que `asc` sea el inverso de `desc` y que no reordene las mitadas que
 * llegan ya ordenadas de sus consultas. Son las tres condiciones de las que depende que la
 * página sea una ventana real del feed, y no se pueden comprobar contra la base de datos
 * sin escribir en ella.
 */
export function historyComparator(
  sort: AdminHistorySort,
): (a: AdminMatchHistoryRow, b: AdminMatchHistoryRow) => number {
  // `1` en `desc`, que es el sentido por defecto, y `-1` en `asc`. **Todos** los
  // criterios se multiplican por este signo, y todos se calculan con la misma
  // convención: un número positivo significa "a va después de b en descendente".
  const signo = sort.dir === "desc" ? 1 : -1;

  return (a, b) => {
    if (sort.key === "resultado") {
      const porResultado = historyResultRank(b) - historyResultRank(a);

      if (porResultado !== 0) {
        return porResultado * signo;
      }
    }

    const porFecha = b.startedAt.getTime() - a.startedAt.getTime();

    if (porFecha !== 0) {
      return porFecha * signo;
    }

    const aEsPartida = a.objective === null;

    if (aEsPartida !== (b.objective === null)) {
      return (aEsPartida ? -1 : 1) * signo;
    }

    // La clave de cada clase de fila, con la misma convención que el resto: en
    // descendente va la mayor primero, que es lo que hacen los dos `orderBy`.
    const porClave = a.id < b.id ? 1 : a.id > b.id ? -1 : 0;

    return porClave * signo;
  };
}

/**
 * Orden de las **partidas** del feed, en `orderBy` de Prisma.
 *
 * Tiene que ser el mismo orden que devuelve `historyComparator()` recortado a la clase
 * de las partidas, porque el merge compara las dos mitades: si la consulta las trajera
 * en otro orden, la página dejaría de ser una ventana del feed real.
 *
 * En `resultado` el `result` va primero y luego la fecha y la clave. El `result` es
 * `not null` en este listado (`classificatoryWhere`), así que su orden no tiene nulos
 * que colocar y no hace falta ninguna regla para ellos.
 */
const MATCH_HISTORY_ORDER_BY: Record<
  AdminHistorySort["key"],
  (dir: AdminSortDir) => Prisma.MatchOrderByWithRelationInput[]
> = {
  fecha: (dir) => [{ startedAt: dir }, { id: dir }],
  resultado: (dir) => [{ result: dir }, { startedAt: dir }, { id: dir }],
};

/**
 * Orden de los **objetivos** del feed, en `orderBy` de Prisma.
 *
 * Es el mismo en los dos órdenes, y no es una casualidad: un objetivo es siempre rango
 * 0 en la columna de resultado, así que ordenar por resultado no le cambia el sitio
 * relativo a nada y solo quedan la fecha y su clave.
 */
function objectiveEventOrderBy(dir: AdminSortDir): Prisma.ObjectiveEventOrderByWithRelationInput[] {
  return [{ achievedAt: dir }, { objectiveId: dir }];
}

/** Una fila de `Match`, con los datos de partida resueltos y los de objetivo a `null`. */
function partidaEnFila(
  row: {
    id: string;
    gameId: string;
    startedAt: Date;
    playerId: string;
    opponentName: string | null;
    opponentProfileId: number | null;
    result: MatchResult | null;
    points: number;
    mode: string | null;
    leaderboard: string;
    map: string | null;
    revertedAt: Date | null;
    rawJson: unknown;
    player: { name: string; profileId: number };
  },
): AdminMatchHistoryRow {
  return {
    id: row.id,
    startedAt: row.startedAt,
    playerId: row.playerId,
    playerName: row.player.name,
    playerProfileId: row.player.profileId,
    points: row.points,
    objective: null,
    gameId: row.gameId,
    opponentName: row.opponentName,
    opponentProfileId: row.opponentProfileId,
    result: row.result,
    // El tamaño se resuelve aquí y no en la interfaz: `rawJson` es el payload
    // literal de la API y no debe salir del DAL.
    teamSize: describeTeamSize(teamSizesFromRawJson(row.rawJson)),
    mode: row.mode,
    leaderboard: row.leaderboard,
    map: row.map,
    revertedAt: row.revertedAt,
  };
}

/**
 * El hueco que hay que traer de partidas para servir una página del feed mezclado.
 *
 * Con `skip` el desplazamiento de la página **en el feed** y `eventosAntes` los
 * objetivos que pasan el filtro (los que van delante de la página en el peor caso):
 *
 * - `skipPartidas`: de dónde se leen las partidas. En el peor caso, los `eventosAntes`
 *   objetivos van todos antes de la página, así que la primera fila de la página está,
 *   como mucho, en la posición `skip - eventosAntes` de la lista de partidas. Antes de
 *   ese punto no hace falta traer nada.
 * - `takePartidas`: cuántas. `skip + pageSize - skipPartidas`, y **no** `pageSize` a
 *   secas: si la página tiene objetivos intercalados, con `pageSize` saldrían menos
 *   filas de las que la página pide.
 * - `desde`: el índice de la lista combinada que corresponde al inicio de la página. La
 *   combinada empieza en la partida número `skipPartidas`, así que lo que se ha dejado
 *   atrás son `skipPartidas` filas; con `skip < eventosAntes` no se ha saltado ninguna
 *   partida y el índice es `skip` directamente.
 *
 * **No depende del eje del orden**, y por eso el orden por resultado no necesita otro
 * hueco: solo cuenta cuántas filas del otro lado del merge caben en las `skip` posiciones
 * anteriores. Lo que sí necesita el eje nuevo es que el comparador sea un orden total y
 * que las dos mitadas lleguen en ese mismo orden, que es de `historyComparator()`.
 *
 * Exportado para `npm run verify:sync`, que pagina el feed entero con esta aritmética y
 * comprueba que ninguna fila se repite ni se pierde.
 */
export function historyHole(
  skip: number,
  pageSize: number,
  eventosAntes: number,
): { skipPartidas: number; takePartidas: number; desde: number } {
  const skipPartidas = Math.max(0, skip - eventosAntes);

  return {
    skipPartidas,
    takePartidas: skip + pageSize - skipPartidas,
    desde: skip - skipPartidas,
  };
}

/**
 * Los objetivos cumplidos que pasan el filtro, ya en filas del historial.
 *
 * Se piden **todos** (no una página): son como mucho 38 filas en toda la vida del
 * torneo, y hace falta el recuento para saber cuántas hay que colar antes de la
 * primera partida de la página.
 *
 * Vienen en el mismo orden que el comparador del merge (`objectiveEventOrderBy()`), que
 * es lo que permite que la mezcla siga siendo correcta cuando el `sort` cambia el eje
 * del feed: si se pidieran en otro orden, la concatenación de las dos mitades no sería
 * el feed.
 *
 * Una fila cuyo `objectiveId` no está en el catálogo se descarta con un aviso en el
 * log en vez de publicarse a medias: solo puede existir si alguien insertó la fila a
 * mano (el motor borra las que no corresponden en cada recálculo), y una fila de hito
 * sin etiqueta ni puntos no dice nada.
 */
async function eventosDeObjetivo(
  where: Prisma.ObjectiveEventWhereInput,
  ruleset: ScoringRuleset,
  dir: AdminSortDir,
): Promise<AdminMatchHistoryRow[]> {
  const filas = await db.objectiveEvent.findMany({
    where,
    orderBy: objectiveEventOrderBy(dir),
    select: OBJECTIVE_EVENT_SELECT,
  });

  const rows: AdminMatchHistoryRow[] = [];

  for (const fila of filas) {
    const objetivo = resolveObjective(fila.objectiveId, ruleset);

    if (objetivo === null) {
      console.warn(
        `[admin] Objetivo "${fila.objectiveId}": no está en el catálogo, su evento no se muestra.`,
      );
      continue;
    }

    rows.push({
      id: objetivo.id,
      // La fecha del feed. En las carreras de civilización es el instante de la
      // hazaña y en los objetivos "en caliente" el fin del torneo.
      startedAt: fila.achievedAt,
      playerId: fila.playerId,
      playerName: fila.player.name,
      playerProfileId: fila.player.profileId,
      points: objetivo.points,
      objective: {
        id: objetivo.id,
        label: objetivo.label,
        group: objetivo.group,
        metric: objetivo.metric,
        points: objetivo.points,
      },
      // Un objetivo no tiene rival, formato, mapa ni resultado: `null` es "no
      // aplica", no "faltan datos".
      gameId: null,
      opponentName: null,
      opponentProfileId: null,
      result: null,
      teamSize: null,
      mode: null,
      leaderboard: null,
      map: null,
      // Y no tiene acción: revertir o restaurar son de `Match`, no hay nada que
      // deshacer en un hito.
      revertedAt: null,
    });
  }

  return rows;
}

/**
 * Historial del torneo: **partidas clasificatorias y objetivos cumplidos**, mezclados
 * en un solo feed, paginados en servidor y de lo más reciente a lo más antiguo.
 *
 * ## Las partidas
 *
 * **Solo clasificatorias, y con las revertidas dentro marcadas.** El filtro sale de
 * `classificatoryWhere()` —la misma regla del motor *sin* la condición de revertida—
 * y `revertedAt` viaja en cada fila para que la interfaz marque las que no cuentan.
 * Es el motivo de que ese filtro se exporte aparte en `ranked-match.ts`: si el
 * listado usara `rankedMatchWhere()`, la partida revertida desaparecería del
 * histórico y no habría nada que volver a mirar ni que deshacer.
 *
 * **Se pagina en servidor** porque el histórico de un torneo son decenas de miles de
 * filas, y mandarlas todas al navegador en el *payload* de RSC no es una opción.
 *
 * ## Los objetivos
 *
 * Los eventos de `ObjectiveEvent`: un objetivo cumplido por jugador, como mucho uno
 * por objetivo del catálogo (38 en total), escritos por el motor de puntuación. Se
 * filtran con el **mismo jugador y las mismas fechas** (sobre `achievedAt`, con los
 * mismos límites), y **no salen si hay filtro de resultado**: un objetivo no es ni
 * una victoria ni una derrota, y quien escribe `?resultado=WIN` está buscando las
 * victorias de alguien, no sus hitos.
 *
 * ## El merge, y por qué sale barato
 *
 * Los eventos son ≤ 38, así que se piden enteros (y por el mismo motivo no se pueden
 * pedir en paralelo con las partidas: el hueco de partidas depende de cuántos son). El
 * hueco que hay que traer y por dónde se recorta la página están en `historyHole()`, que
 * explica la aritmética y que **no depende del eje del orden**: solo cuenta cuántas filas
 * del otro lado del merge caben en las posiciones anteriores. Por eso el
 * `?sort=resultado` reutiliza el mismo hueco y lo único que cambia son los dos `orderBy`.
 *
 * ## El filtro de clasificatorias sale del ruleset activo
 *
 * Igual que el motor: si la organización cambia la ventana o las familias sin
 * desplegar, el historial cambia con ella.
 */
export async function getAdminMatchHistory(
  query: AdminMatchHistoryQuery = {},
): Promise<PublicRead<AdminPage<AdminMatchHistoryRow, AdminHistorySort>>> {
  return readFromDatabase("admin/getAdminMatchHistory", async () => {
    const page = readBoundedInt(query.page, { min: 1, max: 100_000, fallback: 1 });
    const pageSize = readBoundedInt(query.pageSize, {
      min: 1,
      max: MAX_PAGE_SIZE,
      fallback: DEFAULT_PAGE_SIZE,
    });

    const ruleset = await readRuleset();
    const sort = readHistorySort(query);
    const filtros = readHistoryFilters(query);
    const { playerId, rango, resultado } = filtros;

    // Los filtros se suman, no se eligen: `where` es una conjunción, así que jugador
    // + fechas + resultado se combinan solos. No hace falta ninguna lógica de "si hay
    // dos, el segundo gana", que es justo donde estos filtros se suelen equivocar.
    const where: Prisma.MatchWhereInput = {
      ...classificatoryWhere(ruleset.modes, ruleset.window),
      ...(playerId === null ? {} : { playerId }),
      ...(hasDateBounds(rango) ? { startedAt: rango } : {}),
      ...(resultado === null ? {} : { result: resultado }),
    };

    // Los mismos filtros para los hitos, sobre su columna de fecha. Sin el de
    // resultado, por lo que dice el docblock de la función.
    const eventosWhere: Prisma.ObjectiveEventWhereInput = {
      ...(playerId === null ? {} : { playerId }),
      ...(hasDateBounds(rango) ? { achievedAt: rango } : {}),
    };

    return adminPage<AdminMatchHistoryRow, AdminHistorySort>(async (wanted) => {
      const skip = (wanted - 1) * pageSize;

      // Los eventos salen enteros y antes que las partidas, porque el hueco de
      // partidas depende de cuántos sean. El `count` de partidas no depende de eso, así
      // que sí se pide en paralelo con ellos.
      const [eventos, totalPartidas] = await Promise.all([
        resultado === null ? eventosDeObjetivo(eventosWhere, ruleset, sort.dir) : [],
        db.match.count({ where }),
      ]);

      // El hueco acotado del docblock de `historyHole()`, y no `pageSize` a secas: una
      // página puede tener eventos delante y, si solo se trajeran `pageSize` partidas,
      // saldrían menos filas de las que la página pide.
      const eventosAntes = eventos.length;
      const { skipPartidas, takePartidas, desde } = historyHole(skip, pageSize, eventosAntes);

      const partidas = await db.match.findMany({
        where,
        orderBy: MATCH_HISTORY_ORDER_BY[sort.key](sort.dir),
        skip: skipPartidas,
        take: takePartidas,
        select: {
          id: true,
          gameId: true,
          startedAt: true,
          playerId: true,
          opponentName: true,
          opponentProfileId: true,
          result: true,
          points: true,
          mode: true,
          leaderboard: true,
          map: true,
          revertedAt: true,
          rawJson: true,
          player: { select: { name: true, profileId: true } },
        },
      });

      const combined = [...partidas.map(partidaEnFila), ...eventos].sort(
        historyComparator(sort),
      );

      // `desde` es el índice de `combined` que corresponde a la posición `skip` del
      // feed, según el mismo docblock de `historyHole()`.
      return {
        total: totalPartidas + eventosAntes,
        rows: combined.slice(desde, desde + pageSize),
      };
    }, page, pageSize, sort);
  });
}

/* -------------------------------------------------------------------------- */
/* Historial de acciones                                                       */
/* -------------------------------------------------------------------------- */

/** Una acción del panel, con el `summary` ya redactado. */
export type AdminActionRow = {
  id: string;
  type: AdminActionType;
  /** Correo de la persona que la hizo. */
  actorEmail: string;
  /** La línea en español, tal cual se pinta. Su forma la fija `admin-actions.ts`. */
  summary: string;
  /** `Player.id` o `Match.id` de la fila afectada; `null` si la acción no tiene. */
  targetId: string | null;
  /**
   * Los datos estructurados de la acción, **aplanados**: solo valores primitivos de
   * un nivel.
   *
   * Se aplana a propósito. `details` es un `Json` cuya forma cambia con cada
   * `type`, y publicarlo entero obligaría a la interfaz a validar en cliente lo que
   * el proyecto valida en el servidor. Con un nivel y primitivos, el contrato es
   * cerrado: lo que no entre aquí, no sale.
   */
  details: Record<string, string | number | boolean> | null;
  createdAt: Date;
};

/**
 * El `details` de una acción, validado.
 *
 * Se lee como `unknown` porque la columna es `Json`: lo que escribió la acción
 * puede ser de otra versión del código (una fila de hace un mes, cuando el tipo
 * tenía otros campos). Los valores que no son primitivos de primer nivel se
 * descartan en vez de inventar una forma que la interfaz tendría que comprobar en
 * cada celda.
 */
function readDetails(value: unknown): Record<string, string | number | boolean> | null {
  if (!isRecord(value)) {
    return null;
  }

  const details: Record<string, string | number | boolean> = {};
  let hayValores = false;

  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "string" || typeof raw === "boolean") {
      details[key] = raw;
      hayValores = true;
    } else if (typeof raw === "number" && Number.isFinite(raw)) {
      details[key] = raw;
      hayValores = true;
    }
  }

  return hayValores ? details : null;
}

/** Parámetros del historial de acciones, tal como llegan de la URL. */
export type AdminActionsQuery = AdminPageQuery & AdminSortQuery;

/**
 * Historial de acciones del admin, de la más reciente a la más antigua.
 *
 * Se lee tal cual, `summary` incluido, para que la interfaz no tenga que montar la
 * frase ni hacer un `join` por `targetId` para pintar algo que ya está escrito: el
 * formato lo decide `admin-actions.ts` y esta lectura solo lo publica.
 *
 * Paginada en servidor por el mismo motivo que el historial de partidas, y con
 * `id` de desempate del orden por la misma razón: dos acciones del mismo milisegundo
 * tienen que tener un orden estable para que la paginación no las mezcle.
 *
 * ## El `where` lo usan las dos consultas
 *
 * Hoy esta lista **no tiene filtros** —es un rastro que se lee entero y son pocas
 * filas—, así que el `where` está vacío. Se construye igualmente y lo comparten el
 * `findMany` y el `count`, porque es lo que hace imposible la afirmación falsa: contar
 * sin el filtro de la consulta daría una paginación que miente ("página 1 de 40"
 * con un filtro que deja tres filas), y en cuanto esta lista reciba un filtro ese
 * error aparecería solo.
 */
export async function getAdminActions(
  query: AdminActionsQuery = {},
): Promise<PublicRead<AdminPage<AdminActionRow, AdminActionsSort>>> {
  return readFromDatabase("admin/getAdminActions", async () => {
    const page = readBoundedInt(query.page, { min: 1, max: 100_000, fallback: 1 });
    const pageSize = readBoundedInt(query.pageSize, {
      min: 1,
      max: MAX_PAGE_SIZE,
      fallback: DEFAULT_PAGE_SIZE,
    });
    const sort = readActionsSort(query);

    const where: Prisma.AdminActionWhereInput = {};

    return adminPage<AdminActionRow, AdminActionsSort>(async (wanted) => {
      const [rows, total] = await Promise.all([
        db.adminAction.findMany({
          where,
          orderBy: ACTION_ORDER_BY[sort.key](sort.dir),
          skip: (wanted - 1) * pageSize,
          take: pageSize,
          select: {
            id: true,
            type: true,
            actorEmail: true,
            summary: true,
            targetId: true,
            details: true,
            createdAt: true,
          },
        }),
        db.adminAction.count({ where }),
      ]);

      return {
        total,
        rows: rows.map((row) => ({
          id: row.id,
          type: row.type,
          actorEmail: row.actorEmail,
          summary: row.summary,
          targetId: row.targetId,
          details: readDetails(row.details),
          createdAt: row.createdAt,
        })),
      };
    }, page, pageSize, sort);
  });
}

/* -------------------------------------------------------------------------- */
/* Alertas de comportamiento                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Una alerta disparada, tal y como la pinta la pestaña de alertas.
 *
 * ## Por qué `rule` y `ruleLabel` viajan los dos
 *
 * `rule` es el identificador estable, el que se puede filtrar o contrastar con la tabla;
 * `ruleLabel` es su nombre en español y sale de `ALERT_RULE_LABELS` (el dominio de
 * alertas). Publicar las dos cosas evita que cada sitio que pinte una fila decida cómo se
 * llama la regla: el informe descargable y el panel leerían la misma alerta con dos
 * nombres distintos en cuanto uno de los dos se tocara.
 *
 * ## Lo que no viaja
 *
 * Ni `threshold` ni `anchorGameId` ni `details`: esta fila es para leer de un vistazo, y
 * lo que hay detrás está en el informe descargable y en `Alert`. El `summary` sí viaja
 * entero, redactado por el motor al escribir la fila, y se pinta tal cual —montar la
 * frase en el componente daría dos textos para el mismo hallazgo—.
 */
export type AdminAlertRow = {
  /** `Alert.id`. */
  id: string;
  /** Cuándo se detectó: es también por lo que se ordena la lista. */
  createdAt: Date;
  /** `Alert.rule`: el identificador estable de la regla. */
  rule: AlertRule;
  /** Cómo se llama esa regla en español (`ALERT_RULE_LABELS`). */
  ruleLabel: string;
  /** `Alert.kind`: si la racha se rompió, la cerró el torneo o se cruzó un acumulado. */
  kind: AlertKind;
  /** Nombre de display del jugador, del `join` con `Player` (nunca del texto de la alerta). */
  playerName: string;
  playerProfileId: number;
  /** El rival o el compañero al que se refiere, o `null` en las reglas sin sujeto. */
  subjectName: string | null;
  subjectProfileId: number | null;
  /** Magnitud del hallazgo: partidas de la racha o del acumulado. */
  count: number;
  /** La frase en español, tal cual se pinta. La redacta `alertSummary()`. */
  summary: string;
};

/**
 * Lo que se lee de cada fila de `Alert`.
 *
 * El nombre del jugador no está en la alerta (a propósito: un nombre guardado se
 * quedaría congelado el día que alguien se renombre), así que sale del `join`.
 */
const ALERT_SELECT = {
  id: true,
  createdAt: true,
  rule: true,
  kind: true,
  subjectName: true,
  subjectProfileId: true,
  count: true,
  summary: true,
  player: { select: { name: true, profileId: true } },
} satisfies Prisma.AlertSelect;

/**
 * Parámetros de la tabla de alertas, tal como llegan de la URL.
 *
 * | Parámetro | Filtra por | Valores admitidos |
 * |---|---|---|
 * | `from` / `to` | `Alert.createdAt` | fecha `YYYY-MM-DD` o instante con zona, con los mismos bordes que el historial |
 * | `playerId` | `Alert.playerId` | un `Player.id` con forma de `cuid` |
 * | `regla` | `Alert.rule` | uno de los ocho `AlertRule` |
 * | `tipo` | `Alert.kind` | `STREAK_CLOSED`, `STREAK_AT_TOURNAMENT_END`, `TOTAL_REACHED` |
 *
 * Los cuatro se combinan (es una conjunción), y los tres que son una lista usan
 * **allowlist**: un valor que no está en la lista es ausencia de filtro, no "cero alertas
 * con esa regla", que sería una afirmación falsa sobre una URL manipulada.
 *
 * `tipo` no es una columna de la tabla —el tipo se pinta como distintivo dentro de la de
 * regla—, pero sí es el cuarto criterio por el que se recorta una tabla de avisos: "solo
 * lo que rompió una racha", "solo los acumulados que se alcanzaron".
 */
export type AdminAlertsQuery = AdminPageQuery &
  AdminSortQuery & {
    /** `Player.id` (no `profileId`): el mismo id que usan los formularios de admin. */
    playerId?: AdminQueryParam;
    /** Límite inferior **inclusivo** de fechas sobre `createdAt`. */
    from?: AdminQueryParam;
    /** Límite superior **exclusivo** de fechas sobre `createdAt`. */
    to?: AdminQueryParam;
    /** Un `AlertRule`; cualquier otra cosa se trata como ausencia de filtro. */
    regla?: AdminQueryParam;
    /** Un `AlertKind`; cualquier otra cosa se trata como ausencia de filtro. */
    tipo?: AdminQueryParam;
  };

/** Un `AlertRule` de la URL, ya validado. */
function readAlertRuleFilter(value: AdminQueryParam): AlertRule | null {
  const raw = readSingleParam(value);

  return raw !== null && isAlertRule(raw) ? raw : null;
}

/** Un `AlertKind` de la URL, ya validado. */
function readAlertKindFilter(value: AdminQueryParam): AlertKind | null {
  const raw = readSingleParam(value);

  return raw !== null && isAlertKind(raw) ? raw : null;
}

/**
 * ¿Es un `AlertRule` del enum?
 *
 * Allowlist contra el enum generado, y no contra una lista escrita aquí: una regla nueva
 * —que exige un cambio de esquema, así que es un cambio de código— se puede filtrar en
 * cuanto existe, y sin tener que acordarse de añadirla a dos sitios. Lo que no se acepta
 * es un valor inventado, porque entonces el filtro sería una afirmación falsa.
 */
function isAlertRule(value: string): value is AlertRule {
  return (Object.values(AlertRule) as string[]).includes(value);
}

/** ¿Es un `AlertKind` del enum? Con la misma Allowlist que `isAlertRule()`. */
function isAlertKind(value: string): value is AlertKind {
  return (Object.values(AlertKind) as string[]).includes(value);
}

/**
 * Los filtros de la tabla de alertas, ya validados.
 *
 * El rango es el mismo que el del historial y con los mismos bordes: un `?to` tiene que
 * incluir el día entero en las dos tablas, y sería una sorpresa que en una significara
 * algo distinto.
 */
export type AdminAlertsFilters = {
  /** `Player.id` con forma de `cuid`, o `null` si no hay filtro. */
  playerId: string | null;
  /** Rango sobre `Alert.createdAt`. */
  rango: AdminDateRange;
  /** La regla, o `null`. */
  regla: AlertRule | null;
  /** El tipo de alerta (`kind`), o `null`. */
  kind: AlertKind | null;
};

/**
 * Los filtros de la tabla de alertas, ya validados y listos para el `where`.
 *
 * Exportado para `npm run verify:sync`: son funciones puras y son donde se decide qué
 * hace una URL manipulada (`?regla=inventada`, `?tipo=GANADOR`, `?from=2026-02-31`).
 */
export function readAlertsFilters(query: AdminAlertsQuery): AdminAlertsFilters {
  return {
    playerId: readPlayerIdFilter(query.playerId),
    rango: dateRangeWhere(query.from, query.to),
    regla: readAlertRuleFilter(query.regla),
    kind: readAlertKindFilter(query.tipo),
  };
}

/**
 * Alertas disparadas, de la más reciente a la más antigua y paginadas, con sus filtros
 * y su orden en la URL.
 *
 * ## Qué se filtra y qué no, y por qué
 *
 * Se filtra por **fecha, jugador, regla y tipo**. Los tres primeros son columnas de la
 * tabla y el cuarto se pinta como distintivo dentro de la de regla, pero es el criterio por
 * el que más se recorta una tabla de avisos —"solo lo que rompió una racha", "solo los
 * acumulados que se alcanzaron"— y por eso tiene su propio parámetro en vez de quedar
 * metido en la regla.
 *
 * **No** hay filtro por sujeto, por detalle ni por conteo, y es una decisión del cliente
 * y no un hueco:
 *
 * - El **sujeto** es el nombre de alguien que puede no estar en la liga (es lo normal en
 *   un torneo individual), así que no hay una lista de la que elegir: un desplegable
 *   tendría que ser un buscador sobre la propia tabla.
 * - El **detalle** es una frase redactada por el motor ("3 partidas seguidas contra
 *   Marta"), y filtrar por un trozo de texto libre no es un filtro, es un buscador.
 * - El **conteo** es un número, y con la vista se escanea; un filtro por él solo valdría
 *   para "solo las de 5 o más", que no es ninguna pregunta que alguien se haga con unos
 *   avisos.
 *
 * ## El orden es total a propósito
 *
 * Todos los órdenes acaban en `id`: dos alertas del mismo milisegundo tienen que tener un
 * orden estable, o una página podría repetir o perder filas de la anterior. El índice
 * `@@index([createdAt])` sostiene el orden por defecto, que es el que se usa casi siempre.
 *
 * `degraded` significa lo mismo que en el resto del módulo: **no se ha podido leer**, no
 * "no hay alertas". Un corte de la base dejaría la pestaña vacía y parecería que el
 * torneo está limpio, que es la afirmación más falsa que puede hacer esta pantalla.
 */
export async function getAdminAlerts(
  query: AdminAlertsQuery = {},
): Promise<PublicRead<AdminPage<AdminAlertRow, AdminAlertsSort>>> {
  return readFromDatabase("admin/getAdminAlerts", async () => {
    const page = readBoundedInt(query.page, { min: 1, max: 100_000, fallback: 1 });
    const pageSize = readBoundedInt(query.pageSize, {
      min: 1,
      max: MAX_PAGE_SIZE,
      fallback: DEFAULT_PAGE_SIZE,
    });
    const sort = readAlertsSort(query);
    const filtros = readAlertsFilters(query);

    // Un solo `where` para las **dos** consultas, como en el resto de listas con filtro:
    // un `count` que no contara lo mismo que la página daría una paginación falsa.
    const where: Prisma.AlertWhereInput = {
      ...(filtros.playerId === null ? {} : { playerId: filtros.playerId }),
      ...(hasDateBounds(filtros.rango) ? { createdAt: filtros.rango } : {}),
      ...(filtros.regla === null ? {} : { rule: filtros.regla }),
      ...(filtros.kind === null ? {} : { kind: filtros.kind }),
    };

    return adminPage<AdminAlertRow, AdminAlertsSort>(async (wanted) => {
      const [rows, total] = await Promise.all([
        db.alert.findMany({
          where,
          orderBy: ALERT_ORDER_BY[sort.key](sort.dir),
          skip: (wanted - 1) * pageSize,
          take: pageSize,
          select: ALERT_SELECT,
        }),
        db.alert.count({ where }),
      ]);

      return {
        total,
        rows: rows.map((row) => ({
          id: row.id,
          createdAt: row.createdAt,
          rule: row.rule,
          ruleLabel: ALERT_RULE_LABELS[row.rule],
          kind: row.kind,
          playerName: row.player.name,
          playerProfileId: row.player.profileId,
          subjectName: row.subjectName,
          subjectProfileId: row.subjectProfileId,
          count: row.count,
          summary: row.summary,
        })),
      };
    }, page, pageSize, sort);
  });
}

/**
 * Los **umbrales vivos** de las alertas de comportamiento, más la ventana del torneo.
 *
 * Existe para que el copy de las reglas no pueda mentir. Los umbrales están en
 * `Setting["alerts.ruleset"]` y se cambian sin desplegar (es lo mismo que los puntos por
 * victoria del motor de puntuación), así que un texto que dijera "tres partidas seguidas"
 * escrito en el componente sería falso en cuanto la organización retocara el número.
 * Publicando los umbrales efectivos, quien pinta decide el texto y el número salen de la
 * misma fuente.
 *
 * ## De dónde sale cada cosa
 *
 * - `version` y `thresholds` son del ruleset de alertas, leído con `readAlertsRuleset()`,
 *   que **no lanza**: un documento retocado a mano que no se entiende se descarta con un
 *   aviso y se usan los valores por defecto. Si no se ha publicado nunca, son los
 *   valores por defecto del código, que es lo que el motor estaría evaluando.
 * - `window` es del ruleset **de puntos**, y no del de alertas a propósito: las alertas no
 *   duplican la ventana (ver `src/lib/alerts/rules.ts`) para no tener dos verdades sobre
 *   qué se está midiendo. Es la misma ventana con la que `rankedMatchWhere()` filtra las
 *   clasificatorias que evalúa el motor.
 */
export type AdminAlertRules = {
  /** `AlertsRuleset.version`: la versión del documento de umbrales que se está usando. */
  version: number;
  /** Los umbrales efectivos, ya validados contra `DEFAULT_ALERTS_RULESET`. */
  thresholds: AlertsThresholds;
  /** Ventana del torneo sobre `Match.startedAt`, `[from, to)`; `to: null` = sin fin. */
  window: ScoringWindow;
};

/**
 * Los umbrales que están vigentes ahora, y la ventana que se está midiendo.
 *
 * Sin paginación ni `count`: son un documento de `Setting` y una ventana, no filas.
 */
export async function getAdminAlertRules(): Promise<PublicRead<AdminAlertRules>> {
  return readFromDatabase("admin/getAdminAlertRules", async () => {
    // Las dos lecturas son de `Setting` y no dependen la una de la otra, así que van en
    // paralelo: los umbrales de alertas y la ventana del ruleset de puntos.
    const [alerts, scoring] = await Promise.all([readAlertsRuleset(), readRuleset()]);

    return {
      version: alerts.version,
      thresholds: alerts.thresholds,
      window: scoring.window,
    };
  });
}
