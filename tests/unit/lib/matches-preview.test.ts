import { describe, expect, it } from "vitest";

import { isKnownCivilization } from "@/lib/civs";
import { DIVISIONS } from "@/lib/divisions";
import { mapImage } from "@/lib/maps";
import {
  createMatchesPreview,
  MATCHES_PREVIEW_COUNT,
  MATCHES_STRESS_COUNT,
  parseMatchesPreview,
} from "@/lib/matches-preview";

const NOW = new Date("2026-11-08T18:30:00.000Z");

describe("previsualización de partidas sin base de datos", () => {
  it("solo reconoce modos explícitos y rechaza parámetros repetidos o desconocidos", () => {
    for (const mode of ["live", "empty", "unavailable", "loading", "stress"] as const) {
      expect(parseMatchesPreview(mode)).toBe(mode);
    }
    for (const value of [undefined, "", "LIVE", "live ", "real", ["live"], ["live", "empty"]]) {
      expect(parseMatchesPreview(value)).toBeNull();
    }
  });

  it("crea 8 o 32 partidas deterministas con identidades únicas y fechas relativas al instante recibido", () => {
    for (const mode of ["live", "stress"] as const) {
      const matches = createMatchesPreview(NOW, mode);
      expect(matches).toHaveLength(mode === "live" ? MATCHES_PREVIEW_COUNT : MATCHES_STRESS_COUNT);
      expect(matches.length).toBe(mode === "live" ? 8 : 32);
      expect(createMatchesPreview(NOW, mode)).toEqual(matches);
      expect(new Set(matches.map((match) => match.gameId)).size).toBe(matches.length);
      const profileIds = matches.flatMap((match) => match.participants)
        .flatMap((participant) => participant.profileId === null ? [] : [participant.profileId]);
      expect(new Set(profileIds).size).toBe(profileIds.length);
      for (const [index, match] of matches.entries()) {
        expect(match.startedAt.getTime()).toBe(NOW.getTime() - match.elapsedSeconds * 1000);
        expect(match.elapsedSeconds).toBeGreaterThanOrEqual(0);
        expect(match.elapsedSeconds).toBeLessThan(3600);
        expect(match.durationSeconds).toBeNull();
        if (index > 0) expect(match.startedAt.getTime()).toBeLessThanOrEqual(matches[index - 1].startedAt.getTime());
      }
      const later = createMatchesPreview(new Date(NOW.getTime() + 60_000), mode);
      expect(later.map((match) => match.startedAt.getTime() - 60_000))
        .toEqual(matches.map((match) => match.startedAt.getTime()));
    }
    expect(NOW.toISOString()).toBe("2026-11-08T18:30:00.000Z");
    expect(() => createMatchesPreview(new Date(Number.NaN))).toThrow(RangeError);
  });

  it("conserva la coherencia entre alineaciones, división, perfiles y canales", () => {
    for (const match of createMatchesPreview(NOW, "stress")) {
      expect(match.leaguePlayerCount).toBe(match.participants.filter((participant) => participant.isLeaguePlayer).length);
      expect(match.leaguePlayerCount).toBeGreaterThan(0);
      for (const participant of match.participants) {
        if (participant.profileId === null) expect(participant.profileUrl).toBeNull();
        else expect(participant.profileUrl).toBe(`https://aoe4world.com/players/${participant.profileId}`);
        if (participant.civ !== null) expect(isKnownCivilization(participant.civ)).toBe(true);
        if (!participant.isLeaguePlayer) {
          expect(participant.division).toBeNull();
          expect(participant.twitchChannel).toBeNull();
          expect(participant.youtubeChannel).toBeNull();
          expect(participant.kickChannel).toBeNull();
        }
        if (participant.twitchIsLive) expect(participant.twitchChannel).not.toBeNull();
        if (participant.youtubeIsLive) expect(participant.youtubeChannel).not.toBeNull();
        if (participant.kickIsLive) expect(participant.kickChannel).not.toBeNull();
      }
      if (["1vs1", "2v2", "3v3", "4v4"].includes(match.format)) {
        const teamOne = match.participants.filter((participant) => participant.team === 1);
        const teamTwo = match.participants.filter((participant) => participant.team === 2);
        expect(teamOne.length).toBe(teamTwo.length);
        expect(teamOne.length + teamTwo.length).toBe(match.participants.length);
      }
    }
  });

  it("cubre formatos y casos visuales sin inventar bandos para una alineación incompleta", () => {
    const matches = createMatchesPreview(NOW);
    const participants = matches.flatMap((match) => match.participants);
    expect(new Set(matches.map((match) => match.format)))
      .toEqual(new Set(["1vs1", "2v2", "3v3", "4v4", "FFA", "Por equipos"]));
    for (const division of DIVISIONS) expect(participants.some((participant) => participant.division === division.id)).toBe(true);
    expect(participants.some((participant) => participant.name.length > 55)).toBe(true);
    expect(participants.some((participant) => participant.name === "" && participant.profileId === null)).toBe(true);
    expect(participants.some((participant) => participant.isLeaguePlayer && participant.division === null)).toBe(true);
    expect(participants.some((participant) => participant.civ === null)).toBe(true);
    expect(participants.some((participant) => participant.country === null)).toBe(true);
    expect(participants.some((participant) => participant.twitchIsLive)).toBe(true);
    expect(participants.some((participant) => participant.youtubeIsLive)).toBe(true);
    expect(participants.some((participant) => participant.kickIsLive)).toBe(true);
    expect(participants.some((participant) => participant.twitchChannel !== null && !participant.twitchIsLive)).toBe(true);
    expect(matches.some((match) => match.map !== null && mapImage(match.map) === null)).toBe(true);
    expect(matches.some((match) => match.map !== null && mapImage(match.map) !== null)).toBe(true);
    const unknownRoster = matches.find((match) => match.map === null)!;
    expect(unknownRoster.participants.every((participant) => participant.team === null)).toBe(true);
    expect(unknownRoster.format).toBe("Por equipos");
    const ffa = matches.find((match) => match.format === "FFA")!;
    expect(ffa.participants).toHaveLength(8);
    expect(new Set(ffa.participants.map((participant) => participant.team)).size).toBe(8);
  });

  it("devuelve datos independientes por petición, sin compartir objetos mutables", () => {
    const first = createMatchesPreview(NOW);
    const second = createMatchesPreview(NOW);
    first[0].participants[0].name = "Nombre modificado";
    first[0].startedAt.setTime(0);
    expect(second).toEqual(createMatchesPreview(NOW));
  });
});
