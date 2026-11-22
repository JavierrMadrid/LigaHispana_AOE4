import { describe, expect, it } from "vitest";

import { CIVILIZATION_IDS } from "@/lib/civs";
import { DEFAULT_MAP_POOL } from "@/lib/map-pool";
import { OBJECTIVE_DEFINITIONS } from "@/lib/objectives";
import {
  createObjectivesPreview,
  OBJECTIVES_PREVIEW_PLAYER_COUNT,
  parseObjectivesPreview,
} from "@/lib/objectives-preview";

const NOW = new Date("2026-11-19T18:00:00.000Z");

describe("previsualización de objetivos sin base de datos", () => {
  it("solo reconoce modos explícitos y rechaza parámetros repetidos o desconocidos", () => {
    for (const mode of ["live", "empty", "zero", "missing", "unavailable", "loading"] as const) {
      expect(parseObjectivesPreview(mode)).toBe(mode);
    }
    for (const value of [undefined, "", "LIVE", "live ", "real", ["live"], ["live", "empty"]]) {
      expect(parseObjectivesPreview(value)).toBeNull();
    }
  });

  it("produce datos deterministas, serializables y coherentes con el catálogo vigente", () => {
    const preview = createObjectivesPreview(NOW);
    expect(createObjectivesPreview(NOW)).toEqual(preview);
    expect(JSON.parse(JSON.stringify(preview))).toEqual(preview);
    expect(preview.standings).toHaveLength(OBJECTIVES_PREVIEW_PLAYER_COUNT);
    expect(new Set(preview.standings!.map((player) => player.profileId)).size).toBe(OBJECTIVES_PREVIEW_PLAYER_COUNT);
    expect(preview.objectives.mapPool).toEqual(DEFAULT_MAP_POOL);
    expect(preview.objectives.options.map((option) => option.id)).toEqual(OBJECTIVE_DEFINITIONS.map((definition) => definition.id));
    const definitions = new Map(OBJECTIVE_DEFINITIONS.map((definition) => [definition.id, definition]));
    const profiles = new Set(preview.standings!.map((player) => player.profileId));
    for (const option of preview.objectives.options) {
      const definition = definitions.get(option.id)!;
      expect(option).toMatchObject({
        label: definition.label, description: definition.description, group: definition.group,
        kind: definition.kind, metric: definition.metric, parent: definition.parent,
      });
      if (option.parent !== null) expect(definitions.has(option.parent)).toBe(true);
      for (const contender of option.ranking) {
        expect(profiles.has(contender.profileId)).toBe(true);
        expect(contender.value).toBeGreaterThanOrEqual(0);
        expect(contender.matches).toBeGreaterThan(0);
      }
      if (option.kind === "competition") {
        expect(option.beneficiaries).toEqual([]);
        if (option.holder !== null) {
          expect(option.holder.eligible).toBe(true);
          expect(option.ranking).toContainEqual(option.holder);
        }
      } else {
        expect(option.holder).toBeNull();
        for (const beneficiary of option.beneficiaries) {
          expect(profiles.has(beneficiary.profileId)).toBe(true);
          expect(option.ranking.some((contender) => contender.profileId === beneficiary.profileId && contender.eligible)).toBe(true);
          expect(beneficiary.points).toBeGreaterThanOrEqual(0);
          expect(beneficiary.count).toBeGreaterThan(0);
        }
      }
    }
  });

  it("incluye líderes empatados, progreso parcial, nuevas familias y cobros repetibles", () => {
    const { objectives } = createObjectivesPreview(NOW);
    const option = (id: string) => objectives.options.find((candidate) => candidate.id === id)!;
    const activity = option("loco-por-ganar");
    expect(activity.ranking[0].value).toBe(CIVILIZATION_IDS.length * 6);
    expect(activity.ranking[1].value).toBe(activity.ranking[0].value);
    expect(activity.holder?.profileId).toBe(activity.ranking[0].profileId);
    expect(activity.ranking[0].profileId).not.toBe(activity.ranking[1].profileId);
    for (const id of ["avance-relampago", "tira-y-afloja", "maestro", "polifacetico", "jugon"]) {
      expect(option(id).beneficiaries.length).toBeGreaterThan(0);
      expect(objectives.options.some((candidate) => candidate.parent === id)).toBe(true);
    }
    for (const id of ["avance-relampago-feudal", "avance-relampago-castillos", "avance-relampago-imperial", "defensor-del-pueblo", "ansioso"]) {
      expect(option(id).beneficiaries.length).toBeGreaterThan(0);
    }
    expect(option("imparable").ranking.some((contender) => contender.value < option("imparable").target!.value)).toBe(true);
    for (const beneficiary of option("victorias").beneficiaries) {
      expect(beneficiary.points).toBe(beneficiary.count * objectives.pointsPerWin);
    }
    expect(objectives.options.filter((candidate) => candidate.id.startsWith("maestro-")).some((candidate) =>
      candidate.beneficiaries.some((beneficiary) => beneficiary.count > 1 && beneficiary.points < candidate.points),
    )).toBe(true);
    expect(option("por-tierra-y-agua").ranking.some((contender) => contender.mapGaps?.length)).toBe(true);
    expect(option("por-tierra-y-agua").ranking.some((contender) => contender.mapGaps?.length === 0)).toBe(true);
  });

  it("conserva ausencias, derrotas a cero y el efecto de la condición de equipos", () => {
    const { objectives, standings } = createObjectivesPreview(NOW);
    expect(standings!.some((player) => player.name.length > 45)).toBe(true);
    expect(standings!.some((player) => player.avatarUrl === null)).toBe(true);
    expect(objectives.options.some((option) => option.ranking.some((contender) => contender.value === 0 && !contender.eligible))).toBe(true);
    const activity = objectives.options.find((option) => option.id === "loco-por-ganar")!;
    const longName = standings!.find((player) => player.name.startsWith("Doña Leonor"))!;
    // Su histórico contiene 80 partidas, tres excluidas por compañeros a dos escalones.
    expect(activity.ranking.find((contender) => contender.profileId === longName.profileId)?.value).toBe(77);
    const noSummary = standings!.find((player) => player.name === "Baluarte")!;
    for (const id of ["ansioso", "avance-relampago-feudal", "avance-relampago-castillos", "avance-relampago-imperial", "defensor-del-pueblo"]) {
      expect(objectives.options.find((option) => option.id === id)!.ranking.some((contender) => contender.profileId === noSummary.profileId)).toBe(false);
    }
    const noGames = standings!.find((player) => player.name === "Niebla")!;
    expect(objectives.options.every((option) => !option.ranking.some((contender) => contender.profileId === noGames.profileId))).toBe(true);
  });

  it("distingue catálogo vacío, progreso sin iniciar y clasificación no disponible", () => {
    const empty = createObjectivesPreview(NOW, "empty");
    expect(empty.objectives.options).toEqual([]);
    expect(empty.standings).toEqual([]);
    const zero = createObjectivesPreview(NOW, "zero");
    expect(zero.objectives.options).toHaveLength(OBJECTIVE_DEFINITIONS.length);
    expect(zero.standings).toHaveLength(OBJECTIVES_PREVIEW_PLAYER_COUNT);
    expect(zero.objectives.options.every((option) => option.holder === null && option.ranking.length === 0 && option.beneficiaries.length === 0)).toBe(true);
    const missing = createObjectivesPreview(NOW, "missing");
    expect(missing.standings).toBeNull();
    expect(missing.objectives).toEqual(createObjectivesPreview(NOW).objectives);
  });

  it("no comparte objetos mutables y deriva la ventana del instante recibido", () => {
    const first = createObjectivesPreview(NOW);
    const second = createObjectivesPreview(NOW);
    first.objectives.mapPool.pop();
    first.objectives.options[0].ranking[0].name = "Nombre cambiado";
    expect(second).toEqual(createObjectivesPreview(NOW));
    const later = createObjectivesPreview(new Date(NOW.getTime() + 86_400_000));
    expect(new Date(later.objectives.window.from).getTime() - new Date(second.objectives.window.from).getTime()).toBe(86_400_000);
    expect(NOW.toISOString()).toBe("2026-11-19T18:00:00.000Z");
    expect(() => createObjectivesPreview(new Date(Number.NaN))).toThrow(RangeError);
  });
});
