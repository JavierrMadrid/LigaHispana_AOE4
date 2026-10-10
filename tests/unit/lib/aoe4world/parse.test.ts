import { describe, expect, it } from "vitest";

import {
  isProcessedState,
  parseAutocomplete,
  parseGame,
  parseGamePlayer,
  parseGamesPage,
  parseLadderPage,
  parseLeaderboard,
  parsePlayer,
} from "@/lib/aoe4world/parse";

/**
 * La frontera de confianza con la API de AoE4World.
 *
 * Todo lo que llega de la red entra como `unknown` y sale de aquí ya tipado, sin
 * un solo `as` sobre la respuesta. Los datos de estas comprobaciones son
 * **inventados**: la forma de los payloads está copiada de lo que se ha medido de
 * la API, pero ningún valor sale de ella, así que la comprobación no depende de lo
 * que la API conteste hoy.
 *
 * El criterio es siempre el mismo, y es el que se prueba: un campo con la forma
 * inesperada se devuelve como `null` y quien llama decide, en vez de inventar un
 * valor o perder el registro entero.
 */

describe("parsePlayer", () => {
  it("lee un perfil tal cual lo manda el endpoint", () => {
    const perfil = parsePlayer({
      profile_id: 1234,
      name: "BeastWizard",
      steam_id: "76561198",
      site_url: "https://aoe4world.com/players/1234",
      country: "es",
      avatars: { small: "s.png", medium: null, full: "f.png" },
    });

    expect(perfil).toEqual({
      profileId: 1234,
      name: "BeastWizard",
      steamId: "76561198",
      siteUrl: "https://aoe4world.com/players/1234",
      country: "es",
      avatars: { small: "s.png", medium: null, full: "f.png" },
    });
  });

  it("sin `profile_id` o sin nombre no hay perfil: son los dos campos de identidad", () => {
    expect(parsePlayer({ name: "Sin id" })).toBeNull();
    expect(parsePlayer({ profile_id: 1234 })).toBeNull();
    expect(parsePlayer({ profile_id: 12.5, name: "Fraccionario" })).toBeNull();
  });

  it("un `profile_id` en texto numérico se acepta, porque la API es inconsistente", () => {
    expect(parsePlayer({ profile_id: "1234", name: "BeastWizard" })?.profileId).toBe(1234);
  });

  it("lo que no es un objeto se descarta", () => {
    for (const valor of [null, undefined, "texto", 42, []]) {
      expect(parsePlayer(valor), String(valor)).toBeNull();
    }
  });

  it("un avatar vacío no es un avatar: se queda a null sin pisar nada", () => {
    // Un `""` se guardaría como una URL rota en la tabla y en la interfaz.
    const perfil = parsePlayer({
      profile_id: 1,
      name: "X",
      avatars: { small: "  ", medium: "m.png" },
    });

    expect(perfil?.avatars).toEqual({ small: null, medium: "m.png", full: null });
  });

  it("sin `avatars` la terna sale entera a null", () => {
    expect(parsePlayer({ profile_id: 1, name: "X", avatars: "nope" })?.avatars).toEqual({
      small: null,
      medium: null,
      full: null,
    });
  });
});

