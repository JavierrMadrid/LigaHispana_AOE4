import "server-only";

import { Prisma } from "@/generated/prisma/client";
import { AdminActionType, MatchResult, PlayerStatus } from "@/generated/prisma/enums";
import { db } from "@/lib/db";
import { readFromDatabase, type PublicRead } from "@/lib/db-errors";
import { isRecord } from "@/lib/json";
import { formatRelativeTime } from "@/lib/format";
import { classificatoryWhere, readInstant } from "@/lib/ranked-match";
import { RULESET_VERSION, readRuleset } from "@/lib/scoring";
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
 * ## Lo que aquí no está
 *
 * La pestaña de alertas es un *placeholder* y este módulo no tiene ninguna lectura
 * que la sustente. Se reserva para **comportamientos anómalos de los
 * participantes**, y sigue sin hacerse porque todavía no se ha definido qué
 * condiciones disparan una alerta ni qué cuenta como anómalo: inventar los avisos
 * enseñaría un estado del torneo que no existe. Cuando se definan, se escribe su
 * consulta aquí, con el mismo contrato y las mismas validaciones.
 *
 * Lo que sí hay es `getSyncHealth()`, que es salud del sistema y no una alerta de
 * jugador, y por eso no va en esa pestaña sino en un aviso de `/admin`.
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

