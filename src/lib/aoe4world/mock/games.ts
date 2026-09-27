/**
 * Partidas del torneo simulado.
 *
 * Dos series con vidas muy distintas:
 *
 * - **Terminadas**: fechas ancladas a `HISTORY_EPOCH_MS`, así el histórico no se
 *   mueve entre ejecuciones y el cursor `since` del worker converge siempre al
 *   mismo sitio.
 * - **En vivo**: su `started_at` se recalcula en **cada petición** como "hace
 *   N minutos" (ver `serializeMockGame`), de modo que nunca sale de la ventana
 *   de 60 minutos de `isLiveGame` aunque la simulación se lance días después.
 *   Si estuvieran ancladas, al cabo de una hora el worker las trataría como
 *   abandonadas y las borraría.
 *
 * El torneo es individual, así que el calendario mezcla cruces entre los diez
 * participantes y partidas contra **rivales externos** (gente de la ladder que
 * no juega la liga). Estas últimas solo dejan fila `Match` para el
 * participante: el externo no tiene `Player` y por eso su nombre aparece en la
 * web como un simple `opponentName`.
 *
 * La duplicación de forma entre listado y detalle imita a la API real: en
 * `/players/:id/games` cada jugador va envuelto en `{ player: {...} }` y en el
 * detalle viene plano. `parse.ts` acepta las dos; `normalize` ve siempre el mismo
 * contenido.
 */

import { MOCK_EXTERNAL_PLAYERS, MOCK_TOURNAMENT_PLAYERS } from "./players";

/**
 * Epoch estable del histórico: todas las partidas terminadas se derivan de aquí
 * restando minutos, de forma determinista. Tiene que quedarse en el pasado.
 */
const HISTORY_EPOCH_MS = Date.parse("2026-09-24T20:00:00.000Z");

/** Separación entre partidas del histórico: 48 partidas ~ 3 días de torneo. */
const HISTORY_INTERVAL_MS = 90 * 60_000;

const FINISHED_GAME_ID_BASE = 9_100_000;

const LIVE_GAME_ID_BASE = 9_190_000;

const MAPS: readonly (readonly [string, number])[] = [
  ["High View", 127_490],
  ["Lipany", 127_497],
  ["Dry Arabia", 127_478],
  ["Boulder Bay", 127_474],
  ["Forest Castle", 127_485],
  ["Amazonia", 127_471],
  ["Golden Heights", 127_489],
  ["Ring of Ruin", 127_499],
];

const DURATIONS_SECONDS: readonly number[] = [1500, 1800, 2100, 2400, 2700, 1200, 1950, 2250];

const CIVILIZATIONS: readonly string[] = [
  "english",
  "french",
  "holy_roman_empire",
  "delhi_sultanate",
  "abbasid_dynasty",
  "mongols",
  "chinese",
  "malians",
  "japanese",
  "rus",
  "ottomans",
  "byzantines",
];

export type MockGameSide = {
  profileId: number;
  name: string;
  country: string;
  /** `null` en partidas en vivo: el resultado todavía no existe. */
  result: "win" | "loss" | null;
  civilization: string;
  civilizationRandomized: boolean;
  rating: number;
  mmr: number;
};

type MockGameBase = {
  gameId: number;
  /** `null` mientras la API no tenga el desenlace (solo partidas en vivo). */
  durationSeconds: number | null;
  map: string;
  mapId: number;
  leaderboard: string;
  kind: string;
  state: string;
  ongoing: boolean;
  averageMmr: number;
  teams: MockGameSide[][];
};

export type MockFinishedGame = MockGameBase & {
  live: false;
  /** Epoch fija: es lo que hace estable el histórico entre ejecuciones. */
  startedAtMs: number;
};

export type MockLiveGame = MockGameBase & {
  live: true;
  /** Cuánto falta para `now` en el momento de la petición (10–20 min). */
  startedAtOffsetMs: number;
};

