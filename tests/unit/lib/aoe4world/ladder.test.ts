import { describe, expect, it } from "vitest";

import { ladderPlayerChanged } from "@/lib/aoe4world/ladder";
import type { Aoe4WorldLeaderboardEntry } from "@/lib/aoe4world/types";

/**
 * La costura pura que decide si el snapshot de la ladder cambió algo que lea el
 * motor de objetivos.
 *
 * Lo que se comprueba aquí es la **lista cerrada** de metadatos: nombre oficial,
 * avatar y división. Todo lo demás que trae la misma entrada —elo, racha,
 * partidas, Twitch— se escribe igual en cada pasada y no puede contar, o el
 * recálculo no se saltaría nunca. Y los dos casos `null` importan: la ladder no
 * pisa un nombre vacío ni borra un avatar bueno, así que tampoco pueden anunciar
 * un cambio.
 */

/** El jugador guardado, con los tres metadatos que se comparan. */
const GUARDADO = {
  aoe4WorldName: "Ana",
  avatarUrl: "https://cdn.example/ana.png",
  rankLevel: "gold_1",
};

/** La entrada que devolvería la ladder para ese jugador. */
const ENTRADA: Aoe4WorldLeaderboardEntry = {
  profileId: 9_000_001,
  name: "Ana",
  country: "es",
  rating: 1_500,
  rank: 10,
  rankLevel: "gold_1",
  streak: 2,
  gamesCount: 40,
  winsCount: 22,
  lossesCount: 18,
  twitchUrl: null,
  twitchIsLive: false,
  avatars: { small: null, medium: null, full: "https://cdn.example/ana.png" },
  lastGameAt: null,
};

describe("ladderPlayerChanged", () => {
  it("sin cambios en nombre, avatar ni división no hay cambio", () => {
    expect(ladderPlayerChanged(GUARDADO, ENTRADA)).toBe(false);
  });

  it("un nombre distinto es un cambio", () => {
    expect(ladderPlayerChanged(GUARDADO, { ...ENTRADA, name: "Ana María" })).toBe(true);
  });

  it("un nombre vacío no es un cambio: la ladder no pisa el que había", () => {
    expect(ladderPlayerChanged(GUARDADO, { ...ENTRADA, name: "" })).toBe(false);
    expect(ladderPlayerChanged(GUARDADO, { ...ENTRADA, name: "   " })).toBe(false);
  });

  it("un nombre vacío tampoco cambia a quien no tenía nombre", () => {
    expect(
      ladderPlayerChanged({ ...GUARDADO, aoe4WorldName: null }, { ...ENTRADA, name: "" }),
    ).toBe(false);
  });

  it("un avatar nuevo y distinto es un cambio", () => {
    expect(
      ladderPlayerChanged(GUARDADO, {
        ...ENTRADA,
        avatars: { small: null, medium: null, full: "https://cdn.example/ana-2.png" },
      }),
    ).toBe(true);
  });

  it("un avatar nulo no es un cambio: no borra el que había", () => {
    expect(
      ladderPlayerChanged(GUARDADO, {
        ...ENTRADA,
        avatars: { small: null, medium: null, full: null },
      }),
    ).toBe(false);
  });

  it("un avatar nuevo para quien no tenía uno es un cambio", () => {
    expect(
      ladderPlayerChanged({ ...GUARDADO, avatarUrl: null }, ENTRADA),
    ).toBe(true);
  });

  it("una división distinta es un cambio", () => {
    expect(ladderPlayerChanged(GUARDADO, { ...ENTRADA, rankLevel: "platinum_3" })).toBe(true);
  });

  it("quedarse sin división también es un cambio", () => {
    expect(ladderPlayerChanged(GUARDADO, { ...ENTRADA, rankLevel: null })).toBe(true);
  });

  it("solo elo, racha, partidas o Twitch distintos no es un cambio", () => {
    // Todo lo que puede cambiar en una entrada sin tocar nombre, avatar ni
    // división: si alguno de estos contara, el recálculo no se saltaría nunca.
    const conRuido: Aoe4WorldLeaderboardEntry = {
      ...ENTRADA,
      rating: 1_900,
      streak: -3,
      gamesCount: 41,
      winsCount: 22,
      lossesCount: 19,
      twitchUrl: "https://twitch.tv/ana",
      twitchIsLive: true,
      lastGameAt: new Date("2026-10-21T10:00:00.000Z"),
    };

    expect(ladderPlayerChanged(GUARDADO, conRuido)).toBe(false);
  });
});
