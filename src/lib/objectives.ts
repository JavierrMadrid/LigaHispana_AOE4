import "server-only";

import { Prisma } from "@/generated/prisma/client";
import { CIVILIZATIONS, CIVILIZATION_IDS } from "@/lib/civs";
import { aoe4WorldProfileUrl } from "@/lib/format";
import { rankedMatchSql, type ScoringWindow } from "@/lib/ranked-match";
import type { ScoringRuleset } from "@/lib/scoring";

/**
 * Los objetivos del torneo de `docs/OBJETIVOS.md`.
 *
 * Hay **dos formas de cobrar** un objetivo, y es la diferencia de fondo de este
 * catálogo:
 *
 * - **Competición** (`kind: "competition"`): *winner-takes-all*, un único
 *   poseedor, el que va primero en su métrica. Es el modelo de siempre.
 * - **Logro** (`kind: "achievement"`): lo cobra **todo el que cumple la
 *   condición**. Puede ser binario (se cumple o no) o acumulativo (p. ej.
 *   `imparable`, con puntos por día). No tiene poseedor único.
 *
 * Este módulo no decide nada por su cuenta: recibe las partidas clasificatorias
 * ya cargadas, el ruleset activo y el pool de mapas, y devuelve qué objetivos
 * posee cada jugador. La lectura de la base (y la escritura de la clasificación)
 * vive en `scoring.ts`, que es quien importa de aquí, así el grafo de módulos no
 * se enrolla sobre sí mismo.
 */

/** Grupos de objetivos, en el orden en que se presentan. */
export type ObjectiveGroup = "actividad" | "racha" | "hazanas" | "formato" | "civilizacion";

/** Forma de cobrar: un solo poseedor o todo el que cumple. */
export type ObjectiveKind = "competition" | "achievement";

/** Métrica que decide el progreso o el poseedor (ver `docs/OBJETIVOS.md`). */
export type ObjectiveMetric =
  | "partidas"
  | "victorias"
  | "racha"
  | "dias"
  | "civilizaciones"
  | "mapas";

export type ObjectiveDefinition = {
  id: string;
  group: ObjectiveGroup;
  kind: ObjectiveKind;
  label: string;
  /**
   * Una frase corta con la regla, para la tarjeta y el modal del objetivo.
   *
   * Se escribe aquí y no en la interfaz porque es la **regla**: si el copy viviera
   * en el componente, cada tarjeta podría acabar contando una cosa distinta de la
   * que el motor aplica. Los umbrales de los logros son fijos y están en el
   * catálogo (`target`), así que la frase puede decirlos sin quedarse mintiendo.
   */
  description: string;
  metric: ObjectiveMetric;
  /** Puntos por defecto; el ruleset activo puede sobrescribirlos por id. */
  points: number;
  /**
   * Id del objetivo **cabeza de familia** (el logro global que agrupa a sus
   * hijos), o `null` si es independiente. `polifacetico` es cabeza de los
   * `lider-<civ>` y `jugon` lo es de los `acolito-<civ>`; la interfaz los agrupa
   * en una tarjeta a partir de este campo.
   */
  parent: string | null;
  /**
   * Umbral del logro, para la barra de avance de la interfaz; `null` en las
   * competiciones y en `por-tierra-y-agua`, cuyo umbral es el tamaño del pool
   * activo y por tanto solo se conoce en tiempo de cálculo.
   */
  target: number | null;
};

/**
 * Detalle extra de un contendiente, cuando el objetivo lo tiene. Hoy no lo usa
 * ninguno, pero el campo se mantiene para que la interfaz pueda añadir contexto
 * (la civilización de un `masterizando-*`, por ejemplo) sin cambiar el contrato.
 */
export type ObjectiveDetail = { id: string; label: string };

/**
 * Un jugador en la lista de un objetivo. `value` es lo que hay que pintar
 * (partidas, victorias, racha, días…), `matches` el número de partidas del que
 * sale, y `eligible` significa:
 *
 * - en una **competición**, que cumple lo mínimo para poder poseerla;
 * - en un **logro**, que **ya lo ha completado** (es el check de la interfaz).
 */
export type ObjectiveContender = {
  profileId: number;
  name: string;
  avatarUrl: string | null;
  /** Enlace al perfil en AoE4World, con el mismo criterio que `StandingRow`. */
  profileUrl: string | null;
  value: number;
  matches: number;
  eligible: boolean;
  /** Detalle del objetivo; `null` cuando no aporta nada (ver `ObjectiveDetail`). */
  detail?: ObjectiveDetail | null;
};

/**
 * Un beneficiario de un logro: quien lo ha completado y cuántos puntos cobra.
 *
 * `points` es variable en `imparable` (1 por día, con tope); en el resto de logros
 * coincide con los puntos de la tarjeta.
 */
export type ObjectiveBeneficiary = {
  profileId: number;
  name: string;
  avatarUrl: string | null;
  profileUrl: string | null;
  points: number;
};

