import "server-only";

import { Prisma } from "@/generated/prisma/client";
import { AdminActionType, AlertKind, AlertRule, MatchResult, ObjectiveLeadKind, PlayerStatus } from "@/generated/prisma/enums";
import { ALERT_RULE_LABELS, alertEditionWhere, anchorInstant, readAlertsRuleset, type AlertsThresholds } from "@/lib/alerts";
import { db } from "@/lib/db";
import { readFromDatabase, type PublicRead } from "@/lib/db-errors";
import { describeTeamSize, formatRelativeTime, teamSizesFromRawJson } from "@/lib/format";
import {
  compareFeedInstants,
  historyFeedPage,
  historyFeedWindows,
  type HistoryFeedWindow,
} from "@/lib/history-feed";
import { isRecord } from "@/lib/json";
import { resolveObjective } from "@/lib/objective-events";
import { OBJECTIVE_LEAD_RANK } from "@/lib/objective-leads";
import { OBJECTIVE_IDS, type ObjectiveGroup, type ObjectiveMetric } from "@/lib/objectives";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  dateRangeWhere,
  hasDateBounds,
  paginate,
  readBoundedInt,
  readSingleParam,
  type DateRange,
  type QueryParam,
} from "@/lib/query-params";
import { classificatoryWhere, windowBounds, type ScoringWindow } from "@/lib/ranked-match";
import {
  RULESET_VERSION,
  playerObjectiveAwards,
  readRuleset,
  type ScoringRuleset,
} from "@/lib/scoring";
import { isSyncTraceStale, readGamesCursor, readSyncRunTrace, type GamesBatchError, type SyncRunTrace } from "@/lib/settings";
import { backfillProgressStalled } from "@/lib/aoe4world/sync";

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
 * pendiente que tienen `/puntuacion` y `/objetivos` con los números del ruleset de puntos.
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
 *   orden por fecha de las tres listas, y la razón por la que el comparador del feed
 *   mezclado y los dos `orderBy` tienen que decir exactamente lo mismo.
 */

/* -------------------------------------------------------------------------- */
/* Parámetros de la URL                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Un valor de `searchParams`, tal como lo entrega Next.
 *
 * Es un alias del tipo compartido (`QueryParam` de `src/lib/query-params.ts`), que es
 * donde vive la validación desde que el historial público necesita los mismos filtros.
 * Se conserva el nombre del panel porque es el que usan sus tipos de query, y porque
 * "un parámetro del admin" y "un parámetro de la web" no tienen por qué coincidir el
 * día que una de las dos admita algo que la otra no.
 */
export type AdminQueryParam = QueryParam;

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

/**
 * Resuelve una página de un listado paginado del panel.
 *
 * El ajuste de la página al rango real —una URL que pide la 7 con un filtro que solo
 * tiene dos páginas devuelve la última con filas— y el reparto de páginas los hace
 * `paginate()` (`src/lib/query-params.ts`), que es lo que comparte con el historial
 * público. Aquí solo se le añade el **orden efectivo**, que es lo que publica cada
 * lista del panel y lo que el historial público no tiene (su orden es fijo).
 */
async function adminPage<T, S>(
  load: (page: number) => Promise<{ rows: T[]; total: number }>,
  page: number,
  pageSize: number,
  sort: S,
): Promise<AdminPage<T, S>> {
  return { ...(await paginate(load, { page, pageSize })), sort };
}

/* -------------------------------------------------------------------------- */
/* Filtro de jugador de la URL                                                 */
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
 *
 * Es lo que queda de los filtros de la URL en este módulo, y es porque es **del
 * panel**: el `Player.id` interno no sale del admin, y las páginas públicas filtran por
 * `Player.profileId`. El resto —el rango de fechas, los enteros acotados y el ajuste de
 * la página— vive en `src/lib/query-params.ts`, que es lo que comparte con el historial
 * público.
 */
const PLAYER_ID_PATTERN = /^[a-z0-9]{1,64}$/;

/**
 * El filtro de jugador de la URL, ya validado.
 *
 * Lo comparten el historial y las alertas del panel, que filtran por `Player.id` los dos,
 * y por eso vive aquí y no en la sección de ninguna de las dos listas: dos copias del
 * mismo patrón acabarían discrepando en cuanto una aceptara algo más que la otra.
 *
 * Exportado para `npm run verify:sync`, que lo comprueba sin base de datos: es una
 * función pura y es justo donde se decide qué hace una URL manipulada.
 */
export function readPlayerIdFilter(value: AdminQueryParam): string | null {
  const raw = readSingleParam(value);

  return raw !== null && PLAYER_ID_PATTERN.test(raw) ? raw : null;
}

/**
 * El rango de fechas del panel, alias del compartido.
 *
 * `DateRange` de `src/lib/query-params.ts` es el tipo de verdad —lo usan el historial
 * público y las alertas—; se conserva el nombre del panel para no reescribir los tipos
 * de sus filtros, y porque son dos lecturas distintas con derecho a separarse.
 */
