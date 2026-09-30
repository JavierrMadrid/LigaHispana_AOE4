import "dotenv/config";

import assert from "node:assert/strict";

import { isLiveGame, LIVE_GAME_WINDOW_MS, normalizeGame, readOwnCivRandomized, resolveGameMode } from "@/lib/aoe4world/normalize";
import { parseGame, parseGamePlayer, parseGamesPage } from "@/lib/aoe4world/parse";
import { Aoe4WorldNotFoundError } from "@/lib/aoe4world/http";

import { CIVILIZATIONS, isKnownCivilization } from "@/lib/civs";
import { unwrapRead } from "@/lib/db-errors";
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import {
  countsAsRanked,
  DEFAULT_RULESET,
  mergeRuleset,
  RANKED_MODES,
  RULE_LABEL,
  RULESET_VERSION,
  SCORING_RULESET_KEY,
} from "@/lib/scoring";
import type { Aoe4WorldClient } from "@/lib/aoe4world/client";
import type { Aoe4WorldGame, Aoe4WorldGamesPage, Aoe4WorldLadderPage } from "@/lib/aoe4world/types";
import { isSyncTraceStale, type SyncRunTrace } from "@/lib/settings";

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
 * Objetivos que fija `docs/PUNTUACION.md`. Vive como constante y no como
 * `OBJECTIVE_COUNT` para que el número no pueda cambiar en los dos sitios a la vez
 * sin que se note.
 */
const EXPECTED_OBJECTIVE_COUNT = 38;
/**
 * Tercer jugador, solo para la ventana: sus partidas se colocan justo en los bordes
 * de `[from, to)` y son las que deciden qué cuenta.
 */