/** Umbral de un logro: en qué unidad y cuánto hace falta para completarlo. */
export type ObjectiveTarget = {
  unit: ObjectiveMetric;
  value: number;
};

export type ObjectiveOption = {
  id: string;
  group: ObjectiveGroup;
  kind: ObjectiveKind;
  label: string;
  /** La regla en una frase, tal cual está en el catálogo (`ObjectiveDefinition`). */
  description: string;
  metric: ObjectiveMetric;
  /** Puntos que otorga poseerlo, ya con los overrides del ruleset aplicado. */
  points: number;
  /** Cabeza de familia del objetivo (`ObjectiveDefinition.parent`). */
  parent: string | null;
  /**
   * Poseedor único; `null` si nadie cumple. **Solo en competiciones**: en un logro
   * es siempre `null`, porque lo cobra cualquiera que cumpla (ver
   * `beneficiaries`).
   */
  holder: ObjectiveContender | null;
  /**
   * **Todos** los contendientes, ordenados por la cadena de desempate.
   *
   * Va entero, sin acotar: quien pinta decide cuánto enseña y con qué paginación.
   * No se rellena con jugadores a cero: solo entra quien tiene al menos una partida
   * dentro del objetivo. El poseedor **no** se pone el primero: aparece donde le
   * deja su métrica y lo marca `holder`.
   */
  ranking: ObjectiveContender[];
  /**
   * Quién ha completado un **logro**, con sus puntos. Vacío en las competiciones.
   * Es la lista que pinta el check de "conseguido" en la ficha de un participante
   * y el reparto de puntos.
   */
  beneficiaries: ObjectiveBeneficiary[];
  /**
   * Umbral del logro, listo para una barra de avance; `null` en las
   * competiciones.
   */
  target: ObjectiveTarget | null;
};

export type ObjectiveView = {
  ruleSetVersion: number;
  /** Etiqueta de la regla activa, la misma que guarda el desglose. */
  rule: string;
  /** Puntos por victoria clasificatoria del ruleset activo. */
  pointsPerWin: number;
  /**
   * Ventana del torneo (`[from, to)` sobre `Match.startedAt`), tal cual está en el
   * ruleset activo: instantes ISO-8601 UTC, `to` a `null` si está abierta por la
   * derecha.
   */
  window: ScoringWindow;
  /**
   * Pool de mapas activo, el mismo que resuelve `por-tierra-y-agua`. Se publica
   * para que la interfaz pueda listar los mapas del objetivo sin volver a leer
   * `Setting`.
   */
  mapPool: string[];
  /**
   * En orden estable: por grupo (`actividad` → `civilizacion`) y, dentro de cada
   * uno, por el orden de la lista (las cabezas de familia antes que sus hijos,
   * civilizaciones por `id`).
   */
  options: ObjectiveOption[];
};

export type ObjectiveGroupLabel = Record<ObjectiveGroup, string>;

/** Rótulos de grupo para la interfaz; el orden es el de `ObjectiveGroup`. */
export const OBJECTIVE_GROUP_LABELS: ObjectiveGroupLabel = {
  actividad: "Actividad",
  racha: "Racha",
  hazanas: "Hazañas",
  formato: "Formatos",
  civilizacion: "Civilizaciones",
};

/** Formatos de partida que reconocen los objetivos `rey-*`. */
export const FORMAT_IDS = ["1v1", "2v2", "3v3", "4v4"] as const;

export type FormatId = (typeof FORMAT_IDS)[number];

/** Puntos de un `rey-*`, los mismos para los cuatro formatos. */
const REY_POINTS = 240;

/** Puntos de un `masterizando-<civ>`. */
const MASTERIZANDO_POINTS = 120;

/** Puntos de un `lider-<civ>` y de un `acolito-<civ>`. */
const LIDER_POINTS = 12;
const ACOLITO_POINTS = 6;

/** Ids de familia y de los logros globales. */
export const POLIFACETICO_ID = "polifacetico";
export const JUGON_ID = "jugon";
export const IMPARABLE_ID = "imparable";
export const POR_TIERRA_ID = "por-tierra-y-agua";

/**
 * Umbrales de los logros. Son **fijos** (están en `docs/OBJETIVOS.md`), a
 * diferencia de los mínimos configurables que tenía el catálogo anterior: por eso
 * viven como constantes y no en `Setting`.
 */
const WINS_PER_CIV = 3;
const MATCHES_PER_CIV = 3;
const MATCHES_PER_MAP = 3;
const IMBATIBLE_STREAK = 5;
const IMPARABLE_DAYS = 14;
/** Duración de una partida corta (`agresor`) y larga (`estratega`), en segundos. */
const SHORT_MATCH_SECONDS = 600;
const LONG_MATCH_SECONDS = 1200;

