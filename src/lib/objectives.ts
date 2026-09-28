import "server-only";

import { Prisma } from "@/generated/prisma/client";
import { CIVILIZATIONS, civilizationName } from "@/lib/civs";
import { DIVISIONS, divisionFromRankLevel, type DivisionId } from "@/lib/divisions";
import { aoe4WorldProfileUrl } from "@/lib/format";
import { rankedMatchSql, type ScoringWindow } from "@/lib/ranked-match";
import type { ScoringMinimums, ScoringRuleset } from "@/lib/scoring";

/**
 * Los 37 objetivos de `docs/PUNTUACION.md`.
 *
 * Este módulo no decide nada por su cuenta: recibe las partidas clasificatorias
 * ya cargadas y el ruleset activo, y devuelve qué objetivo posee cada jugador.
 * La lectura de la base (y la escritura de la clasificación) vive en
 * `scoring.ts`, que es quien importa de aquí, así el grafo de módulos no se
 * enrolla sobre sí mismo.
 *
 * Las traducciones de civilización y de división salen de `civs.ts` y
 * `divisions.ts`; la única lógica propia de este archivo es el orden y los
 * mínimos.
 */

/** Grupos de objetivos, en el orden en que se presentan (§3.1 del documento). */
export type ObjectiveGroup =
  | "actividad"
  | "racha"
  | "division"
  | "formato"
  | "civilizacion";

/** Métrica que decide quién posee un objetivo (ver §5 de `docs/PUNTUACION.md`). */
export type ObjectiveMetric = "partidas" | "winrate" | "racha" | "victorias";

export type ObjectiveDefinition = {
  id: string;
  group: ObjectiveGroup;
  label: string;
  metric: ObjectiveMetric;
  /** Puntos por defecto; el ruleset activo puede sobrescribirlos por id. */
  points: number;
};

/**
 * Detalle extra de un contendiente, cuando el objetivo lo tiene.
 *
 * Hoy solo lo rellena `otp`: la civilización con la que el jugador acumula sus
 * victorias. `label` es el nombre en español de `civilizationName()`.
 */
export type ObjectiveDetail = { id: string; label: string };

/**
 * Un jugador en la lista de un objetivo. `value` es lo que hay que pintar
 * (partidas, victorias o racha) y `matches` el número de partidas del que sale,
 * para poder mostrar el ratio sin datos extra: en `winrate` son
 * `value` victorias de `matches` partidas.
 */
export type ObjectiveContender = {
  profileId: number;
  name: string;
  avatarUrl: string | null;
  /** Enlace al perfil en AoE4World, con el mismo criterio que `StandingRow`. */
  profileUrl: string | null;
  value: number;
  matches: number;
  /** Cumple el mínimo del objetivo: solo un `eligible` puede poseerlo. */
  eligible: boolean;
  /** Detalle del objetivo; `null` cuando no aporta nada (ver `ObjectiveDetail`). */
  detail?: ObjectiveDetail | null;
};

export type ObjectiveOption = {
  id: string;
  group: ObjectiveGroup;
  label: string;
  metric: ObjectiveMetric;
  /** Puntos que otorga poseerlo, ya con el overrides del ruleset aplicado. */
  points: number;
  /** Poseedor actual; `null` si nadie cumple (o si la carrera no se ha completado). */
  holder: ObjectiveContender | null;
  /** Tres primeros por la cadena de desempate, con o sin mínimo cumplido. */
  ranking: ObjectiveContender[];
};

export type ObjectiveView = {
  ruleSetVersion: number;
  /** Etiqueta de la regla activa, la misma que guarda el desglose. */
  rule: string;
  /** Puntos por victoria clasificatoria del ruleset activo (§2). */
  pointsPerWin: number;
  /**
   * Ventana del torneo (`[from, to)` sobre `Match.startedAt`), tal cual está en el
   * ruleset activo: instantes ISO-8601 UTC, `to` a `null` si la ventana está
   * abierta por la derecha.
   *
   * Se publica para que la interfaz pueda decir qué periodo cuenta sin escribir
   * fechas en el copy, que es lo que hay que hacer con §1 de `PUNTUACION.md` cuando
   * la organización fije las suyas.
   */
  window: ScoringWindow;
  /** Mínimos del ruleset activo: de aquí sale el "mínimo de N partidas" (§3). */
  minimums: ScoringMinimums;
  /**
   * En orden estable: por grupo (`actividad` → `civilizacion`) y, dentro de
   * cada uno, por el orden de la lista (divisiones de Bronce a Conquistador,
   * formatos de 1v1 a 4v4, civilizaciones por `id`).
   */
  options: ObjectiveOption[];
};