export type MockGame = MockFinishedGame | MockLiveGame;

/**
 * Lo que un lateral de partido necesita saber de su jugador: perfil, nombre,
 * país y rating, que es lo común entre un participante y un rival externo.
 */
type MockSidePlayer = {
  profileId: number;
  name: string;
  country: string;
  rating: number;
};

/** Civilización determinista por (partida, perfil): variada y sin aleatoriedad. */
function civilizationFor(gameIndex: number, profileId: number): string {
  return CIVILIZATIONS[(gameIndex * 3 + profileId) % CIVILIZATIONS.length];
}

function makeSide(
  gameIndex: number,
  player: MockSidePlayer,
  result: "win" | "loss" | null,
): MockGameSide {
  const rating = player.rating;

  return {
    profileId: player.profileId,
    name: player.name,
    country: player.country,
    result,
    civilization: civilizationFor(gameIndex, player.profileId),
    // Marca ocasional de civ aleatoria, para que `Match.civRandomized` no sea
    // siempre `false` en los datos simulados.
    civilizationRandomized: (gameIndex + player.profileId) % 7 === 0,
    rating,
    mmr: rating + 80,
  };
}

function averageMmr(sides: MockGameSide[][]): number {
  const all = sides.flat();
  const total = all.reduce((sum, side) => sum + side.mmr, 0);

  return Math.round(total / all.length);
}

function baseFields(
  gameIndex: number,
  leaderboard: string,
  kind: string,
  teams: MockGameSide[][],
): Omit<MockGameBase, "gameId"> {
  const [map, mapId] = MAPS[gameIndex % MAPS.length];

  return {
    durationSeconds: DURATIONS_SECONDS[gameIndex % DURATIONS_SECONDS.length],
    map,
    mapId,
    leaderboard,
    kind,
    state: "processed",
    ongoing: false,
    averageMmr: averageMmr(teams),
    teams,
  };
}

function makeSoloGame(
  gameIndex: number,
  winner: MockSidePlayer,
  loser: MockSidePlayer,
): MockFinishedGame {
  return {
    gameId: FINISHED_GAME_ID_BASE + gameIndex + 1,
    live: false,
    startedAtMs: HISTORY_EPOCH_MS - gameIndex * HISTORY_INTERVAL_MS,
    ...baseFields(
      gameIndex,
      "rm_solo",
      "rm_1v1",
      [
        [makeSide(gameIndex, winner, "win")],
        [makeSide(gameIndex, loser, "loss")],
      ],
    ),
  };
}

function makeTeamGame(
  gameIndex: number,
  winners: readonly MockSidePlayer[],
  losers: readonly MockSidePlayer[],
): MockFinishedGame {
  const winnerSides = winners.map((player) => makeSide(gameIndex, player, "win"));
  const loserSides = losers.map((player) => makeSide(gameIndex, player, "loss"));

  return {
    gameId: FINISHED_GAME_ID_BASE + gameIndex + 1,
    live: false,
    startedAtMs: HISTORY_EPOCH_MS - gameIndex * HISTORY_INTERVAL_MS,
    ...baseFields(gameIndex, "rm_team", "rm_2v2", [winnerSides, loserSides]),
  };
}

/**
 * Calendario terminado: todos contra todos una vez, tres 2v2 y un puñado de
 * partidas contra rivales externos.
 *
 * Cada par `(i, j)` con `i > j` juega una 1v1 ganada por `i`, así el jugador `k`
 * suma `k` victorias: 0, 1, 2 … 9, todos distintos. Los tres 2v2 de después
 * suman +1 a los ganadores `{6,7}`, `{8,9}` y `{4,5}` —es decir, a los índices
 * 4 a 9—. Por último, contra la ladder cada participante gana **exactamente una
 * y pierde otra**: +1 victoria para todos, que es un empujón uniforme y por eso
 * no colisiona con nadie. Los totales quedan en **1, 2, 3, 4, 6, 7, 8, 9, 10,
 * 11**: diez cifras distintas, que es lo que hace que la clasificación
 * simulada no salga empatada ni plana. Si se toca este calendario, hay que
 * volver a comprobar que los diez totales siguen distintos.
 *
 * El reparto de los externos es `k` contra el externo `k` (victoria) y el
 * externo `k + 5` contra `k` (derrota): con diez externos, cada uno de ellos
 * juega dos partidas terminadas, una ganada y una perdida.
 */