/**
 * Los objetivos en orden de presentación.
 *
 * El `id` es estable y forma parte de la configuración guardada en `Setting`
 * (`scoring.ruleset.objectives`) y del desglose de `PlayerScore`: renombrarlo deja
 * huérfanos los puntos ya publicados.
 *
 * Dentro del grupo `civilizacion` el orden respeta la jerarquía: primero las 23
 * `masterizando-<civ>` (competiciones), después la cabeza `polifacetico` seguida
 * de sus 23 `lider-<civ>`, y por último `jugon` seguida de sus 23 `acolito-<civ>`.
 */
export const OBJECTIVE_DEFINITIONS: readonly ObjectiveDefinition[] = [
  {
    id: "loco-por-ganar",
    group: "actividad",
    kind: "competition",
    label: "Loco por ganar",
    description: "El jugador con más partidas clasificatorias jugadas en el torneo.",
    metric: "partidas",
    points: 50,
    parent: null,
    target: null,
  },
  {
    id: IMPARABLE_ID,
    group: "actividad",
    kind: "achievement",
    label: "Imparable",
    description: `Juega al menos una partida clasificatoria cada día natural: 1 punto por día, hasta ${IMPARABLE_DAYS}.`,
    metric: "dias",
    points: IMPARABLE_DAYS,
    parent: null,
    target: IMPARABLE_DAYS,
  },
  {
    id: "bienhadado",
    group: "racha",
    kind: "competition",
    label: "Bienhadado",
    description: "La racha de victorias seguidas más larga del torneo.",
    metric: "racha",
    points: 200,
    parent: null,
    target: null,
  },
  {
    id: "imbatible",
    group: "racha",
    kind: "achievement",
    label: "Imbatible",
    description: `Encadena una racha de ${IMBATIBLE_STREAK} victorias seguidas.`,
    metric: "racha",
    points: 32,
    parent: null,
    target: IMBATIBLE_STREAK,
  },
  {
    id: "agresor",
    group: "hazanas",
    kind: "achievement",
    label: "Agresor",
    description: `Gana al menos ${WINS_PER_CIV} partidas de menos de 10 minutos.`,
    metric: "victorias",
    points: 24,
    parent: null,
    target: WINS_PER_CIV,
  },
  {
    id: "estratega",
    group: "hazanas",
    kind: "achievement",
    label: "Estratega",
    description: `Gana al menos ${WINS_PER_CIV} partidas de más de 20 minutos.`,
    metric: "victorias",
    points: 24,
    parent: null,
    target: WINS_PER_CIV,
  },
  {
    id: POR_TIERRA_ID,
    group: "hazanas",
    kind: "achievement",
    label: "Por tierra y agua",
    description: `Juega al menos ${MATCHES_PER_MAP} partidas en cada mapa del pool activo.`,
    metric: "mapas",
    points: 81,
    parent: null,
    // El umbral es el tamaño del pool activo, que solo se conoce al calcular.
    target: null,
  },
  ...FORMAT_IDS.map((format) => ({
    id: `rey-${format}`,
    group: "formato" as const,
    kind: "competition" as const,
    label: `Rey del ${format}`,
    description: `El jugador con más victorias jugando en formato ${format}.`,
    metric: "victorias" as const,
    points: REY_POINTS,
    parent: null,
    target: null,
  })),
  ...CIVILIZATIONS.map((civ) => ({
    id: `masterizando-${civ.id}`,
    group: "civilizacion" as const,
    kind: "competition" as const,
    label: `Masterizando ${civ.name}`,
    description: `El jugador con más victorias con ${civ.name}.`,
    metric: "victorias" as const,
    points: MASTERIZANDO_POINTS,
    parent: null,
    target: null,
  })),
  {
    id: POLIFACETICO_ID,
    group: "civilizacion",
    kind: "achievement",
    label: "Polifacético",
    description: `Gana al menos ${WINS_PER_CIV} partidas con cada una de las ${CIVILIZATIONS.length} civilizaciones.`,
    metric: "civilizaciones",
    points: 96,
    parent: null,
    target: CIVILIZATION_IDS.length,
  },
  ...CIVILIZATIONS.map((civ) => ({
    id: `lider-${civ.id}`,
    group: "civilizacion" as const,
    kind: "achievement" as const,
    label: `Líder ${civ.name}`,
    description: `Gana al menos ${WINS_PER_CIV} partidas con ${civ.name}.`,
    metric: "victorias" as const,
    points: LIDER_POINTS,
    parent: POLIFACETICO_ID,
    target: WINS_PER_CIV,
  })),
  {
    id: JUGON_ID,
    group: "civilizacion",
    kind: "achievement",
    label: "Jugón",
    description: `Juega al menos ${MATCHES_PER_CIV} partidas con cada una de las ${CIVILIZATIONS.length} civilizaciones.`,
    metric: "civilizaciones",
    points: 24,
    parent: null,
    target: CIVILIZATION_IDS.length,
  },
  ...CIVILIZATIONS.map((civ) => ({
    id: `acolito-${civ.id}`,
    group: "civilizacion" as const,
    kind: "achievement" as const,
    label: `Acólito ${civ.name}`,
    description: `Juega al menos ${MATCHES_PER_CIV} partidas con ${civ.name}.`,
    metric: "partidas" as const,
    points: ACOLITO_POINTS,
    parent: JUGON_ID,
    target: MATCHES_PER_CIV,
  })),
];

