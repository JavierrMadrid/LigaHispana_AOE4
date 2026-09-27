import "dotenv/config";

import assert from "node:assert/strict";

import { isLiveGame, LIVE_GAME_WINDOW_MS, normalizeGame, readOwnCivRandomized, resolveGameMode } from "@/lib/aoe4world/normalize";
import { parseGame, parseGamePlayer, parseGamesPage } from "@/lib/aoe4world/parse";
import { Aoe4WorldNotFoundError } from "@/lib/aoe4world/http";
import { countsAsRanked, MVP_RULESET_VERSION } from "@/lib/scoring";
import type { Aoe4WorldClient } from "@/lib/aoe4world/client";
import type { Aoe4WorldGame, Aoe4WorldGamesPage } from "@/lib/aoe4world/types";

/**
 * Verificación de la normalización y del guardado, sin llamar a la API real.
 *
 *   npm run verify:sync         # solo normalización, no necesita base de datos
 *   npm run verify:sync -- --db # además comprueba el guardado y lo limpia
 *
 * Los payloads imitan la forma real de `/api/v0` (contrastada contra la API en
 * septiembre de 2026) pero con perfiles y nombres inventados, y con fechas fijas
 * para que el resultado no dependa del día en que se ejecute.
 */

const SAMPLE_PROFILE_ID = 9_000_001;
const SAMPLE_OPPONENT_ID = 9_000_002;
const SAMPLE_ALLY_ID = 9_000_003;
const SAMPLE_RIVAL_ID = 9_000_004;
/** Segundo jugador, para comprobar que las lecturas públicas filtran por estado. */
const SAMPLE_PENDING_PROFILE_ID = 9_000_005;

/**
 * Reloj congelado para las comprobaciones de normalización: al pasarle `NOW` a
 * `normalizeGame` el resultado no depende del día en que se ejecute. El
 * worker usa el reloj real, y su fixture se construye aparte con `buildFixtureAt`.
 */
const NOW = new Date("2026-09-26T20:00:00.000Z");

const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

function samplePlayer(overrides: Record<string, unknown> = {}) {
  return {
    profile_id: SAMPLE_PROFILE_ID,
    name: "Jugador Muestra",
    country: "es",
    result: "win",
    civilization: "britons",
    civilization_randomized: false,
    rating: 1510,
    rating_diff: 7,
    mmr: 1610,
    mmr_diff: 4,
    input_type: "mouse",
    ...overrides,
  };
}

/** Ranked 1v1 terminada y ganada. */
const SOLO_WIN = {
  game_id: 9_000_001,
  started_at: "2026-09-26T18:00:00.000Z",
  updated_at: "2026-09-26T18:32:00.000Z",
  duration: 1800,
  map: "High View",
  map_id: 127_490,
  map_custom_id: null,
  state: "processed",
  kind: "rm_1v1",
  leaderboard: "rm_solo",
  mmr_leaderboard: "rm_1v1",
  season: 14,
  server: "EU",
  patch: 11_308,
  average_rating: 1500,
  average_mmr: 1600,
  ongoing: false,
  just_finished: false,
  teams: [
    [
      {
        player: samplePlayer({
          profile_id: SAMPLE_OPPONENT_ID,
          name: "Rival Muestra",
          result: "loss",
          civilization: "malians",
        }),
      },
    ],
    [{ player: samplePlayer() }],
  ],
};

/** Ranked por equipos 2v2 perdida: el rival guardado es el primero del equipo contrario. */
const TEAM_LOSS = {
  game_id: 9_000_002,
  started_at: "2026-09-26T17:00:00.000Z",
  duration: 2400,
  map: "Forest Castle",
  state: "processed",
  kind: "rm_2v2",
  leaderboard: "rm_team",
  ongoing: false,
  just_finished: true,
  teams: [
    [
      { player: samplePlayer({ profile_id: SAMPLE_RIVAL_ID, name: "Rival A", result: "win" }) },
      { player: samplePlayer({ profile_id: SAMPLE_ALLY_ID, name: "Compañero", result: "loss" }) },
    ],
    [{ player: samplePlayer({ result: "loss", civilization: "delhi" }) }],
  ],
};