export type ObjectiveGroupLabel = Record<ObjectiveGroup, string>;

/** Rótulos de grupo para la interfaz; el orden es el de `ObjectiveGroup`. */
export const OBJECTIVE_GROUP_LABELS: ObjectiveGroupLabel = {
  actividad: "Actividad",
  racha: "Racha",
  division: "Divisiones",
  formato: "Formatos",
  civilizacion: "Civilizaciones",
};

/** Formatos de partida que reconocen los objetivos `rey-*`. */
export const FORMAT_IDS = ["1v1", "2v2", "3v3", "4v4"] as const;

export type FormatId = (typeof FORMAT_IDS)[number];

/** Cuántos contendientes salen en el ranking de cada objetivo. */
const RANKING_LIMIT = 3;

/** Puntos por división, en el orden de `DIVISIONS` (§3.4). */
const SENSEI_POINTS = [40, 40, 45, 50, 55, 60];

/** Puntos por formato, en el orden de `FORMAT_IDS` (§3.5). */
const REY_POINTS = [55, 45, 40, 40];

const MASTERIZAR_POINTS = 70;

/**
 * Los 14 objetivos que no son de civilización, en su orden de presentación.
 *
 * Dentro de cada grupo el orden es el de esta lista: en `actividad`,
 * `loco-por-ganar` antes que `otp`; en `racha`, `golpe-de-suerte` antes que
 * `prohibido-perder` (el grupo se llama Racha, así que la racha se lee
 * primero). Es el orden que respeta `ObjectiveView.options` (§3.1).
 */
const NON_CIVILIZATION_DEFINITIONS: ObjectiveDefinition[] = [
  {
    id: "loco-por-ganar",
    group: "actividad",
    label: "Loco por ganar",
    metric: "partidas",
    points: 70,
  },
  { id: "otp", group: "actividad", label: "OTP", metric: "victorias", points: 60 },
  {
    id: "golpe-de-suerte",
    group: "racha",
    label: "¿Golpe de suerte?",
    metric: "racha",
    points: 50,
  },
  {
    id: "prohibido-perder",
    group: "racha",
    label: "Prohibido perder",
    metric: "winrate",
    points: 60,
  },
  ...DIVISIONS.map((division, index) => ({
    id: `sensei-${division.id}`,
    group: "division" as const,
    label: `El Sensei de ${division.label}`,
    metric: "victorias" as const,
    points: SENSEI_POINTS[index],
  })),
  ...FORMAT_IDS.map((format, index) => ({
    id: `rey-${format}`,
    group: "formato" as const,
    label: `Rey del ${format}`,
    metric: "victorias" as const,
    points: REY_POINTS[index],
  })),
];

/**
 * Los 37 objetivos en orden de presentación.
 *
 * El `id` es estable y forma parte de la configuración guardada en `Setting`
 * (`scoring.ruleset.objectives`) y del desglose de `PlayerScore`: renombrarlo
 * deja huérfanos los puntos ya publicados.
 */
export const OBJECTIVE_DEFINITIONS: readonly ObjectiveDefinition[] = [
  ...NON_CIVILIZATION_DEFINITIONS,
  ...CIVILIZATIONS.map((civ) => ({
    id: `masterizar-${civ.id}`,
    group: "civilizacion" as const,
    label: `Masterizando ${civ.name}`,
    metric: "victorias" as const,
    points: MASTERIZAR_POINTS,
  })),
];

/** Total de objetivos: 14 sin civilización + 23 con ella. */
export const OBJECTIVE_COUNT = OBJECTIVE_DEFINITIONS.length;

/** Puntos por defecto de cada objetivo, indexados por id. */
export const OBJECTIVE_POINTS: Record<string, number> = Object.fromEntries(
  OBJECTIVE_DEFINITIONS.map((definition) => [definition.id, definition.points]),
);

export type ObjectiveAward = {
  /** Puntos que suma el jugador por objetivos. */
  points: number;
  /** Ids de los objetivos que posee, en orden de presentación. */
  earned: string[];
};

export type ObjectivesComputation = {
  options: ObjectiveOption[];
  /** Solo aparece quien posee al menos un objetivo. */
  pointsByPlayer: Map<string, ObjectiveAward>;
  /** Cuántos objetivos tienen poseedor hoy. */
  holders: number;
};