/** Total de objetivos del catálogo. */
export const OBJECTIVE_COUNT = OBJECTIVE_DEFINITIONS.length;

/** Puntos por defecto de cada objetivo, indexados por id. */
export const OBJECTIVE_POINTS: Record<string, number> = Object.fromEntries(
  OBJECTIVE_DEFINITIONS.map((definition) => [definition.id, definition.points]),
);

export type ObjectiveAward = {
  /** Puntos que suma el jugador por objetivos. */
  points: number;
  /** Ids de los objetivos que posee o ha completado, en orden de presentación. */
  earned: string[];
};

/**
 * Un objetivo cobrado por un jugador, visto desde el motor.
 *
 * Va en `awarded` y no en `ObjectiveOption` a propósito: es lo que consume el
 * registro de hitos (`ObjectiveEvent`, escrito por `reconcileObjectiveEvents()`
 * en `scoring.ts`), y `/objetivos` no tiene por qué enterarse de que existe una
 * tabla de hitos. En una competición hay una entrada; en un logro, una por
 * beneficiario.
 */
export type ObjectiveAwarded = {
  /** Id estable del objetivo (`loco-por-ganar`, `lider-japanese`…). */
  id: string;
  /** `Player.id` de quien lo cobra. */
  playerId: string;
};

export type ObjectivesComputation = {
  options: ObjectiveOption[];
  /** Solo aparece quien cobra al menos un objetivo. */
  pointsByPlayer: Map<string, ObjectiveAward>;
  /** Cuántos objetivos tienen al menos un beneficiario hoy. */
  holders: number;
  /** Un objetivo cobrado por jugador; alimenta el registro de hitos. */
  awarded: ObjectiveAwarded[];
};

/** Cliente con la única consulta que necesita este módulo (`db` o una `tx`). */
export type ObjectiveQueryClient = Pick<Prisma.TransactionClient, "$queryRaw">;

type ObjectiveMatchRow = {
  playerId: string;
  profileId: number;
  name: string;
  avatarUrl: string | null;
  rankLevel: string | null;
  mode: string | null;
  result: string;
  civ: string | null;
  civRandomized: boolean;
  map: string | null;
  durationSeconds: number | null;
  gameId: string;
  leaderboard: string;
  kind: string | null;
  finishedAtMs: number;
};

/**
 * Partidas clasificatorias de los jugadores aprobados, con lo que hace falta
 * para los objetivos, en una sola sentencia.
 *
 * Qué es una partida clasificatoria **no** se decide aquí: sale de
 * `rankedMatchSql()`, el mismo predicado que aplica el `UPDATE` de `Match.points`
 * y el agregado de la clasificación (`src/lib/ranked-match.ts`). Así los
 * objetivos cuentan exactamente las mismas partidas que las victorias, incluido el
 * **corte de inscripción**, el final de la ventana y la marca de revertida.
 *
 * `map` y `durationSeconds` entran porque los necesitan `por-tierra-y-agua`,
 * `agresor` y `estratega`; antes no se leían. Los `finishedAt` viajan como
 * milisegundos: es un número, no una fecha, y evita discutir con la zona horaria
 * de la sesión al cruzar los tiempos. `at time zone 'UTC'` hace falta porque
 * Prisma guarda los `DateTime` como timestamp sin zona interpretado en UTC.
 */
function objectiveRowsQuery(ruleset: ScoringRuleset): Prisma.Sql {
  return Prisma.sql`
    select p."id" as "playerId",
           p."profileId" as "profileId",
           p."name" as "name",
           p."avatarUrl" as "avatarUrl",
           p."rankLevel" as "rankLevel",
           m."mode" as "mode",
           m."result"::text as "result",
           m."civ" as "civ",
           m."civRandomized" as "civRandomized",
           m."map" as "map",
           m."durationSeconds" as "durationSeconds",
           m."gameId" as "gameId",
           m."leaderboard" as "leaderboard",
           m."rawJson" ->> 'kind' as "kind",
           (extract(epoch from m."finishedAt" at time zone 'UTC') * 1000)::double precision as "finishedAtMs"
    from "Match" m
    join "Player" p on p."id" = m."playerId"
    where p."status" = 'APPROVED'
      and ${rankedMatchSql(Prisma.sql`m`, Prisma.sql`p`, ruleset.modes, ruleset.window)}
    order by p."id", m."finishedAt", m."gameId"
  `;
}

type PlayerMeta = {
  playerId: string;
  profileId: number;
  name: string;
  avatarUrl: string | null;
  rankLevel: string | null;
};

type CivRecord = {
  matches: number;
  wins: number;
  /** Última victoria con esta civ, para el desempate 3. */
  lastWinAt: number;
};

type FormatRecord = {
  matches: number;
  wins: number;
  lastWinAt: number;
};

