import { describe, expect, it } from "vitest";

import { DEFAULT_COUNTRIES } from "@/lib/countries";
import { DIVISIONS, divisionFromRankLevel } from "@/lib/divisions";
import { createHomeStressRows, HOME_STRESS_PLAYER_COUNT } from "@/lib/home-preview";
import { IMPARABLE_ID, OBJECTIVE_DEFINITIONS, VICTORIAS_ID } from "@/lib/objectives";
import { DEFAULT_RULESET } from "@/lib/scoring";

describe("clasificación de desarrollo para carga completa", () => {
  it("produce 1500 identidades únicas y el mismo orden en cada llamada", () => {
    const rows = createHomeStressRows();
    expect(rows).toHaveLength(1500);
    expect(rows).toHaveLength(HOME_STRESS_PLAYER_COUNT);
    expect(new Set(rows.map((row) => row.profileId)).size).toBe(rows.length);
    expect(rows[0].rank).toBe(1);
    expect(rows.every((row, index) => row.rank <= index + 1)).toBe(true);
    expect(createHomeStressRows()).toEqual(rows);
  });

  it("mantiene coherentes puntos, resultados, rachas, divisiones y canales en directo", () => {
    const rows = createHomeStressRows();
    const objectives = new Map(OBJECTIVE_DEFINITIONS.map((definition) => [definition.id, definition]));
    for (const [index, row] of rows.entries()) {
      expect(row.points).toBe(row.objectives.reduce((total, objective) => total + objective.points, 0));
      expect(row.points).toBe(row.pointsByAchievements + row.pointsByCompetitions);
      expect(row.pointsByCompetitions).toBe(row.objectives.reduce((total, objective) => (
        objective.kind === "competition" ? total + objective.points : total
      ), 0));
      expect(row.pointsByAchievements).toBe(row.points - row.pointsByCompetitions);
      const victories = row.objectives.find(({ id }) => id === VICTORIAS_ID);
      expect(victories?.points ?? 0).toBe(row.wins * DEFAULT_RULESET.pointsPerWin);
      expect(victories?.count ?? 0).toBe(row.wins);
      expect(row.wins).toBeGreaterThanOrEqual(0);
      expect(row.losses).toBeGreaterThanOrEqual(0);
      if (row.streak === null) expect(row.wins + row.losses).toBe(0);
      else if (row.streak > 0) expect(row.streak).toBeLessThanOrEqual(row.wins);
      else expect(-row.streak).toBeLessThanOrEqual(row.losses);
      expect(row.division).toBe(divisionFromRankLevel(row.rankLevel));
      expect(row.elo === null).toBe(row.division === null);
      if (row.twitchIsLive) expect(row.twitchChannel).not.toBeNull();
      if (row.youtubeIsLive) expect(row.youtubeChannel).not.toBeNull();
      if (row.kickIsLive) expect(row.kickChannel).not.toBeNull();
      for (const objective of row.objectives) {
        const definition = objectives.get(objective.id)!;
        expect(definition.label).toBe(objective.label);
        expect(definition.kind).toBe(objective.kind);
        expect(definition.metric).toBe(objective.metric);
        expect(definition.description).toBe(objective.description);
        expect(objective.count).toBeGreaterThan(0);
        if (objective.id === VICTORIAS_ID) continue;
        if (objective.id === IMPARABLE_ID) expect(objective.points).toBe(objective.count);
        else if (definition.pointsPerUnit !== undefined) {
          expect(objective.points).toBe(objective.count * definition.pointsPerUnit);
        } else {
          expect(objective.count).toBe(1);
          expect(objective.points).toBe(DEFAULT_RULESET.objectives[objective.id] ?? definition.points);
        }
      }
      if (index > 0) expect(rows[index - 1].points).toBeGreaterThanOrEqual(row.points);
    }
  });

  it("respeta precios activos, puntos por victoria y objetivos desactivados", () => {
    const ruleset = { ...DEFAULT_RULESET, pointsPerWin: 7,
      objectives: { ...DEFAULT_RULESET.objectives, "bienhadado": 51, [VICTORIAS_ID]: 999 },
      disabledObjectives: [IMPARABLE_ID, "agresor"],
    };
    const rows = createHomeStressRows(ruleset);
    expect(rows.every((row) => !row.objectives.some(({ id }) => ruleset.disabledObjectives.includes(id)))).toBe(true);
    expect(rows.some((row) => row.objectives.some(({ id, points }) => id === "bienhadado" && points === 51))).toBe(true);
    for (const row of rows) {
      expect(row.objectives.find(({ id }) => id === VICTORIAS_ID)?.points ?? 0).toBe(row.wins * 7);
      expect(row.points).toBe(row.pointsByAchievements + row.pointsByCompetitions);
    }
  });

  it("incluye repeticiones parciales en lugar de cobrar los máximos del catálogo", () => {
    const objectives = createHomeStressRows().flatMap((row) => row.objectives);
    expect(objectives.some(({ id, points, count }) => id === IMPARABLE_ID && count === points && points < DEFAULT_RULESET.objectives[IMPARABLE_ID])).toBe(true);
    expect(objectives.some(({ id, count }) => id.startsWith("maestro-") && count > 1)).toBe(true);
    expect(objectives.some(({ metric }) => metric === "racha-partidas")).toBe(true);
  });

  it("incluye todos los países y divisiones y los casos límite de lectura", () => {
    const rows = createHomeStressRows();
    const countries = new Set(rows.map((row) => row.country));
    const divisions = new Set(rows.map((row) => row.division));
    for (const country of DEFAULT_COUNTRIES) expect(countries.has(country)).toBe(true);
    for (const division of DIVISIONS) expect(divisions.has(division.id)).toBe(true);
    expect(rows.some((row) => row.points === 0)).toBe(true);
    expect(rows.some((row) => row.elo === null)).toBe(true);
    expect(rows.some((row) => row.name.length > 55)).toBe(true);
    expect(rows.some((row) => row.streak !== null && row.streak < 0)).toBe(true);
    expect(rows.some((row) => row.objectives.length >= 10)).toBe(true);
    expect(rows.some((row) => row.isPlaying && row.twitchIsLive)).toBe(true);
  });

  it("presenta actividad variada y las tres plataformas en las primeras filas de la demo", () => {
    const firstRows = createHomeStressRows().slice(0, 8);
    const isLive = (row: (typeof firstRows)[number]) => row.twitchIsLive || row.youtubeIsLive || row.kickIsLive;

    expect(firstRows[0].isPlaying).toBe(true);
    expect(firstRows.some((row) => row.isPlaying && row.twitchIsLive && row.twitchChannel)).toBe(true);
    expect(firstRows.some((row) => row.isPlaying && row.youtubeIsLive && row.youtubeChannel)).toBe(true);
    expect(firstRows.some((row) => row.isPlaying && row.kickIsLive && row.kickChannel)).toBe(true);
    expect(firstRows.some((row) => row.isPlaying && !isLive(row))).toBe(true);
    expect(firstRows.some((row) => !row.isPlaying && isLive(row))).toBe(true);
    expect(firstRows.some((row) => !row.isPlaying && !isLive(row))).toBe(true);
    expect(firstRows.some((row) => !row.twitchChannel && !row.youtubeChannel && !row.kickChannel)).toBe(true);
    expect(firstRows.some((row) => !isLive(row) && (row.twitchChannel || row.youtubeChannel || row.kickChannel))).toBe(true);
  });
});
