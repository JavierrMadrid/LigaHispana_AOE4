import "server-only";

import { DEFAULT_COUNTRIES } from "@/lib/countries";
import { DIVISIONS } from "@/lib/divisions";
import { aoe4WorldProfileUrl } from "@/lib/format";
import { OBJECTIVE_DEFINITIONS } from "@/lib/objectives";
import type { StandingObjective, StandingRow } from "@/lib/public";

export const HOME_STRESS_PLAYER_COUNT = 1500;

const NAMES = [
  "Centinela", "Tizona", "Cóndor Andino", "Alfil", "Guardián del Sur", "Jaguar",
  "La Adelantada", "Baluarte", "Puma", "Caballero de Alba", "Halcón", "La Regente",
  "Niebla", "Lancero", "Lobo Ibérico", "Atalaya", "Carabela", "Cacique",
  "Explorador", "Furia del Caribe", "Águila", "La Mariscala", "Bastión", "Valquiria",
];
const ELO_BASE = [420, 600, 800, 1000, 1200, 1400];
const OBJECTIVES: ReadonlyMap<string, StandingObjective> = new Map(
  OBJECTIVE_DEFINITIONS.map(({ id, label, group, metric, points }) => [
    id,
    Object.freeze({ id, label, group, metric, points }),
  ]),
);
const CIVILIZATION_OBJECTIVES = OBJECTIVE_DEFINITIONS.filter(({ id }) => id.startsWith("lider-"));
const COMPETITIONS = OBJECTIVE_DEFINITIONS.filter(({ kind }) => kind === "competition");

function sampleObjectives(index: number, wins: number, losses: number): StandingObjective[] {
  const ids = new Set<string>();
  if (wins + losses >= 14) ids.add("imparable");
  if (wins >= 6 && index % 3 === 0) ids.add("agresor");
  if (wins >= 6 && index % 4 === 0) ids.add("estratega");
  if (wins >= 12 && index % 5 === 0) ids.add("imbatible");
  if (index < COMPETITIONS.length && wins > 0) ids.add(COMPETITIONS[index].id);
  const count = Math.min(Math.floor(wins / 3), index % 7);
  for (let offset = 0; offset < count; offset += 1) {
    const definition = CIVILIZATION_OBJECTIVES[(index + offset * 5) % CIVILIZATION_OBJECTIVES.length];
    ids.add(definition.id);
    if (offset % 2 === 0) ids.add(definition.id.replace("lider-", "acolito-"));
  }
  return [...OBJECTIVES.values()].filter(({ id }) => ids.has(id));
}

// Solo la vista de desarrollo invoca esta fábrica: no escribe ni recalcula puntuaciones.
export function createHomeStressRows(): StandingRow[] {
  const rows = Array.from({ length: HOME_STRESS_PLAYER_COUNT }, (_, index): StandingRow => {
    const profileId = 90_100_000 + index;
    const suffix = String(index + 1).padStart(4, "0");
    const noMatches = index % 37 === 0;
    const wins = noMatches || index % 29 === 0 ? 0 : (index * 17 + 13) % 121;
    const losses = noMatches ? 0 : (index * 7 + 11) % 76;
    const objectives = sampleObjectives(index, wins, losses);
    const pointsByObjectives = objectives.reduce((sum, objective) => sum + objective.points, 0);
    const pointsByWins = wins * 2;
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
    const channel = `liga_demo_${suffix}`;

    return {
      rank: 0,
      profileId,
      name: index % 53 === 1
        ? `Capitán Rodrigo de la Guardia de los Andes y del Caribe ${suffix}`
        : `${NAMES[index % NAMES.length]} ${suffix}`,
      aoe4WorldName: index % 3 === 0 ? `[LH] ${NAMES[(index + 7) % NAMES.length]}_${suffix}` : null,
      country: index % 41 === 0 ? null : DEFAULT_COUNTRIES[index % DEFAULT_COUNTRIES.length],
      points: pointsByWins + pointsByObjectives,
      pointsByWins,
      pointsByObjectives,
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

  rows.sort((a, b) => b.points - a.points || b.wins - a.wins || a.profileId - b.profileId);
  return rows.map((row, index) => ({ ...row, rank: index + 1 }));
}
