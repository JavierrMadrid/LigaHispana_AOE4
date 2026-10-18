import { describe, expect, it } from "vitest";

import { MatchResult } from "@/generated/prisma/enums";
import { asJsonValue } from "@/lib/aoe4world/parse";
import type { JsonInput } from "@/lib/aoe4world/types";
import { countTournamentMatches } from "@/lib/aoe4world/sync";
import type { NormalizedMatch } from "@/lib/aoe4world/normalize";
import type { LadderCutoffsTable } from "@/lib/alerts/division-cutoffs";
import { SUBDIVISION_RANK_LEVELS } from "@/lib/divisions";
import type { ScoringWindow, TeamTierContext } from "@/lib/ranked-match";

/**
 * La costura pura del contador `matchesCounted` del sincronizador.
 *
 * `countTournamentMatches()` es la regla única (`countsAsRanked()`) aplicada a
 * una lista de partidas normalizadas, con la ventana del ruleset, el `registeredAt`
 * del jugador y el contexto de equipos (`profileId` y cortes). Aquí se comprueban
 * los bordes que deciden si una partida "cuenta como nueva para el torneo":
 * resuelta, dentro de la ventana y del corte de inscripción, de una familia que
 * puntúa y —en equipos— con los compañeros a un escalón o menos. El paso de "en
 * curso a resuelta" (que decide
 * `persistMatches`/`reconcileUnfinishedMatches` sobre la fila guardada) necesita
 * base de datos y no se prueba aquí.
 */

const VENTANA: ScoringWindow = {
  from: "2026-09-15T00:00:00.000Z",
  to: "2026-10-15T00:00:00.000Z",
};

/** El jugador de las fixtures; es el dueño de las partidas normalizadas. */
const PERFIL = 9_000_001;
const COMPAÑERO = 9_000_002;

/** Sin cortes, la condición de equipos no se puede comprobar y la partida cuenta. */
const SIN_CORTES: TeamTierContext = { profileId: PERFIL, cutoffs: null };

/**
 * Cortes inventados pero **monótonos y de la misma escala** que la ladder real: se
 * construyen hacia abajo desde `conqueror_3` en pasos de 100, así cada escalón vale
 * exactamente 100 de elo y las cuentas salen a mano.
 */
const CORTES: LadderCutoffsTable = {
  rm_team: {
    ladder: "rm_team",
    derivedAt: VENTANA.from,
    totalCount: 50_000,
    cutoffs: SUBDIVISION_RANK_LEVELS.map((rankLevel, index) => ({
      rankLevel,
      minRating: 3000 - index * 100,
    })),
    requests: 1,
  },
};

const CON_CORTES: TeamTierContext = { profileId: PERFIL, cutoffs: CORTES };

/** Payload de una partida de equipo con este jugador y un compañero, con ratings. */
function payloadEquipo(propio: number, companero: number): JsonInput {
  const entrada = (profileId: number, rating: number) => ({
    player: { profile_id: profileId, name: "Jugador", rating },
  });

  return asJsonValue({
    game_id: 9_000_001,
    started_at: "2026-09-20T12:00:00.000Z",
    teams: [[entrada(PERFIL, propio), entrada(COMPAÑERO, companero)]],
  });
}

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
    expect(countTournamentMatches([match()], ruleset, null, SIN_CORTES)).toBe(1);
  });

  it("cuenta también las derrotas: lo que decide es que la partida cuente, no si se ganó", () => {
    expect(
      countTournamentMatches([match({ result: MatchResult.LOSS })], ruleset, null, SIN_CORTES),
    ).toBe(1);
  });

  it("no cuenta una partida empezada antes de la ventana", () => {
    const preVentana = match({ startedAt: new Date("2026-09-14T23:59:59.000Z") });

    expect(countTournamentMatches([preVentana], ruleset, null, SIN_CORTES)).toBe(0);
  });

  it("no cuenta una partida empezada en el límite superior: `to` es exclusivo", () => {
    const enElLimite = match({ startedAt: new Date("2026-10-15T00:00:00.000Z") });

    expect(countTournamentMatches([enElLimite], ruleset, null, SIN_CORTES)).toBe(0);
  });

  it("no cuenta una partida en curso (`finishedAt` nulo)", () => {
    const enCurso = match({ finishedAt: null, result: null });

    expect(countTournamentMatches([enCurso], ruleset, null, SIN_CORTES)).toBe(0);
  });

  it("no cuenta una partida de un modo que no puntúa", () => {
    const custom = match({ mode: "custom", leaderboard: "custom" });

    expect(countTournamentMatches([custom], ruleset, null, SIN_CORTES)).toBe(0);
  });

  it("no cuenta una partida anterior al corte de inscripción del jugador", () => {
    const registeredAt = new Date("2026-09-25T00:00:00.000Z");

    expect(countTournamentMatches([match()], ruleset, registeredAt, SIN_CORTES)).toBe(0);
    expect(
      countTournamentMatches(
        [match({ startedAt: new Date("2026-09-25T00:00:00.000Z") })],
        ruleset,
        registeredAt,
        SIN_CORTES,
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

    expect(countTournamentMatches(matches, ruleset, null, SIN_CORTES)).toBe(2);
  });

  it("con cortes, no cuenta una partida de equipo con un compañero a dos escalones", () => {
    // Con estos cortes (100 de elo por escalón de subdivisión, 3 por división) el
    // oro va del índice 9 al 11, la plata del 12 al 14 y el bronce del 15 al 17:
    // 2100 es oro, 1799 plata (un escalón: cuenta), y 1599 bronce y 2700 diamante
    // están a dos (no cuenta).
    const deEquipo = (propio: number, companero: number) =>
      match({ mode: "rm_team", rawJson: payloadEquipo(propio, companero) });

    expect(
      countTournamentMatches([deEquipo(2100, 1799)], ruleset, null, CON_CORTES),
      "a un escalón cuenta",
    ).toBe(1);
    expect(
      countTournamentMatches([deEquipo(2100, 1799)], ruleset, null, SIN_CORTES),
      "y sin cortes también, porque no se puede comprobar",
    ).toBe(1);
    expect(
      countTournamentMatches([deEquipo(2100, 1599)], ruleset, null, CON_CORTES),
      "a dos escalones por abajo no cuenta",
    ).toBe(0);
    expect(
      countTournamentMatches([deEquipo(2100, 2700)], ruleset, null, CON_CORTES),
      "y a dos por arriba tampoco",
    ).toBe(0);
  });

  it("sin cortes la condición de equipos no se puede comprobar y la partida cuenta", () => {
    const deEquipo = match({ mode: "rm_team", rawJson: payloadEquipo(2100, 1500) });

    expect(countTournamentMatches([deEquipo], ruleset, null, CON_CORTES)).toBe(0);
    expect(countTournamentMatches([deEquipo], ruleset, null, SIN_CORTES)).toBe(1);
  });
});
