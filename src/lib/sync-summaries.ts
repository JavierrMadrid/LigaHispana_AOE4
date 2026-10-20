import "server-only";

import { Prisma } from "@/generated/prisma/client";
import { PlayerStatus } from "@/generated/prisma/enums";
import type { LadderCutoffsTable } from "@/lib/alerts/division-cutoffs";
import { readDivisionCutoffs } from "@/lib/alerts/settings";
import { getAoe4WorldConfig, type Aoe4WorldConfig } from "@/lib/aoe4world/env";
import {
  fetchGameSummary,
  planSummaryBackfill,
  type GameSummaryMetrics,
  type SummaryBackfillCandidate,
} from "@/lib/aoe4world/summary";
import type { SummaryAnomalies } from "@/lib/aoe4world/summary-anomalies";
import { db } from "@/lib/db";
import { rankedMatchSql } from "@/lib/ranked-match";
import { readRuleset, type ScoringRuleset } from "@/lib/scoring";

/**
 * El paso del worker que rellena las métricas del *summary* de cada partida.
 *
 * ## Qué escribe y qué no
 *
 * Los objetivos `ansioso`, `avance-relampago-feudal`, `avance-relampago-castillos`,
 * `avance-relampago-imperial` y `defensor-del-pueblo` (`docs/OBJETIVOS.md`) se
 * cobran con datos que solo están en el summary de la partida (plan `aoe4world`):
 * los APM, cuándo se pasó de edad y cuántos aldeanos se perdieron. Este módulo se
 * los pide a `src/lib/aoe4world/summary.ts` y los guarda en `Match`, siguiendo el
 * patrón de `history-checks.ts`: presupuesto por pasada, tolerante a fallos y con
 * una línea para el rastro.
 *
 * | Respuesta | Qué se escribe |
 * |---|---|
 * | métricas leídas | las siete columnas de métricas + `summaryAnomalies` + `summaryCheckedAt` + `summaryLastAttemptAt` |
 * | 404 (la partida no tiene summary) | `summaryCheckedAt` + `summaryLastAttemptAt` |
 * | fallo de red, 5xx, timeout, 200 ilegible | solo `summaryLastAttemptAt` |
 * | 429 | `summaryLastAttemptAt`, y **se corta la pasada** |
 *
 * **Un fallo no escribe la marca concluyente.** Si un timeout dejara
 * `summaryCheckedAt`, la partida saldría de la cola con las métricas a `null`, que
 * para el motor significa "no hay summary": el objetivo de APM la saltaría y las
 * pérdidas no contarían. Lo que sí escribe es `summaryLastAttemptAt`, que es el
 * dato honesto —"se intentó"— y lo que sostiene el reintento de una hora y el aviso
 * de las partidas que nunca se resolvieron.
 *
 * ## Las dos marcas
 *
 * `summaryCheckedAt` es **concluyente**: hubo summary o el sitio dijo que no lo
 * tiene, y la partida no se vuelve a pedir. `summaryLastAttemptAt` es **cualquier
 * intento**, con su desenlace, y es lo que usa el planificador puro para no repetir
 * la misma partida en cada pasada y lo que permite detectar, pasada la ventana de
 * revisión, las partidas que se intentaron y nunca se resolvieron.
 *
 * ## El orden y el presupuesto
 *
 * Candidatas: partidas resueltas de participantes aprobados **que puntúan** (el
 * mismo predicado `rankedMatchSql()` que los puntos y la clasificación, para que
 * las métricas que se piden sean las de las partidas que de verdad cuentan), dentro
 * de la ventana de revisión y de un jugador que no tenga el historial cerrado. La
 * cola y el presupuesto los decide el planificador puro (`planSummaryBackfill()`),
 * que va de la partida más nueva a la más vieja: lo que el torneo está viviendo
 * primero, el histórico por detrás.
 *
 * El acotado de la **base** —la ventana de revisión y el margen de reintento— vive
 * en la consulta y no en el planificador, porque es lo que mantiene el conjunto
 * pequeño: el histórico completo del torneo ya son miles de filas y traerlas para
 * descartarlas en JS en cada pasada sería peor que el trabajo que este paso ahorra.
 *
 * Y lo que se quedó sin revisar no desaparece: una segunda consulta, con el mismo
 * `rankedMatchSql()`, cuenta por jugador las partidas que se intentaron, pasaron la
 * ventana y nunca se resolvieron. Ese recuento es lo que el motor convierte en
 * `SUMMARY_NOT_REVIEWED` y lo que hace que el sincronizador reevalúe a su dueño
 * aunque no haya jugado nada nuevo.
 *
 * ## Rate limit
 *
 * Dos summaries por minuto como mucho (`summaryMinIntervalMs`), un presupuesto por
 * pasada y un 429 que corta el bucle: cuando AoE4World pide bajar el ritmo, seguir
 * con la siguiente partida es la peor respuesta posible. El intento queda apuntado
 * y el resto de la cola espera a la pasada siguiente.
 *
 * ## Un jugador con el historial cerrado no tiene summaries
 *
 * La condición va en la **consulta** (`historyPublic is distinct from false`, que
 * incluye `null` = sin comprobar) y no en el planificador: sin ella, cada pasada
 * volvería a poner sus partidas al principio de la cola —son las más nuevas— y se
 * llevaría el presupuesto entero a cambio de nada, porque de un historial cerrado
 * no publica summaries ni el sitio.
 */