/** En curso: la API todavía no tiene el desenlace. */
const ONGOING_SOLO = {
  game_id: 9_000_003,
  started_at: minutesAgo(5),
  duration: null,
  map: "Amazonia",
  state: "unprocessed",
  kind: "rm_1v1",
  leaderboard: "rm_solo",
  ongoing: true,
  just_finished: false,
  teams: [
    [
      {
        player: samplePlayer({
          profile_id: SAMPLE_OPPONENT_ID,
          name: "Rival Muestra",
          result: null,
          civilization: "japanese",
        }),
      },
    ],
    [{ player: samplePlayer({ result: null, civilization: "mongols" }) }],
  ],
};

/** Abandonada hace horas: el estado "en curso" se queda pegado, no es una partida viva. */
const STALE_UNPROCESSED = {
  ...ONGOING_SOLO,
  game_id: 9_000_004,
  started_at: minutesAgo(180),
  ongoing: false,
};

const SAMPLE_PAGE = {
  total_count: 4,
  page: 1,
  per_page: 100,
  count: 4,
  offset: 0,
  next_page: null,
  filters: { leaderboard: null, since: null, profile_ids: [SAMPLE_PROFILE_ID] },
  games: [SOLO_WIN, TEAM_LOSS, ONGOING_SOLO, STALE_UNPROCESSED],
};

let passed = 0;
const failures: string[] = [];