const WINDOW_PROFILE_ID = 9_000_006;

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
    civilization: "english",
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
    [{ player: samplePlayer({ result: "loss", civilization: "delhi_sultanate" }) }],
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
    assert.equal(match.civ, "english");
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
    const base = {
      mode: "rm_solo",
      result: "WIN" as const,
      startedAt: new Date("2026-09-20T18:00:00.000Z"),
      finishedAt: NOW,
      revertedAt: null,
    };
    const ventana = DEFAULT_RULESET.window;

    assert.equal(countsAsRanked(base, ventana), true);
    assert.equal(
      countsAsRanked({ ...base, mode: "rm_team" }, ventana),
      true,
      "los equipos también son ranked",
    );
    assert.equal(countsAsRanked({ ...base, finishedAt: null }, ventana), false, "en curso no puntúa");
    assert.equal(countsAsRanked({ ...base, result: null }, ventana), false, "sin resultado no puntúa");
    assert.equal(
      countsAsRanked({ ...base, mode: "qm_1v1" }, ventana),
      false,
      "una custom no es clasificatoria",
    );
    assert.equal(countsAsRanked({ ...base, mode: null }, ventana), false, "sin ladder resuelta no puntúa");
    assert.equal(
      countsAsRanked({ ...base, mode: "rm_solo", result: "LOSS", finishedAt: NOW }, ventana),
      true,
      "una derrota cuenta como partida, aunque no dé puntos",
    );
    assert.equal(
      countsAsRanked({ ...base, revertedAt: NOW }, ventana),
      false,
      "una partida revertida no cuenta, ni a favor ni en contra",
    );
  });

  await check("revertir y devolver usan el mismo criterio: que la partida cuente", () => {
    // Réplica de la guarda de `setMatchReverted()`. El criterio es el mismo en los
    // dos sentidos, y tiene que seguir siéndolo: invertido al restaurar, ninguna
    // partida clasificatoria se podía devolver. La guarda se pregunta siempre con
    // `revertedAt: null`, que es lo que la deja decidir por las otras tres
    // condiciones.
    const clasificatoria = {
      mode: "rm_team",
      result: "WIN" as const,
      startedAt: new Date("2026-09-29T23:55:24.000Z"),
      finishedAt: NOW,
      revertedAt: null,
    };
    const ventana = DEFAULT_RULESET.window;
    // El parámetro se toma del de `countsAsRanked` y no del literal de `clasificatoria`:
    // si se declarara con el tipo de este, `result: null` no entraría.
    const cuenta = (m: Parameters<typeof countsAsRanked>[0]) => countsAsRanked(m, ventana);

    assert.equal(cuenta(clasificatoria), true, "una partida clasificatoria cuenta");
    assert.equal(
      cuenta({ ...clasificatoria, mode: "qm_2v2" }),
      false,
      "una custom no cuenta, y por eso no hay nada que revertir ni que devolver",
    );
    assert.equal(
      cuenta({ ...clasificatoria, result: null }),
      false,
      "sin resolver no cuenta en ningún sentido",
    );
    assert.equal(
      countsAsRanked({ ...clasificatoria, revertedAt: NOW }, ventana),
      false,
      "marcada no cuenta, que es justo lo que deshace el restore",
    );
  });

  await check("el rastro de la pasada conserva el ultimo acierto", () => {
    // Réplica de `writeSyncRunTrace()`. Lo que importa no es el volcado de números
    // sino el `lastSuccessAt`: una racha de pasadas rotas tiene que seguir
    // enseñando cuándo funcionó por última vez, que es el número que contesta
    // «¿desde cuándo está roto?». Si avanzara con cada pasada fallida, el rastro
    // diría que todo va bien mientras nada va bien.
    const buena: Omit<SyncRunTrace, "lastSuccessAt"> = {
      startedAt: "2026-09-30T10:00:00.000Z",
      finishedAt: "2026-09-30T10:00:09.000Z",
      durationMs: 9000,
      playersTotal: 9,
      playersOk: 9,
      playersFailed: 0,
      playersCancelled: 0,
      newMatches: 495,
      updatedMatches: 0,
      resolvedByRefetch: 0,
      abandonedMatches: 0,
      skippedGames: 1,
      liveMatches: 0,
      apiRequests: 48,
      apiRetries: 0,
      rateLimitResponses: 0,
      rateLimitPausesMs: 0,
      ladderError: null,
      scoringError: null,
      alertsError: null,
      failures: [],
    };

    const salida = (
      sobre: Omit<SyncRunTrace, "lastSuccessAt">,
      anterior: SyncRunTrace | null,
    ): string | null => {
      const bien =
        sobre.playersFailed === 0 &&
        sobre.playersCancelled === 0 &&
        sobre.ladderError === null &&
        sobre.scoringError === null;

      return bien ? sobre.finishedAt : (anterior?.lastSuccessAt ?? null);
    };

    assert.equal(
      salida(buena, null),
      buena.finishedAt,
      "una pasada entera mueve el marcador",
    );
    assert.equal(
      salida({ ...buena, playersFailed: 1 }, { ...buena, lastSuccessAt: buena.finishedAt }),
      buena.finishedAt,
      "una pasada con un jugador fallido conserva el marcador anterior",
    );
    assert.equal(
      salida({ ...buena, playersFailed: 1 }, null),
      null,
      "sin rastro anterior, una pasada rota no inventa un marcador",
    );
    assert.equal(
      salida({ ...buena, scoringError: "se cayó la base" }, { ...buena, lastSuccessAt: buena.finishedAt }),
      buena.finishedAt,
      "fallar el recálculo tampoco mueve el marcador",
    );
    assert.equal(
      salida({ ...buena, ladderError: "429" }, { ...buena, lastSuccessAt: buena.finishedAt }),
      buena.finishedAt,
      "fallar la ladder tampoco lo mueve",
    );
    // `alertsError` está en el rastro pero **no** cuenta para "salió bien": el
    // marcador responde a «¿desde cuándo está roto el sincronizador?», y el motor
    // de alertas no trae ni una partida. Si contara, un fallo del informe daría
    // "el torneo lleva horas roto" sin que hubiera parado nada.
    assert.equal(
      salida({ ...buena, alertsError: "no se ha podido evaluar" }, { ...buena, lastSuccessAt: buena.finishedAt }),
      buena.finishedAt,
      "fallar el motor de alertas tampoco lo mueve",
    );
  });

  await check("una pasada vieja se detecta como vieja y una ausente no", () => {
    const ahora = new Date("2026-09-30T12:00:00.000Z");
    const pasada = (finishedAt: string): SyncRunTrace => ({
      startedAt: finishedAt,
      finishedAt,
      durationMs: 1000,
      playersTotal: 1,
      playersOk: 1,
      playersFailed: 0,
      playersCancelled: 0,
      newMatches: 0,
      updatedMatches: 0,
      resolvedByRefetch: 0,
      abandonedMatches: 0,
      skippedGames: 0,
      liveMatches: 0,
      apiRequests: 1,
      apiRetries: 0,
      rateLimitResponses: 0,
      rateLimitPausesMs: 0,
      ladderError: null,
      scoringError: null,
      alertsError: null,
      failures: [],
      lastSuccessAt: finishedAt,
    });

    assert.equal(isSyncTraceStale(null, ahora), false, "sin rastro no se dice que está viejo");
    assert.equal(
      isSyncTraceStale(pasada("2026-09-30T11:55:00.000Z"), ahora),
      false,
      `hace 5 minutos está al día`,
    );
    assert.equal(
      isSyncTraceStale(pasada("2026-09-30T11:00:00.000Z"), ahora),
      true,
      `hace una hora ya no está al día`,
    );
  });

  await check("la ventana de fechas se aplica por la fecha de inicio de la partida", () => {
    const { from, to } = DEFAULT_RULESET.window;
    const ventana = DEFAULT_RULESET.window;
    const resuelta = (startedAt: string) => ({
      mode: "rm_solo",
      result: "WIN" as const,
      startedAt: new Date(startedAt),
      finishedAt: NOW,
      revertedAt: null,
    });
    const milisegundoAntes = (instante: string) =>
      new Date(Date.parse(instante) - 1).toISOString();

    assert.ok(to !== null, "la ventana de pruebas tiene fin, para poder cortar los dos bordes");
    assert.equal(
      countsAsRanked(resuelta(milisegundoAntes(from)), ventana),
      false,
      "un milisegundo antes de `from` no cuenta",
    );
    assert.equal(countsAsRanked(resuelta(from), ventana), true, "`from` es inclusivo");
    assert.equal(
      countsAsRanked(resuelta(milisegundoAntes(to)), ventana),
      true,
      "un milisegundo antes de `to` todavía cuenta",
    );
    assert.equal(
      countsAsRanked(resuelta(to), ventana),
      false,
      "`to` es exclusivo: una partida empezada exactamente ahí ya es de la siguiente",
    );
    assert.equal(
      countsAsRanked(resuelta(new Date(Date.parse(to) + 1).toISOString()), ventana),
      false,
      "después de `to` no cuenta",
    );

    // La ventana se ancla en `startedAt`, no en `finishedAt`: lo que decide es
    // cuándo se jugó, no cuándo se publicó el desenlace.
    const empezadaDentroTerminadaDespues = {
      ...resuelta(from),
      finishedAt: new Date(Date.parse("2030-01-01T00:00:00.000Z")),
    };
    assert.equal(
      countsAsRanked(empezadaDentroTerminadaDespues, ventana),
      true,
      "empezada dentro de la ventana cuenta aunque termine fuera",
    );

    // `to: null` deja la ventana abierta por la derecha: es lo que permite fijar
    // el fin del torneo más tarde sin tocar código.
    const abierta = { from, to: null };
    assert.equal(
      countsAsRanked(resuelta("2031-06-01T12:00:00.000Z"), abierta),
      true,
      "con `to: null` no hay corte por la derecha",
    );
    assert.equal(
      countsAsRanked(resuelta(milisegundoAntes(from)), abierta),
      false,
      "`from` sigue cortando por la izquierda con la ventana abierta",
    );
  });

  await check("el `window` guardado se valida y lo raro cae al valor por defecto", () => {
    const porDefecto = DEFAULT_RULESET.window;

    // Sin `window` en `Setting`: el documento por defecto, sin avisos.
    const ausente = mergeRuleset({ version: RULESET_VERSION, pointsPerWin: 10 });
    assert.deepEqual(ausente.ruleset.window, porDefecto);
    assert.deepEqual(
      ausente.warnings.filter((warning) => warning.includes("window")),
      [],
      "una ventana ausente no es un error: es la de por defecto",
    );

    // Una ventana bien escrita se aplica tal cual, con las horas normalizadas.
    const buena = mergeRuleset({
      version: RULESET_VERSION,
      window: { from: "2026-09-15T02:00:00+02:00", to: "2026-10-15T00:00:00Z" },
    });
    assert.deepEqual(buena.ruleset.window, { from: "2026-09-15T00:00:00.000Z", to: "2026-10-15T00:00:00.000Z" });
    assert.deepEqual(buena.warnings, []);

    // `to: null` es legítimo: ventana abierta.
    const abierta = mergeRuleset({
      version: RULESET_VERSION,
      window: { from: "2026-09-15T00:00:00Z", to: null },
    });
    assert.equal(abierta.ruleset.window.to, null);
    assert.deepEqual(abierta.warnings, []);

    // Todo lo demás cae al valor por defecto, avisando, y sin romperse.
    const invalidos: unknown[] = [
      "no-es-un-objeto",
      {},
      { from: "ayer" },
      { from: "2026-09-15" },
      { from: "2026-09-15T00:00:00" },
      { from: 20261 },
      { from: "2026-09-15T00:00:00Z", to: "mañana" },
      { from: "2026-10-15T00:00:00Z", to: "2026-09-15T00:00:00Z" },
      { from: "2026-09-15T00:00:00Z", to: "2026-09-15T00:00:00Z" },
    ];

    for (const window of invalidos) {
      const resultado = mergeRuleset({ version: RULESET_VERSION, window });

      assert.deepEqual(
        resultado.ruleset.window,
        porDefecto,
        `window ${JSON.stringify(window)} debería caer al valor por defecto`,
      );
      assert.equal(
        resultado.warnings.some((warning) => warning.includes("window")),
        true,
        `window ${JSON.stringify(window)} debería avisar`,
      );
    }

    // Un `to` ausente hereda el del documento por defecto y lo dice: abrir la
    // ventana hay que pedirlo escribiendo `null`, no por olvidarse.
    const sinFin = mergeRuleset({
      version: RULESET_VERSION,
      window: { from: "2026-09-15T00:00:00Z" },
    });
    assert.equal(sinFin.ruleset.window.to, porDefecto.to);
    assert.equal(sinFin.warnings.some((warning) => warning.includes("window.to")), true);
  });

  await check("el ruleset por defecto no se contradice con las familias rankeadas", () => {
    assert.deepEqual(
      DEFAULT_RULESET.modes,
      [...RANKED_MODES],
      "las familias del ruleset por defecto son las rankeadas: si divergen, `countsAsRanked()` y el SQL filtrarían distinto",
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
    assert.equal(delDetalle?.civilization, "english");
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
 * El catálogo de objetivos, sin tocar la base de datos.
 *
 * Lo que decide el motor (qué objetivos hay, en qué orden, con qué rótulo, con
 * qué descripción y cuántos puntos) es código, no datos: se puede comprobar sin
 * `--db`. Lo que sí necesita la base es **quién posee cada uno**, y eso vive en
 * la otra mitad (`--db`).
 */
async function checkObjectiveCatalogue(): Promise<void> {
  console.log("Catálogo de objetivos");

  const {
    MASTERIZAR_TODOS_ID,
    OBJECTIVE_COUNT,
    OBJECTIVE_DEFINITIONS,
    OBJECTIVE_GROUP_LABELS,
    OBJECTIVE_POINTS,
    computeObjectives,
  } = await import("@/lib/objectives");

  await check(`el catálogo tiene los ${EXPECTED_OBJECTIVE_COUNT} objetivos de docs/PUNTUACION.md`, () => {
    assert.equal(OBJECTIVE_COUNT, EXPECTED_OBJECTIVE_COUNT);
    assert.equal(OBJECTIVE_DEFINITIONS.length, EXPECTED_OBJECTIVE_COUNT);
    assert.equal(
      new Set(OBJECTIVE_DEFINITIONS.map((definition) => definition.id)).size,
      EXPECTED_OBJECTIVE_COUNT,
      "los ids del catálogo no se repiten",
    );
    assert.deepEqual(
      [...new Set(OBJECTIVE_DEFINITIONS.map((definition) => definition.group))],
      ["actividad", "racha", "division", "formato", "civilizacion"],
      "los grupos salen en el orden documentado, sin intercalarse",
    );
  });

  await check("cada objetivo trae rótulo y descripción de la regla", () => {
    for (const definition of OBJECTIVE_DEFINITIONS) {
      assert.ok(definition.label.trim().length > 0, `${definition.id}: falta el rótulo`);
      assert.ok(
        definition.description.trim().length > 0,
        `${definition.id}: falta la descripción de la regla`,
      );
      assert.ok(
        definition.description.length <= 90,
        `${definition.id}: la descripción es una frase, no un párrafo`,
      );
      assert.equal(
        definition.description.endsWith("."),
        true,
        `${definition.id}: la descripción es una frase completa`,
      );
      assert.ok(definition.points > 0, `${definition.id}: los puntos por defecto son un entero`);
      assert.equal(
        definition.group in OBJECTIVE_GROUP_LABELS,
        true,
        `${definition.id}: el grupo no tiene rótulo`,
      );
    }
  });

  await check("ninguna descripción escribe un número del ruleset", () => {
    // El único número configurable que aparece en una regla es el mínimo
    // (`minimums.masterizar`), y por eso las descripciones no lo escriben: si lo
    // hicieran, dejarían de ser ciertas el día que se cambiara en `Setting`.
    // Los dígitos de "1v1" o de un nombre de civ no son números de configuración.
    for (const definition of OBJECTIVE_DEFINITIONS) {
      for (const minimum of Object.values(DEFAULT_RULESET.minimums)) {
        assert.equal(
          new RegExp(`\\b${minimum}\\b`).test(definition.description),
          false,
          `${definition.id}: la descripción escribe el mínimo ${minimum}, que es configurable`,
        );
      }
    }
  });

  await check("masterizarlos-a-todos: carrera al final del grupo de civilizaciones", () => {
    const ultimo = OBJECTIVE_DEFINITIONS.at(-1);
    const masterizarlos = OBJECTIVE_DEFINITIONS.find(
      (definition) => definition.id === MASTERIZAR_TODOS_ID,
    );

    assert.ok(masterizarlos !== undefined, "el objetivo existe en el catálogo");
    assert.equal(ultimo?.id, MASTERIZAR_TODOS_ID, "se presenta al final del grupo");
    assert.equal(masterizarlos.group, "civilizacion");
    assert.equal(masterizarlos.label, "Masterízalos a todos", "el rótulo es copy del cliente");
    assert.equal(
      masterizarlos.description,
      "El primero en ganar una partida con cada civilización.",
    );
    assert.equal(masterizarlos.metric, "victorias", "ordena por civilizaciones de forma entera");
    assert.ok(
      masterizarlos.points > Math.max(...CIVILIZATIONS.map(() => 70)),
      "los 100 puntos superan a los 70 de un masterizar-*",
    );
    assert.equal(
      DEFAULT_RULESET.objectives[MASTERIZAR_TODOS_ID],
      masterizarlos.points,
      "los puntos por defecto están en el ruleset",
    );
    assert.equal(
      MASTERIZAR_TODOS_ID.startsWith("masterizar-"),
      false,
      "el id no empieza por `masterizar-`, que es el prefijo de las civilizaciones",
    );
  });

  await check("el ruleset publica un punto por objetivo y ninguno de más", () => {
    const guardados = Object.keys(DEFAULT_RULESET.objectives);

    assert.deepEqual(
      guardados.sort(),
      OBJECTIVE_DEFINITIONS.map((definition) => definition.id).sort(),
      "`scoring.ruleset.objectives` tiene exactamente las claves del catálogo",
    );

    for (const definition of OBJECTIVE_DEFINITIONS) {
      assert.equal(
        DEFAULT_RULESET.objectives[definition.id],
        OBJECTIVE_POINTS[definition.id],
        `${definition.id}: el ruleset y el catálogo dicen lo mismo`,
      );
    }
  });

  await check("los puntos en juego son los de la tabla de §4", () => {
    const porGrupo = new Map<string, number>();

    for (const definition of OBJECTIVE_DEFINITIONS) {
      porGrupo.set(definition.group, (porGrupo.get(definition.group) ?? 0) + definition.points);
    }

    assert.equal(porGrupo.get("actividad"), 130, "Actividad");
    assert.equal(porGrupo.get("racha"), 110, "Racha");
    assert.equal(porGrupo.get("division"), 290, "Divisiones");
    assert.equal(porGrupo.get("formato"), 180, "Formatos");
    assert.equal(porGrupo.get("civilizacion"), 1710, "Civilizaciones");
    assert.equal(
      [...porGrupo.values()].reduce((suma, puntos) => suma + puntos, 0),
      2420,
      "el total en juego",
    );
  });

  await check("sin partidas no hay poseedores, y el ranking sale vacío", () => {
    const { options, pointsByPlayer, holders } = computeObjectives([], DEFAULT_RULESET);

    assert.equal(options.length, OBJECTIVE_COUNT, "los objetivos existen aunque no haya datos");
    assert.equal(holders, 0, "nadie posee nada sin partidas");
    assert.equal(pointsByPlayer.size, 0, "y nadie cobra");
    assert.equal(
      options.every((option) => option.holder === null && option.ranking.length === 0),
      true,
      "cada objetivo sale sin poseedor y con el ranking vacío, no relleno con ceros",
    );
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
    async getLadderPage(): Promise<Aoe4WorldLadderPage> {
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
 *
 * Las dos partidas **terminadas** sí se anclan a la ventana activa, con
 * `withinWindow()`, y no al reloj: no hay nada de "en directo" que juzgar, y así
 * las comprobaciones del motor no dependen del día en que se ejecuten ni se rompen
 * cuando la ventana de pruebas se mueva. La partida en directo no puede anclarse
 * (su prueba *es* la ventana de 60 minutos), así que sí depende de que la ventana
 * del torneo siga cubriendo el presente: lo comprueba la primera comprobación de
 * la sección de base de datos.
 */
function withinWindow(days: number): string {
  return new Date(Date.parse(DEFAULT_RULESET.window.from) + days * 86_400_000).toISOString();
}

function buildFixtureAt(now: Date) {
  const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
  const liveStartedAt = ago(10).toISOString();

  return {
    solo: { ...SOLO_WIN, started_at: withinWindow(2) },
    team: { ...TEAM_LOSS, started_at: withinWindow(3) },
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

/**
 * Comprobaciones de la ventana de fechas contra la base de datos de verdad.
 *
 * Usa un jugador aparte cuyas partidas están **justo en los bordes** de
 * `[from, to)`, y para el `to = null` sustituye temporalmente el ruleset guardado
 * y lo deja como estaba (con un `finally`, y recalculando al final para que la
 * clasificación real no se quede calculada con la ventana de prueba).
 */
async function runWindowChecks(
  db: PrismaClient,
  jugadorMuestra: { id: string },
): Promise<void> {
  const { getObjectives, readRuleset, recomputeScores } = await import("@/lib/scoring");
  const { countsAsRanked } = await import("@/lib/ranked-match");

  const ventana = (await readRuleset()).window;

  assert.ok(ventana.to !== null, "estas comprobaciones necesitan una ventana con los dos bordes");

  const from = Date.parse(ventana.from);
  const to = Date.parse(ventana.to);

  /** Las cinco partidas, todas ganadas y resueltas: solo decide la fecha de inicio. */
  const casos = [
    { gameId: "9000101", etiqueta: "justo antes de from", at: from - 1, dentro: false },
    { gameId: "9000102", etiqueta: "justo en from", at: from, dentro: true },
    { gameId: "9000103", etiqueta: "justo antes de to", at: to - 1, dentro: true },
    { gameId: "9000104", etiqueta: "justo en to", at: to, dentro: false },
    { gameId: "9000105", etiqueta: "después de to", at: to + 1, dentro: false },
  ];

  const existente = await db.player.findUnique({ where: { profileId: WINDOW_PROFILE_ID } });
  assert.equal(
    existente,
    null,
    `ya existe un jugador con profileId ${WINDOW_PROFILE_ID}; bórralo antes de repetir la verificación`,
  );

  // El ruleset guardado, para poder devolverlo tal cual estaba.
  const rulesetGuardado = await db.setting.findUnique({ where: { key: SCORING_RULESET_KEY } });

  const jugador = await db.player.create({
    data: { profileId: WINDOW_PROFILE_ID, name: "Jugador Ventana", status: "APPROVED" },
  });

  console.log("Ventana de fechas");

  try {
    await db.match.createMany({
      data: casos.map((caso) => ({
        gameId: caso.gameId,
        playerId: jugador.id,
        leaderboard: "rm_solo",
        mode: "rm_solo",
        civ: "english",
        result: "WIN" as const,
        startedAt: new Date(caso.at),
        finishedAt: new Date(caso.at + 1_800_000),
        rawJson: { game_id: Number(caso.gameId), kind: "rm_1v1", leaderboard: "rm_solo" },
      })),
    });

    await check("los dos bordes de la ventana se cortan como dice la regla", async () => {
      for (const caso of casos) {
        assert.equal(
          countsAsRanked(
            {
              mode: "rm_solo",
              result: "WIN",
              startedAt: new Date(caso.at),
              finishedAt: new Date(),
              revertedAt: null,
            },
            ventana,
          ),
          caso.dentro,
          `${caso.etiqueta} (${new Date(caso.at).toISOString()})`,
        );
      }
    });

    await check("una partida fuera de la ventana no puntúa, y el agregado la ignora", async () => {
      await recomputeScores();

      const puntos = await db.match.findMany({
        where: { playerId: jugador.id },
        orderBy: { startedAt: "asc" },
        select: { gameId: true, startedAt: true, points: true },
      });

      for (const caso of casos) {
        const fila = puntos.find((fila) => fila.gameId === caso.gameId);

        assert.ok(fila !== undefined, `falta la partida ${caso.gameId}`);

        if (caso.dentro) {
          assert.equal(
            fila.points,
            DEFAULT_RULESET.pointsPerWin,
            `${caso.etiqueta}: cuenta y puntúa`,
          );
        } else {
          assert.equal(fila.points, 0, `${caso.etiqueta}: no cuenta y no puntúa`);
        }
      }

      const score = await db.playerScore.findUnique({
        where: {
          playerId_ruleSetVersion: { playerId: jugador.id, ruleSetVersion: RULESET_VERSION },
        },
      });

      assert.ok(score !== null, "el jugador de la ventana está en la clasificación");
      assert.equal(
        score.matches,
        casos.filter((caso) => caso.dentro).length,
        "solo cuentan las partidas de dentro de la ventana",
      );
      assert.equal(score.wins, score.matches, "todas están ganadas");
      assert.equal(
        score.total - (score.breakdown as { objectives: { points: number } }).objectives.points,
        score.wins * DEFAULT_RULESET.pointsPerWin,
        "los puntos de partidas cuadran con las victorias de la ventana",
      );
    });

    await check("los objetivos cuentan las mismas partidas de la ventana", async () => {
      const { loadObjectivePlayers } = await import("@/lib/objectives");
      const dentro = casos.filter((caso) => caso.dentro).length;
      const agregados = await loadObjectivePlayers(db, (await readRuleset()));
      const suyo = agregados.find((agregado) => agregado.playerId === jugador.id);

      // Es el mismo filtro que el del `UPDATE` de `Match.points` y que el del
      // agregado de la clasificación, así que su recuento de partidas tiene que
      // coincidir con el de `PlayerScore.matches`.
      assert.equal(suyo?.matches, dentro, "el jugador de la ventana solo suma sus partidas de dentro");
      assert.equal(suyo?.wins, dentro, "y solo las ganadas, que aquí son todas");

      // Y tiene que ser el mismo número que el agregado de la clasificación.
      const score = await db.playerScore.findUnique({
        where: {
          playerId_ruleSetVersion: { playerId: jugador.id, ruleSetVersion: RULESET_VERSION },
        },
      });
      assert.equal(suyo?.matches, score?.matches, "objetivos y clasificación cuentan lo mismo");

      // La vista pública publica la clasificación entera de cada objetivo, así
      // que este jugador sale en todos los objetivos donde ha jugado. Si sale,
      // sus números tienen que ser los de la ventana.
      // `unwrapRead` en todos los sitios donde se lee de la base: una
      // comprobación que se traga un corte de la base y sigue con datos vacíos
      // daría "todo correcto" sin haber mirado nada. Aquí la lectura degradada
      // tiene que abortar.
      const vista = unwrapRead(await getObjectives(), "verify:objetivos/ventana");

      for (const option of vista.options) {
        const contendiente = option.ranking.find(
          (contendiente) => contendiente.profileId === WINDOW_PROFILE_ID,
        );

        if (contendiente !== undefined) {
          assert.ok(
            contendiente.matches <= dentro && contendiente.value <= dentro,
            `${option.id}: no puede competir con más de ${dentro} partidas de la ventana`,
          );
        }
      }
    });

    await check("con `to: null` la ventana se abre por la derecha", async () => {
      const { loadObjectivePlayers } = await import("@/lib/objectives");

      await db.setting.update({
        where: { key: SCORING_RULESET_KEY },
        data: {
          value: { ...(rulesetGuardado?.value as object), window: { from: ventana.from, to: null } },
        },
      });

      const abierta = (await readRuleset()).window;
      assert.equal(abierta.to, null, "el ruleset abierto se lee tal cual");

      await recomputeScores();

      const score = await db.playerScore.findUnique({
        where: {
          playerId_ruleSetVersion: { playerId: jugador.id, ruleSetVersion: RULESET_VERSION },
        },
      });

      // `from` sigue cortando por la izquierda: solo la partida de antes se queda
      // fuera. Las tres que estaban en o después de `to` vuelven a contar.
      const dentro = casos.filter((caso) => caso.dentro).length;
      const fueraPorLaIzquierda = casos.filter((caso) => !caso.dentro && caso.at < from).length;
      const esperada = casos.length - fueraPorLaIzquierda;

      assert.ok(esperada > dentro, "el cambio tiene que verse: con `to: null` cuenta más");
      assert.equal(
        score?.matches,
        esperada,
        "con la ventana abierta cuentan también las partidas de después de `to`",
      );

      const puntos = await db.match.aggregate({
        where: { playerId: jugador.id, points: { gt: 0 } },
        _count: { _all: true },
      });
      assert.equal(puntos._count._all, esperada, "y todas ellas puntúan");

      const agregados = await loadObjectivePlayers(db, (await readRuleset()));
      const suyo = agregados.find((agregado) => agregado.playerId === jugador.id);
      assert.equal(suyo?.matches, esperada, "los objetivos también las cuentan");
    });
  } finally {
    // Se devuelve el ruleset como estaba y se recalcula, para que la
    // clasificación real no se quede con la ventana abierta de la prueba.
    if (rulesetGuardado === null) {
      await db.setting.deleteMany({ where: { key: SCORING_RULESET_KEY } });
    } else {
      await db.setting.update({
        where: { key: SCORING_RULESET_KEY },
        data: { value: rulesetGuardado.value as Prisma.InputJsonValue },
      });
    }

    await db.player.deleteMany({ where: { profileId: WINDOW_PROFILE_ID } });
    await recomputeScores();
    assert.equal(
      (await db.playerScore.count({ where: { playerId: jugadorMuestra.id } })),
      1,
      "tras devolver la ventana, el jugador de muestra vuelve a estar en la clasificación",
    );
    console.log("  --    ventana de prueba restaurada");
  }
}

async function runDatabaseChecks(): Promise<void> {
  // Importación diferida: las comprobaciones de normalización no tocan la base
  // de datos y así funcionan aunque `DATABASE_URL` no esté definida.
  const { syncApprovedPlayers } = await import("@/lib/aoe4world/sync");
  const { playerSyncKey, readPlayerSyncState, writePlayerSyncState } = await import(
    "@/lib/settings"
  );
  const { db } = await import("@/lib/db");
  const { getObjectives, readRuleset, recomputeScores } = await import("@/lib/scoring");

  const now = new Date();
  const fixture = buildFixtureAt(now);
  const soloStartedAt = new Date(fixture.solo.started_at);
  const liveStartedAt = new Date(fixture.live.started_at);

  console.log("Guardado en base de datos");

  await check("la ventana activa cubre la fixture de esta verificación", async () => {
    const ventana = (await readRuleset()).window;
    const fin = ventana.to === null ? Number.POSITIVE_INFINITY : Date.parse(ventana.to);

    assert.ok(
      ventana.to !== null,
      `la ventana de ${SCORING_RULESET_KEY} está abierta (to = null) y las cuentas de esta verificación asumen un fin`,
    );
    assert.ok(
      soloStartedAt.getTime() < now.getTime() && new Date(fixture.team.started_at) < now,
      "la ventana activa tiene que empezar en el pasado, o las partidas de muestra serían futuras",
    );
    assert.ok(
      liveStartedAt.getTime() < fin,
      `la ventana activa (${ventana.from} — ${String(ventana.to)}) ya no cubre el presente y la partida en ` +
        "directo de la fixture caería fuera: hay que mover la ventana de DEFAULT_RULESET o esperar a la siguiente",
    );
  });

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
      assert.equal(
        player.name,
        "Jugador Muestra",
        "el resultado identifica al jugador por su nombre de display, no por el oficial",
      );

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
      assert.equal(
        solo?.points,
        DEFAULT_RULESET.pointsPerWin,
        "el motor da pointsPerWin puntos a la victoria clasificatoria",
      );
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

    await check(
      "el nombre de display no se pisa y el oficial va a su propia columna",
      async () => {
        const player = await db.player.findUnique({ where: { profileId: SAMPLE_PROFILE_ID } });
        assert.equal(
          player?.name,
          "Jugador Muestra",
          "el worker no toca `Player.name`: es lo que escribió quien se inscribió",
        );
        assert.equal(
          player?.aoe4WorldName,
          "Jugador Muestra Actualizado",
          "el nombre de AoE4World se guarda aparte, para poder publicar los dos",
        );
      },
    );

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
      const primera = await recomputeScores();
      assert.equal(primera.ruleSetVersion, RULESET_VERSION);
      assert.equal(primera.playersRanked >= 1, true);

      const segunda = await recomputeScores();
      assert.equal(
        segunda.playersRanked,
        primera.playersRanked,
        "repetir el recálculo no crea filas nuevas",
      );
      assert.equal(segunda.playersUnranked, 0);
      assert.equal(
        segunda.objectivesPoints,
        primera.objectivesPoints,
        "repetir el recálculo reparte los mismos objetivos",
      );

      const score = await db.playerScore.findUnique({
        where: { playerId_ruleSetVersion: { playerId: player.id, ruleSetVersion: RULESET_VERSION } },
      });

      assert.ok(score !== null, "el jugador de muestra tiene que estar en la clasificación");
      assert.ok(score.rank >= 1, "el puesto es un entero positivo");
      assert.equal(score.wins, 3);
      assert.equal(score.matches, 4, "cuatro partidas clasificatorias resueltas: 3 ganadas y la perdida");

      const breakdown = score.breakdown as {
        ruleSetVersion: number;
        rule: string;
        byMode: Record<string, { wins: number; points: number; matches: number }>;
        objectives: { points: number; earned: string[] };
      };

      const puntosDePartidas = DEFAULT_RULESET.pointsPerWin * score.wins;
      assert.equal(
        score.total,
        puntosDePartidas + breakdown.objectives.points,
        "total = victorias × pointsPerWin + puntos de objetivos",
      );

      // Los puntos de la tabla y los de las partidas tienen que cuadrar.
      const puntosEnPartidas = await db.match.aggregate({
        where: { playerId: player.id },
        _sum: { points: true },
      });
      assert.equal(
        puntosEnPartidas._sum.points,
        puntosDePartidas,
        "Match.points suma lo mismo que los puntos de partidas del desglose",
      );

      // Ninguna partida en vivo ni abandonada puede haber colado puntos.
      const puntosInesperados = await db.match.aggregate({
        where: { playerId: player.id, points: { gt: 0 }, OR: [{ finishedAt: null }, { result: null }] },
        _sum: { points: true },
      });
      assert.equal(puntosInesperados._sum.points, null, "una partida sin resolver nunca puntúa");

      assert.equal(breakdown.ruleSetVersion, RULESET_VERSION);
      assert.equal(typeof breakdown.rule, "string");
      assert.deepEqual(breakdown.byMode.rm_solo, {
        wins: 3,
        points: 3 * DEFAULT_RULESET.pointsPerWin,
        matches: 3,
      });
      assert.deepEqual(breakdown.byMode.rm_team, { wins: 0, points: 0, matches: 1 });

      // Los objetivos del desglose tienen que existir y sumar lo que dice el ruleset.
      assert.equal(
        breakdown.objectives.earned.every((id) => id in DEFAULT_RULESET.objectives),
        true,
        `objetivos desconocidos en el desglose: ${breakdown.objectives.earned.join(", ")}`,
      );
      assert.equal(
        breakdown.objectives.points,
        breakdown.objectives.earned.reduce(
          (sum, id) => sum + (DEFAULT_RULESET.objectives[id] ?? 0),
          0,
        ),
        "los puntos de objetivos cuadran con los ids ganados",
      );

      // Los puntos de partidas de toda la tabla suman lo que dice `Match.points`.
      const partidasAprobados = await db.match.aggregate({
        where: { player: { status: "APPROVED" }, mode: { in: DEFAULT_RULESET.modes } },
        _sum: { points: true },
      });
      assert.equal(
        primera.totalPoints - primera.objectivesPoints,
        partidasAprobados._sum.points ?? 0,
        "los puntos de partidas del recálculo cuadran con la suma de Match.points",
      );

      // Los puestos de toda la tabla tienen que ser coherentes con el orden.
      const todas = await db.playerScore.findMany({
        where: { ruleSetVersion: RULESET_VERSION },
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

      // `countsAsRanked()` (que decide fila a fila, en memoria) tiene que contar
      // lo mismo que el `groupBy` y que el `UPDATE` de `Match.points`, que son sus
      // dos traducciones a SQL. Es la comprobación que avisa si las tres se
      // desincronizan: se recorren todas las partidas del jugador de muestra y se
      // comparan las dos cuentas.
      const ventana = (await readRuleset()).window;
      const filas = await db.match.findMany({
        where: { playerId: player.id },
        select: {
          mode: true,
          result: true,
          startedAt: true,
          finishedAt: true,
          revertedAt: true,
          points: true,
        },
      });
      const enJs = filas.filter((fila) => countsAsRanked(fila, ventana));

      assert.equal(
        enJs.length,
        score.matches,
        "las partidas que cuentan en memoria son las que cuenta el agregado",
      );
      assert.equal(
        enJs.filter((fila) => fila.result === "WIN").length,
        score.wins,
        "y las victorias también",
      );
      assert.equal(
        enJs.reduce((sum, fila) => sum + fila.points, 0),
        score.total - breakdown.objectives.points,
        "los puntos de `Match.points` son los que suman en la clasificación",
      );
      assert.equal(
        filas.filter((fila) => !countsAsRanked(fila, ventana)).every((fila) => fila.points === 0),
        true,
        "ninguna partida que no cuenta puede tener puntos",
      );
    });

    await check("los objetivos se publican con el contrato previsto", async () => {
      const { MASTERIZAR_TODOS_ID, OBJECTIVE_COUNT, OBJECTIVE_GROUP_LABELS } = await import(
        "@/lib/objectives"
      );

      const view = unwrapRead(await getObjectives(), "verify:objetivos/contrato");

      assert.equal(view.ruleSetVersion, RULESET_VERSION);
      assert.equal(view.rule, RULE_LABEL, "la etiqueta pública es la del código");
      assert.deepEqual(
        view.window,
        (await readRuleset()).window,
        "la vista publica la ventana activa, para que el copy no lleve fechas escritas a mano",
      );
      assert.equal(
        view.pointsPerWin,
        DEFAULT_RULESET.pointsPerWin,
        "los puntos por victoria salen del ruleset activo",
      );
      assert.deepEqual(
        view.minimums,
        DEFAULT_RULESET.minimums,
        "los mínimos salen del ruleset activo",
      );
      assert.equal(
        view.options.length,
        OBJECTIVE_COUNT,
        `hay los ${OBJECTIVE_COUNT} objetivos de docs/PUNTUACION.md`,
      );

      const groups = view.options.map((option) => option.group);
      assert.deepEqual(
        [...new Set(groups)],
        ["actividad", "racha", "division", "formato", "civilizacion"],
        "los grupos salen en el orden documentado, sin intercalarse",
      );
      assert.deepEqual(
        view.options.slice(0, 4).map((option) => option.id),
        ["loco-por-ganar", "otp", "golpe-de-suerte", "prohibido-perder"],
        "otp va con Actividad y prohibido-perder con Racha, en ese orden",
      );
      assert.equal(
        groups.every((group) => group in OBJECTIVE_GROUP_LABELS),
        true,
        "todo grupo tiene rótulo",
      );

      // Copy exacto del cliente y métricas de Actividad y Racha (§3.2-§3.3).
      const porId = new Map(view.options.map((option) => [option.id, option]));

      assert.equal(
        porId.get("golpe-de-suerte")?.label,
        "¿Golpe de suerte?",
        "el rótulo de `golpe-de-suerte` es copy del cliente",
      );
      assert.equal(
        porId.get("sensei-oro")?.label,
        "El Sensei de Oro",
        "los rótulos de `sensei-*` son copy del cliente",
      );
      assert.equal(
        porId.get("otp")?.group,
        "actividad",
        "otp se agrupa en Actividad (sin grupo Dominio)",
      );
      assert.equal(
        porId.get("prohibido-perder")?.group,
        "racha",
        "prohibido-perder se agrupa en Racha (sin grupo Dominio)",
      );
      assert.equal(
        porId.get("otp")?.metric,
        "victorias",
        "otp lo decide el máximo de victorias con una misma civ, sin umbral",
      );
      assert.equal(
        porId.get("prohibido-perder")?.metric,
        "winrate",
        "prohibido-perder sigue decidiéndose por ratio",
      );

      // `masterizarlos-a-todos`: el objetivo que abarca las 23 civilizaciones,
      // al final del grupo y con la etiqueta fijada por el cliente.
      const todos = porId.get(MASTERIZAR_TODOS_ID);

      assert.ok(todos !== undefined, "masterizarlos-a-todos existe");
      assert.equal(
        view.options.at(-1)?.id,
        MASTERIZAR_TODOS_ID,
        "masterizarlos-a-todos se presenta al final del grupo de civilizaciones",
      );
      assert.equal(
        todos.group,
        "civilizacion",
        "masterizarlos-a-todos va en el grupo Civilizaciones",
      );
      assert.equal(
        todos.label,
        "Masterízalos a todos",
        "el rótulo de `masterizarlos-a-todos` es copy del cliente",
      );
      assert.equal(
        todos.points,
        DEFAULT_RULESET.objectives[MASTERIZAR_TODOS_ID],
        "los 100 de masterizarlos-a-todos salen del ruleset, como los demás",
      );
      assert.equal(
        porId.get("masterizar-japanese")?.points,
        DEFAULT_RULESET.objectives["masterizar-japanese"],
        "y un masterizar-* sigue valiendo lo que diga el ruleset",
      );
      // Nadie que no haya ganado con todas las civs puede tenerlo, así que en
      // la prueba (que no llega a las 23) el objetivo tiene que salir vacío.
      assert.equal(
        todos.holder,
        null,
        "sin las 23 civilizaciones dominadas el objetivo no tiene poseedor",
      );
      for (const contender of todos.ranking) {
        assert.ok(
          contender.value <= CIVILIZATIONS.length,
          `masterizarlos-a-todos: ${contender.value} civilizaciones no puede pasar de ${CIVILIZATIONS.length}`,
        );
        assert.equal(
          contender.eligible,
          contender.value === CIVILIZATIONS.length,
          "masterizarlos-a-todos: solo es elegible quien las tiene todas",
        );
        assert.ok(
          contender.matches >= contender.value,
          "masterizarlos-a-todos: cada civ dominada necesita al menos una partida",
        );
      }

      // El detalle de `otp`: la civilización del jugador, en el catálogo.
      const otp = porId.get("otp");

      assert.ok(otp !== undefined, "otp existe");

      for (const contender of otp.ranking) {
        assert.ok(contender.detail, `otp: ${contender.name} lleva su civ en detail`);
        assert.equal(
          isKnownCivilization(contender.detail.id),
          true,
          `otp: ${contender.detail.id} es una civ del catálogo`,
        );
        assert.ok(
          contender.detail.label.length > 0,
          `otp: la civ ${contender.detail.id} tiene nombre en español`,
        );
      }

      assert.equal(
        view.options
          .filter((option) => option.id !== "otp")
          .every((option) => option.ranking.every((contender) => contender.detail == null)),
        true,
        "solo otp rellena detail",
      );

      const holders = new Set<string>();

      for (const option of view.options) {
        assert.equal(
          option.points,
          DEFAULT_RULESET.objectives[option.id],
          `${option.id}: los puntos salen del ruleset`,
        );
        assert.ok(
          option.description.trim().length > 0,
          `${option.id}: la descripción de la regla no está vacía`,
        );
        // Sin mínimos dentro: el único configurable es `minimums.masterizar`
        // (y los de ratio y racha), y si uno estuviera escrito en la
        // descripción dejaría de ser cierto el día que se cambiara en
        // `Setting`. Los dígitos de "1v1" o de una civ no cuentan: no son
        // números de configuración.
        for (const minimum of Object.values(view.minimums)) {
          assert.equal(
            new RegExp(`\\b${minimum}\\b`).test(option.description),
            false,
            `${option.id}: la descripción no escribe el mínimo ${minimum}, que es configurable`,
          );
        }
        assert.equal(
          new Set(option.ranking.map((contender) => contender.profileId)).size,
          option.ranking.length,
          `${option.id}: el ranking no repite jugador`,
        );

        for (const contender of option.ranking) {
          assert.equal(typeof contender.value, "number", `${option.id}: value es numérico`);
          assert.equal(
            typeof contender.eligible,
            "boolean",
            `${option.id}: eligible marca si cumple el mínimo`,
          );
          assert.equal(
            contender.profileUrl,
            `https://aoe4world.com/players/${contender.profileId}`,
            `${option.id}: profileUrl con el mismo criterio que la clasificación`,
          );
        }

        if (option.holder !== null) {
          holders.add(option.id);
          assert.equal(option.holder.eligible, true, `${option.id}: el poseedor cumple el mínimo`);
          // El ranking va entero, así que el poseedor tiene que salir en él con
          // la posición que le da su métrica: no se extrae ni se pone el primero.
          assert.ok(
            option.ranking.some(
              (contender) => contender.profileId === option.holder?.profileId,
            ),
            `${option.id}: el poseedor aparece en el ranking, marcado por holder`,
          );
        }
      }

      // Lo que el motor anotó en el desglose tiene que coincidir con lo que
      // publica la vista: mismos objetivos, mismos poseedores.
      const score = await db.playerScore.findUnique({
        where: { playerId_ruleSetVersion: { playerId: player.id, ruleSetVersion: RULESET_VERSION } },
      });

      assert.ok(score !== null);
      const breakdown = score.breakdown as { rule: string; objectives: { earned: string[] } };
      assert.equal(breakdown.rule, RULE_LABEL, "el desglose guarda la etiqueta del código");
      assert.equal(
        breakdown.objectives.earned.every((id) => holders.has(id)),
        true,
        `el desglose anota objetivos que no tienen poseedor: ${breakdown.objectives.earned.join(", ")}`,
      );

      // `ensureRuleset` corrige la copia guardada: en `Setting` no puede quedar
      // el texto de una versión anterior de las reglas.
      const stored = await db.setting.findUnique({ where: { key: SCORING_RULESET_KEY } });

      assert.ok(stored !== null, "el ruleset está publicado en Setting");
      assert.equal(
        typeof stored.value === "object" &&
          stored.value !== null &&
          !Array.isArray(stored.value)
          ? (stored.value as { label?: unknown }).label
          : undefined,
        RULE_LABEL,
        "el label guardado en scoring.ruleset es el del código",
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

        const standings = unwrapRead(await getStandings(), "verify:clasificacion");
        const fila = standings.find((row) => row.profileId === SAMPLE_PROFILE_ID);

        assert.ok(fila !== undefined, "el jugador de muestra sale en la clasificación");
        assert.equal(
          fila.name,
          "Jugador Muestra",
          "la clasificación publica el nombre de display",
        );
        assert.equal(
          fila.aoe4WorldName,
          "Jugador Muestra Actualizado",
          "y también el oficial, para poder pintar los dos",
        );

        const esperado = await db.playerScore.findUnique({
          where: {
            playerId_ruleSetVersion: { playerId: player.id, ruleSetVersion: RULESET_VERSION },
          },
        });

        assert.ok(esperado !== null);
        assert.equal(fila.points, esperado.total, "la tabla pública lee el total del agregado");
        assert.equal(fila.wins, esperado.wins);
        assert.equal(fila.wins + fila.losses, 4);
        assert.equal(
          fila.points >= 3 * DEFAULT_RULESET.pointsPerWin,
          true,
          "con los objetivos no se puede sumar menos que con las partidas solas",
        );
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

        const vivos = unwrapRead(await getLiveMatches(), "verify:partidas-en-curso");
        assert.equal(
          vivos.some((match) =>
            match.participants.some(
              (participant) =>
                participant.profileId === SAMPLE_PENDING_PROFILE_ID && participant.isLeaguePlayer,
            ),
          ),
          false,
          "una partida en curso de un jugador pendiente no se publica",
        );
        assert.equal(
          vivos.every((match) => match.startedAt instanceof Date),
          true,
          "startedAt llega como Date, no como texto",
        );

        // Una partida con **dos** participantes del torneo tiene dos filas
        // `Match` (unicidad `(playerId, gameId)`), pero es una sola partida y
        // cada jugador aparece una sola vez dentro de ella.
        const gameIdCruce = "9000098";
        const teamsCruce = [
          [{ player: samplePlayer({ result: null, civilization: "mongols" }) }],
          [
            {
              player: samplePlayer({
                profile_id: vacio.profileId,
                name: vacio.name,
                result: null,
                civilization: "japanese",
              }),
            },
          ],
        ];

        await db.match.createMany({
          data: [
            {
              gameId: gameIdCruce,
              playerId: player.id,
              leaderboard: "rm_solo",
              mode: "rm_solo",
              civ: "mongols",
              opponentProfileId: vacio.profileId,
              opponentName: vacio.name,
              opponentCiv: "japanese",
              result: null,
              startedAt: new Date(now.getTime() - 5 * 60_000),
              finishedAt: null,
              rawJson: { ...fixture.live, game_id: 9_000_098, teams: teamsCruce },
            },
            {
              gameId: gameIdCruce,
              playerId: vacio.id,
              leaderboard: "rm_solo",
              mode: "rm_solo",
              civ: "japanese",
              opponentProfileId: player.profileId,
              opponentName: player.name,
              opponentCiv: "mongols",
              result: null,
              startedAt: new Date(now.getTime() - 5 * 60_000),
              finishedAt: null,
              rawJson: { ...fixture.live, game_id: 9_000_098, teams: teamsCruce },
            },
          ],
        });

        const conCruce = unwrapRead(await getLiveMatches(), "verify:partidas-cruce");

        assert.equal(
          conCruce.filter((match) => match.gameId === gameIdCruce).length,
          1,
          "una partida con dos participantes de la liga se publica una sola vez",
        );
        assert.equal(
          new Set(conCruce.map((match) => match.gameId)).size,
          conCruce.length,
          "no hay dos entradas con el mismo gameId",
        );

        const cruce = conCruce.find((match) => match.gameId === gameIdCruce);

        assert.ok(cruce !== undefined, "el cruce sale en la lista");
        assert.deepEqual(
          cruce.participants.map((participant) => participant.profileId).sort(),
          [player.profileId, vacio.profileId].sort(),
          "cada participante aparece una sola vez y son los dos",
        );
        assert.equal(cruce.leaguePlayerCount, 2, "los dos se marcan como de la liga");
        assert.equal(
          cruce.participants.every((participant) => participant.isLeaguePlayer),
          true,
          "los dos participantes están aprobados",
        );
        assert.deepEqual(
          cruce.participants.map((participant) => participant.team),
          [1, 2],
          "la alineación sale en orden de equipos",
        );
        assert.equal(cruce.format, "1vs1", "el formato sale resuelto y legible");
        assert.deepEqual(
          cruce.participants.map((participant) => participant.civ),
          ["mongols", "japanese"],
          "cada jugador conserva su civilización",
        );

        await db.match.deleteMany({ where: { gameId: gameIdCruce } });

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

    await runWindowChecks(db, player);
  } finally {
    await db.player.deleteMany({ where: { profileId: SAMPLE_PROFILE_ID } });
    await db.setting.deleteMany({ where: { key: playerSyncKey(SAMPLE_PROFILE_ID) } });
    console.log("  --    datos de prueba borrados");
  }
}

async function main(): Promise<void> {
  await checkNormalization();
  console.log("");
  await checkObjectiveCatalogue();
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
