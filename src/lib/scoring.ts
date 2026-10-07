import "server-only";

import { Prisma } from "@/generated/prisma/client";
import { MatchResult, PlayerStatus } from "@/generated/prisma/enums";
import { db } from "@/lib/db";
import { readFromDatabase, type PublicRead } from "@/lib/db-errors";
import { isRecord } from "@/lib/json";
import { reconcileObjectiveEvents } from "@/lib/objective-events";
import {
  OBJECTIVE_POINTS,
  computeObjectives,
  loadObjectivePlayers,
  type ObjectiveView,
} from "@/lib/objectives";
import {
  RANKED_MODES,
  parseWindow,
  rankedMatchSql,
  type ScoringWindow,
} from "@/lib/ranked-match";
import { writeScoringLastRun } from "@/lib/settings";

/**
 * Motor de puntuación (reglas v2).
 *
 * La regla completa está en `docs/PUNTUACION.md`: 10 puntos por victoria
 * clasificatoria más los 38 objetivos winner-takes-all de `objectives.ts`.
 * Aquí vive lo que no es cálculo: el ruleset (configurable en `Setting`),
 * el agregado (`PlayerScore`) y el orden final de la clasificación.
 *
 * Qué cuenta como partida clasificatoria **no** está aquí: vive en
 * `src/lib/ranked-match.ts`, que es donde se puede definir sin que `scoring.ts` y
 * `objectives.ts` se importen mutuamente. De ahí viene `rankedMatchSql()`, el
 * predicado que usan **las tres** consultas de abajo —el `UPDATE` de
 * `Match.points`, el agregado y la carga de objetivos—, así que el modo, el
 * resultado, el corte de inscripción, el final de la ventana y la marca de
 * revertida se filtran igual en todas partes.
 *
 * Cosas que no cambian entre versiones de las reglas y ya estaban resueltas:
 *
 * - Un `ruleset` con número de versión, y el agregado lleva ese número: cuando
 *   se publiquen reglas nuevas se recalcula al lado de las anteriores.
 * - Los puntos por partida se materializan en `Match.points`, así que se pueden
 *   auditar sin volver a agregarlos.
 * - El desempate es `total desc, wins desc, profileId asc`, que termina en un
 *   valor único (`profileId` es único), de modo que el puesto es un entero
 *   denso y estable.
 */

/* -------------------------------------------------------------------------- */
/* Qué cuenta como partida clasificatoria                                      */
/* -------------------------------------------------------------------------- */

/*
 * Se reexporta desde `@/lib/ranked-match`, que es donde está la definición, para
 * no tener dos sitios desde los que importar lo mismo.
 */
export {
  countsAsRanked,
  isRankedMode,
  RANKED_MODES,
  type RankedMode,
  type ScoringWindow,
} from "@/lib/ranked-match";

/* -------------------------------------------------------------------------- */
/* Ruleset                                                                     */
/* -------------------------------------------------------------------------- */

/** Clave de `Setting` donde vive el ruleset activo (§8 de `docs/PUNTUACION.md`). */
export const SCORING_RULESET_KEY = "scoring.ruleset";

/**
 * Versión de las reglas activas.
 *
 * La fija **el código**, no el documento guardado: cambiar un número de
 * `scoring.ruleset` no requiere despliegue, pero un cambio estructural sí
 * (nuevos mínimos, nueva familia de modos, …) y para eso sube esta constante.
 *
 * La ventana de fechas **no** sube la versión: es una reconfiguración, igual que
 * `pointsPerWin` o un mínimo. Lo que sí exigiría subirla es cambiar la forma de la
 * ventana (por ejemplo, pasar de un intervalo a una lista de Ventanas), porque
 * entonces un documento guardado dejaría de describir lo que el código espera.
 */
export const RULESET_VERSION = 2;

/**
 * Etiqueta de la regla activa; aparece en `breakdown` y en la vista pública.
 *
 * Es texto de producto, así que lo fija **el código**: el `label` que haya en
 * `Setting` se ignora (ver `mergeRuleset`) y `ensureRuleset` corrige la copia
 * guardada para que un lector directo de la tabla no vea texto de otra versión.
 */
export const RULE_LABEL =
  "10 puntos por victoria clasificatoria más 38 objetivos especiales; solo el primero los cobra";

