import "server-only";

import { Prisma } from "@/generated/prisma/client";
import { PlayerStatus } from "@/generated/prisma/enums";
import type { LadderCutoffsTable } from "@/lib/alerts/division-cutoffs";
import { readDivisionCutoffs } from "@/lib/alerts/settings";
import { getAoe4WorldConfig, type Aoe4WorldConfig } from "@/lib/aoe4world/env";
import {
  SUMMARY_RETRY_WINDOW_HOURS,
  fetchGameSummary,
  planSummaryBackfill,
  type GameSummaryMetrics,
  type SummaryBackfillCandidate,
} from "@/lib/aoe4world/summary";
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
 * | metrics leídas | las siete columnas de métricas + `summaryCheckedAt` |
 * | 404 (la partida no tiene summary) | solo `summaryCheckedAt` |
 * | fallo de red, 5xx, timeout, 200 ilegible | **nada** |
 *
 * **Un fallo no escribe la marca.** Si un timeout dejara `summaryCheckedAt`, la
 * partida saldría de la cola con las métricas a `null`, que para el motor significa
 * "no hay summary": el objetivo de APM la saltaría y las pérdidas no contarían. Lo
 * que no se sabe no se escribe, que es la misma regla que aplican las dos reglas de
 * F11.
 *
 * ## El orden y el presupuesto
 *
 * Candidas: partidas resueltas de participantes aprobados **que puntúan** (el mismo
 * predicado `rankedMatchSql()` que los puntos y la clasificación, para que las
 * métricas que se piden sean las de las partidas que de verdad cuentan) y de un
 * jugador que no tenga el historial cerrado. La cola y el presupuesto los decide el
 * planificador puro (`planSummaryBackfill()`), que va de la partida más nueva a la
 * más vieja: lo que el torneo está viviendo primero, el histórico por detrás.
 *
 * El acotado de la **base** —una partida ya intentada hace más de
 * `SUMMARY_RETRY_WINDOW_HOURS` no vuelve a entrar— vive en la consulta y no en el
 * planificador, porque es lo que mantiene el conjunto pequeño: el histórico
 * completo del torneo ya son miles de filas y traerlas para descartarlas en JS en
 * cada pasada sería peor que el trabajo que este paso ahorra.
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

export type SummaryBackfillResult = {
  /** Partidas candidatas leídas: resueltas, clasificatorias y sin métricas. */
  candidates: number;
  /** Cuántas toca esta pasada, ya con el presupuesto aplicado. */
  planned: number;
  /** Summaries leídos y guardados de verdad. */
  fetched: number;
  /** Partidas que el sitio ha dicho que no tienen summary (404). */
  missing: number;
  /** Intentos que no se han podido resolver; no escriben nada. */
  failed: number;
  /** Las que quedaron para la siguiente pasada por el presupuesto. */
  skippedByBudget: number;
  /** Lo que no se ha podido hacer, en texto legible para el rastro. */
  warnings: string[];
  durationMs: number;
};

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : `Error desconocido: ${String(error)}`;
}

/** Reloj de pared UTC, `YYYY-MM-DD HH:MM:SS.mmm`, tal y como lo guarda Postgres. */
function utcTimestamp(value: Date): string {
  return value.toISOString().replace("T", " ").replace("Z", "");
}

/**
 * Las partidas a las que les falta el summary, acotadas por la base.
 *
 * `apm is null` es el filtro de "sin métricas", y **no** `summaryCheckedAt is
 * null`: la marca también se escribe cuando el sitio contesta 404, así que hay
 * partidas marcadas sin métricas que no hay que volver a pedir. Como `apm` es la
 * marca de "hubo summary" (ver `Match` en el esquema), las dos condiciones juntas
 * dicen "no hay métricas y no consta que se hayan pedido".

 * `historyPublic is distinct from false` deja pasar `null` (sin comprobar): lo que
 * se descarta es a quien consta que tiene el historial cerrado, que no publica
 * summaries.
 */
