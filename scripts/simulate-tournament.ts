import "dotenv/config";

import { createAoe4WorldClient } from "@/lib/aoe4world/client";
import { getAoe4WorldConfig } from "@/lib/aoe4world/env";
import { syncApprovedPlayers } from "@/lib/aoe4world/sync";
import { db } from "@/lib/db";
import { unwrapRead } from "@/lib/db-errors";
import { DIVISIONS } from "@/lib/divisions";
import { getLiveMatches, getStandings } from "@/lib/public";
import { SCORING_LAST_RUN_KEY } from "@/lib/settings";
import {
  cleanSimulationRoster,
  mergeRosterEntries,
  readSimulationRoster,
  seedSyncCursors,
  upsertSimulationPlayers,
  writeSimulationRoster,
  SIMULATION_ROSTER_KEY,
  SIMULATION_ROSTER_VERSION,
  type SimulationRoster,
} from "@/lib/simulation/roster";
import {
  MIN_RECENT_RANKED_GAMES,
  RECENT_WINDOW_DAYS,
  SELECTION_DEFAULTS,
  selectTournamentPlayers,
  type SelectionResult,
} from "@/lib/simulation/select";

/**
 * Torneo simulado con **jugadores reales** de AoE4World.
 *
 *   npm run simulate:tournament           # elige, da de alta, importa y recalcula
 *   npm run simulate:tournament -- --select-only  # solo elige y lo informa
 *   npm run simulate:clean                       # deshace lo que creó
 *   npm run simulate:clean -- --dry-run          # comprueba qué borraría, sin borrar
 *
 * A diferencia de `mock:tournament`, que usa fixtures y un rango de `profileId`
 * reservado, esto mete en la base de datos de producción gente real de la ladder.
 * Por eso todo va contra la API de verdad (el script **falla** si el mock está
 * activo) y por eso la limpieza se apoya en un manifiesto escrito
 * (`Setting["simulation.roster"]`) en vez de en un rango de ids: es lo único que
 * permite borrar exactamente a los nuestros y no tocar a los participantes de
 * verdad que estén dentro de un mes.
 *
 * Idempotente: repetirlo vuelve a elegir (la selección se audita cada vez), no
 * duplica jugadores ni partidas, y no mueve el cursor de sincronización hacia
 * atrás.
 */

/**
 * Ventana del torneo simulado: cuatro semanas de las que ya han pasado tres.
 *
 * No es un dato del motor — las reglas todavía no filtran por fecha (D-02/D-03
 * están diferidas) — sino la ventana que se le pide a la API: el arranque marca
 * desde dónde se importa y el fin marca dónde acabarían las cuatro semanas. Un
 * torneo que sigue vivo tiene que **poder seguir creciendo** con el worker real,
 * y por eso el script siembra el cursor en el arranque en vez de truncarlo al
 * momento de importarlo.
 */
const TOURNAMENT_WEEKS = 4;
const TOURNAMENT_WEEKS_ELAPSED = 3;

function tournamentWindow(now: Date): { start: Date; end: Date } {
  const start = new Date(now.getTime() - TOURNAMENT_WEEKS_ELAPSED * 7 * 86_400_000);

  return { start, end: new Date(start.getTime() + TOURNAMENT_WEEKS * 7 * 86_400_000) };
}