export type PlayerAggregate = {
  playerId: string;
  profileId: number;
  name: string;
  avatarUrl: string | null;
  rankLevel: string | null;
  matches: number;
  wins: number;
  lastMatchAt: number;
  lastWinAt: number;
  /** Victorias seguidas más larga y cuándo terminó. */
  streak: number;
  streakEndsAt: number;
  /** Victorias cortas (`< 10 min`) y largas (`> 20 min`). */
  shortWins: number;
  longWins: number;
  /** Días naturales (Europe/Madrid) con al menos una partida clasificatoria. */
  playedDays: Set<string>;
  byFormat: Map<FormatId, FormatRecord>;
  byCiv: Map<string, CivRecord>;
  /** Partidas clasificatorias por mapa (`Match.map` tal cual). */
  byMap: Map<string, number>;
};

/** Los ids del catálogo en `Set`, para el recuento de civilizaciones dominadas. */
const CATALOG_CIVS: ReadonlySet<string> = new Set(CIVILIZATION_IDS);

/**
 * El día natural de un instante en la zona del torneo.
 *
 * `Europe/Madrid` es la zona que la organización usa para leer el torneo (la misma
 * que `src/lib/alerts/report.ts` para fechas de informe): lo que decide `imparable`
 * es "el día" del calendario de la liga, no el día UTC, que cambiaría de frontera
 * a las 2 de la madrugada local. El formato `en-CA` da `YYYY-MM-DD`, que ordena
 * alfabéticamente igual que cronológicamente.
 */
const MADRID_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Madrid",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function naturalDay(ms: number): string {
  return MADRID_DAY.format(ms);
}

/**
 * El tamaño de la partida, si se puede determinar.
 *
 * `mode` no sirve para esto (`rm_team` colapsa 2v2, 3v3 y 4v4): el tamaño solo
 * está en el `kind` del payload (`rm_2v2`) o, de reserva, en el `leaderboard`.
 * Si no aparece ninguno de los dos, la partida puntúa en todo lo demás pero no
 * entra en ningún `rey-*`.
 */
function resolveFormat(row: ObjectiveMatchRow): FormatId | null {
  for (const candidate of [row.kind, row.leaderboard]) {
    if (candidate === null) {
      continue;
    }

    const match = /^rm_(\d)v(\d)$/.exec(candidate);

    if (match === null || match[1] !== match[2]) {
      continue;
    }

    const format = `${match[1]}v${match[2]}`;

    if ((FORMAT_IDS as readonly string[]).includes(format)) {
      return format as FormatId;
    }
  }

  return null;
}

function emptyPlayer(meta: PlayerMeta): PlayerAggregate {
  return {
    playerId: meta.playerId,
    profileId: meta.profileId,
    name: meta.name,
    avatarUrl: meta.avatarUrl,
    rankLevel: meta.rankLevel,
    matches: 0,
    wins: 0,
    lastMatchAt: 0,
    lastWinAt: 0,
    streak: 0,
    streakEndsAt: 0,
    shortWins: 0,
    longWins: 0,
    playedDays: new Set(),
    byFormat: new Map(),
    byCiv: new Map(),
    byMap: new Map(),
  };
}

/**
 * Agrega las partidas de un jugador ya ordenadas por `finishedAt`.
 *
 * La racha se calcula aquí, en el mismo barrido: es el único cálculo que depende
 * del orden, y hacerlo en el cliente de la consulta obligaría a guardar la partida
 * entera en memoria. Los días (`imparable`), las partidas cortas y largas
 * (`agresor`/`estratega`) y los mapas (`por-tierra-y-agua`) salen del mismo
 * recorrido.
 */
function aggregatePlayer(
  aggregate: PlayerAggregate,
  rows: ObjectiveMatchRow[],
  ruleset: ScoringRuleset,
): void {
  let run = 0;

  for (const row of rows) {
    const won = row.result === "WIN";

    aggregate.matches += 1;
    aggregate.lastMatchAt = row.finishedAtMs;
    aggregate.playedDays.add(naturalDay(row.finishedAtMs));

    if (won) {
      aggregate.wins += 1;
      aggregate.lastWinAt = row.finishedAtMs;
      run += 1;

      if (run > aggregate.streak) {
        aggregate.streak = run;
        aggregate.streakEndsAt = row.finishedAtMs;
      }

      if (row.durationSeconds !== null) {
        if (row.durationSeconds < SHORT_MATCH_SECONDS) {
          aggregate.shortWins += 1;
        } else if (row.durationSeconds > LONG_MATCH_SECONDS) {
          aggregate.longWins += 1;
        }
      }
    } else {
      run = 0;
    }

    const format = resolveFormat(row);

    if (format !== null) {
      const record = aggregate.byFormat.get(format) ?? { matches: 0, wins: 0, lastWinAt: 0 };
      record.matches += 1;

      if (won) {
        record.wins += 1;
        record.lastWinAt = row.finishedAtMs;
      }

      aggregate.byFormat.set(format, record);
    }

    if (row.map !== null) {
      aggregate.byMap.set(row.map, (aggregate.byMap.get(row.map) ?? 0) + 1);
    }

    // Las partidas con civ aleatoria no dicen nada de la civilización de nadie: se
    // excluyen de todos los objetivos de civilización. No afectan a los demás.
    if (row.civ === null || (!ruleset.countRandomizedCivs && row.civRandomized)) {
      continue;
    }

    const civ = aggregate.byCiv.get(row.civ) ?? { matches: 0, wins: 0, lastWinAt: 0 };

    civ.matches += 1;

    if (won) {
      civ.wins += 1;
      civ.lastWinAt = row.finishedAtMs;
    }

    aggregate.byCiv.set(row.civ, civ);
  }
}