function summaryCandidateQuery(
  ruleset: ScoringRuleset,
  cutoffs: LadderCutoffsTable | null,
  now: Date,
): Prisma.Sql {
  const { window } = ruleset;
  const retryFloor = utcTimestamp(new Date(now.getTime() - SUMMARY_RETRY_WINDOW_HOURS * 3_600_000));

  return Prisma.sql`
    select m."gameId" as "gameId",
           m."playerId" as "playerId",
           p."profileId" as "profileId",
           m."finishedAt" as "finishedAt",
           m."summaryCheckedAt" as "summaryCheckedAt"
    from "Match" m
    join "Player" p on p."id" = m."playerId"
    where p."status" = ${PlayerStatus.APPROVED}
      and ${rankedMatchSql(Prisma.sql`m`, Prisma.sql`p`, ruleset.modes, window, cutoffs)}
      and m."apm" is null
      and m."finishedAt" is not null
      and (m."summaryCheckedAt" is null or m."finishedAt" >= ${retryFloor}::timestamp)
      and p."historyPublic" is distinct from false
  `;
}

/** Las métricas de un summary, como `update` de Prisma. */
function metricsData(metrics: GameSummaryMetrics, checkedAt: Date): Prisma.MatchUpdateInput {
  return {
    apm: metrics.apm,
    feudalAgeSeconds: metrics.feudalAgeSeconds,
    castleAgeSeconds: metrics.castleAgeSeconds,
    imperialAgeSeconds: metrics.imperialAgeSeconds,
    villagersLost: metrics.villagersLost,
    gildedVillagersLost: metrics.gildedVillagersLost,
    mountedVillagersLost: metrics.mountedVillagersLost,
    summaryCheckedAt: checkedAt,
  };
}

/**
 * Rellena las métricas del summary de las partidas que aún no las tienen.
 *
 * **Nunca lanza.** Como `checkPlayerHistory()`: un fallo de la base o del ruleset
 * va a `warnings` con el resto de la pasada hecho, y un fallo de red de una partida
 * no impide intentar la siguiente. El motivo es que esto alimenta unos objetivos,
 * no el torneo: que no se pueda leer un summary no puede parar la sincronización.
 */
export async function backfillMatchSummaries(
  options: { signal?: AbortSignal; config?: Aoe4WorldConfig } = {},
): Promise<SummaryBackfillResult> {
  const startedAtMs = Date.now();
  const config = options.config ?? getAoe4WorldConfig();
  const now = new Date();
  const warnings: string[] = [];

  const result: SummaryBackfillResult = {
    candidates: 0,
    planned: 0,
    fetched: 0,
    missing: 0,
    failed: 0,
    skippedByBudget: 0,
    warnings,
    durationMs: 0,
  };

  try {
    // El ruleset de puntuación y los cortes de división: son los dos argumentos de
    // `rankedMatchSql()`, el predicado que decide qué partidas puntúan. Sin ellos,
    // se pedirían summaries de partidas que no cuentan para nada.
    const scoring: ScoringRuleset = await readRuleset();
    const cutoffs = await readDivisionCutoffs();

    if (scoring.modes.length === 0) {
      result.durationMs = Date.now() - startedAtMs;

      return result;
    }

    const rows = await db.$queryRaw<SummaryCandidateRow[]>(
      summaryCandidateQuery(scoring, cutoffs, now),
    );

    result.candidates = rows.length;

    const planned = planSummaryBackfill(rows, { now });

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

          continue;
        }

        // Un 404 es concluyente y solo deja la marca; un summary leído escribe sus
        // métricas y la marca en el mismo `update`.
        await db.match.update({
          where: { playerId_gameId: { playerId: candidate.playerId, gameId: candidate.gameId } },
          data:
            outcome.kind === "summary"
              ? metricsData(outcome.metrics, now)
              : { summaryCheckedAt: now },
        });

        if (outcome.kind === "summary") {
          result.fetched += 1;
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
  } catch (error) {
    // Aquí solo llega un fallo de la base o del ruleset, que son los pasos sin
    // `try` propio. Lo que ya se había escrito no se pierde y el aviso va al rastro.
    warnings.push(`No se han podido rellenar los summaries: ${toErrorMessage(error)}`);
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
 * relleno va avanzando, no que algo falle.
 */
export function describeSummaryBackfill(result: SummaryBackfillResult): string | null {
  if (result.candidates === 0 && result.warnings.length === 0) {
    return null;
  }

  const partes = [
    result.fetched > 0 ? `${result.fetched} summaries guardados` : null,
    result.missing > 0 ? `${result.missing} sin summary` : null,
    result.failed > 0 ? `${result.failed} sin respuesta` : null,
    result.skippedByBudget > 0 ? `${result.skippedByBudget} para la siguiente pasada` : null,
  ].filter((parte): parte is string => parte !== null);

  if (partes.length === 0 && result.warnings.length === 0) {
    return null;
  }

  return [`Summaries de partida: ${partes.join(", ")}.`, ...result.warnings].join(" ");
}