describe("parseGamePlayer", () => {
  it("lee la forma anidada del listado y la plana del detalle", () => {
    // `/players/:id/games` envuelve cada entrada en `{ player: {...} }` y
    // `/players/:id/games/:game_id` la manda plana. Aceptar las dos es lo que
    // permite que la normalización no esté atada a un endpoint.
    const anidada = { player: { profile_id: 7, name: "Alfa", result: "win" } };
    const plana = { profile_id: 7, name: "Alfa", result: "win" };

    expect(parseGamePlayer(anidada)).toEqual(parseGamePlayer(plana));
  });

  it("el resultado solo admite `win` y `loss`, sin mirar mayúsculas", () => {
    expect(parseGamePlayer({ profile_id: 1, result: "WIN" })?.result).toBe("win");
    expect(parseGamePlayer({ profile_id: 1, result: " Loss " })?.result).toBe("loss");
    // Cualquier otro valor significa que la API no ha publicado el desenlace: es
    // `null`, que es justo lo que distingue una partida en curso de una resuelta.
    for (const resultado of ["draw", "unknown", "", null, 1]) {
      expect(parseGamePlayer({ profile_id: 1, result: resultado })?.result, String(resultado)).toBeNull();
    }
  });

  it("la civ aleatoria acepta el booleano y su forma en texto", () => {
    expect(parseGamePlayer({ profile_id: 1, civilization_randomized: true })?.civilizationRandomized).toBe(
      true,
    );
    expect(parseGamePlayer({ profile_id: 1, civilization_randomized: "true" })?.civilizationRandomized).toBe(
      true,
    );
    // La API no siempre manda el campo, y quedarse sin dato se lee como "no
    // aleatoria", que es el valor por defecto de la columna.
    expect(parseGamePlayer({ profile_id: 1 })?.civilizationRandomized).toBe(false);
  });

  it("un rating no numérico es `null`, no `0`", () => {
    // `0` diría "no tenía rating"; `null` dice "no se ha podido leer", que es lo
    // que R4 necesita para no acusar a nadie de una brecha inventada.
    expect(parseGamePlayer({ profile_id: 1, rating: "alto" })?.rating).toBeNull();
    expect(parseGamePlayer({ profile_id: 1, rating: 0 })?.rating).toBe(0);
  });

  it("lo que no es un objeto se descarta", () => {
    for (const valor of [null, "texto", 42, []]) {
      expect(parseGamePlayer(valor), String(valor)).toBeNull();
    }
  });
});

describe("parseGame", () => {
  const MINIMO = {
    game_id: 5_000_001,
    started_at: "2026-09-20T18:00:00.000Z",
    duration: 1_842.4,
    map: "High View",
    map_id: 77,
    leaderboard: "rm_solo",
    kind: "rm_1v1",
    state: "processed",
    ongoing: false,
    just_finished: false,
    average_mmr: 1520,
  };

  it("sin `game_id` o sin `started_at` la partida se descarta", () => {
    // Son los dos campos sin los que no se puede ni identificar la fila ni
    // colocarla en el tiempo.
    expect(parseGame({ ...MINIMO, game_id: null })).toBeNull();
    expect(parseGame({ ...MINIMO, game_id: 0 })).toBeNull();
    expect(parseGame({ ...MINIMO, started_at: "ayer" })).toBeNull();
    expect(parseGame({ ...MINIMO, started_at: null })).toBeNull();
  });

  it("un `started_at` en epoch se normaliza a `Date`", () => {
    // La API usa segundos en unos campos y milisegundos en otros, así que el
    // orden de magnitud decide cuál es cuál.
    const enSegundos = parseGame({ ...MINIMO, started_at: 1_789_000_000 });
    const enMilis = parseGame({ ...MINIMO, started_at: 1_789_000_000_000 });

    expect(enSegundos?.startedAt.getTime()).toBe(1_789_000_000_000);
    expect(enMilis?.startedAt.getTime()).toBe(1_789_000_000_000);
  });

  it("la duración se redondea a segundos enteros", () => {
    expect(parseGame({ ...MINIMO, duration: 1_842.4 })?.durationSeconds).toBe(1_842);
    expect(parseGame({ ...MINIMO, duration: null })?.durationSeconds).toBeNull();
  });

  it("lee la media de rating de la partida (`average_rating`), que es la que compara R5", () => {
    expect(parseGame({ ...MINIMO, average_rating: 1_610 })?.averageRating).toBe(1_610);
    expect(parseGame({ ...MINIMO, average_rating: "1610" })?.averageRating).toBe(1_610);
    // Sin el campo o con algo ilegible queda `null`, que es un hueco de datos y no
    // un cero: R5 omite la partida en vez de contar un escalón inventado.
    expect(parseGame({ ...MINIMO, average_rating: null })?.averageRating).toBeNull();
    expect(parseGame({ ...MINIMO, average_rating: "alto" })?.averageRating).toBeNull();
    expect(parseGame(MINIMO)?.averageRating).toBeNull();
  });

  it("acepta la fecha legible `2022/04/19` que manda la API", () => {
    // `Date.parse` la interpreta como medianoche **local**, que es lo que significa
    // una fecha sin hora; no se le pone zona porque la API no la manda.
    expect(parseGame({ ...MINIMO, started_at: "2022/04/19" })?.startedAt.getTime()).toBe(
      new Date(2022, 3, 19).getTime(),
    );
  });

  it("los equipos que no se pueden leer se pierden, y un equipo vacío no cuenta", () => {
    const conRuido = parseGame({
      ...MINIMO,
      teams: [
        [{ player: { profile_id: 1, name: "Alfa" } }, "esto no es un jugador"],
        "esto no es un equipo",
        [],
        [{ player: { profile_id: 2, name: "Bravo" } }],
      ],
    });

    expect(conRuido?.teams).toEqual([
      [{ profileId: 1, name: "Alfa", country: null, result: null, civilization: null, civilizationRandomized: false, rating: null, mmr: null }],
      [{ profileId: 2, name: "Bravo", country: null, result: null, civilization: null, civilizationRandomized: false, rating: null, mmr: null }],
    ]);
  });

  it("sin `teams` la partida sigue siendo legible, con la lista vacía", () => {
    const juego = parseGame(MINIMO);

    expect(juego?.teams).toEqual([]);
    expect(juego?.gameId).toBe(5_000_001);
  });

  it("el payload original se conserva tal cual, para recalcular sin volver a pedirlo", () => {
    // Es lo que hace posible un recálculo cuando cambian las reglas.
    expect(parseGame(MINIMO)?.raw).toBe(MINIMO);
  });
});