/**
 * Partidas clasificatorias → agregados por jugador, listos para los objetivos.
 *
 * Una sola consulta y ninguna por fila: 1300 partidas hoy y decenas de miles en el
 * peor caso, todo cabe en el mismo barrido.
 */
export async function loadObjectivePlayers(
  client: ObjectiveQueryClient,
  ruleset: ScoringRuleset,
): Promise<PlayerAggregate[]> {
  if (ruleset.modes.length === 0) {
    return [];
  }

  const rows = await client.$queryRaw<ObjectiveMatchRow[]>(objectiveRowsQuery(ruleset));
  const byPlayer = new Map<string, { meta: PlayerMeta; rows: ObjectiveMatchRow[] }>();

  for (const row of rows) {
    const entry = byPlayer.get(row.playerId);

    if (entry !== undefined) {
      entry.rows.push(row);
      continue;
    }

    byPlayer.set(row.playerId, {
      meta: {
        playerId: row.playerId,
        profileId: row.profileId,
        name: row.name,
        avatarUrl: row.avatarUrl,
        rankLevel: row.rankLevel,
      },
      rows: [row],
    });
  }

  const players: PlayerAggregate[] = [];

  for (const { meta, rows: playerRows } of byPlayer.values()) {
    // La consulta ya ordena, pero el orden sostiene la racha: no se deja en manos
    // del planificador.
    const ordered = [...playerRows].sort(
      (a, b) =>
        a.finishedAtMs - b.finishedAtMs ||
        (a.gameId < b.gameId ? -1 : a.gameId > b.gameId ? 1 : 0),
    );

    const aggregate = emptyPlayer(meta);
    aggregatePlayer(aggregate, ordered, ruleset);
    players.push(aggregate);
  }

  players.sort((a, b) => a.profileId - b.profileId);

  return players;
}

/* -------------------------------------------------------------------------- */
/* Cálculo                                                                    */
/* -------------------------------------------------------------------------- */

type ObjectiveCandidate = {
  player: PlayerAggregate;
  metric: ObjectiveMetric;
  /** Valor de la métrica (partidas, victorias, racha, días…). */
  value: number;
  /** Partidas de las que sale `value`. */
  matches: number;
  /** Cumple la condición: posee la competición o completa el logro. */
  eligible: boolean;
  /** Cuándo se alcanzó `value`, para el desempate 3. */
  achievedAt: number;
  detail: ObjectiveDetail | null;
};

function candidate(
  player: PlayerAggregate,
  metric: ObjectiveMetric,
  value: number,
  matches: number,
  eligible: boolean,
  achievedAt: number,
  detail: ObjectiveDetail | null = null,
): ObjectiveCandidate {
  return { player, metric, value, matches, eligible, achievedAt, detail };
}

/**
 * Cadena de desempate: métrica, victorias, antigüedad y `profileId`.
 *
 * Todas las métricas del catálogo son cantidades enteras, así que la comparación
 * es una resta; el desempate termina en `profileId`, que es único.
 */
function compareCandidates(a: ObjectiveCandidate, b: ObjectiveCandidate): number {
  if (a.value !== b.value) {
    return b.value - a.value;
  }

  if (a.player.wins !== b.player.wins) {
    return b.player.wins - a.player.wins;
  }

  if (a.achievedAt !== b.achievedAt) {
    return a.achievedAt - b.achievedAt;
  }

  return a.player.profileId - b.player.profileId;
}

function toContender(value: ObjectiveCandidate): ObjectiveContender {
  return {
    profileId: value.player.profileId,
    name: value.player.name,
    avatarUrl: value.player.avatarUrl,
    profileUrl: aoe4WorldProfileUrl(value.player.profileId),
    value: value.value,
    matches: value.matches,
    eligible: value.eligible,
    detail: value.detail,
  };
}

export type ObjectiveStanding = {
  /** Posición 1-based entre los aspirantes; `null` fuera del ranking. */
  position: number | null;
  /** Distancia al líder en la unidad de la métrica; `null` fuera del ranking. */
  distance: number | null;
};

