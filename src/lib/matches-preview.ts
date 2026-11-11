import "server-only";

import { CIVILIZATIONS } from "@/lib/civs";
import type { DivisionId } from "@/lib/divisions";
import { aoe4WorldProfileUrl, describeMode, describeTeamSize } from "@/lib/format";
import type { LiveMatch, LiveMatchParticipant } from "@/lib/public";

export type MatchesPreviewMode = "live" | "empty" | "unavailable" | "loading" | "stress";

export function parseMatchesPreview(value: string | string[] | undefined): MatchesPreviewMode | null {
  switch (value) {
    case "live":
    case "empty":
    case "unavailable":
    case "loading":
    case "stress":
      return value;
    default:
      return null;
  }
}

type StreamSeed = { participant: number; platform: "twitch" | "youtube" | "kick"; live: boolean };
type MatchSeed = {
  map: string | null;
  mode: string | null;
  leaderboard: string;
  teamSizes: readonly number[];
  elapsedSeconds: number;
  leaguePlayers: readonly number[];
  streams?: readonly StreamSeed[];
  longName?: number;
  unranked?: number;
  unknownPlayer?: number;
  missingCiv?: number;
  missingCountry?: number;
  unknownTeams?: boolean;
};

const MATCHES = [
  {
    map: "Dry Arabia", mode: "rm_solo", leaderboard: "rm_solo", teamSizes: [1, 1],
    elapsedSeconds: 38, leaguePlayers: [0, 1],
    streams: [
      { participant: 0, platform: "twitch", live: true },
      { participant: 1, platform: "twitch", live: true },
    ],
  },
  {
    map: "Lipany", mode: "rm_team", leaderboard: "rm_2v2", teamSizes: [2, 2],
    elapsedSeconds: 270, leaguePlayers: [0, 1, 2],
    streams: [
      { participant: 0, platform: "twitch", live: false },
      { participant: 1, platform: "kick", live: true },
      { participant: 2, platform: "youtube", live: true },
    ],
  },
  {
    map: "High View", mode: "rm_solo", leaderboard: "rm_solo", teamSizes: [1, 1],
    elapsedSeconds: 552, leaguePlayers: [0], missingCountry: 1,
  },
  {
    map: "Boulder Bay", mode: "rm_team", leaderboard: "rm_3v3", teamSizes: [3, 3],
    elapsedSeconds: 1020, leaguePlayers: [0, 2, 5], longName: 2,
    streams: [{ participant: 5, platform: "youtube", live: false }],
  },
  {
    map: "Hill and Dale", mode: "rm_team", leaderboard: "rm_4v4", teamSizes: [4, 4],
    elapsedSeconds: 1505, leaguePlayers: [0, 1, 4, 6],
    streams: [
      { participant: 0, platform: "twitch", live: true },
      { participant: 4, platform: "kick", live: true },
      { participant: 6, platform: "youtube", live: false },
    ],
  },
  // La FFA prueba una alineación de más de dos bandos; no amplía el filtro real del ruleset.
  {
    map: "MegaRandom", mode: "qm_ffa", leaderboard: "qm_ffa", teamSizes: [1, 1, 1, 1, 1, 1, 1, 1],
    elapsedSeconds: 1980, leaguePlayers: [0, 3],
    streams: [{ participant: 3, platform: "kick", live: true }],
  },
  {
    map: null, mode: "rm_team", leaderboard: "rm_team", teamSizes: [1, 1],
    elapsedSeconds: 2520, leaguePlayers: [0], unranked: 0, unknownPlayer: 1,
    missingCiv: 0, missingCountry: 0, unknownTeams: true,
  },
  {
    map: "Paso del León", mode: null, leaderboard: "", teamSizes: [1, 1],
    elapsedSeconds: 3240, leaguePlayers: [0], longName: 1,
    streams: [{ participant: 0, platform: "twitch", live: false }],
  },
] as const satisfies readonly MatchSeed[];