function parseFlag(argv: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  return argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function printSelection(result: SelectionResult, durationMs: number): void {
  console.log("");
  console.log("--- 1. Selección (la API no filtra la ladder: hay que paginarla) ---");
  console.log(
    `Ladder ${result.leaderboard}: ${result.totalLadderPlayers} jugadores, ` +
      `${result.lastPage} páginas. Se han hecho ${result.ladderRequests} llamadas para localizar ` +
      `las divisiones y ${result.gameRequests} para contar las partidas de los candidatos ` +
      `(${durationMs} ms).`,
  );

  for (const division of result.divisions) {
    const label = DIVISIONS.find((candidate) => candidate.id === division.division)?.label ?? "";
    const picked =
      division.pick === null
        ? "sin candidato"
        : `${division.pick.name} (#${division.pick.profileId}) — ${division.pick.recentRankedGames}+ partidas de ladder en ${result.recentWindowDays} días`;

    console.log("");
    console.log(
      `${label} (páginas ${division.firstPage}-${division.lastPage}, leídas ${division.pagesScanned.join(", ")}): ${picked}`,
    );

    for (const rejection of division.rejections) {
      console.log(
        `  descartado ${rejection.profileId} ${rejection.name} (${rejection.rating ?? "s/rating"}): ${rejection.reason}`,
      );
    }

    for (const note of division.notes) {
      console.log(`  aviso: ${note}`);
    }
  }

  if (result.missingDivisions.length > 0) {
    console.log("");
    console.log(`Divisiones sin candidato: ${result.missingDivisions.join(", ")}`);
  }
}

async function runClean(argv: string[]): Promise<void> {
  const dryRun = argv.includes("--dry-run");
  const roster = await readSimulationRoster();

  console.log("--- Limpieza del torneo simulado con jugadores reales ---");

  if (roster === null) {
    console.log(
      `No hay manifiesto en "${SIMULATION_ROSTER_KEY}": no hay nada que limpiar. ` +
        "Si se ejecutó la simulación y el manifiesto falta, hay que borrarlo a mano: " +
        "no se va a adivinar qué jugadores eran.",
    );
    return;
  }

  console.log(
    `Manifiesto de ${roster.updatedAt}: ${roster.entries.length} jugadores, ` +
      `${roster.entries.filter((entry) => entry.current).length} vigentes.`,
  );

  const result = await cleanSimulationRoster({ dryRun });

  if (!result.executed) {
    console.log(dryRun ? "--dry-run: no se ha borrado nada." : "No se ha borrado nada.");
    return;
  }

  console.log("");
  console.log(`Jugadores borrados: ${result.playersDeleted} (partidas y clasificación, en cascada)`);
  console.log(`Cursores y manifiesto borrados: ${result.cursorsDeleted}`);
  console.log("Las partidas en las que estos jugadores eran rivales se conservan (son de otros).");
}

async function runSimulation(argv: string[]): Promise<void> {
  const config = getAoe4WorldConfig();

  if (config.mock) {
    throw new Error(
      "AOE4WORLD_MOCK está activo. Este torneo usa jugadores reales de AoE4World: " +
        "vuelve a lanzarlo sin el mock (npm run simulate:tournament).",
    );
  }

  const now = new Date();
  const window = tournamentWindow(now);
  const selectOnly = argv.includes("--select-only");
  const maxCandidates = Number(
    parseFlag(argv, "max-candidates") ?? SELECTION_DEFAULTS.maxCandidatesPerDivision,
  );
  const maxPages = Number(parseFlag(argv, "max-pages") ?? SELECTION_DEFAULTS.maxPagesPerDivision);

  if (!Number.isInteger(maxCandidates) || maxCandidates < 1) {
    throw new Error("--max-candidates tiene que ser un entero mayor que 0.");
  }

  if (!Number.isInteger(maxPages) || maxPages < 1) {
    throw new Error("--max-pages tiene que ser un entero mayor que 0.");
  }

  console.log("--- Torneo simulado con jugadores reales de AoE4World ---");
  console.log(
    `Ventana del torneo: ${window.start.toISOString()} — ${window.end.toISOString()} ` +
      `(${TOURNAMENT_WEEKS} semanas, van ${TOURNAMENT_WEEKS_ELAPSED}).`,
  );
  console.log(
    `Se busca 1 jugador por división con más de ${MIN_RECENT_RANKED_GAMES} partidas de ladder ` +
      `en los últimos ${RECENT_WINDOW_DAYS} días.`,
  );

  const client = createAoe4WorldClient();
  const selectionStartedAt = Date.now();
  const selection = await selectTournamentPlayers({
    client,
    maxCandidatesPerDivision: maxCandidates,
    maxPagesPerDivision: maxPages,
    now,
    onProgress: (message) => console.log(`  ${message}`),
  });

  printSelection(selection, Date.now() - selectionStartedAt);

  if (selection.picks.length === 0) {
    throw new Error(
      "No se ha encontrado ningún jugador que cumpla el mínimo. No se toca la base de datos.",
    );
  }

  if (selectOnly) {
    console.log("");
    console.log("--select-only: no se ha tocado la base de datos.");
    return;
  }

  const previous = await readSimulationRoster();
  const entries = mergeRosterEntries(previous, selection.picks, now.toISOString());
  const roster: SimulationRoster = {
    version: SIMULATION_ROSTER_VERSION,
    updatedAt: now.toISOString(),
    leaderboard: selection.leaderboard,
    minRecentRankedGames: selection.minRecentRankedGames,
    recentWindowDays: selection.recentWindowDays,
    tournamentStart: window.start.toISOString(),
    tournamentEnd: window.end.toISOString(),
    entries,
  };

  await writeSimulationRoster(roster);

  console.log("");
  console.log("--- 2. Alta de jugadores ---");
  console.log(`Manifiesto escrito en Setting["${SIMULATION_ROSTER_KEY}"] (${entries.length} jugadores).`);

  const upserted = await upsertSimulationPlayers(entries);

  console.log(`Creados: ${upserted.created}. Actualizados: ${upserted.updated}.`);

  for (const entry of entries.filter((candidate) => candidate.current)) {
    console.log(
      `- ${entry.profileId} ${entry.name}: ${entry.division} (${entry.rankLevel ?? "s/clase"}), ` +
        `rating ${entry.rating ?? "s/rating"}, ${entry.recentRankedGames}+ partidas de ladder, ` +
        `canal ${entry.twitchChannel ?? "sin Twitch"}`,
    );
  }

  console.log("");
  console.log("--- 3. Cursor de sincronización acotado a la ventana del torneo ---");

  const cursors = await seedSyncCursors(entries, window.start, now.toISOString());

  console.log(
    `Semillados en el arranque del torneo: ${cursors.seeded}. ` +
      `Ya tenían un cursor más reciente y se han respetado: ${cursors.kept}.`,
  );

  console.log("");
  console.log("--- 4. Importación de partidas de la ventana del torneo ---");

  const profileIds = entries
    .filter((entry) => entry.current)
    .map((entry) => entry.profileId);
  const sync = await syncApprovedPlayers({ profileIds });

  for (const player of sync.players) {
    const detail =
      player.status === "ok"
        ? [
            `${player.gamesSeen} partidas vistas`,
            `${player.matchesInserted} nuevas`,
            player.matchesSkipped > 0 ? `${player.matchesSkipped} descartadas` : null,
            player.matchesAbandoned > 0 ? `${player.matchesAbandoned} abandonadas` : null,
            player.historyTruncated ? "histórico recortado" : null,
          ]
            .filter((value): value is string => value !== null)
            .join(", ")
        : `${player.status.toUpperCase()} — ${player.error ?? ""}`;

    console.log(`- ${player.profileId} ${player.name}: ${detail}`);
  }

  console.log(`Partidas nuevas: ${sync.newMatches} (actualizadas: ${sync.updatedMatches}).`);
  console.log(
    `Ladder: ${sync.ladder.batches} llamada(s), ${sync.ladder.playersUpdated} jugador(es) con ` +
      `elo/división/avatar${sync.ladder.error === null ? "" : ` — ERROR: ${sync.ladder.error}`}`,
  );
  console.log(`Llamadas a la API: ${sync.apiRequests} (reintentos: ${sync.apiRetries}).`);
  console.log(`Duración del import: ${sync.durationMs} ms.`);

  if (sync.playersFailed > 0) {
    console.error("");
    console.error(`ERROR: ${sync.playersFailed} jugadores no se han podido sincronizar.`);
    process.exitCode = 1;
    return;
  }

  console.log("");
  console.log("--- 5. Comprobación de lo que ve la web ---");

  const [standingsRead, liveMatchesRead, matches, lastRun] = await Promise.all([
    getStandings(),
    // El DAL tal cual lo usa `/partidas`, no una consulta equivalente: lo que se
    // comprueba es lo que vería un lector.
    getLiveMatches(),
    db.match.count({ where: { player: { profileId: { in: profileIds } } } }),
    db.setting.findUnique({ where: { key: SCORING_LAST_RUN_KEY } }),
  ]);

  // Comprobación de lo que ve la web: si la base no ha podido leer, esto tiene que
  // abortar en vez de "verificar" contra una clasificación vacía.
  const standings = unwrapRead(standingsRead, "simulate:tournament");
  const liveMatches = unwrapRead(liveMatchesRead, "simulate:tournament");

  const simulated = standings.filter((row) => profileIds.includes(row.profileId));

  console.log(`Filas de partida de los ${profileIds.length} jugadores: ${matches}.`);
  console.log(`Partidas en directo de la simulación: ${liveMatches.length}.`);
  console.log(`Filas en la clasificación: ${simulated.length} de ${standings.length}.`);
  console.log("");
  console.log("Clasificación:");

  for (const row of simulated) {
    console.log(
      `  ${row.rank}. ${row.name} — ${row.points} puntos (${row.pointsByWins} por victorias, ` +
        `${row.pointsByObjectives} por objetivos) | ${row.wins}V/${row.losses}D | elo ${row.elo ?? "s/l"} | ` +
        `${row.division ?? "sin división"} (${row.rankLevel ?? "-"}) | ` +
        `objetivos: ${row.objectives.length === 0 ? "ninguno" : row.objectives.map((objective) => objective.id).join(", ")}`,
    );
  }

  console.log("");
  console.log(`scoring.lastRun: ${JSON.stringify(lastRun?.value ?? null)}`);

  console.log("");
  console.log("--- Cómo se deshace ---");
  console.log("npm run simulate:clean   (comprueba la identidad de cada fila antes de borrar)");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  try {
    if (argv.includes("--clean")) {
      await runClean(argv);
      return;
    }

    await runSimulation(argv);
  } catch (error) {
    // Sin esto, un fallo esperado (la limpieza abortada, la API caída) sale como
    // una promesa rechazada con el volcado del error, que en un script que se
    // ejecuta a mano no dice nada útil.
    console.error("");
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

void main();