function buildFinishedGames(): MockFinishedGame[] {
  const games: MockFinishedGame[] = [];

  for (let winner = 1; winner < MOCK_TOURNAMENT_PLAYERS.length; winner += 1) {
    for (let loser = 0; loser < winner; loser += 1) {
      games.push(
        makeSoloGame(
          games.length,
          MOCK_TOURNAMENT_PLAYERS[winner],
          MOCK_TOURNAMENT_PLAYERS[loser],
        ),
      );
    }
  }

  const [p0, p1, p2, p3, p4, p5, p6, p7, p8, p9] = MOCK_TOURNAMENT_PLAYERS;
  games.push(makeTeamGame(games.length, [p6, p7], [p0, p1]));
  games.push(makeTeamGame(games.length, [p8, p9], [p2, p3]));
  games.push(makeTeamGame(games.length, [p4, p5], [p0, p2]));

  const externals = MOCK_EXTERNAL_PLAYERS.length;

  for (let index = 0; index < MOCK_TOURNAMENT_PLAYERS.length; index += 1) {
    const participant = MOCK_TOURNAMENT_PLAYERS[index];

    games.push(makeSoloGame(games.length, participant, MOCK_EXTERNAL_PLAYERS[index]));
    games.push(
      makeSoloGame(games.length, MOCK_EXTERNAL_PLAYERS[(index + 5) % externals], participant),
    );
  }

  return games;
}

function makeLiveGame(
  gameIndex: number,
  first: MockSidePlayer,
  second: MockSidePlayer,
  offsetMinutes: number,
): MockLiveGame {
  const teams: MockGameSide[][] = [
    [makeSide(gameIndex + 100, first, null)],
    [makeSide(gameIndex + 100, second, null)],
  ];
  const [map, mapId] = MAPS[(gameIndex + 3) % MAPS.length];

  return {
    gameId: LIVE_GAME_ID_BASE + gameIndex + 1,
    live: true,
    startedAtOffsetMs: offsetMinutes * 60_000,
    durationSeconds: null,
    map,
    mapId,
    leaderboard: "rm_solo",
    kind: "rm_1v1",
    state: "unprocessed",
    ongoing: true,
    averageMmr: averageMmr(teams),
    teams,
  };
}

/**
 * Las 3 partidas en vivo. La primera es un participante contra un rival
 * externo: deja **una sola fila** `Match`, que es lo que hace que la tarjeta de
 * `/partidas` no lleve el distintivo de "jugadores de la liga" y pinte el
 * nombre del externo en "contra …". Las otras dos son cruces entre
 * participantes (dos filas cada una), para que la simulación ejercite las dos
 * formas de la tarjeta. `started_at` no está aquí a propósito: se resta el
 * desfase a `now` en cada petición.
 */
export const MOCK_LIVE_GAMES: readonly MockLiveGame[] = [
  makeLiveGame(0, MOCK_TOURNAMENT_PLAYERS[0], MOCK_EXTERNAL_PLAYERS[0], 10),
  makeLiveGame(1, MOCK_TOURNAMENT_PLAYERS[2], MOCK_TOURNAMENT_PLAYERS[3], 15),
  makeLiveGame(2, MOCK_TOURNAMENT_PLAYERS[4], MOCK_TOURNAMENT_PLAYERS[5], 20),
];

export const MOCK_FINISHED_GAMES: readonly MockFinishedGame[] = buildFinishedGames();