describe("isProcessedState", () => {
  it("`processed` es el único estado con resultado definitivo", () => {
    expect(isProcessedState("processed")).toBe(true);
    expect(isProcessedState("PROCESSED")).toBe(true);
    for (const estado of ["running", "ended", "", null]) {
      expect(isProcessedState(estado), String(estado)).toBe(false);
    }
  });
});

describe("parseGamesPage", () => {
  it("descarta las partidas raras y conserva las buenas, con la paginación de la respuesta", () => {
    const pagina = parseGamesPage({
      page: 2,
      per_page: 50,
      total_count: 114,
      count: 2,
      next_page: 3,
      games: [
        { game_id: 1, started_at: "2026-09-20T18:00:00Z" },
        { game_id: "no-es-un-numero", started_at: "2026-09-20T19:00:00Z" },
      ],
    });

    // El `per_page` se toma de la respuesta y no del pedido: la API nunca devuelve
    // más de 50 por página, aunque se le pidan más.
    expect(pagina?.perPage).toBe(50);
    expect(pagina?.totalCount).toBe(114);
    expect(pagina?.nextPage).toBe(3);
    expect(pagina?.games).toHaveLength(1);
  });

  it("sin `games` la página sale vacía en vez de descartarse", () => {
    const pagina = parseGamesPage({ page: 1 });

    expect(pagina?.games).toEqual([]);
    expect(pagina?.perPage).toBe(0);
    expect(pagina?.nextPage).toBeNull();
  });

  it("`next_page` a 0 o `null` se lee como última página", () => {
    expect(parseGamesPage({ next_page: 0 })?.nextPage).toBeNull();
    expect(parseGamesPage({ next_page: null })?.nextPage).toBeNull();
    expect(parseGamesPage({ next_page: 7 })?.nextPage).toBe(7);
  });

  it("más allá de la última página la API contesta 200 con la lista vacía", () => {
    // Es lo que se comprobó contra la API: no un 404, y por eso el worker tiene que
    // tratar "página vacía" como fin de la paginación y no como un fallo.
    const pagina = parseGamesPage({ page: 999, per_page: 50, total_count: 114, games: [] });

    expect(pagina).not.toBeNull();
    expect(pagina?.games).toEqual([]);
  });
});

