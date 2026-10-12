import { describe, expect, it } from "vitest";

import { MatchResult } from "@/generated/prisma/enums";
import { countTournamentMatches } from "@/lib/aoe4world/sync";
import type { NormalizedMatch } from "@/lib/aoe4world/normalize";
import type { ScoringWindow } from "@/lib/ranked-match";

/**
 * La costura pura del contador `matchesCounted` del sincronizador.
 *
 * `countTournamentMatches()` es la regla única (`countsAsRanked()`) aplicada a
 * una lista de partidas normalizadas, con la ventana del ruleset y el
 * `registeredAt` del jugador. Aquí se comprueban los bordes que deciden si una
 * partida "cuenta como nueva para el torneo": resuelta, dentro de la ventana y
 * del corte de inscripción, y de una familia que puntúa. El paso de "en curso a
 * resuelta" (que decide `persistMatches`/`reconcileUnfinishedMatches` sobre la
 * fila guardada) necesita base de datos y no se prueba aquí.
 */

const VENTANA: ScoringWindow = {
  from: "2026-09-15T00:00:00.000Z",
  to: "2026-10-15T00:00:00.000Z",
};

function match(overrides: Partial<NormalizedMatch> = {}): NormalizedMatch {
  return {
    gameId: "1",
    leaderboard: "rm_solo",
    mode: "rm_solo",
    opponentProfileId: null,
    opponentName: null,
    civ: null,
    opponentCiv: null,
    civRandomized: false,
    map: null,
    result: MatchResult.WIN,
    startedAt: new Date("2026-09-20T12:00:00.000Z"),
    finishedAt: new Date("2026-09-20T12:30:00.000Z"),
    durationSeconds: 1800,
    rawJson: {},
    ...overrides,
  };
}

/** El ruleset solo aporta la ventana a la costura; el resto no la afecta. */
const ruleset = { window: VENTANA };

describe("countTournamentMatches", () => {
  it("cuenta una partida resuelta dentro de la ventana y de una familia del ruleset", () => {
    expect(countTournamentMatches([match()], ruleset, null)).toBe(1);
  });

  it("cuenta también las derrotas: lo que decide es que la partida cuente, no si se ganó", () => {
    expect(countTournamentMatches([match({ result: MatchResult.LOSS })], ruleset, null)).toBe(1);
  });

  it("no cuenta una partida empezada antes de la ventana", () => {
    const preVentana = match({ startedAt: new Date("2026-09-14T23:59:59.000Z") });

    expect(countTournamentMatches([preVentana], ruleset, null)).toBe(0);
  });

  it("no cuenta una partida empezada en el límite superior: `to` es exclusivo", () => {
    const enElLimite = match({ startedAt: new Date("2026-10-15T00:00:00.000Z") });

    expect(countTournamentMatches([enElLimite], ruleset, null)).toBe(0);
  });

  it("no cuenta una partida en curso (`finishedAt` nulo)", () => {
    const enCurso = match({ finishedAt: null, result: null });

    expect(countTournamentMatches([enCurso], ruleset, null)).toBe(0);
  });

  it("no cuenta una partida de un modo que no puntúa", () => {
    const custom = match({ mode: "custom", leaderboard: "custom" });

    expect(countTournamentMatches([custom], ruleset, null)).toBe(0);
  });

  it("no cuenta una partida anterior al corte de inscripción del jugador", () => {
    const registeredAt = new Date("2026-09-25T00:00:00.000Z");

    expect(countTournamentMatches([match()], ruleset, registeredAt)).toBe(0);
    expect(
      countTournamentMatches(
        [match({ startedAt: new Date("2026-09-25T00:00:00.000Z") })],
        ruleset,
        registeredAt,
      ),
    ).toBe(1);
  });

  it("en una lista mixta suma solo las que cumplen la regla", () => {
    const matches = [
      match({ gameId: "1" }),
      match({ gameId: "2", result: MatchResult.LOSS }),
      match({ gameId: "3", finishedAt: null, result: null }),
      match({ gameId: "4", mode: "ffa_1v1" }),
      match({ gameId: "5", startedAt: new Date("2026-09-01T00:00:00.000Z") }),
    ];

    expect(countTournamentMatches(matches, ruleset, null)).toBe(2);
  });
});
