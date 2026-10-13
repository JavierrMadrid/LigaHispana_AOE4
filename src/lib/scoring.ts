import "server-only";

import { Prisma } from "@/generated/prisma/client";
import { MatchResult, PlayerStatus } from "@/generated/prisma/enums";
import { readDivisionCutoffs } from "@/lib/alerts/settings";
import { db } from "@/lib/db";
import { readFromDatabase, type PublicRead } from "@/lib/db-errors";
import { isRecord } from "@/lib/json";
import { reconcileObjectiveEvents } from "@/lib/objective-events";
import {
  OBJECTIVES_SNAPSHOT_VERSION,
  OBJECTIVE_POINTS,
  computeObjectives,
  loadObjectivePlayers,
  objectivesSnapshotFingerprint,
  readObjectivesSnapshotValue,
  type ObjectiveAward,
  type ObjectiveOption,
  type ObjectiveView,
  type ObjectivesSnapshot,
} from "@/lib/objectives";
import {
  RANKED_MODES,
  parseWindow,
  rankedMatchSql,
  type ScoringWindow,
} from "@/lib/ranked-match";
import { readMapPool, writeScoringLastRun } from "@/lib/settings";

/**
 * Motor de puntuación (reglas v3).
 *
 * La regla completa está en `docs/PUNTUACION.md`: 2 puntos por victoria
 * clasificatoria más los objetivos de `objectives.ts`, que son de dos formas:
 * competiciones (un único poseedor) y logros (los cobra quien los cumple). Aquí
 * vive lo que no es cálculo: el ruleset (configurable en `Setting`), el agregado
 * (`PlayerScore`) y el orden final de la clasificación.
 *
 * Qué cuenta como partida clasificatoria **no** está aquí: vive en
 * `src/lib/ranked-match.ts`, que es donde se puede definir sin que `scoring.ts` y
 * `objectives.ts` se importen mutuamente. De ahí viene `rankedMatchSql()`, el
 * predicado que usan **las tres** consultas de abajo —el `UPDATE` de
 * `Match.points`, el agregado y la carga de objetivos—, así que el modo, el
 * resultado, el corte de inscripción, el final de la ventana, la marca de
 * revertida y la **condición de equipos** se filtran igual en todas partes. Esa
 * última necesita los cortes rating → subdivisión, que este módulo lee **una vez
 * por recálculo** (`readDivisionCutoffs()`) y les pasa a las tres: son
 * configuración, no datos del torneo, así que se leen fuera de la transacción.
 *
 * Cosas que no cambian entre versiones de las reglas y ya estaban resueltas:
 *
 * - Un `ruleset` con número de versión, y el agregado lleva ese número: cuando
 *   se publiquen reglas nuevas se recalcula al lado de las anteriores.
 * - Los puntos por partida se materializan en `Match.points`, así que se pueden
 *   auditar sin volver a agregarlos.
 * - El desempate es `total desc`, tasa de victorias desc, `wins desc`, `matches
 *   desc` y, dentro de un empate, `profileId asc` solo para ordenar la
 *   presentación. Quien comparte la tupla de criterios **comparte puesto**
 *   (ranking de competición: 1, 2, 2, 4), así que el puesto ya no es un entero
 *   denso.
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

/** Clave de `Setting` donde vive el ruleset activo. */
export const SCORING_RULESET_KEY = "scoring.ruleset";

/**
 * Clave de `Setting` donde `recomputeScores()` publica la vista de objetivos.
 *
 * Existe para que las páginas de objetivos (`/objetivos` y la ficha de participante)
 * lean el resultado ya calculado en vez de barrer todas las clasificatorias y
 * recomputar el catálogo en JS en cada visita. El detalle y el porqué, en
 * `docs/OPERACION.md`, "El límite de CPU del plan Free".
 */
export const OBJECTIVES_SNAPSHOT_KEY = "scoring.objectives";