export const MATCHES_PREVIEW_COUNT = MATCHES.length;
export const MATCHES_STRESS_COUNT = 32;

const DIVISIONS: readonly DivisionId[] = ["conquistador", "diamante", "platino", "oro", "plata", "bronce"];
const COUNTRIES = ["es", "mx", "ar", "co", "cl", "pe", "uy", "ec"];
const NAMES = ["Tizona", "Cóndor", "La Regente", "Baluarte", "Jaguar", "Atalaya", "Halcón", "Alfil"];
const PROFILE_ID_BASE = 90_200_000;

function createParticipants(seed: MatchSeed, matchIndex: number): LiveMatchParticipant[] {
  let participantIndex = 0;
  return seed.teamSizes.flatMap((size, teamIndex) => Array.from({ length: size }, () => {
    const index = participantIndex++;
    const identity = matchIndex * 8 + index;
    const suffix = String(identity + 1).padStart(3, "0");
    const unknown = index === seed.unknownPlayer;
    const profileId = unknown ? null : PROFILE_ID_BASE + identity;
    const isLeaguePlayer = seed.leaguePlayers.includes(index);
    const stream = seed.streams?.find((entry) => entry.participant === index);
    const channel = `liga_demo_${suffix}`;

    return {
      profileId,
      name: unknown ? "" : index === seed.longName
        ? `Don Rodrigo de la Guardia Real de los Andes y del Caribe ${suffix}`
        : `${NAMES[identity % NAMES.length]} ${suffix}`,
      civ: unknown || index === seed.missingCiv ? null : CIVILIZATIONS[identity % CIVILIZATIONS.length].id,
      country: unknown || index === seed.missingCountry ? null : COUNTRIES[identity % COUNTRIES.length],
      isLeaguePlayer,
      division: !isLeaguePlayer || index === seed.unranked ? null : DIVISIONS[identity % DIVISIONS.length],
      profileUrl: profileId === null ? null : aoe4WorldProfileUrl(profileId),
      avatarUrl: null,
      twitchChannel: stream?.platform === "twitch" ? channel : null,
      twitchIsLive: stream?.platform === "twitch" && stream.live,
      youtubeChannel: stream?.platform === "youtube" ? channel : null,
      youtubeIsLive: stream?.platform === "youtube" && stream.live,
      kickChannel: stream?.platform === "kick" ? channel : null,
      kickIsLive: stream?.platform === "kick" && stream.live,
      team: seed.unknownTeams ? null : teamIndex + 1,
    };
  }));
}

// La página solo la carga dentro de NODE_ENV=development; no hay lecturas ni escrituras externas.
export function createMatchesPreview(now: Date, mode: "live" | "stress" = "live"): LiveMatch[] {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new RangeError("La fecha de la previsualización no es válida.");

  const count = mode === "stress" ? MATCHES_STRESS_COUNT : MATCHES_PREVIEW_COUNT;
  return Array.from({ length: count }, (_, index): LiveMatch => {
    const seed: MatchSeed = MATCHES[index % MATCHES.length];
    const participants = createParticipants(seed, index);
    const elapsedSeconds = seed.elapsedSeconds + Math.floor(index / MATCHES.length) * 19;
    const teamFormat = seed.unknownTeams ? null : describeTeamSize(seed.teamSizes);

    return {
      gameId: `preview-match-${String(index + 1).padStart(3, "0")}`,
      map: seed.map,
      mode: seed.mode,
      leaderboard: seed.leaderboard,
      format: teamFormat ?? describeMode(seed.mode, seed.leaderboard),
      startedAt: new Date(nowMs - elapsedSeconds * 1000),
      durationSeconds: null,
      elapsedSeconds,
      participants,
      leaguePlayerCount: participants.filter((participant) => participant.isLeaguePlayer).length,
    };
  }).sort((left, right) => right.startedAt.getTime() - left.startedAt.getTime());
}