/** Una fila de candidata tal y como la devuelve la consulta. */
type SummaryCandidateRow = SummaryBackfillCandidate;

/** Una fila de la consulta de partidas que se quedaron sin revisar. */
type UnreviewedRow = {
  playerId: string;
  profileId: number;
  unreviewed: number;
};

export type SummaryBackfillResult = {
  /** Partidas candidatas leídas: resueltas, clasificatorias y sin métricas. */
  candidates: number;
  /** Cuántas toca esta pasada, ya con el presupuesto aplicado. */
  planned: number;
  /** Summaries leídos y guardados de verdad. */
  fetched: number;
  /** Partidas que el sitio ha dicho que no tienen summary (404). */
  missing: number;
  /** Intentos que no se han podido resolver. */
  failed: number;
  /** Las que quedaron para la siguiente pasada por el presupuesto. */
  skippedByBudget: number;
  /** La pasada se cortó porque AoE4World respondió 429. */
  throttled: boolean;
  /** Partidas que pasaron la ventana de revisión sin respuesta concluyente. */
  unreviewed: number;
  /**
   * Jugadores con al menos un summary leído en esta pasada. El sincronizador los
   * reevalúa aunque no hayan jugado nada nuevo: el summary rellenado cambia lo que
   * el motor de alertas tiene que mirar.
   */
  reviewedProfileIds: number[];
  /** Jugadores con alguna partida sin revisar; también hay que reevaluarlos. */
  unreviewedProfileIds: number[];
  /** Lo que no se ha podido hacer, en texto legible para el rastro. */
  warnings: string[];
  durationMs: number;
};

/**
 * Cómo se espera entre dos summaries. Inyectable para que las pruebas puras se
 * prueben sin temporizadores reales.
 */
export type SummaryWait = (ms: number, signal?: AbortSignal) => Promise<void>;

/** `setTimeout` con cancelación: la espera entre summaries respeta la señal. */
const waitWithSignal: SummaryWait = (ms, signal) => {
  if (ms <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Petición cancelada."));
    };

    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }

      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
};

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : `Error desconocido: ${String(error)}`;
}

/** Reloj de pared UTC, `YYYY-MM-DD HH:MM:SS.mmm`, tal y como lo guarda Postgres. */
function utcTimestamp(value: Date): string {
  return value.toISOString().replace("T", " ").replace("Z", "");
}

/**
 * El suelo de la ventana: las partidas terminadas antes de este instante ya no se
 * piden, se quedaron sin revisar.
 */
function reviewFloor(now: Date, reviewWindowHours: number): Date {
  return new Date(now.getTime() - reviewWindowHours * 3_600_000);
}

/**
 * Las partidas a las que les falta el summary, acotadas por la base.
 *
 * `apm is null` es el filtro de "sin métricas", y **no** `summaryCheckedAt is
 * null`: la marca también se escribe cuando el sitio contesta 404, así que hay
 * partidas marcadas sin métricas que no hay que volver a pedir. Como `apm` es la
 * marca de "hubo summary" (ver `Match` en el esquema), las dos condiciones juntas
 * dicen "no hay métricas y no hay respuesta concluyente".
 *
 * La ventana de revisión recorta el histórico irresoluble y el margen de reintento
 * deja pasar al resto sin repetir la misma partida en cada pasada.
 *
 * `historyPublic is distinct from false` deja pasar `null` (sin comprobar): lo que
 * se descarta es a quien consta que tiene el historial cerrado, que no publica
 * summaries.
 */
