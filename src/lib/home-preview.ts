import "server-only";

import { DEFAULT_COUNTRIES } from "@/lib/countries";
import { DIVISIONS } from "@/lib/divisions";
import { aoe4WorldProfileUrl } from "@/lib/format";
import { IMPARABLE_ID, OBJECTIVE_DEFINITIONS, VICTORIAS_ID } from "@/lib/objectives";
import { objectiveLookup, splitStandingPoints, type StandingObjective, type StandingRow } from "@/lib/public";
import { DEFAULT_RULESET, rankApprovedPlayers, type ScoringRuleset } from "@/lib/scoring";

export const HOME_STRESS_PLAYER_COUNT = 1500;
const PROFILE_ID_BASE = 90_100_000;

function sampleIdentity(index: number) {
  const suffix = String(index + 1).padStart(4, "0");
  return {
    profileId: PROFILE_ID_BASE + index,
    suffix,
    channel: `liga_demo_${suffix}`,
  };
}

const NAMES = [
  "Centinela", "Tizona", "Cóndor Andino", "Alfil", "Guardián del Sur", "Jaguar",
  "La Adelantada", "Baluarte", "Puma", "Caballero de Alba", "Halcón", "La Regente",
  "Niebla", "Lancero", "Lobo Ibérico", "Atalaya", "Carabela", "Cacique",
  "Explorador", "Furia del Caribe", "Águila", "La Mariscala", "Bastión", "Valquiria",
];
const ELO_BASE = [420, 600, 800, 1000, 1200, 1400];
const DEFINITIONS = new Map(OBJECTIVE_DEFINITIONS.map((definition) => [definition.id, definition]));
const CIVILIZATION_OBJECTIVES = OBJECTIVE_DEFINITIONS.filter(({ id }) => id.startsWith("lider-"));
const COMPETITIONS = OBJECTIVE_DEFINITIONS.filter(({ kind }) => kind === "competition");
// Se aplican después de ordenar para que la primera pantalla sirva también para las demos.
const FIRST_ROWS_ACTIVITY = [
  { platform: "twitch", isLive: true, isPlaying: true },
  { platform: "youtube", isLive: true, isPlaying: true },
  { platform: null, isLive: false, isPlaying: false },
  { platform: "kick", isLive: true, isPlaying: true },
  { platform: "twitch", isLive: false, isPlaying: false },
  { platform: null, isLive: false, isPlaying: true },
  { platform: "youtube", isLive: false, isPlaying: false },
  { platform: "twitch", isLive: true, isPlaying: false },
] as const;

function sampleObjectives(
  index: number, wins: number, losses: number, lookup: ReadonlyMap<string, StandingObjective>,
): StandingObjective[] {
  const ids = new Set<string>();
  if (wins > 0) ids.add(VICTORIAS_ID);
  if (wins + losses > 0) ids.add(IMPARABLE_ID);
  if (wins + losses >= 3 && index % 6 === 0) ids.add("ansioso");
  if (wins >= 6 && index % 3 === 0) ids.add("agresor");
  if (wins >= 6 && index % 4 === 0) ids.add("estratega");
  if (wins >= 12 && index % 5 === 0) ids.add("imbatible");
  if (index < COMPETITIONS.length && wins > 0) ids.add(COMPETITIONS[index].id);
  const count = Math.min(Math.floor(wins / 3), index % 7);
  for (let offset = 0; offset < count; offset += 1) {
    const definition = CIVILIZATION_OBJECTIVES[(index + offset * 5) % CIVILIZATION_OBJECTIVES.length];
    ids.add(definition.id);
    if (offset % 2 === 0) ids.add(definition.id.replace("lider-", "acolito-"));
    if (offset % 3 === 0) ids.add(definition.id.replace("lider-", "maestro-"));
  }
  return [...lookup.values()].filter(({ id }) => ids.has(id)).map((objective) => {
    if (objective.id === VICTORIAS_ID) {
      return { ...objective, count: wins, points: wins * objective.points };
    }
    if (objective.id === IMPARABLE_ID) {
      const days = Math.min(wins + losses, index % objective.points + 1);
      return { ...objective, count: days, points: days };
    }
    const definition = DEFINITIONS.get(objective.id)!;
    if (definition.pointsPerUnit !== undefined) {
      const count = Math.min(wins, index % (definition.target ?? 1) + 1);
      return { ...objective, count, points: count * definition.pointsPerUnit };
    }
    return objective;
  });
}