export type ScoringMinimums = {
  /** Mínimo de partidas clasificatorias para `prohibido-perder`. */
  winrate: number;
  /** Mínimo de partidas para `golpe-de-suerte`. */
  streak: number;
  /** Victorias con una civilización para `masterizar-*`. */
  masterizar: number;
};

export type ScoringRuleset = {
  version: number;
  label: string;
  /** Familias de ladder que puntúan (`Match.mode`). */
  modes: string[];
  /**
   * Ventana del torneo sobre `Match.startedAt`, `[from, to)` en instantes ISO-8601
   * UTC y con `to` opcional. Reconfigurable sin desplegar (ver `mergeRuleset`).
   */
  window: ScoringWindow;
  pointsPerWin: number;
  minimums: ScoringMinimums;
  /** ¿Las partidas con civ aleatoria cuentan para `otp` y `masterizar-*`? */
  countRandomizedCivs: boolean;
  /** Puntos de cada objetivo por id; los que no aparecen usan los suyos. */
  objectives: Record<string, number>;
};

/**
 * Los valores con los que se publica el ruleset la primera vez.
 *
 * La ventana es **de prueba**: las fechas oficiales las pondrá la organización en
 * `Setting["scoring.ruleset"].window` sin desplegar (mismo mecanismo que
 * `pointsPerWin`), y hasta entonces esta es la que aplica. Son medianoche UTC
 * porque el proyecto guarda los instantes en UTC y `Match.startedAt` es un
 * `timestamp` sin zona interpretado en UTC; el porqué largo está en
 * `ranked-match.ts`.
 */
export const DEFAULT_RULESET: ScoringRuleset = {
  version: RULESET_VERSION,
  label: RULE_LABEL,
  modes: [...RANKED_MODES],
  window: { from: "2026-09-15T00:00:00.000Z", to: "2026-10-15T00:00:00.000Z" },
  pointsPerWin: 10,
  minimums: { winrate: 10, streak: 10, masterizar: 10 },
  countRandomizedCivs: false,
  objectives: { ...OBJECTIVE_POINTS },
};