async function check(name: string, run: () => void | Promise<void>): Promise<void> {
  try {
    await run();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`  FALLA ${name}`);
    console.log(`        ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parsedGame(value: unknown): Aoe4WorldGame {
  const game = parseGame(value);
  assert.ok(game !== null, "la partida debería parsearse");
  return game;
}

function normalized(value: unknown) {
  const result = normalizeGame(parsedGame(value), SAMPLE_PROFILE_ID, NOW);
  assert.ok(result.status === "ok", "la partida debería normalizarse");
  return result.match;
}

async function checkNormalization(): Promise<void> {
  console.log("Normalización de partidas");

  await check("la página de ejemplo trae las cuatro partidas", () => {
    const page = parseGamesPage(SAMPLE_PAGE);
    assert.ok(page !== null);
    assert.equal(page.games.length, 4);
    assert.equal(page.totalCount, 4);
    assert.equal(page.nextPage, null);
    assert.equal(page.games[0].leaderboard, "rm_solo");
    assert.equal(page.games[0].durationSeconds, 1800);
    assert.equal(page.games[1].durationSeconds, 2400);
    assert.equal(page.games[2].durationSeconds, null, "en curso no hay duración");
  });

  await check("ranked 1v1 ganada: resultado, rival, civs y finishedAt derivado", () => {
    const match = normalized(SOLO_WIN);
    assert.equal(match.gameId, "9000001");
    assert.equal(match.leaderboard, "rm_solo");
    assert.equal(match.result, "WIN");
    assert.equal(match.opponentProfileId, SAMPLE_OPPONENT_ID);
    assert.equal(match.opponentName, "Rival Muestra");
    assert.equal(match.civ, "britons");
    assert.equal(match.opponentCiv, "malians");
    assert.equal(match.map, "High View");
    assert.equal(match.durationSeconds, 1800);
    assert.equal(match.startedAt.toISOString(), "2026-09-26T18:00:00.000Z");
    assert.equal(match.finishedAt?.toISOString(), "2026-09-26T18:30:00.000Z");
  });

  await check("mode resuelve la familia de ladder a partir de lo que dice la API", () => {
    assert.equal(resolveGameMode("rm_1v1"), "rm_solo");
    assert.equal(resolveGameMode("rm_2v2"), "rm_team");
    assert.equal(resolveGameMode("rm_3v3"), "rm_team");
    assert.equal(resolveGameMode("rm_4v4"), "rm_team");
    assert.equal(resolveGameMode("rm_solo"), "rm_solo", "lo que ya viene canónico pasa tal cual");
    assert.equal(resolveGameMode("qm_1v1"), "qm_1v1", "un modo desconocido pasa tal cual");
    assert.equal(resolveGameMode(null), null);
    assert.equal(resolveGameMode("  "), null);

    assert.equal(normalized(SOLO_WIN).mode, "rm_solo");
    assert.equal(normalized(TEAM_LOSS).mode, "rm_team", "el 2v2 cuenta como ranked de equipos");
  });

  await check("civRandomized se lee del jugador de esta fila, no del compañero", () => {
    assert.equal(readOwnCivRandomized(parsedGame(SOLO_WIN), SAMPLE_PROFILE_ID), false);
    assert.equal(normalized(SOLO_WIN).civRandomized, false);

    // El compañero juega con civ aleatoria; el jugador de la fila no.
    const conCompaneroAleatorio = {
      ...TEAM_LOSS,
      teams: TEAM_LOSS.teams.map((team) =>
        team.map((entry) => {
          const player = entry.player;
          const profileId = player.profile_id;
          return { player: { ...player, civilization_randomized: profileId === SAMPLE_ALLY_ID } };
        }),
      ),
    };
    assert.equal(
      readOwnCivRandomized(parsedGame(conCompaneroAleatorio), SAMPLE_PROFILE_ID),
      false,
      "que el compañero lleve civ aleatoria no dice nada de esta fila",
    );

    const propia = {
      ...TEAM_LOSS,
      teams: TEAM_LOSS.teams.map((team) =>
        team.map((entry) => {
          const player = entry.player;
          return { player: { ...player, civilization_randomized: player.profile_id === SAMPLE_PROFILE_ID } };
        }),
      ),
    };
    assert.equal(readOwnCivRandomized(parsedGame(propia), SAMPLE_PROFILE_ID), true);
    assert.equal(normalized(propia).civRandomized, true);

    // Un payload sin el campo se interpreta como "no aleatoria", que es lo mismo
    // que el valor por defecto de la columna.
    assert.equal(readOwnCivRandomized(parsedGame(SOLO_WIN), SAMPLE_RIVAL_ID), false);
  });

  await check("solo cuentan las partidas clasificatorias resueltas", () => {
    const base = { mode: "rm_solo", result: "WIN" as const, finishedAt: NOW };

    assert.equal(countsAsRanked(base), true);
    assert.equal(countsAsRanked({ ...base, mode: "rm_team" }), true, "los equipos también son ranked");
    assert.equal(countsAsRanked({ ...base, finishedAt: null }), false, "en curso no puntúa");
    assert.equal(countsAsRanked({ ...base, result: null }), false, "sin resultado no puntúa");
    assert.equal(countsAsRanked({ ...base, mode: "qm_1v1" }), false, "una custom no es clasificatoria");
    assert.equal(countsAsRanked({ ...base, mode: null }), false, "sin ladder resuelta no puntúa");
    assert.equal(
      countsAsRanked({ ...base, mode: "rm_solo", result: "LOSS", finishedAt: NOW }),
      true,
      "una derrota cuenta como partida, aunque no dé puntos",
    );
  });

  await check("rawJson guarda la partida tal cual la devolvió la API", () => {
    const match = normalized(SOLO_WIN);
    assert.deepEqual(match.rawJson, SOLO_WIN);
  });

  await check("ranked por equipos: el rival es el primero del equipo contrario", () => {
    const match = normalized(TEAM_LOSS);
    assert.equal(match.leaderboard, "rm_team");
    assert.equal(match.result, "LOSS");
    assert.equal(match.opponentProfileId, SAMPLE_RIVAL_ID);
    assert.equal(match.opponentName, "Rival A");
    assert.equal(match.finishedAt?.toISOString(), "2026-09-26T17:40:00.000Z");
  });

  await check("partida en curso: se guarda con finishedAt y result a null", () => {
    const match = normalized(ONGOING_SOLO);
    assert.equal(match.finishedAt, null);
    assert.equal(match.result, null);
    assert.equal(match.durationSeconds, null);
    assert.equal(match.opponentProfileId, SAMPLE_OPPONENT_ID);
  });

  await check("partida en curso abandonada: se descarta en vez de inventar un resultado", () => {
    const result = normalizeGame(parsedGame(STALE_UNPROCESSED), SAMPLE_PROFILE_ID, NOW);
    assert.ok(result.status === "skipped");
    assert.match(result.reason, /sin resultado/);
  });

  await check("la ventana de directo es de 60 minutos y corta en el borde", () => {
    const enBorde = parsedGame({
      ...ONGOING_SOLO,
      started_at: new Date(NOW.getTime() - LIVE_GAME_WINDOW_MS).toISOString(),
    });
    assert.equal(isLiveGame(enBorde, NOW), true);

    const justPassed = parsedGame({
      ...ONGOING_SOLO,
      started_at: new Date(NOW.getTime() - LIVE_GAME_WINDOW_MS - 1).toISOString(),
    });
    assert.equal(isLiveGame(justPassed, NOW), false);

    const terminada = parsedGame({
      ...ONGOING_SOLO,
      ongoing: false,
      state: "processed",
      duration: 900,
    });
    assert.equal(isLiveGame(terminada, NOW), false);
  });

  await check("una partida sin ladder ni kind se descarta", () => {
    const result = normalizeGame(
      parsedGame({ ...SOLO_WIN, leaderboard: null, kind: null }),
      SAMPLE_PROFILE_ID,
      NOW,
    );
    assert.equal(result.status, "skipped");
  });

  await check("el endpoint de detalle (jugador plano) también se entiende", () => {
    const deLaLista = parseGamePlayer({ player: samplePlayer() });
    const delDetalle = parseGamePlayer(samplePlayer());

    assert.equal(deLaLista?.profileId, SAMPLE_PROFILE_ID);
    assert.equal(delDetalle?.profileId, SAMPLE_PROFILE_ID);
    assert.equal(delDetalle?.result, "win");
    assert.equal(delDetalle?.civilization, "britons");
  });

  await check("un payload roto no revienta: se descarta", () => {
    assert.equal(parseGame(null), null);
    assert.equal(parseGame({ game_id: 9_000_001 }), null, "sin started_at no hay partida");
    assert.equal(parseGame({ started_at: SOLO_WIN.started_at }), null, "sin game_id no hay partida");
    assert.equal(parseGame({ game_id: 9_000_001, started_at: "no-es-una-fecha" }), null);
    assert.equal(parseGamesPage({})?.games.length, 0);
  });
}

/**
 * Cliente falso: no toca la red, solo sirve los payloads de ejemplo. El listado
 * y el detalle son independientes a propósito, para poder reproducir el caso en
 * el que el listado ya no alcanza una partida y solo el detalle la resuelve.
 */
function createFakeClient(
  games: Aoe4WorldGame[],
  details: Map<string, Aoe4WorldGame> = new Map(),
  detailCalls: number[] = [],
): Aoe4WorldClient {
  return {
    async getPlayer() {
      return {
        profileId: SAMPLE_PROFILE_ID,
        name: "Jugador Muestra Actualizado",
        steamId: null,
        siteUrl: null,
        country: "es",
        avatars: { small: null, medium: null, full: null },
      };
    },
    async getPlayerGames(): Promise<Aoe4WorldGamesPage> {
      return {
        page: 1,
        perPage: 100,
        totalCount: games.length,
        count: games.length,
        nextPage: null,
        games: [...games],
      };
    },
    async getPlayerGame(_profileId, gameId) {
      detailCalls.push(gameId);

      const detail = details.get(String(gameId));

      if (detail === undefined) {
        throw new Aoe4WorldNotFoundError(`/players/${SAMPLE_PROFILE_ID}/games/${gameId}`);
      }

      return detail;
    },
    async getLeaderboard() {
      throw new Error("no se usa en esta verificación");
    },
    async autocompletePlayers() {
      throw new Error("no se usa en esta verificación");
    },
    stats: { requests: 0, retries: 0, rateLimitResponses: 0, rateLimitPausesMs: 0 },
  };
}

/**
 * Las comprobaciones de normalización usan el `NOW` congelado de arriba, así que
 * son deterministas. El worker, en cambio, juzga si una partida está "en
 * directo" contra el reloj real, así que su fixture tiene que anclarse a `now`
 * de verdad: si no, la partida en curso acaba ageing por fuera de la ventana de
 * 60 minutos y el worker la descarta (que es lo correcto, pero no lo que
 * queremos comprobar aquí).
 */
function buildFixtureAt(now: Date) {
  const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
  const liveStartedAt = ago(10).toISOString();

  return {
    solo: { ...SOLO_WIN, started_at: ago(180).toISOString() },
    team: { ...TEAM_LOSS, started_at: ago(300).toISOString() },
    // 10 minutos dentro de la ventana de 60, con 50 de margen: aunque la
    // comprobación tardara media hora, la partida seguiría "en curso".
    live: { ...ONGOING_SOLO, started_at: liveStartedAt },
    // La misma partida ya terminada: la API ahora sabe el resultado, así que
    // `result` y `duration` dejan de ser null y `state` pasa a `processed`.
    // Dura justo los 10 minutos que lleva jugada, así que acaba de terminar.
    liveFinished: {
      ...ONGOING_SOLO,
      started_at: liveStartedAt,
      duration: 600,
      state: "processed",
      ongoing: false,
      just_finished: true,
      teams: [
        [
          {
            player: samplePlayer({
              profile_id: SAMPLE_OPPONENT_ID,
              name: "Rival Muestra",
              result: "loss",
              civilization: "japanese",
            }),
          },
        ],
        [{ player: samplePlayer({ result: "win", civilization: "mongols" }) }],
      ],
    },
  };
}

async function runDatabaseChecks(): Promise<void> {
  // Importación diferida: las comprobaciones de normalización no tocan la base
  // de datos y así funcionan aunque `DATABASE_URL` no esté definida.
  const { syncApprovedPlayers } = await import("@/lib/aoe4world/sync");
  const { playerSyncKey, readPlayerSyncState, writePlayerSyncState } = await import(
    "@/lib/settings"
  );
  const { db } = await import("@/lib/db");

  const now = new Date();
  const fixture = buildFixtureAt(now);
  const soloStartedAt = new Date(fixture.solo.started_at);
  const liveStartedAt = new Date(fixture.live.started_at);

  const games: Aoe4WorldGame[] = [
    parsedGame(fixture.solo),
    parsedGame(fixture.team),
    parsedGame(fixture.live),
  ];

  const existing = await db.player.findUnique({ where: { profileId: SAMPLE_PROFILE_ID } });
  assert.equal(
    existing,
    null,
    `ya existe un jugador con profileId ${SAMPLE_PROFILE_ID}; bórralo antes de repetir la verificación`,
  );

  const player = await db.player.create({
    data: { profileId: SAMPLE_PROFILE_ID, name: "Jugador Muestra", status: "APPROVED" },
  });

  console.log("Guardado en base de datos");

  try {
    await check("la primera pasada inserta las partidas y guarda el cursor", async () => {
      const summary = await syncApprovedPlayers({
        profileIds: [SAMPLE_PROFILE_ID],
        client: createFakeClient(games),
      });

      const player = summary.players[0];
      assert.equal(summary.playersOk, 1);
      assert.equal(player.matchesInserted, 3);
      assert.equal(player.matchesUpdated, 0);
      assert.equal(player.matchesSkipped, 0, "no debería descartarse ninguna partida");
      assert.equal(player.liveMatches, 1);
      assert.equal(player.name, "Jugador Muestra Actualizado");

      const rows = await db.match.findMany({
        where: { player: { profileId: SAMPLE_PROFILE_ID } },
        orderBy: { gameId: "asc" },
      });
      assert.equal(rows.length, 3);

      const solo = rows.find((row) => row.gameId === "9000001");
      assert.equal(solo?.result, "WIN");
      assert.equal(solo?.leaderboard, "rm_solo");
      assert.equal(solo?.mode, "rm_solo", "la familia de ladder se resuelve al guardar");
      assert.equal(solo?.civRandomized, false);
      assert.equal(solo?.points, 1, "el motor da 1 punto a la victoria clasificatoria");
      assert.equal(
        solo?.finishedAt?.toISOString(),
        new Date(soloStartedAt.getTime() + 1_800_000).toISOString(),
        "finishedAt = started_at + duración",
      );

      const porEquipos = rows.find((row) => row.gameId === "9000002");
      assert.equal(porEquipos?.mode, "rm_team");
      assert.equal(porEquipos?.points, 0, "una derrota clasificatoria no da puntos, pero sí cuenta");

      const enCurso = rows.find((row) => row.gameId === "9000003");
      assert.equal(enCurso?.finishedAt, null);
      assert.equal(enCurso?.result, null);
      assert.equal(enCurso?.points, 0, "una partida en curso nunca puntúa");

      const state = await readPlayerSyncState(SAMPLE_PROFILE_ID);
      assert.ok(state !== null);
      assert.equal(
        state.maxStartedAt,
        liveStartedAt.toISOString(),
        "el cursor es el started_at más nuevo",
      );
      assert.equal(
        state.since,
        new Date(liveStartedAt.getTime() - 3_600_000).toISOString(),
        "el since lleva 60 min de solape",
      );
    });

    await check("la segunda pasada no duplica y refresca la partida en curso", async () => {
      // La partida en curso acaba de terminar: la API la devuelve procesada.
      games[2] = parsedGame(fixture.liveFinished);

      const summary = await syncApprovedPlayers({
        profileIds: [SAMPLE_PROFILE_ID],
        client: createFakeClient(games),
      });

      const player = summary.players[0];
      assert.equal(player.matchesInserted, 0, "no debe insertar nada nuevo");
      assert.equal(player.matchesUpdated, 1, "solo la que estaba en curso");
      assert.equal(player.matchesSkipped, 0, "ahora es jugable, no debe descartarse");
      assert.equal(
        player.sinceStored,
        player.sinceUsed,
        "sin partidas más nuevas el cursor se queda donde estaba",
      );

      const refrescada = await db.match.findFirst({
        where: { gameId: "9000003", player: { profileId: SAMPLE_PROFILE_ID } },
      });
      assert.equal(refrescada?.result, "WIN");
      assert.equal(refrescada?.finishedAt?.toISOString(), now.toISOString());
      assert.equal(refrescada?.durationSeconds, 600);

      const total = await db.match.count({ where: { player: { profileId: SAMPLE_PROFILE_ID } } });
      assert.equal(total, 3, "sigue habiendo tres filas, no se duplica nada");
    });

    await check("el nombre del jugador se refresca con el de AoE4World", async () => {
      const player = await db.player.findUnique({ where: { profileId: SAMPLE_PROFILE_ID } });
      assert.equal(player?.name, "Jugador Muestra Actualizado");
    });

    await check(
      "el refetch resuelve una partida en vivo que el listado ya no devuelve",
      async () => {
        // La partida 9000010 se guardó en vivo hace 90 min, pero el cursor está
        // 30 min por delante: el listado `since` ya no la alcanza.
        const startedAt = new Date(now.getTime() - 90 * 60_000);
        await db.match.create({
          data: {
            gameId: "9000010",
            playerId: player.id,
            leaderboard: "rm_solo",
            result: null,
            startedAt,
            finishedAt: null,
            rawJson: fixture.solo,
          },
        });

        await writePlayerSyncState(SAMPLE_PROFILE_ID, {
          since: new Date(now.getTime() - 60 * 60_000).toISOString(),
          maxStartedAt: new Date(now.getTime() - 30 * 60_000).toISOString(),
          lastSyncedAt: now.toISOString(),
          historyTruncated: false,
          abandonedCount: 0,
          abandonedGameIds: [],
          lastAbandonedAt: null,
        });

        // El detalle sí la devuelve ya resuelta; el listado no la menciona.
        const details = new Map<string, Aoe4WorldGame>([
          [
            "9000010",
            parsedGame({
              ...fixture.liveFinished,
              game_id: 9_000_010,
              started_at: startedAt.toISOString(),
              duration: 3300,
            }),
          ],
        ]);
        const detailCalls: number[] = [];

        const summary = await syncApprovedPlayers({
          profileIds: [SAMPLE_PROFILE_ID],
          client: createFakeClient(games, details, detailCalls),
        });

        const playerResult = summary.players[0];
        assert.equal(summary.resolvedByRefetch, 1);
        assert.equal(playerResult.matchesResolvedByRefetch, 1);
        assert.equal(playerResult.matchesAbandoned, 0, "una partida resuelta no se descarta");
        assert.deepEqual(detailCalls, [9_000_010], "solo se pide el detalle de la partida affected");

        const resuelta = await db.match.findFirst({
          where: { gameId: "9000010", playerId: player.id },
        });
        assert.equal(resuelta?.result, "WIN");
        assert.equal(resuelta?.durationSeconds, 3300);
        assert.equal(
          resuelta?.finishedAt?.toISOString(),
          new Date(startedAt.getTime() + 3300_000).toISOString(),
        );
      },
    );

    await check("una partida abandonada definitivamente se borra y queda anotada", async () => {
      // 9000011: la API la sigue dando en curso (nunca publica el desenlace).
      // 9000012: la API ya no la conoce (404). Se ordenan por antigüedad para
      // que la lista de abandonos sea predecible.
      await db.match.createMany({
        data: [
          {
            gameId: "9000011",
            playerId: player.id,
            leaderboard: "rm_solo",
            result: null,
            startedAt: new Date(now.getTime() - 210 * 60_000),
            finishedAt: null,
            rawJson: fixture.live,
          },
          {
            gameId: "9000012",
            playerId: player.id,
            leaderboard: "rm_solo",
            result: null,
            startedAt: new Date(now.getTime() - 200 * 60_000),
            finishedAt: null,
            rawJson: fixture.live,
          },
        ],
      });

      const details = new Map<string, Aoe4WorldGame>([
        [
          "9000011",
          parsedGame({
            ...fixture.live,
            game_id: 9_000_011,
            started_at: new Date(now.getTime() - 210 * 60_000).toISOString(),
          }),
        ],
      ]);

      const summary = await syncApprovedPlayers({
        profileIds: [SAMPLE_PROFILE_ID],
        client: createFakeClient(games, details),
      });

      const playerResult = summary.players[0];
      assert.equal(playerResult.matchesAbandoned, 2, "las dos se descartan");
      assert.equal(playerResult.matchesResolvedByRefetch, 0);
      assert.equal(summary.abandonedMatches, 2);

      const quedan = await db.match.count({
        where: { playerId: player.id, gameId: { in: ["9000011", "9000012"] } },
      });
      assert.equal(quedan, 0, "la fila borrada no puede volver a contar para F3");

      const state = await readPlayerSyncState(SAMPLE_PROFILE_ID);
      assert.ok(state !== null);
      assert.equal(state.abandonedCount, 2);
      assert.deepEqual(state.abandonedGameIds, ["9000011", "9000012"]);

      // El worker sella la hora con su propio reloj, unas milésimas después de
      // la del fixture, así que se comprueba que es reciente y no un instante exacto.
      const abandonedAt = Date.parse(state.lastAbandonedAt ?? "");
      assert.ok(!Number.isNaN(abandonedAt), "lastAbandonedAt debe ser una fecha válida");
      assert.ok(
        abandonedAt >= now.getTime() && abandonedAt - now.getTime() < 60_000,
        "lastAbandonedAt debe ser de ahora mismo",
      );
    });

    await check("la clave de Setting es la documentada", async () => {
      const setting = await db.setting.findUnique({
        where: { key: playerSyncKey(SAMPLE_PROFILE_ID) },
      });

      assert.ok(setting !== null);
      assert.equal(setting.key, "aoe4world.sync.player.9000001");
    });

    await check("el motor deja la clasificación al día y es idempotente", async () => {
      const { recomputeScores } = await import("@/lib/scoring");

      const primera = await recomputeScores();
      assert.equal(primera.ruleSetVersion, MVP_RULESET_VERSION);
      assert.equal(primera.playersRanked >= 1, true);

      const segunda = await recomputeScores();
      assert.equal(
        segunda.playersRanked,
        primera.playersRanked,
        "repetir el recálculo no crea filas nuevas",
      );
      assert.equal(segunda.playersUnranked, 0);

      const score = await db.playerScore.findUnique({
        where: { playerId_ruleSetVersion: { playerId: player.id, ruleSetVersion: MVP_RULESET_VERSION } },
      });

      assert.ok(score !== null, "el jugador de muestra tiene que estar en la clasificación");
      assert.ok(score.rank >= 1, "el puesto es un entero positivo");
      assert.equal(score.total, 3, "tres victorias clasificatorias (1v1, 2v2 y la del refetch)");
      assert.equal(score.wins, 3);
      assert.equal(score.matches, 4, "cuatro partidas clasificatorias resueltas: 3 ganadas y la perdida");

      // Los puntos de la tabla y los de la clasificación tienen que cuadrar.
      const puntosEnPartidas = await db.match.aggregate({
        where: { playerId: player.id },
        _sum: { points: true },
      });
      assert.equal(puntosEnPartidas._sum.points, score.total, "PlayerScore.total = suma de Match.points");

      // Ninguna partida en vivo ni abandonada puede haber colado puntos.
      const puntosInesperados = await db.match.aggregate({
        where: { playerId: player.id, points: { gt: 0 }, OR: [{ finishedAt: null }, { result: null }] },
        _sum: { points: true },
      });
      assert.equal(puntosInesperados._sum.points, null, "una partida sin resolver nunca puntúa");

      const breakdown = score.breakdown as {
        ruleSetVersion: number;
        rule: string;
        byMode: Record<string, { wins: number; points: number; matches: number }>;
      };
      assert.equal(breakdown.ruleSetVersion, MVP_RULESET_VERSION);
      assert.equal(typeof breakdown.rule, "string");
      assert.deepEqual(breakdown.byMode.rm_solo, { wins: 3, points: 3, matches: 3 });
      assert.deepEqual(breakdown.byMode.rm_team, { wins: 0, points: 0, matches: 1 });

      // Los puestos de toda la tabla tienen que ser coherentes con el orden.
      const todas = await db.playerScore.findMany({
        where: { ruleSetVersion: MVP_RULESET_VERSION },
        orderBy: { rank: "asc" },
        select: { rank: true, total: true, wins: true },
      });

      assert.deepEqual(
        todas.map((row) => row.rank),
        todas.map((_, index) => index + 1),
        "los puestos son un entero denso y sin huecos",
      );
      assert.equal(
        todas.every((row, index) => {
          const anterior = todas[index - 1];
          return anterior === undefined || anterior.total >= row.total;
        }),
        true,
        "el orden por rank coincide con el orden por puntos",
      );
    });

    await check("la clasificación pública solo muestra a los aprobados", async () => {
      const { getStandings, getLiveMatches, getTwitchChannels } = await import("@/lib/public");

      // Un segundo jugador, aprobado, sin partidas: no debe tener fila.
      const vacio = await db.player.create({
        data: { profileId: SAMPLE_PENDING_PROFILE_ID + 1, name: "Sin Partidas", status: "APPROVED" },
      });
      // Y uno pendiente, con partidas y canal: tampoco debe aparecer en nada.
      const pendiente = await db.player.create({
        data: {
          profileId: SAMPLE_PENDING_PROFILE_ID,
          name: "Jugador Pendiente",
          status: "PENDING",
          twitchChannel: "canal_pendiente",
        },
      });

      try {
        await db.match.create({
          data: {
            gameId: "9000099",
            playerId: pendiente.id,
            leaderboard: "rm_solo",
            mode: "rm_solo",
            result: null,
            startedAt: new Date(now.getTime() - 10 * 60_000),
            finishedAt: null,
            rawJson: fixture.live,
          },
        });

        const standings = await getStandings();
        const fila = standings.find((row) => row.profileId === SAMPLE_PROFILE_ID);

        assert.ok(fila !== undefined, "el jugador de muestra sale en la clasificación");
        assert.equal(fila.points, 3);
        assert.equal(fila.wins, 3);
        assert.equal(fila.wins + fila.losses, 4);
        assert.equal(
          standings.some((row) => row.profileId === vacio.profileId),
          false,
          "un aprobado sin partidas clasificatorias no tiene fila (P-02)",
        );
        assert.deepEqual(
          standings.map((row) => row.rank),
          standings.map((_, index) => index + 1),
          "los puestos son un entero denso y en orden",
        );

        const vivos = await getLiveMatches();
        assert.equal(
          vivos.some((row) => row.playerProfileId === SAMPLE_PENDING_PROFILE_ID),
          false,
          "una partida en curso de un jugador pendiente no se publica",
        );
        assert.equal(
          vivos.every((row) => row.startedAt instanceof Date),
          true,
          "startedAt llega como Date, no como texto",
        );

        await db.player.update({
          where: { id: player.id },
          data: { twitchChannel: "https://twitch.tv/Canal_De_Prueba" },
        });

        const canales = await getTwitchChannels();
        const mio = canales.find((row) => row.profileId === SAMPLE_PROFILE_ID);

        assert.ok(mio !== undefined, "el canal del jugador aprobado sale en la lista");
        assert.equal(mio.twitchChannel, "canal_de_prueba", "una URL se recorta a nombre de canal");
        assert.equal(
          canales.some((row) => row.profileId === SAMPLE_PENDING_PROFILE_ID),
          false,
          "los jugadores pendientes no publican canal",
        );
      } finally {
        await db.player.deleteMany({
          where: { profileId: { in: [SAMPLE_PENDING_PROFILE_ID, SAMPLE_PENDING_PROFILE_ID + 1] } },
        });
      }
    });
  } finally {
    await db.player.deleteMany({ where: { profileId: SAMPLE_PROFILE_ID } });
    await db.setting.deleteMany({ where: { key: playerSyncKey(SAMPLE_PROFILE_ID) } });
    console.log("  --    datos de prueba borrados");
  }
}

async function main(): Promise<void> {
  await checkNormalization();
  console.log("");

  if (process.argv.includes("--db")) {
    try {
      await runDatabaseChecks();
    } catch (error) {
      failures.push("guardado en base de datos");
      console.log(
        `  FALLA guardado en base de datos: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } else {
    console.log("Guardado en base de datos: omitido (añade --db para comprobarlo)");
  }

  console.log("");
  console.log(`${passed} comprobaciones correctas, ${failures.length} con errores.`);

  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

void main();