// Solo la vista de desarrollo invoca esta fábrica: no escribe ni recalcula puntuaciones.
export function createHomeStressRows(ruleset: ScoringRuleset = DEFAULT_RULESET): StandingRow[] {
  const lookup = objectiveLookup(ruleset);
  const rows = Array.from({ length: HOME_STRESS_PLAYER_COUNT }, (_, index): StandingRow => {
    const { profileId, suffix, channel } = sampleIdentity(index);
    const noMatches = index % 37 === 0;
    const wins = noMatches || index % 29 === 0 ? 0 : (index * 17 + 13) % 121;
    const losses = noMatches ? 0 : (index * 7 + 11) % 76;
    const objectives = sampleObjectives(index, wins, losses, lookup);
    const points = objectives.reduce((sum, objective) => sum + objective.points, 0);
    const breakdown = { objectives: {
      points,
      earned: objectives.map(({ id }) => id),
      awards: Object.fromEntries(objectives.map(({ id, points, count }) => [id, { points, count }])),
    } };
    const unranked = index % 7 === 0;
    const divisionIndex = index % DIVISIONS.length;
    const division = DIVISIONS[divisionIndex];
    const tier = Math.floor(index / DIVISIONS.length) % 3 + 1;
    const negativeStreak = losses > 0 && (wins === 0 || index % 4 === 0);
    const streak = wins + losses === 0
      ? null
      : negativeStreak
        ? -Math.min(losses, index % 9 + 1)
        : Math.min(wins, index % 12 + 1);
    return {
      rank: 0,
      profileId,
      name: index % 53 === 1
        ? `Capitán Rodrigo de la Guardia de los Andes y del Caribe ${suffix}`
        : `${NAMES[index % NAMES.length]} ${suffix}`,
      aoe4WorldName: index % 3 === 0 ? `[LH] ${NAMES[(index + 7) % NAMES.length]}_${suffix}` : null,
      country: index % 41 === 0 ? null : DEFAULT_COUNTRIES[index % DEFAULT_COUNTRIES.length],
      points,
      ...splitStandingPoints(points, breakdown, lookup),
      wins,
      losses,
      elo: unranked ? null : ELO_BASE[divisionIndex] + (tier - 1) * 65 + index % 45,
      division: unranked ? null : division.id,
      rankLevel: unranked ? null : `${division.rankLevelPrefix}_${tier}`,
      streak,
      twitchChannel: index % 3 === 0 ? channel : null,
      twitchIsLive: index % 39 === 0,
      youtubeChannel: index % 5 === 0 ? channel : null,
      youtubeIsLive: index % 55 === 0,
      kickChannel: index % 11 === 0 ? channel : null,
      kickIsLive: index % 121 === 0,
      isPlaying: index % 17 === 0,
      avatarUrl: null,
      profileUrl: aoe4WorldProfileUrl(profileId),
      objectives,
    };
  });

  const rankedRows = rankApprovedPlayers(
    rows.map((row) => ({ id: String(row.profileId), profileId: row.profileId })),
    new Map(rows.map((row) => [String(row.profileId), {
      wins: row.wins, matches: row.wins + row.losses, matchPoints: 0, byMode: {},
    }])),
    new Map(rows.map((row) => [String(row.profileId), {
      points: row.points,
      earned: row.objectives.map(({ id }) => id),
      awards: Object.fromEntries(row.objectives.map(({ id, points, count }) => [id, { points, count }])),
    }])),
    ruleset,
  );
  const byProfile = new Map(rows.map((row) => [row.profileId, row]));
  return rankedRows.map((standing, index) => {
    const row = byProfile.get(standing.profileId)!;
    const ranked = { ...row, rank: standing.rank };
    const activity = FIRST_ROWS_ACTIVITY[index];
    if (!activity) return ranked;
    const { channel } = sampleIdentity(row.profileId - PROFILE_ID_BASE);
    return {
      ...ranked,
      isPlaying: activity.isPlaying,
      twitchChannel: activity.platform === "twitch" ? channel : null,
      twitchIsLive: activity.platform === "twitch" && activity.isLive,
      youtubeChannel: activity.platform === "youtube" ? channel : null,
      youtubeIsLive: activity.platform === "youtube" && activity.isLive,
      kickChannel: activity.platform === "kick" ? channel : null,
      kickIsLive: activity.platform === "kick" && activity.isLive,
    };
  });
}