function summaryCandidateQuery(
  ruleset: ScoringRuleset,
  cutoffs: LadderCutoffsTable | null,
  now: Date,
  reviewWindowHours: number,
  retryDelayMs: number,
): Prisma.Sql {
  const { window } = ruleset;
  const review = utcTimestamp(reviewFloor(now, reviewWindowHours));
  const retry = utcTimestamp(new Date(now.getTime() - retryDelayMs));

  return Prisma.sql`
    select m."gameId" as "gameId",
           m."playerId" as "playerId",
           p."profileId" as "profileId",
           m."finishedAt" as "finishedAt",
           m."summaryCheckedAt" as "summaryCheckedAt",
           m."summaryLastAttemptAt" as "summaryLastAttemptAt"
    from "Match" m
    join "Player" p on p."id" = m."playerId"
    where p."status" = ${PlayerStatus.APPROVED}
      and ${rankedMatchSql(Prisma.sql`m`, Prisma.sql`p`, ruleset.modes, window, cutoffs)}
      and m."apm" is null
      and m."summaryCheckedAt" is null
      and m."finishedAt" is not null
      and m."finishedAt" >= ${review}::timestamp
      and (m."summaryLastAttemptAt" is null or m."summaryLastAttemptAt" <= ${retry}::timestamp)
      and p."historyPublic" is distinct from false
  `;
}

/**
 * Las partidas que se quedaron sin revisar: se intentaron, no hubo respuesta
 * concluyente y ya pasó la ventana.
 *
 * Es la otra cara de la consulta anterior: lo que aquella deja fuera por viejo, esta
 * lo cuenta por jugador, que es lo que necesita la alerta de estado
 * `SUMMARY_NOT_REVIEWED`. El mismo `rankedMatchSql()` porque solo importan las
 * partidas que cuentan, y el mismo descarte del historial cerrado porque esas ya
 * tienen su propia regla (`HISTORY_NOT_PUBLIC`).
 */
function unreviewedQuery(
  ruleset: ScoringRuleset,
  cutoffs: LadderCutoffsTable | null,
  now: Date,
  reviewWindowHours: number,
): Prisma.Sql {
  const { window } = ruleset;
  const review = utcTimestamp(reviewFloor(now, reviewWindowHours));

  return Prisma.sql`
    select m."playerId" as "playerId",
           p."profileId" as "profileId",
           count(*)::int as "unreviewed"
    from "Match" m
    join "Player" p on p."id" = m."playerId"
    where p."status" = ${PlayerStatus.APPROVED}
      and ${rankedMatchSql(Prisma.sql`m`, Prisma.sql`p`, ruleset.modes, window, cutoffs)}
      and m."apm" is null
      and m."summaryCheckedAt" is null
      and m."summaryLastAttemptAt" is not null
      and m."finishedAt" is not null
      and m."finishedAt" < ${review}::timestamp
      and p."historyPublic" is distinct from false
    group by m."playerId", p."profileId"
  `;
}

/** Las métricas de un summary, como `update` de Prisma. */
function metricsData(
  metrics: GameSummaryMetrics,
  anomalies: SummaryAnomalies | null,
  attemptedAt: Date,
): Prisma.MatchUpdateInput {
  return {
    apm: metrics.apm,
    feudalAgeSeconds: metrics.feudalAgeSeconds,
    castleAgeSeconds: metrics.castleAgeSeconds,
    imperialAgeSeconds: metrics.imperialAgeSeconds,
    villagersLost: metrics.villagersLost,
    gildedVillagersLost: metrics.gildedVillagersLost,
    mountedVillagersLost: metrics.mountedVillagersLost,
    // `DbNull` y no `null`: en una columna `Json?` de Prisma, `null` es "déjalo
    // como está" y `DbNull` es "escríbelo nulo en la base".
    summaryAnomalies:
      anomalies === null ? Prisma.DbNull : (anomalies as unknown as Prisma.InputJsonValue),
    summaryCheckedAt: attemptedAt,
    summaryLastAttemptAt: attemptedAt,
  };
}

