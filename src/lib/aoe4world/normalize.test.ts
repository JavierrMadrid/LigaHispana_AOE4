import { describe, expect, it } from "vitest";

import { MatchResult } from "@/generated/prisma/enums";
import { parseGame } from "@/lib/aoe4world/parse";
import {
  LIVE_GAME_WINDOW_MS,
  LIVE_GAME_WINDOW_MINUTES,
  isLiveGame,
  normalizeGame,
  readOwnCivRandomized,
  resolveGameMode,
  type NormalizedMatch,
} from "@/lib/aoe4world/normalize";
import type { Aoe4WorldGame } from "@/lib/aoe4world/types";

/**
 * La normalización de la respuesta de la API a la fila de `Match`.
 *
 * Es donde fallan las cosas en silencio: un payload raro no lanza, se convierte en
 * un `status: "skipped"` con su motivo, y una partida en curso se distingue de una
 * abandonada por su `finishedAt` a `null`. Los datos son inventados y el payload
 * entra como lo que entra en producción —un `unknown` leído por `parseGame`— para
 * que la forma sea la que produce el lector y no una escrita a mano.
 */

const PERFIL = 9_000_001;
const RIVAL = 9_000_002;
const COMPAÑERO = 9_000_003;

/**
 * "Ahora" de las comprobaciones. Está media hora después de que empezaran las
 * partidas, que es lo que hace que las de `ongoing: true` caigan dentro de la
 * ventana de 60 min: con un `now` más tarde, ninguna estaría "en directo".
 */
const AHORA = new Date("2026-09-20T20:00:00.000Z");

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    game_id: 7_000_001,
    started_at: "2026-09-20T19:30:00.000Z",
    duration: 1_200,
    map: "High View",
    state: "processed",
    kind: "rm_1v1",
    leaderboard: "rm_solo",
    ongoing: false,
    just_finished: false,
    average_mmr: 1500,
    ...overrides,
  };
}

/** Partida de 1v1 ya resuelta por el parser, con el jugador en el primer equipo. */
function partida(overrides: Record<string, unknown> = {}): Aoe4WorldGame {
  const leida = parseGame(
    payload({
      teams: [
        [{ player: { profile_id: PERFIL, name: "Jugador", result: "win", civilization: "english" } }],
        [{ player: { profile_id: RIVAL, name: "Rival", result: "loss", civilization: "mongols" } }],
      ],
      ...overrides,
    }),
  );

  if (leida === null) {
    throw new Error("el payload de la comprobación tiene que ser legible");
  }

  return leida;
}

/** El `match` de una normalización que tiene que haber salido bien. */
function comoMatch(resultado: ReturnType<typeof normalizeGame>): NormalizedMatch {
  if (resultado.status !== "ok") {
    throw new Error(`se esperaba una partida normalizada y salió descartada: ${resultado.reason}`);
  }

  return resultado.match;
}

describe("resolveGameMode", () => {
  it("colapsa los ranked por tamaño a su familia", () => {
    // `Match.mode` es la columna por la que filtra el motor, y no puede tener una
    // entrada por cada tamaño de partida.
    expect(resolveGameMode("rm_1v1")).toBe("rm_solo");
    expect(resolveGameMode("rm_2v2")).toBe("rm_team");
    expect(resolveGameMode("rm_3v3")).toBe("rm_team");
    expect(resolveGameMode("rm_4v4")).toBe("rm_team");
  });

  it("una ladder que no está en el mapeo pasa tal cual", () => {
    // Que el mapeo sea "cómo se llaman las cosas en la API" y no "qué cuenta en este
    // torneo" es lo que permite añadir un modo al ruleset sin reescribir datos.
    expect(resolveGameMode("rm_solo")).toBe("rm_solo");
    expect(resolveGameMode("qm_ffa")).toBe("qm_ffa");
    expect(resolveGameMode("custom_8v8")).toBe("custom_8v8");
  });

  it("sin referencia no hay familia, y tampoco una cadena vacía", () => {
    expect(resolveGameMode(null)).toBeNull();
    expect(resolveGameMode("   ")).toBeNull();
  });

  it("ignora los espacios alrededor del nombre", () => {
    expect(resolveGameMode("  rm_2v2  ")).toBe("rm_team");
  });
});

