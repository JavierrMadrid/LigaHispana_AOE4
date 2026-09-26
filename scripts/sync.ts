import "dotenv/config";

import { syncApprovedPlayers } from "@/lib/aoe4world/sync";

/**
 * Lanzar la sincronización desde la terminal, sin levantar el servidor.
 *
 *   npm run sync            # todos los jugadores aprobados
 *   npm run sync -- 123 456 # solo esos profileId
 *
 * El cron de producción apunta a `POST /api/cron/sync`; esto es para depurar en
 * local y para entornos donde Scheduled Tasks del sistema sea más cómodo.
 */

function readProfileIds(argv: string[]): number[] | undefined {
  const ids = argv
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0);

  return ids.length === 0 ? undefined : ids;
}

async function main(): Promise<void> {
  const profileIds = readProfileIds(process.argv.slice(2));
  const summary = await syncApprovedPlayers(profileIds === undefined ? {} : { profileIds });

  console.log("");
  console.log("--- Sincronización AoE4World ---");
  console.log(
    `Jugadores: ${summary.playersOk} ok / ${summary.playersFailed} con errores / ${summary.playersCancelled} cancelados`,
  );
  console.log(
    `Partidas nuevas: ${summary.newMatches} (actualizadas: ${summary.updatedMatches})`,
  );
  console.log(
    `Resueltas por refetch: ${summary.resolvedByRefetch} | abandonadas y borradas: ${summary.abandonedMatches}`,
  );
  console.log(`Partidas en directo detectadas: ${summary.liveMatches}`);
  console.log(`Partidas descartadas: ${summary.skippedGames}`);
  console.log(
    `Llamadas a la API: ${summary.apiRequests} (reintentos: ${summary.apiRetries}, pausas por rate limit: ${summary.rateLimitPausesMs} ms)`,
  );
  console.log(`Duración: ${summary.durationMs} ms`);
  console.log("");

  for (const player of summary.players) {
    const detail = [
      `${player.gamesSeen} partidas`,
      `${player.matchesInserted} nuevas`,
      player.matchesUpdated > 0 ? `${player.matchesUpdated} actualizadas` : null,
      player.matchesResolvedByRefetch > 0
        ? `${player.matchesResolvedByRefetch} resueltas por refetch`
        : null,
      player.matchesAbandoned > 0 ? `${player.matchesAbandoned} abandonadas` : null,
      player.matchesSkipped > 0 ? `${player.matchesSkipped} descartadas` : null,
      player.historyTruncated ? "histórico recortado" : null,
    ]
      .filter((value): value is string => value !== null)
      .join(", ");

    console.log(
      player.status === "ok"
        ? `- ${player.profileId} ${player.name}: ${detail}`
        : `- ${player.profileId} ${player.name}: ${player.status.toUpperCase()} — ${player.error ?? ""}`,
    );
  }

  process.exitCode = summary.playersFailed > 0 ? 1 : 0;
}

void main();