/**
 * Posición y distancia al primero de un participante dentro del ranking de un
 * objetivo.
 *
 * `position` es 1-based (`1` es el líder) y `distance` son las unidades enteras
 * que le faltan. Los dos son `null` cuando el participante **no aparece** en el
 * ranking: `ObjectiveOption.ranking` solo lleva a quien tiene al menos una partida
 * dentro del objetivo, así que su ausencia significa "no disputa este objetivo
 * ahora mismo", no "va último".
 *
 * Es puro: solo depende del ranking ya ordenado que publica `computeObjectives`.
 */
export function objectiveStanding(
  ranking: readonly ObjectiveContender[],
  profileId: number,
): ObjectiveStanding {
  const index = ranking.findIndex((contender) => contender.profileId === profileId);

  if (index === -1 || ranking.length === 0) {
    return { position: null, distance: null };
  }

  return {
    position: index + 1,
    distance: ranking[0].value - ranking[index].value,
  };
}

/**
 * Cuántas civilizaciones del catálogo cumplen una condición sobre su registro.
 *
 * `byCiv` no se limita al catálogo: guarda la civ que venga en la partida, que
 * puede ser de un DLC que el catálogo todavía no conoce. Para los objetivos
 * globales solo cuentan las del catálogo, y por eso el filtro es explícito.
 */
function countCivs(
  byCiv: ReadonlyMap<string, CivRecord>,
  predicate: (record: CivRecord) => boolean,
): number {
  let count = 0;

  for (const civId of CATALOG_CIVS) {
    const record = byCiv.get(civId);

    if (record !== undefined && predicate(record)) {
      count += 1;
    }
  }

  return count;
}

/** Cuántos mapas del pool llevan al menos `MATCHES_PER_MAP` partidas. */
function countPoolMaps(byMap: ReadonlyMap<string, number>, mapPool: readonly string[]): number {
  let count = 0;

  for (const map of mapPool) {
    if ((byMap.get(map) ?? 0) >= MATCHES_PER_MAP) {
      count += 1;
    }
  }

  return count;
}

function candidatesFor(
  definition: ObjectiveDefinition,
  players: readonly PlayerAggregate[],
  mapPool: readonly string[],
): ObjectiveCandidate[] {
  if (definition.id === "loco-por-ganar") {
    return players
      .filter((player) => player.matches >= 1)
      .map((player) =>
        candidate(player, "partidas", player.matches, player.matches, true, player.lastMatchAt),
      );
  }

  if (definition.id === IMPARABLE_ID) {
    return players
      .filter((player) => player.playedDays.size >= 1)
      .map((player) =>
        candidate(player, "dias", player.playedDays.size, player.matches, true, player.lastMatchAt),
      );
  }

  if (definition.id === "bienhadado") {
    return players
      .filter((player) => player.streak >= 1)
      .map((player) =>
        candidate(player, "racha", player.streak, player.matches, true, player.streakEndsAt),
      );
  }

  if (definition.id === "imbatible") {
    return players
      .filter((player) => player.streak >= 1)
      .map((player) =>
        candidate(
          player,
          "racha",
          player.streak,
          player.matches,
          player.streak >= IMBATIBLE_STREAK,
          player.streakEndsAt,
        ),
      );
  }

  if (definition.id === "agresor" || definition.id === "estratega") {
    const field = definition.id === "agresor" ? "shortWins" : "longWins";

    return players.flatMap((player) => {
      const value = player[field];

      if (value < 1) {
        return [];
      }

      return [
        candidate(
          player,
          "victorias",
          value,
          player.matches,
          value >= WINS_PER_CIV,
          player.lastWinAt,
        ),
      ];
    });
  }

  if (definition.id === POR_TIERRA_ID) {
    return players.flatMap((player) => {
      const covered = countPoolMaps(player.byMap, mapPool);

      if (covered < 1) {
        return [];
      }

      return [
        candidate(
          player,
          "mapas",
          covered,
          player.matches,
          mapPool.length > 0 && covered === mapPool.length,
          player.lastMatchAt,
        ),
      ];
    });
  }

  if (definition.group === "formato") {
    const format = definition.id.slice("rey-".length) as FormatId;

    return players.flatMap((player) => {
      const record = player.byFormat.get(format);

      if (record === undefined || record.matches < 1) {
        return [];
      }

      return [
        candidate(
          player,
          "victorias",
          record.wins,
          record.matches,
          record.wins >= 1,
          record.lastWinAt,
        ),
      ];
    });
  }

  if (definition.id === POLIFACETICO_ID || definition.id === JUGON_ID) {
    const wins = definition.id === POLIFACETICO_ID;

    return players.flatMap((player) => {
      const value = wins
        ? countCivs(player.byCiv, (record) => record.wins >= WINS_PER_CIV)
        : countCivs(player.byCiv, (record) => record.matches >= MATCHES_PER_CIV);

      if (value < 1) {
        return [];
      }

      return [
        candidate(
          player,
          "civilizaciones",
          value,
          player.matches,
          value === CIVILIZATION_IDS.length,
          player.lastWinAt,
        ),
      ];
    });
  }

  // Civilizaciones: `masterizando-<civ>` (competición), `lider-<civ>` y
  // `acolito-<civ>` (logros). Los tres comparten el registro por civ.
  const isMasterizando = definition.id.startsWith("masterizando-");
  const isLider = definition.id.startsWith("lider-");
  const civ = isMasterizando
    ? definition.id.slice("masterizando-".length)
    : isLider
      ? definition.id.slice("lider-".length)
      : definition.id.slice("acolito-".length);

  return players.flatMap((player) => {
    const record = player.byCiv.get(civ);

    if (record === undefined) {
      return [];
    }

    if (isMasterizando) {
      if (record.wins < 1) {
        return [];
      }

      return [
        candidate(player, "victorias", record.wins, record.matches, true, record.lastWinAt),
      ];
    }

    if (isLider) {
      if (record.wins < 1) {
        return [];
      }

      return [
        candidate(
          player,
          "victorias",
          record.wins,
          record.matches,
          record.wins >= WINS_PER_CIV,
          record.lastWinAt,
        ),
      ];
    }

    if (record.matches < 1) {
      return [];
    }

    return [
      candidate(
        player,
        "partidas",
        record.matches,
        record.matches,
        record.matches >= MATCHES_PER_CIV,
        record.lastWinAt,
      ),
    ];
  });
}

