import "dotenv/config";

import { getStandings } from "@/lib/public";
import { RULE_LABEL, recomputeScores } from "@/lib/scoring";

/**
 * Recalcular la clasificación a mano, sin levantar el servidor.
 *
 *   npm run score
 *
 * El worker ya lo hace al final de cada pasada (`npm run sync` o el cron), así
 * que esto es para depurar, para probar reglas antes de publicarlas y para
 * recuperar la clasificación si alguien la ha tocado a mano.
 *
 * El recálculo es idempotente: repetirlo no cambia nada salvo que hayan entrado
 * partidas nuevas o hayan cambiado las reglas.
 */

async function main(): Promise<void> {
  const result = await recomputeScores();

  console.log("");
  console.log("--- Clasificación ---");
  console.log(`Versión de reglas: ${result.ruleSetVersion} (${RULE_LABEL})`);
  console.log(`Partidas con puntos actualizados: ${result.matchesUpdated}`);
  console.log(`Jugadores en la clasificación: ${result.playersRanked}`);
  console.log(`Filas retiradas: ${result.playersUnranked}`);
  console.log(`Puntos de partidas: ${result.totalPoints - result.objectivesPoints}`);
  console.log(
    `Puntos de objetivos: ${result.objectivesPoints} (${result.objectivesAwarded} con poseedor)`,
  );
  console.log(`Suma de puntos: ${result.totalPoints}`);
  console.log(`Duración: ${result.durationMs} ms`);
  console.log("");

  const standings = await getStandings();

  if (standings.length === 0) {
    console.log("Todavía no hay jugadores aprobados con partidas clasificatorias resueltas.");
    return;
  }

  console.log("Puesto  Jugador                            Puntos  Victorias  Partidas");

  for (const row of standings) {
    const name = row.name.padEnd(32).slice(0, 32);
    console.log(
      `${String(row.rank).padStart(6)}  ${name}  ${String(row.points).padStart(6)}  ${String(row.wins).padStart(9)}  ${String(row.wins + row.losses).padStart(8)}`,
    );
  }
}

void main();
