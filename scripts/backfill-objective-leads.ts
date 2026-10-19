import "./load-env.mjs";

import { ObjectiveLeadKind } from "@/generated/prisma/enums";
import { readDivisionCutoffs } from "@/lib/alerts/settings";
import { db } from "@/lib/db";
import {
  OBJECTIVE_DEFINITIONS,
  applyObjectiveMatch,
  computeObjectives,
  emptyObjectiveAggregate,
  loadObjectiveMatchRows,
  type ObjectiveMatchRow,
  type PlayerAggregate,
} from "@/lib/objectives";
import { currentLeadHolders, leadChanges } from "@/lib/objective-leads";
import { windowBounds } from "@/lib/ranked-match";
import { readRuleset, SCORING_LOCK_NAME } from "@/lib/scoring";
import { readMapPool } from "@/lib/settings";

/**
 * Reconstruye el registro de liderazgos (`ObjectiveLeadEvent`) de la edición activa a
 * partir de las partidas ya guardadas.
 *
 * El registro **en vivo** (`reconcileObjectiveLeadEvents()`) solo puede anotar los
 * cambios que presencia: la primera pasada siembra al poseedor de ese momento y no
 * inventa el pasado. Si la edición ya se jugó antes de desplegar el registro —o si se
 * activa a mitad—, este script recorre las partidas en orden cronológico, reconstruye
 * el poseedor de cada competición después de cada partida y escribe la misma secuencia
 * de `LOST`/`GAINED` que habría escrito el motor en vivo.
 *
 * ## Qué usa y qué no
 *
 * Reutiliza la consulta de `loadObjectiveMatchRows()` —la misma que alimenta el
 * motor, con `rankedMatchSql()`— y la agregación de `objectives.ts`, así que la
 * definición de "partida clasificatoria" y los desempates son los del torneo. Los
 * logros no se tocan: su espejo (`ObjectiveEvent`) se escribe al cerrar la ventana y
 * ya está resuelto.
 *
 * ## Idempotencia y cerrojo
 *
 * Borra **todas** las filas de la edición activa y las reescribe enteras, en una
 * transacción y con el mismo cerrojo que `recomputeScores()`. Repetirlo deja el mismo
 * resultado. El `at` de cada fila es el `finishedAt` de la partida que cambió el
 * poseedor, no el instante en que se ejecuta el script: así el historial cuenta
 * cuándo pasó, no cuándo se reconstruyó. Además limpia de `ObjectiveEvent` los ids de
 * competición que hubiera escrito la versión anterior del motor: desde este cambio las
 * competiciones viven solo en `ObjectiveLeadEvent`, y sin esa limpieza el historial
 * las contaría dos veces.
 *
 * ## Uso
 *
 *   npm run backfill:objective-leads
 *   npm run backfill:objective-leads -- --dry-run
 *
 * El `--dry-run` calcula y enseña el resultado sin escribir nada. Conviene ejecutarlo
 * una vez tras desplegar el registro si la edición ya tenía partidas.
 */

type MatchGroup = {
  gameId: string;
  finishedAtMs: number;
  rows: ObjectiveMatchRow[];
};

/** Las partidas de la consulta, agrupadas por `gameId` y ordenadas como se jugaron. */
function groupByMatch(rows: readonly ObjectiveMatchRow[]): MatchGroup[] {
  const groups = new Map<string, MatchGroup>();

  for (const row of rows) {
    const previous = groups.get(row.gameId);

    if (previous === undefined) {
      groups.set(row.gameId, {
        gameId: row.gameId,
        finishedAtMs: row.finishedAtMs,
        rows: [row],
      });
      continue;
    }

    previous.rows.push(row);
    previous.finishedAtMs = Math.min(previous.finishedAtMs, row.finishedAtMs);
  }

  return [...groups.values()].sort(
    (a, b) =>
      a.finishedAtMs - b.finishedAtMs ||
      (a.gameId < b.gameId ? -1 : a.gameId > b.gameId ? 1 : 0),
  );
}