/** El umbral de un logro, listo para la barra de avance de la interfaz. */
function targetFor(
  definition: ObjectiveDefinition,
  mapPool: readonly string[],
): ObjectiveTarget | null {
  if (definition.kind === "competition") {
    return null;
  }

  return {
    unit: definition.metric,
    value: definition.id === POR_TIERRA_ID ? mapPool.length : (definition.target ?? 0),
  };
}

/**
 * Resuelve el catálogo contra las reglas activas y el pool de mapas.
 *
 * Devuelve los puntos por jugador, que es lo que suma el motor a la clasificación:
 * en una competición solo el poseedor recibe sus puntos; en un logro, cada
 * beneficiario los suyos (`imparable` los reparte por día, con tope). Un objetivo
 * sin nadie que lo cumpla no reparte nada.
 */
export function computeObjectives(
  players: readonly PlayerAggregate[],
  ruleset: ScoringRuleset,
  mapPool: readonly string[],
): ObjectivesComputation {
  const options: ObjectiveOption[] = [];
  const pointsByPlayer = new Map<string, ObjectiveAward>();
  const awarded: ObjectiveAwarded[] = [];
  let holders = 0;

  const addAward = (playerId: string, id: string, points: number): void => {
    const award = pointsByPlayer.get(playerId) ?? { points: 0, earned: [] };

    award.points += points;
    award.earned.push(id);
    pointsByPlayer.set(playerId, award);
  };

  for (const definition of OBJECTIVE_DEFINITIONS) {
    const sorted = candidatesFor(definition, players, mapPool).sort(compareCandidates);
    const points = ruleset.objectives[definition.id] ?? definition.points;

    if (definition.kind === "competition") {
      const holder = sorted[0];
      const winner = holder !== undefined && holder.eligible ? holder : null;

      if (winner !== null) {
        addAward(winner.player.playerId, definition.id, points);
        awarded.push({ id: definition.id, playerId: winner.player.playerId });
        holders += 1;
      }

      options.push({
        id: definition.id,
        group: definition.group,
        kind: definition.kind,
        label: definition.label,
        description: definition.description,
        metric: definition.metric,
        points,
        parent: definition.parent,
        holder: winner === null ? null : toContender(winner),
        ranking: sorted.map(toContender),
        beneficiaries: [],
        target: null,
      });

      continue;
    }

    const beneficiaries = sorted.filter((value) => value.eligible);

    for (const beneficiary of beneficiaries) {
      // En `imparable` los puntos son 1 por día, con el tope que marque el
      // ruleset; en el resto de logros, los puntos de la tarjeta.
      const earned =
        definition.id === IMPARABLE_ID ? Math.min(beneficiary.value, points) : points;

      addAward(beneficiary.player.playerId, definition.id, earned);
      awarded.push({ id: definition.id, playerId: beneficiary.player.playerId });
    }

    if (beneficiaries.length > 0) {
      holders += 1;
    }

    options.push({
      id: definition.id,
      group: definition.group,
      kind: definition.kind,
      label: definition.label,
      description: definition.description,
      metric: definition.metric,
      points,
      parent: definition.parent,
      holder: null,
      ranking: sorted.map(toContender),
      beneficiaries: beneficiaries.map((value) => ({
        profileId: value.player.profileId,
        name: value.player.name,
        avatarUrl: value.player.avatarUrl,
        profileUrl: aoe4WorldProfileUrl(value.player.profileId),
        points: definition.id === IMPARABLE_ID ? Math.min(value.value, points) : points,
      })),
      target: targetFor(definition, mapPool),
    });
  }

  return { options, pointsByPlayer, holders, awarded };
}
