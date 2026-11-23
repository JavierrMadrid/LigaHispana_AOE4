import "server-only";

import type { LadderCutoffsTable } from "@/lib/alerts/division-cutoffs";
import { CIVILIZATION_IDS } from "@/lib/civs";
import { SUBDIVISION_RANK_LEVELS } from "@/lib/divisions";
import { aoe4WorldProfileUrl } from "@/lib/format";
import { DEFAULT_MAP_POOL } from "@/lib/map-pool";
import {
  apmRunStreak,
  applyObjectiveMatch,
  computeObjectives,
  currentTournamentStreak,
  emptyObjectiveAggregate,
  FORMAT_IDS,
  OBJECTIVE_IDS,
  type ObjectiveMatchRow,
  type ObjectiveView,
  type PlayerAggregate,
  type PlayerMeta,
} from "@/lib/objectives";
import type { StandingRow } from "@/lib/public";
import { countsAsRanked } from "@/lib/ranked-match";
import { DEFAULT_RULESET, ruleLabel, type ScoringRuleset } from "@/lib/scoring";

export type ObjectivesPreviewMode = "live" | "empty" | "zero" | "missing" | "unavailable" | "loading";
type PopulatedMode = Exclude<ObjectivesPreviewMode, "unavailable" | "loading">;
export type ObjectivesPreviewData = {
  objectives: ObjectiveView;
  standings: Pick<StandingRow, "profileId" | "name" | "avatarUrl" | "profileUrl">[] | null;
};

export function parseObjectivesPreview(value: string | string[] | undefined): ObjectivesPreviewMode | null {
  switch (value) {
    case "live":
    case "empty":
    case "zero":
    case "missing":
    case "unavailable":
    case "loading":
      return value;
    default:
      return null;
  }
}

export const OBJECTIVES_PREVIEW_PLAYER_COUNT = 18;
const PROFILE_ID_BASE = 90_300_000;
const DAY_MS = 86_400_000;
const NAMES = [
  "Tizona", "La Regente", "Cóndor de los Andes", "Baluarte", "La Adelantada", "Jaguar",
  "Alfil", "Atalaya", "Puma", "Centinela", "Halcón", "Carabela", "La Mariscala",
  "Lancero", "Valquiria", "Bastión", "Guardián del Sur", "Niebla",
];

function roster(): PlayerMeta[] {
  return NAMES.map((name, index) => ({
    playerId: `objectives-preview-${index + 1}`,
    profileId: PROFILE_ID_BASE + index,
    name: index === 2 ? "Doña Leonor de la Guardia de los Andes y del Caribe" : name,
    avatarUrl: null,
    rankLevel: index === 17 ? null : SUBDIVISION_RANK_LEVELS[index % SUBDIVISION_RANK_LEVELS.length],
  }));
}