/**
 * Rellena las métricas del summary de las partidas que aún no las tienen.
 *
 * **Nunca lanza.** Como `checkPlayerHistory()`: un fallo de la base o del ruleset
 * va a `warnings` con el resto de la pasada hecho, y un fallo de red de una partida
 * no impide intentar la siguiente.
 *
 * `wait` existe para las pruebas puras: con el valor por defecto duerme de verdad
 * entre peticiones (`summaryMinIntervalMs`), y una prueba que lo dejara así tendría
 * temporizadores reales.
 */
export async function backfillMatchSummaries(
  options: {
    signal?: AbortSignal;
    config?: Aoe4WorldConfig;
    /** Espera entre peticiones; por defecto, la de la señal. Inyectable en pruebas. */
    wait?: SummaryWait;
  } = {},
): Promise<SummaryBackfillResult> {
  const startedAtMs = Date.now();
  const config = options.config ?? getAoe4WorldConfig();
  const wait = options.wait ?? waitWithSignal;
  const now = new Date();
  const warnings: string[] = [];

  const result: SummaryBackfillResult = {
    candidates: 0,
    planned: 0,
    fetched: 0,
    missing: 0,
    failed: 0,
    skippedByBudget: 0,
    throttled: false,
    unreviewed: 0,
    reviewedProfileIds: [],
    unreviewedProfileIds: [],
    warnings,
    durationMs: 0,
  };

  const reviewed = new Set<number>();
  let scoring: ScoringRuleset | null = null;
  let cutoffs: LadderCutoffsTable | null = null;

  try {
    // El ruleset de puntuación y los cortes de división: son los dos argumentos de
    // `rankedMatchSql()`, el predicado que decide qué partidas puntúan. Sin ellos,
    // se pedirían summaries de partidas que no cuentan para nada.
    scoring = await readRuleset();
    cutoffs = await readDivisionCutoffs();

    if (scoring.modes.length === 0) {
      result.durationMs = Date.now() - startedAtMs;

      return result;
    }

    const rows = await db.$queryRaw<SummaryCandidateRow[]>(
      summaryCandidateQuery(
        scoring,
        cutoffs,
        now,
        config.summaryReviewWindowHours,
        config.summaryRetryDelayMs,
      ),
    );

    result.candidates = rows.length;

    const planned = planSummaryBackfill(rows, {
      now,
      budget: config.summaryMaxPerRun,
      retryDelayMs: config.summaryRetryDelayMs,
    });

    result.planned = planned.length;
    result.skippedByBudget = Math.max(0, rows.length - planned.length);

    for (const [index, candidate] of planned.entries()) {
      if (options.signal?.aborted === true) {
        // Lo que queda sin pedir vuelve en la siguiente pasada: no se ha escrito
        // nada de esas partidas, así que no quedan a medias.
        result.planned = index;
        result.skippedByBudget += planned.length - index;

        break;
      }

      // La separación entre peticiones va entre una y otra, no después de la última.
      if (index > 0) {
        try {
          await wait(config.summaryMinIntervalMs, options.signal);
        } catch {
          // La espera solo lanza si la pasada se ha cancelado: lo que queda vuelve
          // en la siguiente, como en el corte por presupuesto.
          result.planned = index;
          result.skippedByBudget += planned.length - index;

          break;
        }
      }

      // El intento se apunta con su propia hora: es lo que sostiene el margen de
      // reintento de la partida.
      const attemptedAt = new Date();

      try {
        const outcome = await fetchGameSummary(candidate.profileId, candidate.gameId, {
          apiBase: config.apiBase,
          userAgent: config.userAgent,
          timeoutMs: config.timeoutMs,
          mock: config.mock,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });

        if (outcome.kind === "failure") {
          result.failed += 1;
          warnings.push(`partida ${candidate.gameId}: ${outcome.reason}`);

          // El fallo no deja métricas, pero sí la hora del intento: sin ella la
          // partida seguiría siendo la primera de la cola en la pasada siguiente.
          await db.match.update({
            where: { playerId_gameId: { playerId: candidate.playerId, gameId: candidate.gameId } },
            data: { summaryLastAttemptAt: attemptedAt },
          });

          if (outcome.throttled) {
            // AoE4World pide bajar el ritmo: se corta la pasada en vez de seguir
            // pidiendo el resto de la cola.
            result.throttled = true;
            result.planned = index + 1;
            result.skippedByBudget += planned.length - index - 1;

            break;
          }

          continue;
        }

        // Un 404 es concluyente y solo deja las marcas; un summary leído escribe sus
        // métricas, su evidencia y las marcas en el mismo `update`.
        await db.match.update({
          where: { playerId_gameId: { playerId: candidate.playerId, gameId: candidate.gameId } },
          data:
            outcome.kind === "summary"
              ? metricsData(outcome.metrics, outcome.anomalies, attemptedAt)
              : { summaryCheckedAt: attemptedAt, summaryLastAttemptAt: attemptedAt },
        });

        if (outcome.kind === "summary") {
          result.fetched += 1;
          reviewed.add(candidate.profileId);
        } else {
          result.missing += 1;
        }
      } catch (error) {
        // Un fallo al leer o al escribir esta partida es un aviso más: la siguiente
        // puede funcionar.
        result.failed += 1;
        warnings.push(
          `partida ${candidate.gameId}: no se ha podido guardar su summary (${toErrorMessage(error)})`,
        );
      }
    }

    result.reviewedProfileIds = [...reviewed].sort((a, b) => a - b);
  } catch (error) {
    // Aquí solo llega un fallo de la base o del ruleset, que son los pasos sin
    // `try` propio. Lo que ya se había escrito no se pierde y el aviso va al rastro.
    warnings.push(`No se han podido rellenar los summaries: ${toErrorMessage(error)}`);
  }

  // Lo que quedó sin revisar se cuenta **fuera** del bloque anterior: es una lectura
  // más y su fallo no puede llevarse por delante lo que la pasada ya ha escrito.
  if (scoring !== null && scoring.modes.length > 0) {
    try {
      const unreviewed = await db.$queryRaw<UnreviewedRow[]>(
        unreviewedQuery(scoring, cutoffs, now, config.summaryReviewWindowHours),
      );

      result.unreviewed = unreviewed.reduce((total, row) => total + Number(row.unreviewed), 0);
      result.unreviewedProfileIds = [...new Set(unreviewed.map((row) => row.profileId))].sort(
        (a, b) => a - b,
      );
    } catch (error) {
      warnings.push(`No se han podido contar los summaries sin revisar: ${toErrorMessage(error)}`);
    }
  }

  result.durationMs = Date.now() - startedAtMs;

  return result;
}