export type AdminDateRange = DateRange;

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
 * - **Tipo de alerta** (`kind`): son cuatro valores, se filtran con `?tipo=` y ya se
 *   pintan como distintivo en cada fila. Ordenarlos no respondería a nada que alguien
 *   se pregunte ("¿cuántas rachas rotas hay y cuántas acumuladas?"), y el filtro cubre
 *   la necesidad real.
 *
 * ## El detalle de cada columna
 *
 * - `sujeto` usa los **nulos al final en los dos sentidos**, no solo en ascendente: las
 *   reglas sin sujeto (R1 y las dos retiradas) son `null`, y en descendente mezclarlas con
 *   los nombres sacaría las alertas sin sujeto por delante de todo.
 * - `regla` ordena por el **enum**, y en Postgres un enum se ordena por el orden de sus
 *   valores en el esquema, no alfabéticamente por la etiqueta. Aquí eso sale bien: el
 *   esquema los declara en el orden de las reglas de comportamiento —las retiradas entre
 *   ellas, para agrupar las familias— y luego las de estado, así que ordenar por regla
 *   agrupa por familia, que es como se explican.
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
 * Orden del historial de puntos: por fecha.
 *
 * La fecha es `Match.startedAt` en una partida y `ObjectiveEvent.achievedAt` o
 * `ObjectiveLeadEvent.at` en un objetivo. El historial del panel enseña las mismas filas
 * que el público —victorias que suman, logros y cambios de poseedor—, y esas filas no
 * tienen un resultado común: una competición no es una victoria ni una derrota. Por eso
 * el único eje de orden es la fecha, y el desempate entre clases lo resuelve
 * `historyComparator()`.
 *
 * Exportado para `npm run verify:sync`, como el de las alertas.
 */
export type AdminHistorySort = {
  key: "fecha";
  dir: AdminSortDir;
};

/** Las columnas ordenables del historial. */
const HISTORY_SORT_COLUMNS = ["fecha"] as const satisfies readonly AdminHistorySort["key"][];