/**
 * Versión de las reglas activas.
 *
 * La fija **el código**, no el documento guardado: cambiar un número de
 * `scoring.ruleset` no requiere despliegue, pero un cambio estructural sí
 * (nuevos objetivos, nueva familia de modos, …) y para eso sube esta constante.
 *
 * La ventana de fechas **no** sube la versión: es una reconfiguración, igual que
 * `pointsPerWin` o un mínimo. Lo que sí exigiría subirla es cambiar la forma de la
 * ventana (por ejemplo, pasar de un intervalo a una lista de Ventanas), porque
 * entonces un documento guardado dejaría de describir lo que el código espera.
 */
export const RULESET_VERSION = 3;

/**
 * Etiqueta de la regla activa; aparece en `breakdown` y en la vista pública.
 *
 * Es texto de producto, así que lo fija **el código**: el `label` que haya en
 * `Setting` se ignora (ver `mergeRuleset`) y `ensureRuleset` corrige la copia
 * guardada para que un lector directo de la tabla no vea texto de otra versión.
 */
export const RULE_LABEL =
  "2 puntos por victoria clasificatoria más 82 objetivos: 29 competiciones y 53 logros";

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
  /** ¿Las partidas con civ aleatoria cuentan para los objetivos de civilización? */
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
  pointsPerWin: 2,
  countRandomizedCivs: false,
  objectives: { ...OBJECTIVE_POINTS },
};