function defaultRuleset(): ScoringRuleset {
  return {
    ...DEFAULT_RULESET,
    modes: [...DEFAULT_RULESET.modes],
    window: { ...DEFAULT_RULESET.window },
    minimums: { ...DEFAULT_RULESET.minimums },
    objectives: { ...DEFAULT_RULESET.objectives },
  };
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

export type RulesetMergeResult = {
  ruleset: ScoringRuleset;
  /** Ajustes que no se han podido aplicar; se avisa y se queda el valor por defecto. */
  warnings: string[];
};

/**
 * Combina el documento guardado con los valores por defecto.
 *
 * Casi todo se puede editar en `Setting` (la excepción es `label`, que es
 * texto de producto y la fija el código); lo que no se puede es cambiar la
 * estructura desde fuera: si `version` no coincide con la del código, **se
 * ignoran todas las reglas guardadas** (podrían describir otra estructura) y se
 * usan los valores por defecto. Nunca se reescribe el documento desde aquí: si
 * está mal, se arregla a mano (la única corrección automática es la etiqueta,
 * en `ensureRuleset`).
 */
export function mergeRuleset(stored: unknown): RulesetMergeResult {
  const warnings: string[] = [];
  const ruleset = defaultRuleset();

  if (!isRecord(stored)) {
    warnings.push("el valor no es un objeto; se usan los valores por defecto");
    return { ruleset, warnings };
  }

  const version = positiveInt(stored.version);

  if (version !== RULESET_VERSION) {
    warnings.push(
      `la versión guardada (${String(stored.version)}) no es ${RULESET_VERSION}; se ignoran las reglas guardadas`,
    );
    return { ruleset, warnings };
  }

  // La etiqueta no es configuración sino texto de producto: la fija
  // `RULE_LABEL` para que la UI no dependa de un `label` guardado que puede
  // describir otra versión de las reglas.
  if (stored.label !== undefined && stored.label !== RULE_LABEL) {
    warnings.push("label se ignora: el texto lo fija el código (RULE_LABEL)");
  }

  const pointsPerWin = positiveInt(stored.pointsPerWin);

  if (pointsPerWin !== null) {
    ruleset.pointsPerWin = pointsPerWin;
  } else if (stored.pointsPerWin !== undefined) {
    warnings.push(`pointsPerWin no es un entero positivo: ${JSON.stringify(stored.pointsPerWin)}`);
  }

  if (stored.modes !== undefined) {
    const modes = Array.isArray(stored.modes) ? stored.modes : [];
    const valid =
      modes.length > 0 &&
      modes.every((mode) => typeof mode === "string" && /^[a-z0-9_]{1,32}$/.test(mode));

    if (valid) {
      ruleset.modes = modes as string[];
    } else {
      warnings.push(`modes no es una lista válida de familias: ${JSON.stringify(stored.modes)}`);
    }
  }

  // La ventana es reconfigurable sin desplegar, pero se valida igual que el resto:
  // una ventana inútil (sin `from`, con una fecha que no se puede leer, o con un
  // `to` anterior al `from`) se descarta entera y se usa la de por defecto, para
  // que una edición a mano no deje el torneo sin puntuar. `to: null` sí es
  // legítimo: es la ventana abierta por la derecha.
  if (stored.window !== undefined) {
    const parsed = parseWindow(stored.window, ruleset.window);

    ruleset.window = parsed.window;
    warnings.push(...parsed.warnings);
  }

  if (stored.minimums !== undefined) {
    if (isRecord(stored.minimums)) {
      for (const key of ["winrate", "streak", "masterizar"] as const) {
        const raw = stored.minimums[key];

        if (raw === undefined) {
          continue;
        }

        const parsed = positiveInt(raw);

        if (parsed === null) {
          warnings.push(`minimums.${key} no es un entero positivo: ${JSON.stringify(raw)}`);
        } else {
          ruleset.minimums[key] = parsed;
        }
      }
    } else {
      warnings.push("minimums no es un objeto");
    }
  }

  if (typeof stored.countRandomizedCivs === "boolean") {
    ruleset.countRandomizedCivs = stored.countRandomizedCivs;
  } else if (stored.countRandomizedCivs !== undefined) {
    warnings.push("countRandomizedCivs no es un booleano");
  }

  if (stored.objectives !== undefined) {
    if (isRecord(stored.objectives)) {
      for (const [id, raw] of Object.entries(stored.objectives)) {
        if (!(id in OBJECTIVE_POINTS)) {
          warnings.push(`el objetivo "${id}" no existe; se ignora`);
          continue;
        }

        const parsed = positiveInt(raw);

        if (parsed === null) {
          warnings.push(`objectives["${id}"] no es un entero positivo: ${JSON.stringify(raw)}`);
        } else {
          ruleset.objectives[id] = parsed;
        }
      }
    } else {
      warnings.push("objectives no es un objeto");
    }
  }

  return { ruleset, warnings };
}

/** Cliente con la única tabla que necesita leer el ruleset (`db` o una `tx`). */
export type RulesetClient = Pick<Prisma.TransactionClient, "setting">;

function reportWarnings(warnings: readonly string[]): void {
  for (const warning of warnings) {
    console.warn(`[scoring] ${SCORING_RULESET_KEY}: ${warning}`);
  }
}

/**
 * Ruleset activo, leyendo `Setting` si existe.
 *
 * Si nadie ha publicado aún `scoring.ruleset`, devuelve los valores por defecto
 * sin escribir nada: leer no debería modificar la base. Quien sí lo publica es
 * `recomputeScores`, que ya está escribiendo.
 */
export async function readRuleset(client: RulesetClient = db): Promise<ScoringRuleset> {
  const setting = await client.setting.findUnique({ where: { key: SCORING_RULESET_KEY } });

  if (setting === null) {
    return defaultRuleset();
  }

  const merged = mergeRuleset(setting.value);
  reportWarnings(merged.warnings);

  return merged.ruleset;
}

/** Como `readRuleset`, pero publica el ruleset por defecto si no existe. */
export async function ensureRuleset(client: RulesetClient = db): Promise<ScoringRuleset> {
  const ruleset = await readRuleset(client);
  const setting = await client.setting.findUnique({ where: { key: SCORING_RULESET_KEY } });

  if (setting === null) {
    // `update: {}` no pisa nada: si otro proceso lo publicó entre la lectura y
    // esta escritura, se queda el documento que ya estaba.
    await client.setting.upsert({
      where: { key: SCORING_RULESET_KEY },
      create: { key: SCORING_RULESET_KEY, value: DEFAULT_RULESET },
      update: {},
    });
    console.info(`[scoring] Publicado ${SCORING_RULESET_KEY} (versión ${RULESET_VERSION}).`);
    return ruleset;
  }

  // Al leer, la etiqueta guardada se ignora porque la fija el código; aquí se
  // corrige además la copia almacenada, para que quien mire `Setting` a mano
  // (panel, SQL) no vea el texto de una versión anterior. Solo se toca ese
  // campo: el resto del documento queda como está.
  if (isRecord(setting.value) && setting.value.label !== RULE_LABEL) {
    const value = { ...setting.value, label: RULE_LABEL } as Prisma.InputJsonObject;

    await client.setting.update({ where: { key: SCORING_RULESET_KEY }, data: { value } });
    console.info(
      `[scoring] Etiqueta de ${SCORING_RULESET_KEY} actualizada a la del código (RULE_LABEL).`,
    );
  }

  return ruleset;
}

/* -------------------------------------------------------------------------- */
/* Desglose                                                                    */
/* -------------------------------------------------------------------------- */

/** Desglose por modo de una fila de `PlayerScore`. */
export type ScoreBreakdownMode = {
  /** Victorias clasificatorias en este modo. */
  wins: number;
  /** Puntos aportados por este modo, solo de partidas (sin objetivos). */
  points: number;
  /** Partidas clasificatorias resueltas en este modo, ganadas y perdidas. */
  matches: number;
};

/**
 * Forma exacta de `PlayerScore.breakdown`.
 *
 * Es JSON y no columnas a propósito: el número de categorías cambia con cada
 * versión de las reglas y migrar columnas en cada versión no es una opción. Las
 * familias del ruleset siempre están presentes (con ceros si no aplican), para
 * que quien lo lea no tenga que tratar un objeto que puede faltar.
 *
 * ```json
 * {
 *   "ruleSetVersion": 2,
 *   "rule": "10 puntos por victoria clasificatoria más 38 objetivos…",
 *   "byMode": {
 *     "rm_solo": { "wins": 3, "points": 30, "matches": 5 },
 *     "rm_team": { "wins": 1, "points": 10, "matches": 2 }
 *   },
 *   "objectives": { "points": 125, "earned": ["loco-por-ganar", "rey-1v1"] }
 * }
 * ```
 *
 * La suma de `byMode[*].points` más `objectives.points` es `total`: comprobar
 * eso es comprobar que la tabla cuadra con `Match.points`.
 */
export type ScoreBreakdown = {
  ruleSetVersion: number;
  rule: string;
  byMode: Record<string, ScoreBreakdownMode>;
  objectives: { points: number; earned: string[] };
};

function emptyByMode(ruleset: ScoringRuleset): Record<string, ScoreBreakdownMode> {
  const modes = new Set<string>([...RANKED_MODES, ...ruleset.modes]);
  const byMode: Record<string, ScoreBreakdownMode> = {};

  for (const mode of modes) {
    byMode[mode] = { wins: 0, points: 0, matches: 0 };
  }

  return byMode;
}

/* -------------------------------------------------------------------------- */
/* Lectura pública de los objetivos                                            */
/* -------------------------------------------------------------------------- */

/**
 * Los 38 objetivos con sus poseedores, listos para pintar.
 *
 * Dos consultas y ninguna por fila: una para el ruleset (una clave de
 * `Setting`) y una para las partidas clasificatorias. Se lee en cada llamada,
 * igual que `getStandings`, así que la página que la use tiene que ser
 * dinámica.
 *
 * `window` se publica para que `/reglas` y `/objetivos` puedan decir qué periodo
 * cuenta, sin que el copy de la interfaz tenga que escribir fechas a mano que
 * acabarían mintiendo el día que se cambien en `Setting`.
 *
 * Con la base de datos caída devuelve `{ status: "degraded", data: null }`: los
 * 38 objetivos existen siempre (es el catálogo), pero **quién posee cada uno**
 * solo existe en la base, y publicar una tabla de objetivos sin poseedores
 * serían los 38 sin dueño, que no es lo que hay.
 */
export async function getObjectives(): Promise<PublicRead<ObjectiveView>> {
  return readFromDatabase("public/getObjectives", loadObjectives);
}

async function loadObjectives(): Promise<ObjectiveView> {
  const ruleset = await readRuleset();
  const players = await loadObjectivePlayers(db, ruleset);
  const { options } = computeObjectives(players, ruleset);

  return {
    ruleSetVersion: ruleset.version,
    rule: ruleset.label,
    pointsPerWin: ruleset.pointsPerWin,
    window: { ...ruleset.window },
    minimums: { ...ruleset.minimums },
    options,
  };
}

/* -------------------------------------------------------------------------- */
/* Motor                                                                       */
/* -------------------------------------------------------------------------- */

export type RecomputeScoresResult = {
  ruleSetVersion: number;
  /**
   * Filas de `Match` cuyo `points` ha cambiado en esta pasada. Da igual que la fila
   * haya ganado o perdido puntos: cuenta las que había que escribir. Es 0 en una
   * pasada sin novedades, que es justo lo que se busca: el motor no toca lo que
   * ya estaba bien.
   */
  matchesUpdated: number;
  /** Jugadores con fila en la clasificación. */
  playersRanked: number;
  /** Jugadores cuya fila anterior se ha retirado (ya no rankean). */
  playersUnranked: number;
  /** Suma de `PlayerScore.total`: partidas y objetivos. */
  totalPoints: number;
  /** Objetivos con poseedor en este recálculo (de 38). */
  objectivesAwarded: number;
  /** Puntos repartidos por objetivos. */
  objectivesPoints: number;
  durationMs: number;
};

type AggregatedRow = {
  matchPoints: number;
  wins: number;
  matches: number;
  byMode: Record<string, ScoreBreakdownMode>;
};

/**
 * Una fila del agregado de la clasificación, tal y como la devuelve el SQL crudo.
 *
 * Los dos `cast` son los que hace falta para no pelearse con el adaptador: el
 * `status` de `Player` es un enum y un parámetro llega como texto, así que hay que
 * castearlo a `"PlayerStatus"` para que la comparación sea válida; y `result`
 * sale como texto porque en la fila de arriba es lo que se compara con el enum de
 * Prisma. `count`/`sum` van a `int` porque en `bigint` Prisma devolvería un
 * `BigInt` que después hay que convertir en cada suma.
 */
type AggregatedMatchRow = {
  playerId: string;
  mode: string | null;
  result: string;
  partidas: number;
  points: number;
};

/**
 * Nombre del cerrojo de la clasificación.
 *
 * `hashtext()` lo convierte en la clave que `pg_advisory_xact_lock` espera, así que
 * todos los procesos que recalculan se serializan con el mismo nombre. Lo toma la
 * transacción y no la sesión: se libera sola al confirmar o al deshacer, de modo
 * que un proceso que revienta no deja el torneo bloqueado hasta que alguien
 * reinicie la base.
 */
const SCORING_LOCK_NAME = "ligahispana.recomputeScores";

/**
 * Reescribe los puntos por partida y la clasificación completa.
 *
 * Es idempotente: se puede ejecutar tantas veces como haga falta y el resultado
 * es el mismo. Se hace un recálculo entero en vez de incremental porque el
 * volumen de un torneo son decenas de miles de partidas y unas cuantas
 * sentencias resuelven la tabla entera; la ventaja real de hacerlo así es que
 * las reglas pueden cambiar sin dejar residuos del cálculo anterior.
 *
 * Se ejecuta en una transacción para que nadie lea una clasificación a medio
 * escribir: sin ella, un visitante podía ver la tabla vacía entre el `delete` y
 * el `createMany`.
 */
export async function recomputeScores(): Promise<RecomputeScoresResult> {
  const startedAtMs = Date.now();

  // El ruleset se lee fuera de la transacción: es configuración, no datos de la
  // clasificación, y su publicación no debe quedarse esperando al resto.
  const ruleset = await ensureRuleset();

  const result = await db.$transaction(
    async (tx) => {
      // El cerrojo va lo primero, antes de tocar ninguna fila. Sin él, el cron y
      // un `npm run score` a mano se entrelazan: los dos borran `PlayerScore` y
      // el que llega tarde puede insertar filas de una clasificación que el otro
      // ya está borrando. Con el cerrojo hay un solo escritor y el otro espera su
      // turno. Es la regla de la guía de Postgres sobre orden de bloqueo
      // consistente: un único cerrojo, tomado siempre en el mismo punto, no puede
      // entrar en ciclo con nadie.
      // El `::text` no es cosmético: la función devuelve `void` y Prisma no sabe
      // deserializar ese tipo, así que sin el cast la llamada falla y el recálculo
      // entero se cae.
      await tx.$queryRaw`select pg_advisory_xact_lock(hashtext(${SCORING_LOCK_NAME}))::text`;

      // Un solo `update` para los puntos de todas las partidas. El `case` calcula
      // qué valor le toca a cada fila y el `where` deja fuera las que ya lo tienen:
      // una pasada sin novedades no escribe ninguna fila, y por eso no genera
      // basura ni se come el presupuesto de *WAL* de las miles de partidas que ya
      // estaban bien. Que el valor se calcule para todas las filas (y no solo para
      // las clasificatorias) es lo que conserva la idempotencia del diseño en dos
      // pasos: si el ruleset deja de contar una familia, mueve la ventana o baja
      // `pointsPerWin`, las partidas que dejan de puntuar caen a 0 igual, sin
      // depender de cómo estaban antes.
      //
      // El predicado del `case` es el de `rankedMatchSql()`, o sea **el mismo** que
      // usa el agregado y la carga de objetivos: familia del ruleset, partida
      // resuelta, `startedAt` después del corte del jugador y antes de `window.to`,
      // y no revertida. Una partida anterior a la inscripción del jugador, o fuera
      // de la ventana, o revertida, acaba con `points = 0` sin más que por no pasar
      // el filtro, y por eso deshacer un revert devuelve los puntos sin tener que
      // tocar esta fila a mano.
      //
      // El `join` con `Player` no es decorativo: el corte de inscripción sale de
      // `p."registeredAt"`. Es un `join` interior sobre la clave foránea, que no
      // admite nulos, así que no deja fuera ninguna partida.
      const clasificatoria = rankedMatchSql(
        Prisma.sql`m`,
        Prisma.sql`p`,
        ruleset.modes,
        ruleset.window,
      );

      const updated = await tx.$executeRaw`
        with deseados as (
          select
            m.id,
            case
              when ${clasificatoria} and m.result = 'WIN'
              then ${ruleset.pointsPerWin}::int
              else 0
            end as puntos
          from "Match" m
          join "Player" p on p."id" = m."playerId"
        )
        update "Match" m
        set points = d.puntos
        from deseados d
        where m.id = d.id and m.points is distinct from d.puntos
      `;

      const objectivePlayers = await loadObjectivePlayers(tx, ruleset);
      const objectives = computeObjectives(objectivePlayers, ruleset);

      // Registro de hitos, en esta misma transacción y a continuación del cómputo:
      // el feed del historial de `/admin/historial` mezcla partidas y objetivos, y
      // un objetivo sin evento se contaría como un objetivo que nadie cumplió.
      //
      // Va aquí y no al final, y no en un segundo paso, por dos motivos que son los
      // mismos que los del resto del motor: dentro de la transacción, con el cerrojo
      // ya tomado, o el registro y la clasificación describen lo mismo o no cambia
      // ninguno; y en **todos** los caminos que recalculan —el worker, `npm run
      // score`, revertir o restaurar los puntos de una partida, aprobar o dar de
      // alta a un jugador— sin tener que acordarse de un segundo paso. El
      // `reconcileObjectiveEvents` es idempotente y solo escribe lo que difiere de
      // lo que ya había.
      await reconcileObjectiveEvents(tx, ruleset, objectives.awarded);

      // Mismo filtro que el `UPDATE` de arriba y que la carga de objetivos (y por
      // tanto también `revertedAt is null`), y con el estado del jugador.
      //
      // **Es SQL crudo y no un `groupBy`, y el motivo es el corte de inscripción.**
      // El filtro necesita `m."startedAt" >= p."registeredAt"`, y el `where` de
      // Prisma compara un campo con un valor, nunca dos columnas: una referencia a
      // campo solo vale entre campos del modelo que se consulta (probado en esta
      // versión de Prisma, que responde *"Expected a referenced scalar field of
      // model Match, but found a field of model Player"*). Como esta consulta
      // abarca a todos los jugadores, el corte solo se puede escribir trayendo la
      // fila de `Player`, y entonces lo natural es que el predicado sea el mismo
      // `rankedMatchSql()` de las otras dos consultas y no una traducción nueva.
      //
      // El plan sigue siendo el mismo: `mode = any(...)` y `startedAt` en rango lo
      // cubre el índice `@@index([mode, startedAt])`, y el `join` con `Player` es
      // sobre su clave primaria con muy pocas filas.
      const aggregated = await tx.$queryRaw<AggregatedMatchRow[]>`
        select
          m."playerId" as "playerId",
          m."mode" as "mode",
          m."result"::text as "result",
          count(*)::int as "partidas",
          coalesce(sum(m."points"), 0)::int as "points"
        from "Match" m
        join "Player" p on p."id" = m."playerId"
        where p."status" = ${PlayerStatus.APPROVED}::"PlayerStatus"
          and ${rankedMatchSql(Prisma.sql`m`, Prisma.sql`p`, ruleset.modes, ruleset.window)}
        group by m."playerId", m."mode", m."result"
      `;

      const totals = new Map<string, AggregatedRow>();

      for (const row of aggregated) {
        // El `where` ya lo garantiza, pero el modo no es un enum en el schema y
        // una familia fuera del ruleset no debe colarse en el desglose.
        if (row.mode === null || !ruleset.modes.includes(row.mode)) {
          continue;
        }

        const mode = row.mode;
        const count = row.partidas;
        const points = row.points;
        const won = row.result === MatchResult.WIN;
        const current = totals.get(row.playerId) ?? {
          matchPoints: 0,
          wins: 0,
          matches: 0,
          byMode: emptyByMode(ruleset),
        };

        current.matchPoints += points;
        current.matches += count;

        if (won) {
          current.wins += count;
        }

        const modeRow = current.byMode[mode] ?? { wins: 0, points: 0, matches: 0 };
        modeRow.matches += count;

        if (won) {
          modeRow.wins += count;
          modeRow.points += points;
        }

        current.byMode[mode] = modeRow;
        totals.set(row.playerId, current);
      }

      // Solo se consulta el perfil de quien tiene alguna partida clasificatoria:
      // los aprobados sin partidas no tienen fila (P-02 del modelo de datos).
      const players = await tx.player.findMany({
        where: { id: { in: [...totals.keys()] }, status: PlayerStatus.APPROVED },
        select: { id: true, profileId: true },
      });

      const profileIdByPlayer = new Map(players.map((player) => [player.id, player.profileId]));

      // Desempate provisional. `profileId` es único, así que el orden es total y
      // el puesto un entero denso: no hay empates que repartir. Una fila sin
      // `profileId` no se publica en lugar de publicarse con un desempate falso.
      const ranked = [...totals.entries()]
        .flatMap(([playerId, aggregate]) => {
          const profileId = profileIdByPlayer.get(playerId);
          const award = objectives.pointsByPlayer.get(playerId);
          const objectivePoints = award?.points ?? 0;

          return profileId === undefined
            ? []
            : [
                {
                  playerId,
                  profileId,
                  ...aggregate,
                  total: aggregate.matchPoints + objectivePoints,
                  objectives: { points: objectivePoints, earned: award?.earned ?? [] },
                },
              ];
        })
        .sort((a, b) => b.total - a.total || b.wins - a.wins || a.profileId - b.profileId)
        .map((row, index) => ({ ...row, rank: index + 1 }));

      const previousCount = await tx.playerScore.count({
        where: { ruleSetVersion: RULESET_VERSION },
      });

      await tx.playerScore.deleteMany({ where: { ruleSetVersion: RULESET_VERSION } });

      if (ranked.length > 0) {
        await tx.playerScore.createMany({
          data: ranked.map((row) => ({
            playerId: row.playerId,
            ruleSetVersion: RULESET_VERSION,
            rank: row.rank,
            total: row.total,
            wins: row.wins,
            matches: row.matches,
            breakdown: {
              ruleSetVersion: RULESET_VERSION,
              rule: ruleset.label,
              byMode: row.byMode,
              objectives: row.objectives,
            } satisfies ScoreBreakdown,
          })),
        });
      }

      const recomputed: RecomputeScoresResult = {
        ruleSetVersion: RULESET_VERSION,
        matchesUpdated: updated,
        playersRanked: ranked.length,
        playersUnranked: Math.max(previousCount - ranked.length, 0),
        totalPoints: ranked.reduce((sum, row) => sum + row.total, 0),
        objectivesAwarded: objectives.holders,
        objectivesPoints: ranked.reduce((sum, row) => sum + row.objectives.points, 0),
        durationMs: Date.now() - startedAtMs,
      };

      // Última sentencia de la transacción: el rastro de la pasada se confirma
      // junto con la clasificación que describe y no en una escritura aparte que
      // pudiera fallar o quedar desfasada.
      await writeScoringLastRun({ ...recomputed }, tx);

      return recomputed;
    },
    // El recálculo escribe las dos tablas enteras; con el plazo por defecto de
    // Prisma (5 s) se quedaría corto en cuanto la base crezca.
    { timeout: 60_000, maxWait: 15_000 },
  );

  return result;
}