/** El orden efectivo del historial. */
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
 * de sus valores en el esquema (altas, bajas, cambios de puntos y ediciones, en el
 * orden en que están declarados) y no alfabéticamente por la etiqueta. Es el mismo
 * criterio que en la columna de regla de las alertas, y con la misma garantía de
 * desempate por `id`. Ojo con añadir un valor: `ALTER TYPE … ADD VALUE` solo añade al
 * final, así que un tipo nuevo nunca se cuela en medio de este orden.
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
 * `matchCount` y `points` vienen de la fila de `PlayerScore` y valen `null` cuando
 * el jugador **no** tiene fila en la clasificación: es el caso de todo el que no esté
 * aprobado. Un aprobado **sí** tiene fila desde que se aprueba, así que ahí ya no
 * sale `null` sino `0` (lo que trae mientras no haya jugado ninguna clasificatoria).
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
   * Identidad de Discord del participante (F12), **solo lectura**.
   *
   * No está en `CamposEditables` ni en `PlayerFormState`, y no es un descuido: el
   * panel **no** añade ni edita Discord. `discordUserId` es la prueba de que una
   * persona es quien dice ser —lo firma Discord con el paso OAuth2 de la
   * inscripción—, y una caja de texto en la que un admin escribiera un id sería un
   * campo de identidad que se rellena a mano, que es justo lo que el paso de OAuth
   * existe para evitar. Quien necesite corregir algo aquí lo hace desde Discord y
   * vuelve a hacer el paso.
   *
   * Llega **sin normalizar**, como los canales: `discordUsername` es el nombre de
   * usuario en el momento del vínculo y Discord permite renombrarse, así que aquí se
   * muestra tal cual está en la fila y no se "arregla" al leer.
   */
  discordUserId: string | null;
  /** Nombre de usuario de Discord, o `null` si la fila no tiene Discord vinculado. */
  discordUsername: string | null;
  /**
   * ¿Está la cuenta de Discord en el servidor del torneo? **Tres estados**, y la
   * distinción es lo que importa:
   *
   * - `true`: el worker lo ha comprobado con la lista de miembros del servidor.
   * - `false`: comprobado, y **no está**. Es el estado que genera la alerta
   *   `DISCORD_NOT_IN_GUILD`.
   * - `null`: sin comprobar. O no se ha comprobado nunca (el alta de admin, hasta que
   *   el worker encuentre la cuenta por el `@usuario`), o no se ha podido comprobar
   *   (un fallo de la API de Discord, o una lista de miembros vacía porque al bot le
   *   falta el intent privilegiado). **Nunca** significa "no está": eso solo puede
   *   salir de una respuesta de Discord.
   *
   * Llega junto a `discordUsername` porque con las dos columnas la interfaz puede
   * distinguir "nunca comprobado" de "comprobado y no se ha podido identificar", que
   * es la diferencia entre no tener nada y tener una avería.
   */
  discordInGuild: boolean | null;
  /**
   * La verificación del alta por privado de Discord (issue 119), **sin el token**.
   *
   * - `discordVerificationRequestedAt`: la fila está sujeta a verificación. `null` =
   *   no lo está (filas antiguas y altas de `/participar`).
   * - `discordVerificationSentAt`: último privado enviado, o `null`.
   * - `discordVerifiedAt`: la persona confirmó desde su cuenta. **No** es lo mismo que
   *   `discordUserId`: ese es lo que dice Discord y se puede resolver sin
   *   consentimiento.
   * - `discordDeclinedAt`: pulsó "No".
   *
   * El **token no sale de aquí**: permite **encontrar** la fila de la interacción, pero
   * resolverla exige además pulsar desde la cuenta destinataria
   * (`discordVerificationUserId`) y que siga `PENDING`, así que no se expone ni a la
   * interfaz ni a un log (ver `docs/MODELO-DATOS.md`).
   */
  discordVerificationRequestedAt: Date | null;
  discordVerificationSentAt: Date | null;
  discordVerifiedAt: Date | null;
  discordDeclinedAt: Date | null;
  /**
   * ¿La verificación está **pendiente de resolverse**?
   *
   * Es `PENDING` **y** sujeta **y** sin confirmar. El estado entra en la condición y
   * no es un adorno: un `REJECTED` conserva `requestedAt` a propósito —para que una
   * re-aprobación vuelva a exigir confirmación— y un `APPROVED` puede tenerlo sin
   * `verifiedAt` si lo aprobó el superadministrador sin verificar. Ninguno de los dos
   * está esperando nada, así que pintarlos como "esperando confirmación" sería falso.
   *
   * Derivado y no leído de la base para que la interfaz no tenga que recomponer la
   * condición de la puerta: es la misma que decide aprobar o no en
   * `setPlayerStatus`, y tenerla dos veces sería pedir que se desincronicen.
   */
  discordVerificationPending: boolean;
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
  /** Partidas clasificatorias contadas; `null` si el jugador no está aprobado (sin fila). */
  matchCount: number | null;
  /** Puntos del torneo, los mismos que publica la clasificación; `null` si no está aprobado (sin fila). */
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
  discordUserId: true,
  discordUsername: true,
  discordInGuild: true,
  discordVerificationRequestedAt: true,
  discordVerificationSentAt: true,
  discordVerifiedAt: true,
  discordDeclinedAt: true,
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
 * Un jugador **sin fila** —alguien no aprobado, que no está en la clasificación— sale
 * con `null` en vez de `0`, y es lo honesto: `0` significa "está en la clasificación y
 * no tiene nada", que es justo lo que ahora trae un aprobado que todavía no ha jugado.
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
      // conservan y son historia, no lo que se muestra.
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
        discordVerificationPending:
          player.status === "PENDING" &&
          player.discordVerificationRequestedAt !== null &&
          player.discordVerifiedAt === null,
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
  /** Aprobados con la ventana del torneo todavía incompleta. */
  backfillPending: number;
  /**
   * `true` si el relleno lleva 7 pasadas truncando o su mínimo lleva 24 h sin
   * bajar. `null` = sin medir (rastro viejo, rastro ausente o sin cursor).
   */
  backfillStalled: boolean | null;
  /** Errores de lote del último rastro, con su número y su rango de ids. */
  gamesBatchErrors: GamesBatchError[];
  /** Aviso de la API (`filters._important_notice_`), si lo mandó. */
  apiNotice: string | null;
  /** `updated_since` que dejó la última pasada, si lo dejó. */
  gamesCursor: string | null;
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
    const [trace, cursor] = await Promise.all([readSyncRunTrace(), readGamesCursor()]);
    const stale = isSyncTraceStale(trace);
    const now = new Date();
    const backfillPending = await db.player.count({
      where: { status: "APPROVED", windowComplete: false },
    });
    const backfillStalled =
      trace !== null && !stale && cursor !== null
        ? backfillProgressStalled(cursor, backfillPending, now)
        : null;

    const degraded =
      trace !== null &&
      (trace.playersFailed > 0 ||
        trace.playersCancelled > 0 ||
        trace.gamesBatchesFailed > 0 ||
        trace.ladderError !== null ||
        trace.scoringError !== null);

    return {
      lastRun: trace,
      lastSuccessAt: trace?.lastSuccessAt ?? null,
      stale,
      degraded,
      backfillPending,
      backfillStalled,
      gamesBatchErrors: trace?.gamesBatchErrors ?? [],
      apiNotice: trace?.apiNotice ?? null,
      gamesCursor: trace?.gamesCursor ?? null,
      headline: syncHeadline(trace, stale, backfillPending),
    };
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
function syncHeadline(
  trace: SyncRunTrace | null,
  stale: boolean,
  backfillPending: number,
): string {
  if (trace === null) {
    return "El sincronizador todavía no ha escrito ninguna pasada.";
  }

  if (stale) {
    return `La última pasada es de ${formatRelativeTime(new Date(trace.finishedAt))} y no se ha escrito ninguna desde entonces.`;
  }

  // El contador vive en la línea de detalle del panel (`backfillPending`), no
  // aquí: si se repitiera en el titular, la misma tarjeta diría dos veces el
  // mismo número con dos redacciones distintas.
  const relleno =
    trace.gamesBatchesIncomplete > 0 || backfillPending > 0
      ? " El relleno de la ventana sigue en curso."
      : "";
  const fallidos = trace.playersFailed + trace.playersCancelled;

  if (fallidos === 0 && trace.ladderError === null && trace.scoringError === null) {
    return `La última pasada salió bien: ${trace.playersOk} de ${trace.playersTotal} jugadores y ${trace.newMatches} partidas nuevas.${relleno}`;
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

  return `La última pasada salió a medias: ${partes.join(", ")}.${relleno}`;
}

/* -------------------------------------------------------------------------- */
/* Historial de puntos y objetivos                                              */
/* -------------------------------------------------------------------------- */

/**
 * Parámetros del historial de puntos, tal como llegan de la URL.
 *
 * El historial del panel enseña las mismas filas que el público —victorias que suman,
 * logros y cambios de poseedor— de todos los participantes, así que los filtros son los
 * mismos: jugador y rango de fechas. No hay filtro de resultado: un objetivo no es ni una
 * victoria ni una derrota, y todas las partidas que entran son victorias.
 */
export type AdminMatchHistoryQuery = AdminPageQuery &
  AdminSortQuery & {
    /** `Player.id` (no `profileId`): el mismo id que usan los formularios de admin. */
    playerId?: AdminQueryParam;
    /** Límite inferior **inclusivo** de fechas; en las partidas, sobre `startedAt`. */
    from?: AdminQueryParam;
    /** Límite superior **exclusivo** de fechas; en las partidas, sobre `startedAt`. */
    to?: AdminQueryParam;
  };

/**
 * El objetivo cumplido de una fila del historial, ya resuelto.
 *
 * Etiqueta, grupo y métrica salen del **catálogo** (`OBJECTIVE_DEFINITIONS`) y los
 * puntos del **ruleset activo**, con el mismo criterio que `objectiveLookup()` en
 * `src/lib/public.ts` (`ruleset.objectives[id] ?? definition.points`, con `victorias`
 * pagando `pointsPerWin`). La tabla `ObjectiveEvent` no los guarda, y a propósito:
 * una copia se quedaría vieja en cuanto se retocara un punto en `Setting`. Es la fila
 * de la interfaz la que tiene todo resuelto, para que pintar un hito no obligue a
 * mirar el catálogo.
 *
 * `points` y `count` son, además, **lo que cobró ese jugador** cuando se puede saber:
 * el importe real de un logro repetible no es el de la tarjeta (`imparable` reparte 1
 * por día con tope, `victorias` paga por victoria), y publicar el tope como si fuera
 * lo cobrado sería el mismo error que tenía la clasificación. El detalle sale del
 * desglose del jugador (ver `playerObjectiveAwards`); sin él, precio de catálogo y
 * una repetición.
 *
 * En una **competición** el importe es el de la tarjeta con una repetición, siempre: un
 * premio *winner-takes-all* no depende de lo que sume el jugador, así que la ganancia y
 * la pérdida de un mismo cambio llevan la misma cifra y no se consulta el desglose.
 */
export type AdminObjectiveEvent = {
  /** `ObjectiveEvent.objectiveId`: id estable del objetivo (`lider-japanese`…). */
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
  /** Puntos que el jugador cobró por este objetivo. Es el mismo número que `points` de la fila. */
  points: number;
  /** Repeticiones cobradas: días, victorias o 1 (ver el tipo). */
  count: number;
  /**
   * `null` cuando la fila es un **objetivo cumplido** (un logro). En un **cambio de
   * poseedor de una competición**, qué le ha pasado a ese jugador: `GAINED` pasa a
   * poseerla, `LOST` deja de poseerla.
   *
   * Es el discriminante que la interfaz necesita para elegir el verbo y el signo
   * (`+points` con `GAINED`, `-points` con `LOST`). Los puntos de la fila son
   * **informativos** —una pérdida no resta nada de la clasificación—, así que el signo
   * es una decisión de quien pinta, no un dato que venga resuelto.
   */
  lead: ObjectiveLeadKind | null;
};

/**
 * Una fila del historial de `/admin/historial`: **una partida, un objetivo cumplido o un
 * cambio de poseedor de una competición**.
 *
 * ## Cómo se distinguen
 *
 * Por `objective`: `null` = fila de partida; no `null` con `objective.lead` a `null` = se
 * cumplió un logro; no `null` con `objective.lead` informado = alguien pasó a poseer una
 * competición (`GAINED`) o dejó de poseerla (`LOST`). No hay un `kind` aparte a propósito:
 * un segundo discriminante que nadie mantiene en sincronía con el primero es una forma de
 * que las clases de fila se contradigan.
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
   * restore— y, en una fila de objetivo, `objective:<objetivo>:<profileId>` en un logro o
   * `lead:<objetivo>:<lead>:<profileId>:<at>` en un cambio de poseedor. En todos los casos
   * sirve como clave de la fila (`key` de React y desempate del orden).
   *
   * El `profileId` entra en los objetivos porque un mismo logro lo cobran varios jugadores:
   * sin él, dos filas del mismo objetivo compartirían clave y el desempate del feed dejaría
   * de ser total. En un **cambio de poseedor** hacen falta además el `lead` y el instante:
   * las dos filas de un mismo cambio comparten objetivo e instante —solo las separa el
   * `lead`— y un mismo jugador puede ganar y perder la misma competición en momentos
   * distintos.
   */
  id: string;
  /**
   * La fecha de la fila, y por lo que se ordena y por lo que se filtra:
   * `Match.startedAt` en una partida, `ObjectiveEvent.achievedAt` en un logro (el instante
   * de la hazaña en las carreras de civilización y el **fin del torneo** en los que se
   * resuelven en caliente) y `ObjectiveLeadEvent.at` en un cambio de poseedor (el instante
   * del recálculo que lo detectó).
   */
  startedAt: Date;
  playerId: string;
  playerName: string;
  playerProfileId: number;
  /** Puntos que aporta la fila: los de la partida, o los que el jugador **cobró** por el objetivo. */
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
 * Los filtros del historial, ya validados.
 *
 * Se resuelven en un sitio y se reparten entre las dos consultas del feed (las partidas
 * y los objetivos), y por eso son un tipo y no dos valores sueltos: es lo que hace
 * imposible que las dos mitades del merge se filtren por cosas distintas.
 */
export type AdminHistoryFilters = {
  /** `Player.id` con forma de `cuid`, o `null` si no hay filtro. */
  playerId: string | null;
  /** Rango sobre `Match.startedAt` y, con los mismos límites, sobre la fecha del objetivo. */
  rango: AdminDateRange;
};

/**
 * Los filtros del historial, ya validados y listos para sus dos consultas.
 *
 * Exportado para `npm run verify:sync`: son funciones puras y son donde se decide qué
 * hace una URL manipulada.
 */
export function readHistoryFilters(query: AdminMatchHistoryQuery): AdminHistoryFilters {
  return {
    playerId: readPlayerIdFilter(query.playerId),
    rango: dateRangeWhere(query.from, query.to),
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
 * El comparador del feed mezclado por fecha.
 *
 * ## Todo orden es total
 *
 * Es lo que necesita la paginación: sin un desempate único, dos filas del mismo instante
 * pueden salir en cualquier orden entre sí y una página puede repetir o perder filas de
 * la anterior. El comparador termina en la **clave propia de cada clase** (`Match.id` y
 * `ObjectiveEvent.objectiveId`), que es única dentro de cada lista, así que no quedan dos
 * filas empatadas.
 *
 * ## `dir` invierte el orden entero
 *
 * `asc` es el inverso exacto de `desc`, desempate y criterio de clase incluidos. Es lo que
 * espera quien pulsa por segunda vez la cabecera de fecha, y además es lo que garantiza
 * que dos páginas del mismo filtro no se solapen. Por eso **todos** los criterios se
 * multiplican por el mismo signo y ninguno se queda fuera.
 *
 * ## Los criterios, en orden
 *
 * Primero la fecha, luego **la partida antes que el objetivo** si comparten instante, y
 * luego la clave. Ese criterio de clase es el que completa el orden total y además el que
 * mejor se lee, porque casi siempre la partida es la fila que explica el hito y así va
 * delante.
 *
 * Los dos primeros criterios son los de `compareFeedInstants()`, que es lo que comparte
 * con el historial público: allí el eje es el mismo y lo único que cambia es el desempate
 * final.
 *
 * ## El desempate final, que separa las dos filas de un cambio
 *
 * Lo calcula `historyTiebreak()`. Se limita al id de la clase en las partidas y en los
 * logros; en un **cambio de poseedor** añade el `lead` y el jugador, porque las dos filas
 * de un mismo cambio comparten instante y objetivo y solo se separan por ahí (ver su
 * docblock). Es el mismo desempate por el que ordena el `orderBy` de los liderazgos.
 *
 * Exportado para `npm run verify:sync`, que lo comprueba con filas sintéticas: que sea un
 * orden **total**, que `asc` sea el inverso de `desc` y que no reordene las mitades que
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
    const porFechaYClase = compareFeedInstants(a, b);

    if (porFechaYClase !== 0) {
      return porFechaYClase * signo;
    }

    return historyTiebreak(a, b) * signo;
  };
}

/**
 * El desempate final del comparador, con dos filas que comparten instante y clase.
 *
 * ## Una partida
 *
 * Basta con su `id` (`Match.id`), que es único dentro de la lista, y es la última columna
 * del `orderBy` de las partidas.
 *
 * ## Un objetivo
 *
 * Primero se compara el **objetivo** (`a.objective.id`), que es la columna por la que
 * ordenan las dos consultas de objetivos: en un logro coincide con el `id` de la fila, y
 * en un cambio de poseedor está dentro del `id` compuesto. Si los dos ids de objetivo
 * difieren, el desempate ya está decidido y no hace falta mirar más.
 *
 * Si son **el mismo** objetivo, puede ser un cambio de poseedor —dos filas, una por
 * jugador, que separa el **signo** (la ganancia delante, el mismo orden que
 * `OBJECTIVE_LEAD_RANK` y que el `orderBy`)— o dos logros del mismo objetivo cobrados por
 * jugadores distintos. En los dos casos el desempate es el **`profileId` numérico**, el
 * mismo por el que ordena la consulta: un `id` de texto no respetaría el orden de
 * `999999` frente a `1000000`. Sin ese desempate, dos filas del mismo instante y objetivo
 * podrían salir en cualquier orden y una página repetiría o perdería una.
 *
 * La convención es la del comparador descendente: un número negativo significa "a va
 * antes". Exportado para `npm run verify:sync`, como `historyComparator()`.
 */
export function historyTiebreak(a: AdminMatchHistoryRow, b: AdminMatchHistoryRow): number {
  if (a.objective !== null && b.objective !== null) {
    const porObjetivo =
      a.objective.id < b.objective.id ? 1 : a.objective.id > b.objective.id ? -1 : 0;

    if (porObjetivo !== 0) {
      return porObjetivo;
    }

    if (a.objective.lead !== null && b.objective.lead !== null) {
      const porSigno =
        OBJECTIVE_LEAD_RANK[b.objective.lead] - OBJECTIVE_LEAD_RANK[a.objective.lead];

      if (porSigno !== 0) {
        return porSigno;
      }
    }

    // Numérico, no por el texto del `id`: la consulta ordena por `profileId` y un id
    // lexicográfico no respeta el orden de 999999 frente a 1000000.
    const porJugador = b.playerProfileId - a.playerProfileId;

    if (porJugador !== 0) {
      return porJugador;
    }
  }

  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * Orden de las **partidas** del feed, en `orderBy` de Prisma.
 *
 * Tiene que ser el mismo orden que devuelve `historyComparator()` recortado a la clase
 * de las partidas, porque el merge compara las dos mitades: si la consulta las trajera
 * en otro orden, la página dejaría de ser una ventana del feed real.
 */
function matchHistoryOrderBy(dir: AdminSortDir): Prisma.MatchOrderByWithRelationInput[] {
  return [{ startedAt: dir }, { id: dir }];
}

/**
 * Orden de los **objetivos** del feed, en `orderBy` de Prisma.
 *
 * La fecha y la clave de la clase, igual que el comparador del merge. El `profileId` del
 * jugador es el desempate final: un mismo objetivo lo cobran varios jugadores en el mismo
 * instante, y sin él la consulta no estaría en el orden del comparador y la ventana podría
 * dejar fuera una de las filas empatadas.
 */
function objectiveEventOrderBy(dir: AdminSortDir): Prisma.ObjectiveEventOrderByWithRelationInput[] {
  return [{ achievedAt: dir }, { objectiveId: dir }, { player: { profileId: dir } }];
}

/**
 * Campos de `ObjectiveLeadEvent` que se leen. Los mismos que los de un logro, con `at`
 * de fecha y `kind` para saber si es una ganancia o una pérdida.
 */
const OBJECTIVE_LEAD_SELECT = {
  objectiveId: true,
  at: true,
  kind: true,
  playerId: true,
  player: { select: { name: true, profileId: true } },
} satisfies Prisma.ObjectiveLeadEventSelect;

/**
 * Orden de los **cambios de poseedor** del feed, en `orderBy` de Prisma.
 *
 * El `kind` va antes que el jugador y no es decorativo: las dos filas de un cambio
 * comparten `at` y `objectiveId`, así que el signo es lo que las separa, y su enum está
 * declarado para que `desc` deje la ganancia delante (ver `ObjectiveLeadKind`). Tiene que
 * decir lo mismo que `historyTiebreak()`.
 */
function leadEventOrderBy(dir: AdminSortDir): Prisma.ObjectiveLeadEventOrderByWithRelationInput[] {
  return [{ at: dir }, { objectiveId: dir }, { kind: dir }, { player: { profileId: dir } }];
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
 * Los objetivos cumplidos de una **ventana** del feed, ya en filas del historial.
 *
 * La consulta pide solo la ventana que calcula `historyFeedWindows()`: el trabajo por
 * petición depende de la página y no del histórico entero. Vienen en el mismo orden que
 * el comparador del merge (`objectiveEventOrderBy()`), que es lo que permite mezclarlas
 * con las de las demás fuentes.
 *
 * Una fila cuyo `objectiveId` no está en el catálogo se descarta con un aviso en el
 * log en vez de publicarse a medias: el `where` ya la filtra, así que solo llegaría aquí
 * si el catálogo cambiara entre el recuento y la consulta, y una fila de hito sin
 * etiqueta ni puntos no dice nada.
 */
async function eventosDeObjetivo(
  where: Prisma.ObjectiveEventWhereInput,
  ruleset: ScoringRuleset,
  dir: AdminSortDir,
  window: HistoryFeedWindow,
): Promise<AdminMatchHistoryRow[]> {
  const filas = await db.objectiveEvent.findMany({
    where,
    orderBy: objectiveEventOrderBy(dir),
    skip: window.skip,
    take: window.take,
    select: OBJECTIVE_EVENT_SELECT,
  });

  const awards = await playerObjectiveAwards(filas.map((fila) => fila.playerId));
  const rows: AdminMatchHistoryRow[] = [];

  for (const fila of filas) {
    const objetivo = resolveObjective(
      fila.objectiveId,
      ruleset,
      awards.get(fila.playerId) ?? null,
    );

    if (objetivo === null) {
      console.warn(
        `[admin] Objetivo "${fila.objectiveId}": no está en el catálogo, su evento no se muestra.`,
      );
      continue;
    }

    rows.push({
      // El `profileId` en la clave: un logro lo cobran varios jugadores y sus filas
      // comparten objetivo; sin él, el desempate del feed no sería total.
      id: `objective:${objetivo.id}:${fila.player.profileId}`,
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
        count: objetivo.count,
        // Un logro no se posee: no hay cambio de poseedor que contar.
        lead: null,
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
 * Los cambios de poseedor de una **ventana** del feed, ya en filas del historial.
 *
 * La consulta pide solo la ventana que calcula `historyFeedWindows()`, igual que los
 * logros (ver `eventosDeObjetivo`), y los puntos son el **premio del catálogo**, sin
 * desglose de jugador: en una competición el importe no depende de lo que sume el
 * jugador, así que la ganancia y la pérdida del mismo cambio llevan la misma cifra y no
 * hace falta la consulta de `awards`.
 *
 * Una fila cuyo `objectiveId` no está en el catálogo se descarta con un aviso en el log,
 * igual que en los logros.
 */
async function liderazgosDeObjetivo(
  where: Prisma.ObjectiveLeadEventWhereInput,
  ruleset: ScoringRuleset,
  dir: AdminSortDir,
  window: HistoryFeedWindow,
): Promise<AdminMatchHistoryRow[]> {
  const filas = await db.objectiveLeadEvent.findMany({
    where,
    orderBy: leadEventOrderBy(dir),
    skip: window.skip,
    take: window.take,
    select: OBJECTIVE_LEAD_SELECT,
  });

  const rows: AdminMatchHistoryRow[] = [];

  for (const fila of filas) {
    const objetivo = resolveObjective(fila.objectiveId, ruleset);

    if (objetivo === null) {
      console.warn(
        `[admin] Objetivo "${fila.objectiveId}": no está en el catálogo, su liderazgo no se muestra.`,
      );
      continue;
    }

    rows.push({
      // El `kind`, el jugador y el instante entran en la clave: las dos filas de un cambio
      // comparten objetivo y solo se separan por ahí (ver `AdminMatchHistoryRow.id`).
      id: `lead:${objetivo.id}:${fila.kind}:${fila.player.profileId}:${fila.at.getTime()}`,
      startedAt: fila.at,
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
        count: objetivo.count,
        lead: fila.kind,
      },
      // Igual que en un logro: una competición no tiene rival, formato, mapa ni resultado.
      gameId: null,
      opponentName: null,
      opponentProfileId: null,
      result: null,
      teamSize: null,
      mode: null,
      leaderboard: null,
      map: null,
      // Y no tiene acción: revertir o restaurar son de `Match`.
      revertedAt: null,
    });
  }

  return rows;
}

/**
 * Historial del torneo: **las mismas ganancias que el historial público**, de todos los
 * participantes, mezcladas en un solo feed y paginadas en servidor.
 *
 * ## Qué filas entran
 *
 * Las mismas que en `/historial`: victorias clasificatorias que suman —o que se
 * revirtieron y siguen marcadas—, logros cumplidos y cambios de poseedor de una
 * competición. El panel añade dos cosas que la web no tiene: el alcance (todos los
 * aprobados, no uno) y la acción de revertir o restaurar los puntos de una partida.
 *
 * El filtro de partidas es el del feed público: `classificatoryWhere()` con
 * `result = WIN` y `points > 0` o `revertedAt` informado, y solo aprobados. Las derrotas
 * y las partidas que nunca puntuaron no son una ganancia, no salen en el historial
 * público y tampoco se pueden revertir; dejarlas fuera es lo que hace que las dos
 * pantallas cuenten lo mismo.
 *
 * La ventana del torneo sigue siendo un suelo y un techo, y el filtro de fechas solo
 * puede recortar por dentro (va en `AND`, como en el feed público).
 *
 * ## Los objetivos
 *
 * Los eventos de `ObjectiveEvent` —un logro cumplido por jugador, como mucho uno por
 * objetivo del catálogo— y los de `ObjectiveLeadEvent` —un cambio de poseedor de una
 * competición, con sus dos filas por cambio—, escritos los dos por el motor de puntuación.
 * Se filtran con el **mismo jugador, las mismas fechas y el mismo estado de aprobado** que
 * el feed público.
 *
 * Los cambios de poseedor llevan además el filtro de **cohorte**: solo los de la edición
 * activa (`editionFrom` = `window.from` de la ventana que se está usando), para que una
 * edición nueva no arrastre los liderazgos de la anterior (ver `ObjectiveLeadEvent`).
 *
 * ## El merge, y por qué el coste depende de la página
 *
 * Las tres fuentes —partidas, logros y liderazgos— se cuentan primero, en paralelo. Con
 * esos totales, `historyFeedWindows()` calcula la ventana de cada una que puede contener
 * la página: una fila que quede más allá de `skip + pageSize` en su propia fuente no
 * puede caer en ella, y las primeras filas de cada fuente son seguro anteriores. Las tres
 * ventanas se piden en paralelo y `historyFeedPage()` las mezcla y recorta. El trabajo por
 * petición depende de la página, no del histórico entero.
 *
 * El orden es siempre por fecha; lo único que cambia con la cabecera es el sentido.
 *
 * ## Los objetivos fuera del catálogo
 *
 * Los `where` de logros y liderazgos filtran por `objectiveId` contra el catálogo para
 * que el recuento que decide la ventana y las filas que se publican cuenten lo mismo. Sin
 * ese filtro, una fila insertada a mano con un id que no existe se contaría pero no se
 * publicaría, y la ventana se quedaría corta.
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
    const { playerId, rango } = filtros;
    const editionFrom = windowBounds(ruleset.window).from;

    // Los filtros se suman, no se eligen: `where` es una conjunción, así que jugador
    // y fechas se combinan solos. No hace falta ninguna lógica de "si hay dos, el
    // segundo gana", que es justo donde estos filtros se suelen equivocar.
    //
    // La selección de partidas es la del historial público: una ganancia es una
    // victoria que suma o una que se revirtió y sigue marcada. Las derrotas y las
    // victorias que nunca puntuaron no son una ganancia y no aparecen en ninguna de
    // las dos pantallas.
    const where: Prisma.MatchWhereInput = {
      ...classificatoryWhere(ruleset.modes, ruleset.window, null),
      result: MatchResult.WIN,
      OR: [{ points: { gt: 0 } }, { revertedAt: { not: null } }],
      player: { status: PlayerStatus.APPROVED },
      ...(playerId === null ? {} : { playerId }),
      ...(hasDateBounds(rango) ? { AND: [{ startedAt: rango }] } : {}),
    };

    // Los mismos filtros para los hitos, sobre su columna de fecha, más el catálogo.
    const eventosWhere: Prisma.ObjectiveEventWhereInput = {
      objectiveId: { in: [...OBJECTIVE_IDS] },
      player: { status: PlayerStatus.APPROVED },
      ...(playerId === null ? {} : { playerId }),
      ...(hasDateBounds(rango) ? { achievedAt: rango } : {}),
    };

    // Los liderazgos, con el mismo filtro más el de cohorte de la edición activa.
    const liderazgosWhere: Prisma.ObjectiveLeadEventWhereInput = {
      editionFrom,
      objectiveId: { in: [...OBJECTIVE_IDS] },
      player: { status: PlayerStatus.APPROVED },
      ...(playerId === null ? {} : { playerId }),
      ...(hasDateBounds(rango) ? { at: rango } : {}),
    };

    return adminPage<AdminMatchHistoryRow, AdminHistorySort>(async (wanted) => {
      const skip = (wanted - 1) * pageSize;

      // Los tres recuentos deciden la ventana de cada fuente y no dependen entre sí, así
      // que salen en una sola tanda.
      const [totalPartidas, totalEventos, totalLiderazgos] = await Promise.all([
        db.match.count({ where }),
        db.objectiveEvent.count({ where: eventosWhere }),
        db.objectiveLeadEvent.count({ where: liderazgosWhere }),
      ]);

      const { windows, offset } = historyFeedWindows(skip, pageSize, [
        totalPartidas,
        totalEventos,
        totalLiderazgos,
      ]);

      // Las tres ventanas se piden en paralelo: ya no hace falta esperar a los objetivos
      // para saber cuántas partidas traer.
      const [partidas, eventos, liderazgos] = await Promise.all([
        db.match.findMany({
          where,
          orderBy: matchHistoryOrderBy(sort.dir),
          skip: windows[0].skip,
          take: windows[0].take,
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
        }),
        eventosDeObjetivo(eventosWhere, ruleset, sort.dir, windows[1]),
        liderazgosDeObjetivo(liderazgosWhere, ruleset, sort.dir, windows[2]),
      ]);

      // El merge y el recorte de la página los hace `historyFeedPage()`, la misma pieza
      // que usa el historial público: `offset` es el inicio de la página en la unión de
      // las tres ventanas (ver `historyFeedWindows()`).
      return {
        total: totalPartidas + totalEventos + totalLiderazgos,
        rows: historyFeedPage(
          [partidas.map(partidaEnFila), eventos, liderazgos],
          {
            offset,
            pageSize,
            compare: historyComparator(sort),
          },
        ),
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
  /**
   * Cuándo se deshizo la acción, o `null` si sigue vigente.
   *
   * Es la marca de la fila **original**, no la de la reversión: la interfaz la usa para
   * decir "deshecha" y para no ofrecer el botón de deshacer dos veces. Quién la deshizo
   * va aparte porque el `actorEmail` de la fila es quien hizo la acción, no quien la
   * revirtió.
   */
  revertedAt: Date | null;
  /** Correo de quien la deshizo, o `null` si sigue vigente. */
  revertedByEmail: string | null;
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
 * Publica también la **marca de revertida** (`revertedAt` / `revertedByEmail`), que es
 * lo que la pestaña necesita para decir que una acción ya no está vigente y para no
 * ofrecer el botón de deshacer dos veces. No publica la fila `ACTION_REVERTED` como algo
 * aparte: es una línea más del historial, y su `summary` ya dice qué se deshizo.
 *
 * Paginada en servidor por el mismo motivo que el historial de puntos, y con
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
            revertedAt: true,
            revertedByEmail: true,
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
          revertedAt: row.revertedAt,
          revertedByEmail: row.revertedByEmail,
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
 * ## La partida que ancla la alerta
 *
 * De `Alert.details` —un `Json`— se publican solo dos cosas, y validadas: la partida
 * ancla (`anchorGameId`, que también es columna propia) y su instante
 * (`anchorStartedAt`), este último leído con `anchorInstant()`, el mismo validador
 * que usa el informe descargable. El resto de `details` no viaja: su forma cambia con
 * cada regla y esta fila es para leer de un vistazo; lo que hay detrás está en el
 * informe y en `Alert`. El `summary` sí viaja entero, redactado por el motor al
 * escribir la fila, y se pinta tal cual —montar la frase en el componente daría dos
 * textos para el mismo hallazgo—.
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
  /**
   * `Alert.kind`: si la racha se rompió, la cerró el torneo, se cruzó un acumulado o se
   * comprobó un estado (las dos reglas del historial de partidas).
   */
  kind: AlertKind;
  /** Nombre de display del jugador, del `join` con `Player` (nunca del texto de la alerta). */
  playerName: string;
  playerProfileId: number;
  /** El rival o el compañero al que se refiere, o `null` en las reglas sin sujeto. */
  subjectName: string | null;
  subjectProfileId: number | null;
  /**
   * Magnitud del hallazgo: partidas de la racha, del acumulado, o —en las reglas de
   * estado— la magnitud con la que se comparó.
   */
  count: number;
  /** La frase en español, tal cual se pinta. La redacta `alertSummary()`. */
  summary: string;
  /** `Alert.anchorGameId`: la partida que ancla la alerta, o `null`. */
  anchorGameId: string | null;
  /**
   * `Match.startedAt` de la partida ancla, leído y validado de
   * `Alert.details.anchorStartedAt` con `anchorInstant()`. `null` si la alerta no
   * tiene ancla o si el `details` no lo trae legible (una fila de otra versión del
   * código).
   */
  anchorStartedAt: Date | null;
};

/**
 * Lo que se lee de cada fila de `Alert`.
 *
 * El nombre del jugador no está en la alerta (a propósito: un nombre guardado se
 * quedaría congelado el día que alguien se renombre), así que sale del `join`.
 *
 * `anchorGameId` es una columna y `details` es el `Json` del motor: se lee entero para
 * sacar de él, y validado con `anchorInstant()`, el instante de la partida ancla.
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
  anchorGameId: true,
  details: true,
  player: { select: { name: true, profileId: true } },
} satisfies Prisma.AlertSelect;

/**
 * Parámetros de la tabla de alertas, tal como llegan de la URL.
 *
 * | Parámetro | Filtra por | Valores admitidos |
 * |---|---|---|
 * | `from` / `to` | `Alert.createdAt` | fecha `YYYY-MM-DD` o instante con zona, con los mismos bordes que el historial |
 * | `playerId` | `Alert.playerId` | un `Player.id` con forma de `cuid` |
 * | `regla` | `Alert.rule` | uno de los dieciséis `AlertRule` |
 * | `tipo` | `Alert.kind` | `STREAK_CLOSED`, `STREAK_AT_TOURNAMENT_END`, `TOTAL_REACHED`, `STATE_DETECTED`, `MATCH_DETECTED` |
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
 * Por encima de esos cuatro hay un quinto filtro que no viene de la URL: la **edición
 * activa**. Solo se publican las alertas con `createdAt >= window.from` de la ventana del
 * ruleset de puntos (ver `alertEditionWhere()`), para que la tabla no mezcle avisos de dos
 * torneos. Las filas anteriores siguen en `Alert` (append-only) y dejan de mostrarse al
 * avanzar la ventana; no hay cota superior porque el cierre de torneo se detecta después
 * de `window.to`.
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
    // La ventana activa, para no mezclar avisos de dos ediciones en la misma tabla.
    const ruleset = await readRuleset();

    // Un solo `where` para las **dos** consultas, como en el resto de listas con filtro:
    // un `count` que no contara lo mismo que la página daría una paginación falsa.
    //
    // El filtro de edición va en `createdAt` y el rango del usuario en un `AND`, no
    // sustituyéndolo: así un `?from` anterior a la ventana no puede anular el suelo de la
    // edición. Con `createdAt` a dos niveles Prisma los combina como una conjunción, que
    // es justo la intersección que se quiere.
    const where: Prisma.AlertWhereInput = {
      ...alertEditionWhere(ruleset.window),
      ...(filtros.playerId === null ? {} : { playerId: filtros.playerId }),
      ...(hasDateBounds(filtros.rango) ? { AND: [{ createdAt: filtros.rango }] } : {}),
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
          anchorGameId: row.anchorGameId,
          anchorStartedAt: anchorInstant(row.details),
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
