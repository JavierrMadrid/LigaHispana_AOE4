import { describe, expect, it } from "vitest";

import { DEFAULT_COUNTRIES } from "@/lib/countries";
import { DIVISIONS, divisionFromRankLevel } from "@/lib/divisions";
import { createHomeStressRows, HOME_STRESS_PLAYER_COUNT } from "@/lib/home-preview";
import { HOME_OBJECTIVE_DESCRIPTIONS } from "@/lib/home-objective-descriptions";
import { OBJECTIVE_DEFINITIONS } from "@/lib/objectives";

describe("clasificación de desarrollo para carga completa", () => {
  it("produce 1500 identidades únicas y el mismo orden en cada llamada", () => {
    const rows = createHomeStressRows();
    expect(rows).toHaveLength(1500);
    expect(rows).toHaveLength(HOME_STRESS_PLAYER_COUNT);
    expect(new Set(rows.map((row) => row.profileId)).size).toBe(rows.length);
    expect(rows.map((row) => row.rank)).toEqual(Array.from({ length: rows.length }, (_, index) => index + 1));
    expect(createHomeStressRows()).toEqual(rows);
  });

  it("mantiene coherentes puntos, resultados, rachas, divisiones y canales en directo", () => {
    const rows = createHomeStressRows();
    const objectives = new Map(OBJECTIVE_DEFINITIONS.map((definition) => [definition.id, definition]));
    for (const [index, row] of rows.entries()) {
      expect(row.points).toBe(row.pointsByWins + row.pointsByObjectives);
      expect(row.pointsByWins).toBe(row.wins * 2);
      expect(row.pointsByObjectives).toBe(row.objectives.reduce((total, objective) => total + objective.points, 0));
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
        expect(objectives.get(objective.id)?.label).toBe(objective.label);
        expect(objectives.get(objective.id)?.points).toBe(objective.points);
      }
      if (index > 0) expect(rows[index - 1].points).toBeGreaterThanOrEqual(row.points);
    }
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
});

describe("descripciones de objetivos de portada", () => {
  it("usa la frase del catálogo sin mantener reglas paralelas en la interfaz", () => {
    expect(Object.keys(HOME_OBJECTIVE_DESCRIPTIONS)).toHaveLength(OBJECTIVE_DEFINITIONS.length);
    for (const definition of OBJECTIVE_DEFINITIONS) {
      expect(HOME_OBJECTIVE_DESCRIPTIONS[definition.id]).toBe(definition.description);
    }
  });
});