function histories(meta: PlayerMeta, index: number, nowMs: number, ruleset: ScoringRuleset): ObjectiveMatchRow[] {
  const count = index < 2 ? CIVILIZATION_IDS.length * 6 : index === 17 ? 0 : index === 16 ? 4 : (18 - index) * 5;
  // Cortes ficticios y locales: solo sirven para ejercitar la condición de equipos ya existente.
  const cutoffs: LadderCutoffsTable = { rm_team: {
    ladder: "rm_team", derivedAt: new Date(nowMs).toISOString(), totalCount: 18, requests: 0,
    cutoffs: SUBDIVISION_RANK_LEVELS.map((rankLevel, position) => ({ rankLevel, minRating: 1800 - position * 80 })),
  } };
  const rows: ObjectiveMatchRow[] = [];
  for (let game = 0; game < count; game += 1) {
    const format = FORMAT_IDS[game % FORMAT_IDS.length];
    const mode = format === "1v1" ? "rm_solo" : "rm_team";
    const result = index === 16 || game % (index < 2 ? 6 : 5) === (index < 2 ? 5 : 4) ? "LOSS" : "WIN";
    const startedAtMs = nowMs - 21 * DAY_MS + game * 3 * 3_600_000 + index * 600_000;
    const durationSeconds = game % 6 === 0 ? 570 : game % 3 === 0 ? 1500 : 1200;
    const finishedAtMs = startedAtMs + durationSeconds * 1000;
    const rawJson = {
      game_id: PROFILE_ID_BASE + index * 1000 + game + 1,
      started_at: new Date(startedAtMs).toISOString(),
      leaderboard: `rm_${format}`,
      teams: [[
        { player: { profile_id: meta.profileId, name: meta.name, rating: 1200 } },
        ...(mode === "rm_team" ? [{ player: { profile_id: PROFILE_ID_BASE + 1000 + game, name: "Compañero", rating: index >= 2 && game % 19 === 0 ? 1750 : 1280 } }] : []),
      ]],
    };
    if (!countsAsRanked({ mode, result, startedAt: new Date(startedAtMs), finishedAt: new Date(finishedAtMs),
      revertedAt: null, rawJson }, ruleset.window, null, { profileId: meta.profileId, cutoffs })) continue;

    const hasSummary = index !== 3 && game % 11 !== 10;
    const civIndex = index < 2 ? Math.floor(game / 6) : Math.floor(game / 4) + index;
    rows.push({
      ...meta, mode, result, gameId: `${meta.playerId}-${game + 1}`, leaderboard: `rm_${format}`,
      kind: `rm_${format}`, startedAtMs, finishedAtMs, durationSeconds,
      civ: index === 16 ? null : CIVILIZATION_IDS[civIndex % CIVILIZATION_IDS.length],
      civRandomized: false,
      map: index === 16 ? null : DEFAULT_MAP_POOL[game % Math.max(1, DEFAULT_MAP_POOL.length - (index < 2 ? 0 : index % 7))],
      apm: hasSummary ? game % 7 === 6 ? 95 : 180 : null,
      feudalAgeSeconds: hasSummary ? game % 5 === 0 ? 225 : 270 : null,
      castleAgeSeconds: hasSummary && durationSeconds > 600 ? index % 3 !== 2 && game % 4 === 0 ? 515 : 650 : null,
      imperialAgeSeconds: hasSummary && durationSeconds > 1000 ? index % 4 === 0 && game % 7 === 0 ? 940 : 1100 : null,
      villagersLost: hasSummary ? game % 4 === 0 ? 2 : 8 : null,
      gildedVillagersLost: hasSummary ? 0 : null,
      mountedVillagersLost: hasSummary ? 0 : null,
    });
  }
  return rows;
}

function aggregate(meta: PlayerMeta, rows: ObjectiveMatchRow[], ruleset: ScoringRuleset): PlayerAggregate {
  const player = emptyObjectiveAggregate(meta);
  let run = 0;
  for (const row of rows) {
    applyObjectiveMatch(player, row, ruleset);
    run = row.result === "WIN" ? run + 1 : 0;
    if (run > player.streak) {
      player.streak = run;
      player.streakEndsAt = row.finishedAtMs;
    }
  }
  player.currentStreak = currentTournamentStreak(rows);
  const apm = apmRunStreak(rows);
  player.apmStreak = apm.streak;
  player.apmStreakEndsAt = apm.endsAt;
  return player;
}

// La página importa este módulo únicamente en desarrollo; no lee ni escribe datos externos.
export function createObjectivesPreview(now: Date, mode: PopulatedMode = "live"): ObjectivesPreviewData {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new RangeError("La fecha de la previsualización no es válida.");
  const ruleset: ScoringRuleset = {
    ...DEFAULT_RULESET,
    modes: [...DEFAULT_RULESET.modes],
    objectives: { ...DEFAULT_RULESET.objectives },
    disabledObjectives: mode === "empty" ? [...OBJECTIVE_IDS] : [],
    window: { from: new Date(nowMs - 28 * DAY_MS).toISOString(), to: new Date(nowMs + 7 * DAY_MS).toISOString() },
  };
  ruleset.label = ruleLabel(ruleset);
  const players = mode === "empty" ? [] : roster();
  const aggregates = players.map((meta, index) => aggregate(meta, mode === "zero" ? [] : histories(meta, index, nowMs, ruleset), ruleset));
  const mapPool = [...DEFAULT_MAP_POOL];
  const computed = computeObjectives(aggregates, ruleset, mapPool);
  const standings = players.slice().sort((left, right) =>
    (computed.pointsByPlayer.get(right.playerId)?.points ?? 0) - (computed.pointsByPlayer.get(left.playerId)?.points ?? 0) || left.profileId - right.profileId,
  ).map(({ profileId, name, avatarUrl }) => ({ profileId, name, avatarUrl, profileUrl: aoe4WorldProfileUrl(profileId) }));
  return {
    objectives: {
      ruleSetVersion: ruleset.version,
      rule: ruleset.label,
      pointsPerWin: ruleset.pointsPerWin,
      window: { ...ruleset.window },
      mapPool,
      options: computed.options,
    },
    standings: mode === "missing" ? null : standings,
  };
}
