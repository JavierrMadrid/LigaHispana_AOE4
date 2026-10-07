import "./load-env.mjs";

import { evaluateAlerts } from "@/lib/alerts/evaluate";
import { readAlertsRuleset, readDivisionCutoffs, readTournamentCloseMark } from "@/lib/alerts/settings";
import { ALERTS_RULE_LABEL } from "@/lib/alerts/rules";
import { readRuleset } from "@/lib/scoring";

/**
 * Comprobación completa de las alertas de comportamiento, a mano.
 *
 *   npm run alerts:check                 # evaluación completa de todos los aprobados
 *   npm run alerts:check -- 6000037      # solo esos profileId
 *
 * Es **idempotente**: repetirlo no crea nada nuevo salvo que hayan entrado
 * partidas o hayan cambiado los umbrales, y por eso también sirve para comprobar
 * que el motor no se está duplicando a sí mismo (si `alertsCreated` no fuera 0 en
 * la segunda vez con los mismos datos, el dedupe estaría roto).
 *
 * Imprime las rachas abiertas, que **no** son alertas: son tramos que todavía no
 * han terminado y que solo avisan cuando se rompen. Están para poder ver hacia
 * dónde va cada jugador.
 */

function pad(value: string, width: number): string {
  return value.padEnd(width).slice(0, width);
}

async function main(): Promise<void> {
  const profileIds = process.argv
    .slice(2)
    .filter((argument) => !argument.startsWith("--"))
    .map((argument) => Number(argument))
    .filter((profileId) => Number.isInteger(profileId) && profileId > 0);

  const alertasRuleset = await readAlertsRuleset();
  const scoring = await readRuleset();
  const cutoffs = await readDivisionCutoffs();
  const closeMark = await readTournamentCloseMark();

  const result = await evaluateAlerts(
    profileIds.length === 0 ? { full: true } : { profileIds },
  );

  console.log("");
  console.log("--- Alertas de comportamiento ---");
  console.log(`Reglas: versión ${result.alertsRulesetVersion} (${ALERTS_RULE_LABEL})`);
  console.log(`Umbrales: ${JSON.stringify(alertasRuleset.thresholds)}`);
  console.log(
    `Clasificatorias: modos ${scoring.modes.join(", ")} de [${scoring.window.from}, ` +
      `${scoring.window.to ?? "sin fin"})`,
  );
  console.log(
    `Cortes de división: ${
      result.cutoffsLadders.length === 0 ? "ninguno" : result.cutoffsLadders.join(", ")
    }`,
  );
  console.log(`Cierre de torneo: ${result.tournamentClose ? "evaluado en esta pasada" : "pendiente"}`);
  if (closeMark !== null) {
    console.log(
      `Último cierre: ${closeMark.evaluatedAt} (ventana ${closeMark.windowFrom} → ` +
        `${closeMark.windowTo ?? "sin fin"}), ${closeMark.alertsCreated} alertas nuevas`,
    );
  }
  console.log("");
  console.log(`Alcance: ${result.scope} (${result.playersEvaluated} jugadores)`);
  console.log(`Clasificatorias leídas: ${result.matchesRead}`);
  console.log(`Alertas disparadas: ${result.alertsTriggered}`);
  console.log(`Alertas nuevas: ${result.alertsCreated}`);
  console.log(`Rachas cerradas por fin de torneo: ${result.closedAtTournamentEnd}`);
  console.log(`Clasificatorias con rawJson ilegible: ${result.unreadableMatches}`);
  console.log(`Duración: ${result.durationMs} ms`);

  if (result.lowDivisionWarning !== null) {
    console.log("");
    console.warn(result.lowDivisionWarning);
  }

  if (result.openStreaks.length > 0) {
    console.log("");
    console.log("Rachas abiertas (todavía no avisan de nada):");
    console.log("  Regla                          Sujeto                        Partidas  Última partida");

    for (const streak of result.openStreaks) {
      const sujeto =
        streak.subject.name ?? (streak.subject.profileId === null ? "el jugador" : `#${streak.subject.profileId}`);

      console.log(
        `  ${pad(streak.rule, 30)} ${pad(sujeto, 30)} ${String(streak.count).padStart(8)}  ${streak.lastGameId}`,
      );
    }
  }

  if (cutoffs === null) {
    console.log("");
    console.log("Sin cortes cacheados, R5 no se ha evaluado. Se derivan con:");
    console.log("  npm run alerts:cutoffs");
  }

  console.log("");
}

void main();