/** Filas de una lectura paginada, con la paginación ya resuelta. */
export type AdminPage<T> = {
  rows: T[];
  /** Filas que cumplen el filtro, sin paginar: de ahí sale `pageCount`. */
  total: number;
  /** Página devuelta, acotada a `[1, pageCount]`. */
  page: number;
  pageSize: number;
  /** Páginas que hay con este filtro; `0` si no hay ninguna fila. */
  pageCount: number;
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
 * Se ajusta la página al rango real (una URL que pide la 7 con un filtro que solo
 * tiene dos páginas devuelve la última con filas): una tabla vacía con "página 7 de
 * 2" desconcierta más que devolver directamente lo que hay. El ajuste solo repite
 * la consulta cuando hace falta, porque el camino normal es una sola pasada.
 */
async function adminPage<T>(
  load: (page: number) => Promise<{ rows: T[]; total: number }>,
  page: number,
  pageSize: number,
): Promise<AdminPage<T>> {
  const first = await load(page);
  const pageCount = Math.ceil(first.total / pageSize);
  const current = pageCount === 0 ? 1 : Math.min(page, pageCount);

  if (current !== page) {
    const last = await load(current);

    return { rows: last.rows, total: last.total, page: current, pageSize, pageCount };
  }

  return { rows: first.rows, total: first.total, page: current, pageSize, pageCount };
}

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
  contactEmail: string | null;
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
  contactEmail: true,
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
/* Historial de partidas                                                        */
/* -------------------------------------------------------------------------- */

/** Filtros del historial de partidas, tal como llegan de la URL. */
export type AdminMatchHistoryQuery = AdminPageQuery & {
  /** `Player.id` (no `profileId`): el mismo id que usan los formularios de admin. */
  playerId?: AdminQueryParam;
  /** Límite inferior **inclusivo** sobre `startedAt`. */
  from?: AdminQueryParam;
  /** Límite superior **exclusivo** sobre `startedAt`. */
  to?: AdminQueryParam;
};

/** Una partida del historial, con el jugador de la liga ya resuelto. */
export type AdminMatchHistoryRow = {
  /** `Match.id`: es lo que viajan los formularios de revert y restore. */
  id: string;
  gameId: string;
  /** Cuándo empezó la partida: la columna por la que se ordena y por la que se filtra. */
  startedAt: Date;
  playerId: string;
  playerName: string;
  playerProfileId: number;
  opponentName: string | null;
  opponentProfileId: number | null;
  result: MatchResult | null;
  /** Puntos que aporta con el ruleset activo; `0` en una partida no ganada. */
  points: number;
  mode: string | null;
  /** Literal de AoE4World (`rm_solo`, `rm_2v2`…); el copy puede necesitarlo. */
  leaderboard: string;
  map: string | null;
  /** Instante del revert, o `null` si la partida cuenta. */
  revertedAt: Date | null;
};

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
 * Rango sobre `startedAt`, ya validado.
 *
 * Es un tipo propio y no el `DateTimeFilter` de Prisma a propósito: lo que sale de
 * aquí son dos comparadores opcionales, y el filtro de la tabla los mete dentro de
 * `startedAt` junto con los que ya trae `classificatoryWhere`.
 */
type StartedAtRange = { gte?: Date; lt?: Date };

/** El filtro de fechas del historial, ya validado y listo para `startedAt`. */
function startedAtWhere(query: AdminMatchHistoryQuery): StartedAtRange {
  const from = readDateBound(query.from, "from");
  const to = readDateBound(query.to, "to");

  return {
    ...(from === null ? {} : { gte: from }),
    ...(to === null ? {} : { lt: to }),
  };
}

/**
 * Historial de partidas clasificatorias, paginado en servidor y de la más reciente a
 * la más antigua.
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
 * **El orden lleva `id` de desempate** porque dos partidas pueden empezar en el mismo
 * milisegundo (el worker importa por páginas) y, sin un segundo criterio, el orden
 * dentro de esas dos filas no es estable: la página 2 repetiría o perdería filas de
 * la 1 al paginar.
 *
 * El filtro de clasificatorias sale del ruleset activo (`readRuleset`), como el
 * motor: si la organización cambia la ventana o las familias sin desplegar, el
 * historial cambia con ella.
 */
export async function getAdminMatchHistory(
  query: AdminMatchHistoryQuery = {},
): Promise<PublicRead<AdminPage<AdminMatchHistoryRow>>> {
  return readFromDatabase("admin/getAdminMatchHistory", async () => {
    const page = readBoundedInt(query.page, { min: 1, max: 100_000, fallback: 1 });
    const pageSize = readBoundedInt(query.pageSize, {
      min: 1,
      max: MAX_PAGE_SIZE,
      fallback: DEFAULT_PAGE_SIZE,
    });

    const ruleset = await readRuleset();
    const playerId = readSingleParam(query.playerId);
    const rango = startedAtWhere(query);
    const filtrandoFechas = rango.gte !== undefined || rango.lt !== undefined;

    const where: Prisma.MatchWhereInput = {
      ...classificatoryWhere(ruleset.modes, ruleset.window),
      ...(playerId !== null && PLAYER_ID_PATTERN.test(playerId) ? { playerId } : {}),
      ...(filtrandoFechas ? { startedAt: rango } : {}),
    };

    return adminPage<AdminMatchHistoryRow>(async (wanted) => {
      const [rows, total] = await Promise.all([
        db.match.findMany({
          where,
          orderBy: [{ startedAt: "desc" }, { id: "desc" }],
          skip: (wanted - 1) * pageSize,
          take: pageSize,
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
            player: { select: { name: true, profileId: true } },
          },
        }),
        db.match.count({ where }),
      ]);

      return {
        total,
        rows: rows.map((row) => ({
          id: row.id,
          gameId: row.gameId,
          startedAt: row.startedAt,
          playerId: row.playerId,
          playerName: row.player.name,
          playerProfileId: row.player.profileId,
          opponentName: row.opponentName,
          opponentProfileId: row.opponentProfileId,
          result: row.result,
          points: row.points,
          mode: row.mode,
          leaderboard: row.leaderboard,
          map: row.map,
          revertedAt: row.revertedAt,
        })),
      };
    }, page, pageSize);
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
 */
export async function getAdminActions(
  query: AdminPageQuery = {},
): Promise<PublicRead<AdminPage<AdminActionRow>>> {
  return readFromDatabase("admin/getAdminActions", async () => {
    const page = readBoundedInt(query.page, { min: 1, max: 100_000, fallback: 1 });
    const pageSize = readBoundedInt(query.pageSize, {
      min: 1,
      max: MAX_PAGE_SIZE,
      fallback: DEFAULT_PAGE_SIZE,
    });

    return adminPage<AdminActionRow>(async (wanted) => {
      const [rows, total] = await Promise.all([
        db.adminAction.findMany({
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
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
        db.adminAction.count(),
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
    }, page, pageSize);
  });
}