describe("isLiveGame", () => {
  it("una partida en curso dentro de la ventana está en directo", () => {
    expect(isLiveGame(partida({ ongoing: true, state: "running" }), AHORA)).toBe(true);
  });

  it("el estado distinto de `processed` también la marca, aunque `ongoing` no venga", () => {
    // La API no siempre manda los dos a la vez, y basta con que uno diga que no ha
    // terminado.
    expect(isLiveGame(partida({ ongoing: false, state: "running" }), AHORA)).toBe(true);
    expect(isLiveGame(partida({ ongoing: true, state: "processed" }), AHORA)).toBe(true);
  });

  it("una partida terminada nunca está en directo, aunque sea de hace un minuto", () => {
    expect(isLiveGame(partida(), AHORA)).toBe(false);
  });

  it("fuera de la ventana deja de estar en directo aunque la API siga diciendo que sí", () => {
    // Sin este límite, una partida olvidada figuraría como "en directo" para siempre.
    const justo = new Date(partida({ ongoing: true }).startedAt.getTime() + LIVE_GAME_WINDOW_MS);
    const pasado = new Date(justo.getTime() + 1);

    expect(isLiveGame(partida({ ongoing: true }), justo)).toBe(true);
    expect(isLiveGame(partida({ ongoing: true }), pasado)).toBe(false);
  });

  it("la ventana es de 60 minutos", () => {
    expect(LIVE_GAME_WINDOW_MINUTES).toBe(60);
    expect(LIVE_GAME_WINDOW_MS).toBe(60 * 60_000);
  });
});

