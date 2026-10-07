/**
 * Superficie pública del motor de alertas.
 *
 * El informe (CSV + panel) y el panel de administración consumen **solo** de
 * aquí; el resto de módulos son piezas internas con una razón para estar
 * separados (`rules.ts` puro y versionable, `compute.ts` puro y comprobable con
 * datos sintéticos, `settings.ts` con las claves de `Setting`, `report.ts` con
 * el CSV, `derive-cutoffs.ts` con lo que sale a la red).
 *
 * Las etiquetas de regla y de tipo (`ALERT_RULE_LABELS`, `ALERT_KIND_LABELS`)
 * también salen de aquí, para que el panel y el informe no puedan divergir en cómo
 * llaman a la misma regla.
 */

export {
  computePlayerAlerts,
  type AlertMatch,
  type AlertPlayer,
  type ComputeAlertsInput,
  type OpenStreak,
  type PlayerAlertsEvaluation,
} from "./compute";

export {
  evaluateAlerts,
  reevaluatePlayerAlerts,
  type EvaluateAlertsOptions,
  type EvaluateAlertsResult,
} from "./evaluate";

export { buildAlertsReport, type AlertsReport } from "./report";

export {
  mergeAlertsRuleset,
  alertDedupeKey,
  alertDetails,
  alertSummary,
  buildTriggeredAlert,
  ALERTS_RULESET_KEY,
  ALERTS_RULESET_VERSION,
  ALERTS_RULE_LABEL,
  ALERT_KIND_LABELS,
  ALERT_RULE_LABELS,
  DEFAULT_ALERTS_RULESET,
  SELF_SUBJECT,
  type AlertAnchorDetail,
  type AlertKindName,
  type AlertsRuleName,
  type AlertsRuleset,
  type AlertsRulesetMergeResult,
  type AlertsThresholds,
  type StateAlertRule,
  type StreakAlertRule,
  type TotalAlertRule,
  type TriggeredAlert,
} from "./rules";

export {
  readCutoffsTable,
  subdivisionForRating,
  type LadderCutoff,
  type LadderCutoffs,
  type LadderCutoffsTable,
  type MatchedSubdivision,
  type StoredDivisionCutoffs,
} from "./division-cutoffs";

export {
  ensureAlertsRuleset,
  readAlertsRuleset,
  readDivisionCutoffs,
  readTournamentCloseMark,
  writeDivisionCutoffs,
  writeTournamentCloseMark,
  ALERTS_DIVISION_CUTOFFS_KEY,
  ALERTS_TOURNAMENT_CLOSE_KEY,
  type TournamentCloseMark,
} from "./settings";

export { deriveLadderCutoffs, refreshDivisionCutoffs } from "./derive-cutoffs";