/** El `PlayerAggregate` de una fila, con la metadata que necesita la agregación. */
function aggregateFor(row: ObjectiveMatchRow): PlayerAggregate {
  return emptyObjectiveAggregate({
    playerId: row.playerId,
    profileId: row.profileId,
    name: row.name,
    avatarUrl: row.avatarUrl,
    rankLevel: row.rankLevel,
  });
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const ruleset = await readRuleset();

  const [mapPool, cutoffs] = await Promise.all([readMapPool(), readDivisionCutoffs()]);
  const rows = await loadObjectiveMatchRows(db, ruleset, cutoffs);
  const groups = groupByMatch(rows);
  const editionFrom = windowBounds(ruleset.window).from;

  const players = new Map<string, PlayerAggregate>();
  const winRuns = new Map<string, number>();
  const events: {
    objectiveId: string;
    playerId: string;
    kind: ObjectiveLeadKind;
    at: Date;
    editionFrom: Date;
  }[] = [];

  let previous = new Map<string, string | null>();

  for (const [index, group] of groups.entries()) {
    if (index > 0 && index % 100 === 0) {
      console.log(
        `[backfill:objective-leads] ${index}/${groups.length} partidas y ${events.length} eventos…`,
      );
    }

    // Primero se aplican **todas** las filas de la partida y después se recalcula: si
    // se hiciera fila a fila, un 1v1 podría dejar un liderazgo intermedio que nunca
    // existió al terminar la partida.
    for (const row of group.rows) {
      const aggregate = players.get(row.playerId) ?? aggregateFor(row);

      players.set(row.playerId, aggregate);
      applyObjectiveMatch(aggregate, row, ruleset);

      const run = row.result === "WIN" ? (winRuns.get(row.playerId) ?? 0) + 1 : 0;

      winRuns.set(row.playerId, run);

      if (run > aggregate.streak) {
        aggregate.streak = run;
        aggregate.streakEndsAt = row.finishedAtMs;
      }
    }

    const current = currentLeadHolders(
      computeObjectives([...players.values()], ruleset, mapPool).awarded,
    );
    const changes = leadChanges(previous, current);

    if (changes.length > 0) {
      const at = new Date(group.finishedAtMs);

      for (const change of changes) {
        events.push({ ...change, at, editionFrom });
      }
    }

    previous = current;
  }

  console.log(
    `[backfill:objective-leads] ${groups.length} partidas, ${players.size} jugadores, ` +
      `${events.length} eventos de liderazgo para la edición ${editionFrom.toISOString()}.`,
  );

  if (dryRun) {
    for (const event of events.slice(0, 40)) {
      console.log(
        `  ${event.at.toISOString()}  ${event.kind.padEnd(6)}  ${event.objectiveId}  ${event.playerId}`,
      );
    }

    if (events.length > 40) {
      console.log(`  … y ${events.length - 40} más.`);
    }

    console.log("[backfill:objective-leads] --dry-run: no se ha escrito nada.");
    return;
  }

  const competitionIds = OBJECTIVE_DEFINITIONS.filter(
    (definition) => definition.kind === "competition",
  ).map((definition) => definition.id);

  await db.$transaction(async (tx) => {
    // El mismo cerrojo que `recomputeScores()`: el worker y el backfill no pueden
    // escribir el registro a la vez.
    await tx.$queryRaw`select pg_advisory_xact_lock(hashtext(${SCORING_LOCK_NAME}))::text`;

    // Las competiciones ya no se escriben en el espejo de logros. Si la versión
    // anterior las dejó ahí, se limpian para que no salgan duplicadas al leer.
    await tx.objectiveEvent.deleteMany({ where: { objectiveId: { in: competitionIds } } });
    await tx.objectiveLeadEvent.deleteMany({ where: { editionFrom } });

    if (events.length > 0) {
      await tx.objectiveLeadEvent.createMany({ data: events });
    }
  });

  console.log(
    "[backfill:objective-leads] registro reescrito: " +
      `${events.length} filas de la edición ${editionFrom.toISOString()}.`,
  );
}

main().catch((error: unknown) => {
  console.error("[backfill:objective-leads] ha fallado:", error);
  process.exitCode = 1;
});