/**
 * La línea que va al rastro de la pasada (`summariesError`), o `null` si no hay
 * nada que decir.
 *
 * **No** mueve `lastSuccessAt`, igual que `historyError`, `streamsError` y
 * `mapPoolError`: no haber podido leer el summary de unas partidas solo deja unos
 * objetivos a medias; las partidas están sincronizadas, la clasificación
 * recalculada y el cron va bien. Mezclarlo daría "el torneo lleva roto desde las
 * 10:00" por un 5xx del sitio de AoE4World.
 *
 * Con el presupuesto agotado también hay línea, y es informativo: dice que el
 * relleno va avanzando, no que algo falle. Lo de "sin revisar" sí es un aviso: son
 * partidas que ya no se van a poder mirar solas y que alguien tiene que revisar.
 */
export function describeSummaryBackfill(result: SummaryBackfillResult): string | null {
  if (result.candidates === 0 && result.warnings.length === 0 && result.unreviewed === 0) {
    return null;
  }

  const partes = [
    result.fetched > 0 ? `${result.fetched} summaries guardados` : null,
    result.missing > 0 ? `${result.missing} sin summary` : null,
    result.failed > 0 ? `${result.failed} sin respuesta` : null,
    result.unreviewed > 0 ? `${result.unreviewed} sin revisar` : null,
    result.skippedByBudget > 0 ? `${result.skippedByBudget} para la siguiente pasada` : null,
  ].filter((parte): parte is string => parte !== null);

  const avisos = result.throttled
    ? [
        "AoE4World pidió bajar el ritmo (429): la pasada se ha cortado y el resto de la cola espera a la siguiente.",
      ]
    : [];

  if (partes.length === 0 && result.warnings.length === 0 && avisos.length === 0) {
    return null;
  }

  return [
    `Summaries de partida: ${partes.join(", ")}.`,
    ...avisos,
    ...result.warnings,
  ].join(" ");
}