describe("leaderboard", () => {
  const ENTRADA = {
    profile_id: 4321,
    name: "BeastWizard",
    country: "es",
    rating: 1_612,
    rank: 12,
    rank_level: "gold_2",
    streak: -3,
    games_count: 200,
    wins_count: 120,
    losses_count: 80,
    twitch_url: "beastwizard",
    twitch_is_live: true,
    avatars: { small: "s.png", medium: null, full: "f.png" },
    last_game_at: 1_789_000_000,
  };

  it("lee una entrada conservando la racha con signo", () => {
    // El lector no descarta negativos, que es justo lo que hay que conservar de una
    // racha de derrotas: con el signo se ve, y sin él parecería que no juega.
    const entrada = parseLeaderboard({ key: "rm_solo", players: [ENTRADA] })?.players[0];

    expect(entrada?.streak).toBe(-3);
    expect(entrada?.rankLevel).toBe("gold_2");
    expect(entrada?.twitchIsLive).toBe(true);
    expect(entrada?.lastGameAt?.getTime()).toBe(1_789_000_000_000);
  });

  it("una entrada sin `profile_id` se descarta; el nombre puede faltar", () => {
    expect(parseLeaderboard({ key: "rm_solo", players: [{ name: "Sin id" }] })?.players).toEqual([]);
    expect(parseLeaderboard({ key: "rm_solo", players: [{ profile_id: 1 }] })?.players[0]?.name).toBe(
      "",
    );
  });

  it("una ladder sin `key` se descarta: la clave es lo que la identifica", () => {
    expect(parseLeaderboard({ players: [] })).toBeNull();
  });

  it("el nombre de la ladder cae a la clave si no viene", () => {
    expect(parseLeaderboard({ key: "rm_solo" })?.name).toBe("rm_solo");
  });

  it("la página de la ladder lleva la paginación que el listado no trae", () => {
    const pagina = parseLadderPage({
      key: "rm_team",
      name: "Ranked Teams",
      season: 8,
      page: 5,
      per_page: 50,
      total_count: 50_847,
      count: 1,
      next_page: 6,
      players: [ENTRADA],
    });

    expect(pagina).toMatchObject({ key: "rm_team", page: 5, perPage: 50, totalCount: 50_847, nextPage: 6 });
    expect(pagina?.players[0]?.profileId).toBe(4321);
  });

  it("la misma entrada se interpreta igual en la ladder y en su página", () => {
    // La paginación se añade encima; el jugador se lee una sola vez, así que el
    // listado y la página no pueden discrepar sobre la misma fila.
    const ladder = parseLeaderboard({ key: "rm_solo", players: [ENTRADA] });
    const pagina = parseLadderPage({ key: "rm_solo", players: [ENTRADA] });

    expect(pagina?.players).toEqual(ladder?.players);
  });

  it("una página de ladder sin `key` se descarta", () => {
    expect(parseLadderPage({ page: 2, players: [ENTRADA] })).toBeNull();
  });
});

describe("parseAutocomplete", () => {
  it("rellena la consulta y la ladder con los valores por defecto", () => {
    const resultado = parseAutocomplete({ players: [{ profile_id: 1, name: "Alfa" }] });

    // `rm_solo` es la ladder por defecto del cliente HTTP, no un dato inventado
    // aquí: sin ella la búsqueda no sabe contra qué leaderboard pregunta.
    expect(resultado?.leaderboard).toBe("rm_solo");
    expect(resultado?.query).toBe("");
    expect(resultado?.players).toHaveLength(1);
  });

  it("respeta la ladder que sí viene", () => {
    expect(parseAutocomplete({ leaderboard: "rm_team" })?.leaderboard).toBe("rm_team");
  });
});