export const MOCK_ALL_GAMES: readonly MockGame[] = [...MOCK_FINISHED_GAMES, ...MOCK_LIVE_GAMES];

/** Todas las partidas (terminadas y en vivo) en las que participa un jugador. */
export function mockGamesForPlayer(profileId: number): MockGame[] {
  return MOCK_ALL_GAMES.filter((game) =>
    game.teams.some((team) => team.some((side) => side.profileId === profileId)),
  );
}

export type MockCareerStats = {
  gamesCount: number;
  winsCount: number;
  lossesCount: number;
  /** Epoch del último partido terminado, o `null` si no tiene ninguno. */
  lastGameAtMs: number | null;
};

/** Carrera en partidas terminadas; la alimenta el endpoint `/leaderboards`. */
export function mockCareerStats(profileId: number): MockCareerStats {
  let gamesCount = 0;
  let winsCount = 0;
  let lossesCount = 0;
  let lastGameAtMs: number | null = null;

  for (const game of MOCK_FINISHED_GAMES) {
    const side = game.teams.flat().find((entry) => entry.profileId === profileId);

    if (side === undefined) {
      continue;
    }

    gamesCount += 1;

    if (side.result === "win") {
      winsCount += 1;
    } else if (side.result === "loss") {
      lossesCount += 1;
    }

    if (lastGameAtMs === null || game.startedAtMs > lastGameAtMs) {
      lastGameAtMs = game.startedAtMs;
    }
  }

  return { gamesCount, winsCount, lossesCount, lastGameAtMs };
}

type FlatSidePayload = {
  profile_id: number;
  name: string;
  country: string;
  result: "win" | "loss" | null;
  civilization: string;
  civilization_randomized: boolean;
  rating: number;
  mmr: number;
};

type SidePayload = FlatSidePayload | { player: FlatSidePayload };

type MockGamePayload = {
  game_id: number;
  started_at: string;
  updated_at: string;
  duration: number | null;
  map: string;
  map_id: number;
  map_custom_id: null;
  state: string;
  kind: string;
  leaderboard: string;
  mmr_leaderboard: string;
  season: number;
  server: string;
  patch: number;
  average_mmr: number;
  ongoing: boolean;
  just_finished: boolean;
  teams: SidePayload[][];
};

/**
 * Serializa una partida con la forma exacta que espera `parse.ts`.
 *
 * `form` reproduce el detalle de la API real: `listing` envuelve a cada jugador
 * en `{ player: {...} }`, `detail` lo deja plano.
 */
export function serializeMockGame(game: MockGame, now: Date, form: "listing" | "detail"): MockGamePayload {
  const startedAtMs = game.live ? now.getTime() - game.startedAtOffsetMs : game.startedAtMs;
  const startedAt = new Date(startedAtMs);
  const updatedMs = game.durationSeconds === null ? startedAtMs : startedAtMs + game.durationSeconds * 1000;

  const flatSide = (side: MockGameSide): FlatSidePayload => ({
    profile_id: side.profileId,
    name: side.name,
    country: side.country,
    result: side.result,
    civilization: side.civilization,
    civilization_randomized: side.civilizationRandomized,
    rating: side.rating,
    mmr: side.mmr,
  });

  return {
    game_id: game.gameId,
    started_at: startedAt.toISOString(),
    updated_at: new Date(updatedMs).toISOString(),
    duration: game.durationSeconds,
    map: game.map,
    map_id: game.mapId,
    map_custom_id: null,
    state: game.state,
    kind: game.kind,
    leaderboard: game.leaderboard,
    mmr_leaderboard: game.kind,
    season: 14,
    server: "EU",
    patch: 11_308,
    average_mmr: game.averageMmr,
    ongoing: game.ongoing,
    just_finished: false,
    teams: game.teams.map((team) =>
      team.map((side) => (form === "listing" ? { player: flatSide(side) } : flatSide(side))),
    ),
  };
}