/* -------------------------------------------------------------------------- */
/* Carga                                                                       */
/* -------------------------------------------------------------------------- */

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
  gameId: string;
  leaderboard: string;
  kind: string | null;
  finishedAtMs: number;
};

/**
 * Partidas clasificatorias de los jugadores aprobados, con lo que hace falta
 * para los objetivos, en dos sentencias como mucho.
 *
 * Qué es una partida clasificatoria **no** se decide aquí: sale de
 * `rankedMatchSql()`, el mismo predicado que aplica el `UPDATE` de `Match.points`
 * y el agregado de la clasificación (`src/lib/ranked-match.ts`). Así los
 * objetivos cuentan exactamente las mismas partidas que las victorias, incluida la
 * ventana de fechas: no hay forma de ganar un objetivo por partidas que no
 * puntúan.
 *
 * El formato de la partida no está en una columna (el `mode` solo distingue
 * `rm_solo` de `rm_team`), así que se deriva aquí del `kind` que devolvió la
 * API. Los `finishedAt` viajan como milisegundos: es un número, no una fecha,
 * y evita discutir con la zona horaria de la sesión al cruzar los tiempos.
 * `at time zone 'UTC'` hace falta porque Prisma guarda los `DateTime` como
 * timestamp sin zona horaria interpretado en UTC.
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
           m."gameId" as "gameId",
           m."leaderboard" as "leaderboard",
           m."rawJson" ->> 'kind' as "kind",
           (extract(epoch from m."finishedAt" at time zone 'UTC') * 1000)::double precision as "finishedAtMs"
    from "Match" m
    join "Player" p on p."id" = m."playerId"
    where p."status" = 'APPROVED'
      and ${rankedMatchSql(Prisma.sql`m`, ruleset.modes, ruleset.window)}
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
  /** Última partida jugada con esta civ. */
  lastAt: number;
  /** Última victoria con esta civ. */
  lastWinAt: number;
  /** Cuándo se consiguieron `minimums.masterizar` victorias, si se llegaron. */
  completedAt: number | null;
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
  division: DivisionId | null;
  matches: number;
  wins: number;
  lastMatchAt: number;
  lastWinAt: number;
  /** Victorias seguidas más larga y cuándo terminó. */
  streak: number;
  streakEndsAt: number;
  byFormat: Map<FormatId, FormatRecord>;
  byCiv: Map<string, CivRecord>;
};

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

function emptyPlayer(meta: PlayerMeta, rankLevel: string | null): PlayerAggregate {
  return {
    playerId: meta.playerId,
    profileId: meta.profileId,
    name: meta.name,
    avatarUrl: meta.avatarUrl,
    rankLevel,
    division: divisionFromRankLevel(rankLevel),
    matches: 0,
    wins: 0,
    lastMatchAt: 0,
    lastWinAt: 0,
    streak: 0,
    streakEndsAt: 0,
    byFormat: new Map(),
    byCiv: new Map(),
  };
}

/**
 * Agrega las partidas de un jugador ya ordenadas por `finishedAt`.
 *
 * La racha se calcula aquí, en el mismo barrido: es el único cálculo que
 * depende del orden, y hacerlo en el cliente de la consulta obligaría a
 * guardar la partida entera en memoria.
 */