describe("normalizeGame", () => {
  it("sin `leaderboard` ni `kind` la partida se descarta y lo dice", () => {
    const resultado = normalizeGame(partida({ leaderboard: null, kind: null }), PERFIL, AHORA);

    expect(resultado).toEqual({
      status: "skipped",
      gameId: 7_000_001,
      reason: "la partida no indica ni leaderboard ni kind",
    });
  });

  it("usa `kind` cuando no hay `leaderboard`", () => {
    // La API usa el mismo nombre para ladder y para tipo de partida según el
    // endpoint, y `kind` es el único que queda en el detalle de una partida.
    const resultado = comoMatch(
      normalizeGame(partida({ leaderboard: null, kind: "rm_2v2" }), PERFIL, AHORA),
    );

    expect(resultado.leaderboard).toBe("rm_2v2");
    expect(resultado.mode).toBe("rm_team");
  });

  it("una partida cerrada sin resultado se descarta: la API no la tiene procesada", () => {
    // No se resuelve como `LOSS` ni bajo ninguna circunstancia: repartir un
    // desenlace inventado sería peor que no repartir nada.
    // Ni `ongoing` ni un estado distinto de `processed` (o sea, no en directo) y sin
    // resultado publicado para nadie: la API no tiene el desenlace y no va a tenerlo.
    const resultado = normalizeGame(
      partida({
        state: "processed",
        ongoing: false,
        started_at: "2026-09-01T18:00:00.000Z",
        teams: [
          [{ player: { profile_id: PERFIL, name: "Jugador" } }],
          [{ player: { profile_id: RIVAL, name: "Rival" } }],
        ],
      }),
      PERFIL,
      AHORA,
    );

    expect(resultado.status).toBe("skipped");
    expect(resultado.status === "skipped" && resultado.reason).toContain("sin resultado");
  });

  it("el `finishedAt` se deduce de `started_at` + duración, que la API no manda", () => {
    const resultado = comoMatch(normalizeGame(partida(), PERFIL, AHORA));

    expect(resultado.finishedAt?.toISOString()).toBe("2026-09-20T19:50:00.000Z");
    expect(resultado.result).toBe(MatchResult.WIN);
  });

  it("una partida en directo tiene `result` y `finishedAt` a null, no un resultado inventado", () => {
    // Es lo que permite que F4 la liste por `finishedAt IS NULL` y que F3 no la
    // cuente: la garantía de que una partida viva nunca puntúa está en estos dos
    // `null`, y por eso la API aún no publica el resultado de nadie.
    const enCurso = partida({
      ongoing: true,
      state: "running",
      teams: [
        [{ player: { profile_id: PERFIL, name: "Jugador", civilization: "english" } }],
        [{ player: { profile_id: RIVAL, name: "Rival" } }],
      ],
    });
    const resultado = comoMatch(normalizeGame(enCurso, PERFIL, AHORA));

    expect(resultado.result).toBeNull();
    expect(resultado.finishedAt).toBeNull();
    expect(resultado.durationSeconds).toBeNull();
  });

  it("guarda el primer rival del equipo contrario y su civilización", () => {
    const resultado = comoMatch(normalizeGame(partida(), PERFIL, AHORA));

    expect(resultado.opponentProfileId).toBe(RIVAL);
    expect(resultado.opponentName).toBe("Rival");
    expect(resultado.civ).toBe("english");
    expect(resultado.opponentCiv).toBe("mongols");
  });

  it("si el jugador no está en la partida no hay civ propia, y el rival es el primero que hay", () => {
    // `findSides` busca el equipo propio y, si no lo encuentra, da como contrario el
    // primero de la lista. No es un caso que el worker provoque, pero sí el que
    // aparece si la API manda una alineación en la que el jugador todavía no está, y
    // lo importante es que no inventa una civilización que no es suya.
    const resultado = comoMatch(normalizeGame(partida({ ongoing: true }), 9_999_999, AHORA));

    expect(resultado.civ).toBeNull();
    expect(resultado.civRandomized).toBe(false);
    expect(resultado.result).toBeNull();
  });

  it("el equipo completo se queda en `rawJson`, no en columnas sueltas", () => {
    // El schema tiene un único par de campos de rival: en 2v2 o 3v3, el resto del
    // equipo solo cabe en el payload.
    const conEquipo = partida({
      kind: "rm_2v2",
      leaderboard: "rm_team",
      teams: [
        [
          { player: { profile_id: PERFIL, name: "Jugador", result: "win" } },
          { player: { profile_id: COMPAÑERO, name: "Compañero", result: "win" } },
        ],
        [{ player: { profile_id: RIVAL, name: "Rival", result: "loss" } }],
      ],
    });
    const resultado = comoMatch(normalizeGame(conEquipo, PERFIL, AHORA));

    expect(resultado.mode).toBe("rm_team");
    expect(resultado.opponentProfileId).toBe(RIVAL);
    expect(resultado.rawJson).toBe(conEquipo.raw);
  });

  it("el `gameId` se guarda como texto, porque es la clave de la unicidad", () => {
    expect(comoMatch(normalizeGame(partida(), PERFIL, AHORA)).gameId).toBe("7000001");
  });
});

describe("readOwnCivRandomized", () => {
  it("lee la marca del jugador, no el primer `true` que aparezca", () => {
    // En un 2v2 puede ser el compañero el que jugó con civ aleatoria, y esa marca no
    // dice nada de la civilización de nadie más.
    const conCompaneroAleatorio = partida({
      kind: "rm_2v2",
      teams: [
        [
          { player: { profile_id: PERFIL, name: "Jugador", result: "win", civilization_randomized: false } },
          { player: { profile_id: COMPAÑERO, name: "Compañero", result: "win", civilization_randomized: true } },
        ],
        [{ player: { profile_id: RIVAL, name: "Rival", result: "loss" } }],
      ],
    });

    expect(readOwnCivRandomized(conCompaneroAleatorio, PERFIL)).toBe(false);
    expect(readOwnCivRandomized(conCompaneroAleatorio, COMPAÑERO)).toBe(true);
  });

  it("si no aparece la marca, se lee como que no fue aleatoria", () => {
    // La API no siempre manda el campo, y quedarse sin dato no puede convertirse en
    // "aleatoria": eso dejaría al jugador sin `otp` y sin `masterizar-*` sin motivo.
    expect(readOwnCivRandomized(partida(), PERFIL)).toBe(false);
    expect(readOwnCivRandomized(partida(), 9_999_999)).toBe(false);
  });
});