function defaultRuleset(): ScoringRuleset {
  return {
    ...DEFAULT_RULESET,
    modes: [...DEFAULT_RULESET.modes],
    window: { ...DEFAULT_RULESET.window },
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
 *   "ruleSetVersion": 3,
 *   "rule": "2 puntos por victoria clasificatoria más 82 objetivos…",
 *   "byMode": {
 *     "rm_solo": { "wins": 3, "points": 6, "matches": 5 },
 *     "rm_team": { "wins": 1, "points": 2, "matches": 2 }
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
 * El catálogo de objetivos con sus poseedores y beneficiarios, listo para pintar.
 *
 * Sale del snapshot que dejó `recomputeScores()` (una fila de `Setting`) y, si no
 * hay o no valida, del cómputo en vivo (el ruleset más todas las partidas
 * clasificatorias). Se lee en cada llamada, igual que `getStandings`, así que la
 * página que la use tiene que ser dinámica.
 *
 * `window` y `mapPool` se publican para que `/puntuacion` y `/objetivos` puedan
 * decir qué periodo cuenta y qué mapas entran, sin que el copy de la interfaz
 * tenga que escribir datos a mano que acabarían mintiendo el día que se cambien
 * en `Setting`.
 *
 * Con la base de datos caída devuelve `{ status: "degraded", data: null }`: el
 * catálogo existe siempre (es código), pero **quién cobra cada objetivo** solo
 * existe en la base, y publicar una tabla de objetivos sin cobradores sería una
 * tabla de nadie, que no es lo que hay.
 */
export async function getObjectives(): Promise<PublicRead<ObjectiveView>> {
  return readFromDatabase("public/getObjectives", loadObjectiveView);
}

/**
 * La vista de objetivos: del snapshot guardado si es válido, y del cómputo en vivo
 * si no.
 *
 * El snapshot lo publica `recomputeScores()` en su propia transacción, así que
 * leerlo es una fila de `Setting` en lugar de una consulta a `Match` más el cómputo
 * del catálogo entero en JS. El respaldo **no** es opcional: en el primer despliegue
 * la clave todavía no existe, y un bump de `RULESET_VERSION` invalida el documento
 * anterior; en los dos casos se cae al camino de siempre y la vista sigue saliendo.
 */
export async function loadObjectiveView(): Promise<ObjectiveView> {
  const snapshot = await readObjectivesSnapshot();

  if (snapshot !== null) {
    return snapshot;
  }

  const [ruleset, mapPool] = await Promise.all([readRuleset(), readMapPool()]);
  const cutoffs = await readDivisionCutoffs();
  const players = await loadObjectivePlayers(db, ruleset, cutoffs);
  const { options } = computeObjectives(players, ruleset, mapPool);

  return buildObjectiveView(ruleset, mapPool, options);
}

/** Arma la `ObjectiveView` con las reglas y el pool activos. */
function buildObjectiveView(
  ruleset: ScoringRuleset,
  mapPool: readonly string[],
  options: ObjectiveOption[],
): ObjectiveView {
  return {
    ruleSetVersion: ruleset.version,
    rule: ruleset.label,
    pointsPerWin: ruleset.pointsPerWin,
    window: { ...ruleset.window },
    mapPool: [...mapPool],
    options,
  };
}

/** La vista guardada, si la clave existe y el documento valida. */
async function readObjectivesSnapshot(client: RulesetClient = db): Promise<ObjectiveView | null> {
  const setting = await client.setting.findUnique({ where: { key: OBJECTIVES_SNAPSHOT_KEY } });

  return setting === null ? null : readObjectivesSnapshotValue(setting.value, RULESET_VERSION);
}

/**
 * Publica la vista, salvo que la huella coincida con la guardada.
 *
 * La comparación es contra la huella y no contra el JSON guardado: `jsonb` normaliza
 * el orden de las claves, así que el documento leído nunca es textualmente igual al
 * que se escribió. Sin esta comprobación, cada pasada reescribiría cientos de KB (82
 * objetivos con sus rankings completos) para dejarlos idénticos.
 */
async function writeObjectivesSnapshot(view: ObjectiveView, client: RulesetClient): Promise<void> {
  const fingerprint = objectivesSnapshotFingerprint(view);
  const current = await client.setting.findUnique({ where: { key: OBJECTIVES_SNAPSHOT_KEY } });

  if (isRecord(current?.value) && current.value.fingerprint === fingerprint) {
    return;
  }

  const snapshot: ObjectivesSnapshot = {
    snapshotVersion: OBJECTIVES_SNAPSHOT_VERSION,
    fingerprint,
    ...view,
  };
  const value = snapshot as unknown as Prisma.InputJsonObject;

  await client.setting.upsert({
    where: { key: OBJECTIVES_SNAPSHOT_KEY },
    create: { key: OBJECTIVES_SNAPSHOT_KEY, value },
    update: { value },
  });
}

/* -------------------------------------------------------------------------- */
/* Motor                                                                       */
/* -------------------------------------------------------------------------- */

export type RecomputeScoresResult = {
  ruleSetVersion: number;
  /**
   * Lo que el recálculo ha tenido que dejar dicho: hoy, solo que no hay cortes de
   * división cacheados, con lo que la condición de compañeros de las partidas de
   * equipo no se ha podido aplicar (esas partidas cuentan). Es la misma forma que
   * los avisos de `mergeRuleset()` —frases en español dentro del rastro—, y se
   * registran en el log con el prefijo `[scoring]`.
   */
  warnings: string[];
  /**
   * Filas de `Match` cuyo `points` ha cambiado en esta pasada. Da igual que la fila
   * haya ganado o perdido puntos: cuenta las que había que escribir. Es 0 en una
   * pasada sin novedades, que es justo lo que se busca: el motor no toca lo que
   * ya estaba bien.
   */
  matchesUpdated: number;
  /**
   * Jugadores con fila en la clasificación. Con la regla actual es **todos los
   * aprobados**, tengan o no partidas: quien no ha jugado sale con todo a cero.
   */
  playersRanked: number;
  /**
   * Filas de la clasificación anterior que ya no se publican: jugadores que dejaron
   * de estar aprobados (o se borraron). Un aprobado sin partidas ya no cuenta aquí:
   * tiene fila con ceros.
   */
  playersUnranked: number;
  /** Suma de `PlayerScore.total`: partidas y objetivos. */
  totalPoints: number;
  /** Objetivos con al menos un cobrador en este recálculo. */
  objectivesAwarded: number;
  /** Puntos repartidos por objetivos. */
  objectivesPoints: number;
  durationMs: number;
};

/**
 * Agregado de partidas de un jugador: lo que aporta el SQL a la clasificación.
 *
 * `matchPoints` son solo los puntos de partidas (sin objetivos); los objetivos se
 * suman al montar la fila, en `rankApprovedPlayers()`. Un jugador aprobado sin
 * ninguna clasificatoria **no aparece** aquí: quien llama lo trata como ceros.
 */
export type AggregatedRow = {
  matchPoints: number;
  wins: number;
  matches: number;
  byMode: Record<string, ScoreBreakdownMode>;
};

/**
 * Una fila de la clasificación ya resuelta: lo que necesita `PlayerScore` más el
 * `rank` y el `breakdown` de objetivos, antes de montar el documento JSON.
 *
 * La devuelve `rankApprovedPlayers()`, que es pura y se prueba sin base de datos.
 */
export type RankedStanding = {
  playerId: string;
  profileId: number;
  total: number;
  wins: number;
  matches: number;
  byMode: Record<string, ScoreBreakdownMode>;
  objectives: { points: number; earned: string[] };
  /**
   * Puesto 1-based de competición sobre todos los aprobados: dos filas con la
   * misma tupla de criterios lo comparten y el siguiente hueco se salta.
   */
  rank: number;
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
 * Los números que deciden el puesto. Si dos filas los comparten, comparten puesto.
 */
type StandingCriteria = {
  total: number;
  wins: number;
  matches: number;
};

/**
 * La cadena de criterios, todos descendentes: **total**, **tasa de victorias**
 * (victorias entre partidas jugadas), **partidas ganadas** y **partidas jugadas**.
 *
 * Es la que decide el puesto, sin el desempate de presentación: cuando devuelve 0,
 * las dos filas empatan y comparten puesto (ver `rankApprovedPlayers`). La tasa se
 * compara con **producto cruzado** (`b.wins * a.matches` frente a
 * `a.wins * b.matches`) y no con `wins / matches`: la división en coma flotante
 * puede ordenar mal por el redondeo binario, y aquí el orden tiene que ser exacto.
 * Con `matches` 0 (que no se da en una fila publicada, pero por si acaso) el
 * producto es 0 —sin `NaN`—, así que la tasa empata y deciden las victorias, las
 * partidas y, al final, `profileId`.
 *
 * Lo que importa de la cadena es que devuelve 0 **exactamente** cuando las dos filas
 * tienen la misma tupla de total, victorias y partidas: con las victorias ya
 * iguales, el cruce solo empata si las partidas coinciden, y con 0 victorias
 * (producto 0 en los dos lados) cierra el criterio de partidas. Por eso un 0 aquí
 * es lo que hace que dos filas compartan puesto.
 */
function compareCriteria(a: StandingCriteria, b: StandingCriteria): number {
  return (
    b.total - a.total ||
    b.wins * a.matches - a.wins * b.matches ||
    b.wins - a.wins ||
    b.matches - a.matches
  );
}

/**
 * Orden de la clasificación. Función pura y exportada para poder comprobarla sin
 * base de datos.
 *
 * Aplica `compareCriteria` y cierra con `profileId` ascendente, que es único.
 * Ese último escalón es **solo** el desempate de presentación: quien tenga la
 * misma tupla de criterios comparte puesto, y `profileId` lo único que hace es que
 * las filas de un puesto compartido salgan en un orden estable y determinista.
 */
export function compareStandings(
  a: StandingCriteria & { profileId: number },
  b: StandingCriteria & { profileId: number },
): number {
  return compareCriteria(a, b) || a.profileId - b.profileId;
}

/**
 * Arma las filas de la clasificación a partir de los aprobados y sus agregados.
 *
 * Es la parte **pura** del motor: recibe todos los aprobados —con o sin partidas—,
 * los agregados de partidas por jugador (puede faltar quien no ha jugado), los
 * puntos de objetivos por jugador y el ruleset (solo para el `byMode` de ceros), y
 * devuelve las filas ya ordenadas y con su `rank`. El SQL y la transacción se
 * quedan en `recomputeScores()`, que es quien no se puede probar sin base.
 *
 * Dos reglas que decide esta función:
 *
 * - **Todo aprobado tiene fila.** Quien no está en `totals` no se salta: entra con
 *   todo a cero (`emptyByMode(ruleset)` para que las familias del ruleset sigan
 *   apareciendo en el desglose). Es la regla de producto: un participante aprobado
 *   tiene que verse en la clasificación desde el primer día, aunque no haya jugado
 *   nada todavía. Un `PENDING` o un `REJECTED` no llega hasta aquí.
 * - **Una entrada de `totals` que no sea de un aprobado se ignora.** Se itera sobre
 *   los aprobados, no sobre los agregados, así que no puede colarse alguien que
 *   dejó de estar aprobado entre el agregado y esta llamada.
 *
 * El `rank` es de competición y sale de `compareStandings`: la fila que abre un
 * grupo nuevo toma su posición natural (`index + 1`) y las que empatan con ella
 * **comparten puesto**, de modo que el hueco del puesto compartido se pierde
 * (1, 2, 2, 4). El grupo lo define la tupla de criterios
 * (`compareCriteria`), no el `profileId`, que solo ordena las filas dentro del
 * puesto. Los que no tienen partidas van con 0 puntos, 0 victorias y 0 partidas,
 * así que quedan detrás de cualquiera que haya jugado alguna y comparten entre
 * ellos el último puesto.
 */
export function rankApprovedPlayers(
  players: readonly { id: string; profileId: number }[],
  totals: ReadonlyMap<string, AggregatedRow>,
  objectives: ReadonlyMap<string, ObjectiveAward>,
  ruleset: ScoringRuleset,
): RankedStanding[] {
  const ordenadas = players
    .map((player) => {
      const aggregate = totals.get(player.id) ?? {
        matchPoints: 0,
        wins: 0,
        matches: 0,
        byMode: emptyByMode(ruleset),
      };
      const award = objectives.get(player.id);
      const objectivePoints = award?.points ?? 0;

      return {
        playerId: player.id,
        profileId: player.profileId,
        wins: aggregate.wins,
        matches: aggregate.matches,
        byMode: aggregate.byMode,
        total: aggregate.matchPoints + objectivePoints,
        objectives: { points: objectivePoints, earned: award?.earned ?? [] },
      };
    })
    .sort(compareStandings);

  let rank = 0;

  return ordenadas.map((row, index) => {
    const anterior = ordenadas[index - 1];

    if (anterior === undefined || compareCriteria(anterior, row) !== 0) {
      rank = index + 1;
    }

    return { ...row, rank };
  });
}

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
  // clasificación, y su publicación no debe quedarse esperando al resto. El pool de
  // mapas y los cortes de división, igual: los cortes son de la condición de
  // equipos de la regla y se piden una sola vez por pasada, no dentro del bucle de
  // sentencias.
  const ruleset = await ensureRuleset();
  const mapPool = await readMapPool();
  const cutoffs = await readDivisionCutoffs();
  const warnings =
    cutoffs === null
      ? [
          "sin cortes de división cacheados: las partidas de equipo no se comprueban contra el escalón de sus compañeros y cuentan (derívalos con `npm run alerts:cutoffs`)",
        ]
      : [];

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
      // no revertida y con los compañeros del equipo a un escalón o menos. Una
      // partida anterior a la inscripción del jugador, o fuera de la ventana, o
      // revertida, o con un compañero a dos escalones o más, acaba con `points = 0`
      // sin más que por no pasar el filtro, y por eso deshacer un revert devuelve
      // los puntos sin tener que tocar esta fila a mano.
      //
      // El `join` con `Player` no es decorativo: el corte de inscripción sale de
      // `p."registeredAt"`. Es un `join` interior sobre la clave foránea, que no
      // admite nulos, así que no deja fuera ninguna partida.
      const clasificatoria = rankedMatchSql(
        Prisma.sql`m`,
        Prisma.sql`p`,
        ruleset.modes,
        ruleset.window,
        cutoffs,
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

      const objectivePlayers = await loadObjectivePlayers(tx, ruleset, cutoffs);
      const objectives = computeObjectives(objectivePlayers, ruleset, mapPool);

      // La racha actual del torneo sale del mismo agregado que los objetivos: los
      // agregados solo existen para quien tiene partidas clasificatorias, así que
      // quien no tiene ninguna queda con `null` (y no con 0).
      const currentStreaks = new Map(
        objectivePlayers.map((player) => [player.playerId, player.currentStreak]),
      );

      // Registro de hitos, en esta misma transacción y a continuación del cómputo:
      // el feed del historial de `/admin/historial` mezcla partidas y objetivos, y
      // un objetivo sin evento se contaría como un objetivo que nadie cumplió.
      //
      // Va aquí y no al final, y no en un segundo paso, por dos motivos que son los
      // mismos que los del resto del motor: dentro de la transacción, con el cerrojo
      // ya tomado, o el registro y la clasificación describen lo mismo o no cambia
      // ninguno; y en **todos** los caminos que recalculan —el worker, `npm run
      // score`, revertir o restaurar los puntos de una partida y la baja de un
      // jugador— sin tener que acordarse de un segundo paso. El
      // `reconcileObjectiveEvents` es idempotente y solo escribe lo que difiere de
      // lo que ya había.
      await reconcileObjectiveEvents(tx, ruleset, objectives.awarded);

      // La vista pública, en la misma transacción que el cómputo del que sale: así
      // las páginas de objetivos leen el snapshot en vez de repetir el barrido, y el
      // snapshot no puede describir un reparto de puntos distinto del que acaba de
      // escribirse en `PlayerScore`. `writeObjectivesSnapshot` decide si hay que
      // tocarlo comparando la huella, de modo que una pasada sin novedades no
      // reescribe el documento.
      await writeObjectivesSnapshot(buildObjectiveView(ruleset, mapPool, objectives.options), tx);

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
          and ${rankedMatchSql(Prisma.sql`m`, Prisma.sql`p`, ruleset.modes, ruleset.window, cutoffs)}
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

      // Se traen **todos** los aprobados, no solo quien tiene partidas: un aprobado
      // sin ninguna clasificatoria también tiene fila, con todo a cero. Un `PENDING`
      // o un `REJECTED` no entra. Los agregados que no correspondan a un aprobado se
      // ignoran en `rankApprovedPlayers()`, que itera sobre esta lista.
      const players = await tx.player.findMany({
        where: { status: PlayerStatus.APPROVED },
        select: { id: true, profileId: true },
      });

      // El orden y el `rank` los pone la parte pura (ver su docblock): total, tasa
      // de victorias, victorias y partidas, con `profileId` solo para el orden de
      // presentación dentro del puesto. Los que empatan en la tupla comparten
      // puesto, así que la numeración puede repetirse y saltarse huecos.
      const ranked = rankApprovedPlayers(players, totals, objectives.pointsByPlayer, ruleset);

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
            streak: currentStreaks.get(row.playerId) ?? null,
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
        warnings,
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

  // Los avisos van al log con el prefijo del motor, igual que los de `mergeRuleset`
  // (`reportWarnings`): el rastro ya los lleva, pero un hueco de configuración que
  // afecta a toda la puntuación tiene que verse sin ir a buscar la fila de `Setting`.
  for (const warning of result.warnings) {
    console.warn(`[scoring] ${warning}`);
  }

  return result;
}