function aggregatePlayer(
  aggregate: PlayerAggregate,
  rows: ObjectiveMatchRow[],
  ruleset: ScoringRuleset,
): void {
  let run = 0;
  let runEndsAt = 0;

  for (const row of rows) {
    const won = row.result === "WIN";

    aggregate.matches += 1;
    aggregate.lastMatchAt = row.finishedAtMs;

    if (won) {
      aggregate.wins += 1;
      aggregate.lastWinAt = row.finishedAtMs;
      run += 1;
      runEndsAt = row.finishedAtMs;

      if (run > aggregate.streak) {
        aggregate.streak = run;
        aggregate.streakEndsAt = runEndsAt;
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

    // Las partidas con civ aleatoria no dicen nada de la civilización de
    // nadie: se excluyen de `otp` y de `masterizar-*` (§3.2 del documento).
    if (row.civ === null || (!ruleset.countRandomizedCivs && row.civRandomized)) {
      continue;
    }

    const civ = aggregate.byCiv.get(row.civ) ?? {
      matches: 0,
      wins: 0,
      lastAt: 0,
      lastWinAt: 0,
      completedAt: null,
    };

    civ.matches += 1;
    civ.lastAt = row.finishedAtMs;

    if (won) {
      civ.wins += 1;
      civ.lastWinAt = row.finishedAtMs;

      if (civ.completedAt === null && civ.wins >= ruleset.minimums.masterizar) {
        civ.completedAt = row.finishedAtMs;
      }
    }

    aggregate.byCiv.set(row.civ, civ);
  }
}

/**
 * Partidas clasificatorias → agregados por jugador, listos para los objetivos.
 *
 * Una sola consulta y ninguna por fila: 127 partidas hoy y decenas de miles en
 * el peor caso, todo cabe en el mismo barrido. Se filtran por el mismo predicado
 * que el resto del motor, así que los `matches` y `wins` que salen de aquí son los
 * mismos números que publica la clasificación (ver `objectiveRowsQuery`).
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
    // La consulta ya ordena, pero el orden es lo que sostiene la racha y el
    // cálculo del "quién llegó primero": no se deja en manos del planificador.
    const ordered = [...playerRows].sort(
      (a, b) =>
        a.finishedAtMs - b.finishedAtMs ||
        (a.gameId < b.gameId ? -1 : a.gameId > b.gameId ? 1 : 0),
    );

    const aggregate = emptyPlayer(meta, meta.rankLevel);
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
  /** Valor de la métrica: partidas, victorias o racha (en `winrate`, victorias). */
  value: number;
  /** Partidas de las que sale `value`. */
  matches: number;
  eligible: boolean;
  /** Cuándo se completó el valor, para el desempate 3 (§5). */
  achievedAt: number;
  /** Cuándo se completó la carrera, solo en `masterizar-*`. */
  raceAt: number | null;
  /** Detalle adicional (hoy solo `otp`); se copia al contendiente. */
  detail: ObjectiveDetail | null;
};

function candidate(
  player: PlayerAggregate,
  metric: ObjectiveMetric,
  value: number,
  matches: number,
  eligible: boolean,
  achievedAt: number,
  raceAt: number | null = null,
  detail: ObjectiveDetail | null = null,
): ObjectiveCandidate {
  return { player, metric, value, matches, eligible, achievedAt, raceAt, detail };
}

/**
 * Cadena de desempate de §5: métrica, victorias, antigüedad y `profileId`.
 *
 * El ratio se compara como fracción (`a/b` frente a `c/d` haciendo
 * `a*d` frente a `c*b`): sin redondear, dos winrates distintos nunca empatan
 * y dos idénticos siempre.
 */
function compareCandidates(a: ObjectiveCandidate, b: ObjectiveCandidate): number {
  if (a.metric === "winrate") {
    const left = a.value * b.matches;
    const right = b.value * a.matches;

    if (left !== right) {
      return right - left;
    }
  } else if (a.value !== b.value) {
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

/**
 * La civilización con la que un jugador acumula más victorias, para `otp`.
 *
 * El objetivo se lo lleva el máximo, sin umbral de partidas (§3.2): un mínimo
 * podría dejar el objetivo sin nadie que cogerlo. Como de cada jugador solo
 * sale un candidato, la civ elegida también fija `matches` y `achievedAt`, así
 * que el desempate interno tiene que ser determinista: más victorias y, si
 * empatan, la civ con la que más partidas jugó (y en último caso, la de `id`
 * menor).
 */
function pickOtpCiv(byCiv: Map<string, CivRecord>): { id: string; record: CivRecord } | null {
  let best: { id: string; record: CivRecord } | null = null;

  for (const [id, record] of byCiv) {
    if (best === null) {
      best = { id, record };
      continue;
    }

    const mejor =
      record.wins !== best.record.wins
        ? record.wins > best.record.wins
        : record.matches !== best.record.matches
          ? record.matches > best.record.matches
          : id < best.id;

    if (mejor) {
      best = { id, record };
    }
  }

  return best;
}

function candidatesFor(
  definition: ObjectiveDefinition,
  players: readonly PlayerAggregate[],
  ruleset: ScoringRuleset,
): ObjectiveCandidate[] {
  const { minimums } = ruleset;

  if (definition.id === "loco-por-ganar") {
    return players
      .filter((player) => player.matches >= 1)
      .map((player) =>
        candidate(player, "partidas", player.matches, player.matches, true, player.lastMatchAt),
      );
  }

  if (definition.id === "prohibido-perder") {
    return players
      .filter((player) => player.matches >= 1)
      .map((player) =>
        candidate(
          player,
          "winrate",
          player.wins,
          player.matches,
          player.matches >= minimums.winrate,
          player.lastMatchAt,
        ),
      );
  }

  if (definition.id === "otp") {
    const result: ObjectiveCandidate[] = [];

    for (const player of players) {
      const best = pickOtpCiv(player.byCiv);

      // Quien no ha ganado con ninguna civilización no disputa el máximo de
      // victorias con una civ: sin eso no habría empate a cero, no un líder.
      if (best === null || best.record.wins < 1) {
        continue;
      }

      result.push(
        candidate(
          player,
          "victorias",
          best.record.wins,
          best.record.matches,
          true,
          best.record.lastWinAt,
          null,
          { id: best.id, label: civilizationName(best.id) },
        ),
      );
    }

    return result;
  }

  if (definition.id === "golpe-de-suerte") {
    return players
      .filter((player) => player.matches >= 1)
      .map((player) =>
        candidate(
          player,
          "racha",
          player.streak,
          player.matches,
          player.matches >= minimums.streak && player.streak >= 1,
          player.streakEndsAt,
        ),
      );
  }

  if (definition.group === "division") {
    const division = definition.id.slice("sensei-".length) as DivisionId;

    return players
      .filter((player) => player.division === division && player.wins >= 1)
      .map((player) =>
        candidate(player, "victorias", player.wins, player.matches, true, player.lastWinAt),
      );
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

  // Último caso: `masterizar-<civilización>` (grupo `civilizacion`).
  const civ = definition.id.slice("masterizar-".length);
  const result: ObjectiveCandidate[] = [];

  for (const player of players) {
    const record = player.byCiv.get(civ);

    if (record === undefined || record.matches < 1) {
      continue;
    }

    result.push(
      candidate(
        player,
        "victorias",
        record.wins,
        record.matches,
        record.wins >= minimums.masterizar,
        record.lastWinAt,
        record.completedAt,
      ),
    );
  }

  return result;
}

/**
 * Quién posee el objetivo.
 *
 * En las carreras `masterizar-*` no gana el que más victorias tiene, sino el
 * que llegó primero a `minimums.masterizar`: son carreras y se resuelven una
 * sola vez (§6). El resto se resuelven en caliente, con el primero de la lista.
 */
function pickHolder(
  definition: ObjectiveDefinition,
  sorted: readonly ObjectiveCandidate[],
): ObjectiveCandidate | null {
  if (definition.group !== "civilizacion") {
    const first = sorted[0];
    return first !== undefined && first.eligible ? first : null;
  }

  let best: ObjectiveCandidate | null = null;

  for (const contender of sorted) {
    if (!contender.eligible || contender.raceAt === null) {
      continue;
    }

    if (
      best === null ||
      contender.raceAt < (best.raceAt ?? Number.POSITIVE_INFINITY) ||
      (contender.raceAt === best.raceAt && contender.player.profileId < best.player.profileId)
    ) {
      best = contender;
    }
  }

  return best;
}

/**
 * Resuelve los 37 objetivos contra las reglas activas.
 *
 * Devuelve también los puntos por jugador, que es lo que suma el motor a la
 * clasificación: solo el poseedor de cada objetivo recibe sus puntos, nadie
 * más, y un objetivo sin poseedor no reparte nada.
 */
export function computeObjectives(
  players: readonly PlayerAggregate[],
  ruleset: ScoringRuleset,
): ObjectivesComputation {
  const options: ObjectiveOption[] = [];
  const pointsByPlayer = new Map<string, ObjectiveAward>();
  let holders = 0;

  for (const definition of OBJECTIVE_DEFINITIONS) {
    const sorted = candidatesFor(definition, players, ruleset).sort(compareCandidates);
    const holder = pickHolder(definition, sorted);
    const points = ruleset.objectives[definition.id] ?? definition.points;

    if (holder !== null) {
      const award = pointsByPlayer.get(holder.player.playerId) ?? { points: 0, earned: [] };

      award.points += points;
      award.earned.push(definition.id);
      pointsByPlayer.set(holder.player.playerId, award);
      holders += 1;
    }

    options.push({
      id: definition.id,
      group: definition.group,
      label: definition.label,
      metric: definition.metric,
      points,
      holder: holder === null ? null : toContender(holder),
      ranking: sorted.slice(0, RANKING_LIMIT).map(toContender),
    });
  }

  return { options, pointsByPlayer, holders };
}
