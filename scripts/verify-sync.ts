import "./load-env.mjs";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { isLiveGame, LIVE_GAME_WINDOW_MS, normalizeGame, readOwnCivRandomized, resolveGameMode } from "@/lib/aoe4world/normalize";
import { parseGame, parseGamePlayer, parseGamesPage } from "@/lib/aoe4world/parse";
import { Aoe4WorldError, Aoe4WorldNotFoundError } from "@/lib/aoe4world/http";

import { CIVILIZATIONS } from "@/lib/civs";
import { unwrapRead } from "@/lib/db-errors";
import { SUBDIVISION_RANK_LEVELS } from "@/lib/divisions";
import { describeMode, describeTeamSize, teamSizesFromRawJson } from "@/lib/format";
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { AlertKind, AlertRule, ObjectiveLeadKind, PlayerStatus } from "@/generated/prisma/enums";
import type { TeamTierContext } from "@/lib/ranked-match";
import {
  historyComparator,
  readActionsSort,
  readAlertsFilters,
  readAlertsSort,
  readHistoryFilters,
  readHistorySort,
  readPlayerIdFilter,
  type AdminHistorySort,
  type AdminMatchHistoryRow,
} from "@/lib/admin";
import { historyFeedPage, historyFeedWindows } from "@/lib/history-feed";
import {
  countsAsRanked,
  DEFAULT_RULESET,
  mergeRuleset,
  RANKED_MODES,
  RULESET_VERSION,
  SCORING_CACHE_VERSION,
  SCORING_RULESET_KEY,
} from "@/lib/scoring";
import type {
  Aoe4WorldBulkGamesQuery,
  Aoe4WorldClient,
  Aoe4WorldGamesQuery,
} from "@/lib/aoe4world/client";
import type {
  Aoe4WorldGame,
  Aoe4WorldGamesPage,
  Aoe4WorldLadderPage,
  Aoe4WorldLeaderboard,
} from "@/lib/aoe4world/types";
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
/** Segundo aprobado de la verificación del masivo: partida compartida y truncación. */
const SAMPLE_BULK_SECOND_PROFILE_ID = 9_000_020;
const SAMPLE_PROFILE_IDS = [SAMPLE_PROFILE_ID, SAMPLE_BULK_SECOND_PROFILE_ID] as const;

/**
 * Objetivos que fija `docs/OBJETIVOS.md`. Vive como constante y no como
 * `OBJECTIVE_COUNT` para que el número no pueda cambiar en los dos sitios a la vez
 * sin que se note.
 */
const EXPECTED_OBJECTIVE_COUNT = 88;
/**
 * Tercer jugador, solo para la ventana: sus partidas se colocan justo en los bordes
 * de `[from, to)` y son las que deciden qué cuenta.
 */
const WINDOW_PROFILE_ID = 9_000_006;
/** Todos los `profileId` que este script crea y debe borrar, pase lo que pase. */
const TEST_PROFILE_IDS = [
  ...SAMPLE_PROFILE_IDS,
  SAMPLE_PENDING_PROFILE_ID,
  SAMPLE_PENDING_PROFILE_ID + 1,
  WINDOW_PROFILE_ID,
] as const;

/**
 * Contexto de equipos **sin cortes** con el que corren las comprobaciones puras de
 * este script: sin cortes cacheados la condición de compañeros no se puede
 * comprobar, así que esas comprobaciones miden las otras cinco condiciones. La
 * condición de equipos tiene la suya, más abajo y contra la base de datos, con unos
 * cortes sintéticos publicados en `Setting` a propósito.
 */
const SIN_EQUIPOS: TeamTierContext = { profileId: SAMPLE_PROFILE_ID, cutoffs: null };

/**
 * Los países de `paises.txt`, escritos aquí aparte a propósito: es la lista que la
 * organización definió y la que `npm run countries:seed` siembra, así que si
 * `DEFAULT_COUNTRIES` dejara de coincidir con ella la comprobación tiene que
 * fallar. Igual que `EXPECTED_OBJECTIVE_COUNT`, vive como constante para que los
 * dos sitios no puedan cambiar a la vez sin que se note.
 */
const EXPECTED_COUNTRIES = [
  "Colombia",
  "España",
  "Venezuela",
  "Perú",
  "Ecuador",
  "Guatemala",
  "Bolivia",
  "Cuba",
  "República Dominicana",
  "Honduras",
  "Paraguay",
  "El Salvador",
  "Nicaragua",
  "Costa Rica",
  "Panamá",
  "Guinea Ecuatorial",
  "Antigua y Barbuda",
  "México",
  "Argentina",
  "Chile",
  "Uruguay",
  "Puerto Rico",
];

/** La lista fuente de la siembra, en la raíz del repositorio. */
const PAISES_FILE = path.join(process.cwd(), "paises.txt");

/**
 * El ISO 3166-1 alfa-2 de cada país de `paises.txt`, en minúsculas como los
 * devuelve AoE4World en `player.country`.
 *
 * Vive aquí aparte, por el mismo motivo que `EXPECTED_COUNTRIES`: la traducción
 * vive en `src/lib/countries.ts`, junto a `DEFAULT_COUNTRIES`, y si las dos
 * tablas se escribieran en el mismo sitio un cambio a medias no se notaría. Aquí
 * está como dato esperado, así que añadir un país a la lista sin su ISO (o al
 * revés) falla la comprobación.
 *
 * Los dos que más se confunden van comentados porque son los que aparecen en la
 * lista: Puerto Rico y República Dominicana.
 */
const EXPECTED_COUNTRY_ISOS: Readonly<Record<string, string>> = {
  Colombia: "co",
  España: "es",
  Venezuela: "ve",
  Perú: "pe",
  Ecuador: "ec",
  Guatemala: "gt",
  Bolivia: "bo",
  Cuba: "cu",
  "República Dominicana": "do",
  Honduras: "hn",
  Paraguay: "py",
  "El Salvador": "sv",
  Nicaragua: "ni",
  "Costa Rica": "cr",
  Panamá: "pa",
  "Guinea Ecuatorial": "gq",
  "Antigua y Barbuda": "ag",
  México: "mx",
  Argentina: "ar",
  Chile: "cl",
  Uruguay: "uy",
  "Puerto Rico": "pr",
};

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
    // `null` es el `Player.registeredAt` de toda la fila que ya estaba inscrita, así
    // que estas comprobaciones cubren el caso mayoritario.
    const cuenta = (m: Parameters<typeof countsAsRanked>[0], registeredAt: Date | null = null) =>
      countsAsRanked(m, ventana, registeredAt, SIN_EQUIPOS);

    assert.equal(cuenta(base), true);
    assert.equal(
      cuenta({ ...base, mode: "rm_team" }),
      true,
      "los equipos también son ranked",
    );
    assert.equal(cuenta({ ...base, finishedAt: null }), false, "en curso no puntúa");
    assert.equal(cuenta({ ...base, result: null }), false, "sin resultado no puntúa");
    assert.equal(
      cuenta({ ...base, mode: "qm_1v1" }),
      false,
      "una custom no es clasificatoria",
    );
    assert.equal(cuenta({ ...base, mode: null }), false, "sin ladder resuelta no puntúa");
    assert.equal(
      cuenta({ ...base, mode: "rm_solo", result: "LOSS", finishedAt: NOW }),
      true,
      "una derrota cuenta como partida, aunque no dé puntos",
    );
    assert.equal(
      cuenta({ ...base, revertedAt: NOW }),
      false,
      "una partida revertida no cuenta, ni a favor ni en contra",
    );
  });

  await check("el corte de inscripcion sube con `registeredAt` y no toca el `to`", () => {
    const ventana = DEFAULT_RULESET.window;
    const alta = new Date("2026-09-25T12:00:00.000Z");
    const partida = (startedAt: string) => ({
      mode: "rm_solo",
      result: "WIN" as const,
      startedAt: new Date(startedAt),
      finishedAt: NOW,
      revertedAt: null,
    });

    // Un alta posterior a la ventana no acorta nada: es el comportamiento que ya
    // había y el que le toca a todo el que se|Apuntó antes de empezar.
    assert.equal(
      countsAsRanked(partida("2026-09-16T10:00:00.000Z"), ventana, new Date("2026-09-01T00:00:00Z"), SIN_EQUIPOS),
      true,
      "inscrito antes de la ventana: cuenta desde `window.from`",
    );
    assert.equal(
      countsAsRanked(partida("2026-09-24T23:59:59.999Z"), ventana, alta, SIN_EQUIPOS),
      false,
      "un alta posterior no cuenta las partidas de antes de la inscripcion",
    );
    assert.equal(
      countsAsRanked(partida("2026-09-25T12:00:00.000Z"), ventana, alta, SIN_EQUIPOS),
      true,
      "el corte es inclusivo",
    );
    assert.equal(
      countsAsRanked(partida("2026-09-26T10:00:00.000Z"), ventana, alta, SIN_EQUIPOS),
      true,
      "despues del alta si cuenta",
    );

    // `null` y "inscrito antes de la ventana" tienen que ser indistinguibles.
    for (const instante of [
      "2026-09-14T23:59:59.999Z",
      "2026-09-15T00:00:00.000Z",
      "2026-09-25T12:00:00.000Z",
      "2026-10-14T23:59:59.999Z",
      "2026-10-15T00:00:00.000Z",
    ]) {
      assert.equal(
        countsAsRanked(partida(instante), ventana, new Date("2026-09-01T00:00:00Z"), SIN_EQUIPOS),
        countsAsRanked(partida(instante), ventana, null, SIN_EQUIPOS),
        `registeredAt null debería ser lo mismo que inscritarse antes, en ${instante}`,
      );
    }

    // El `to` exclusivo no se mueve por el corte, y el corte no destapa el resto de
    // las condiciones.
    assert.equal(
      countsAsRanked(partida("2026-10-15T00:00:00.000Z"), ventana, null, SIN_EQUIPOS),
      false,
      "`to` sigue siendo exclusivo",
    );
    assert.equal(
      countsAsRanked({ ...partida("2026-09-26T10:00:00.000Z"), revertedAt: NOW }, ventana, alta, SIN_EQUIPOS),
      false,
      "el corte no destapa la marca de revertida",
    );
    assert.equal(
      countsAsRanked({ ...partida("2026-09-26T10:00:00.000Z"), finishedAt: null }, ventana, alta, SIN_EQUIPOS),
      false,
      "el corte no destapa una partida sin resolver",
    );
  });

  await check("anular y devolver usan el mismo criterio: que la partida cuente", () => {
    // Réplica de la guarda de `countsWithoutRevertMark()`, la que usa la anulación
    // para no ofrecer ni aceptar una partida que hoy no puntúa. El criterio es el
    // mismo en los dos sentidos, y tiene que seguir siéndolo: invertido al restaurar,
    // ninguna partida clasificatoria se podía devolver. La guarda se pregunta siempre
    // con `revertedAt: null`, que es lo que la deja decidir por las otras cuatro
    // condiciones, y con el `registeredAt` del dueño, que es la quinta.
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
    const cuenta = (m: Parameters<typeof countsAsRanked>[0], registeredAt: Date | null = null) =>
      countsAsRanked(m, ventana, registeredAt, SIN_EQUIPOS);

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
      countsAsRanked({ ...clasificatoria, revertedAt: NOW }, ventana, null, SIN_EQUIPOS),
      false,
      "marcada no cuenta, que es justo lo que deshace el restore",
    );
    assert.equal(
      cuenta(clasificatoria, new Date("2026-10-01T00:00:00.000Z")),
      false,
      "anterior al alta no cuenta, así que no hay puntos que revertir ni que devolver",
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
      scoringSkipped: false,
      alertsError: null,
      historyError: null,
      discordError: null,
      streamsError: null,
      mapPoolError: null,
      summariesError: null,
      announceError: null,
      gamesPagesRead: 0,
      gamesBatchesIncomplete: 0,
      gamesBatchesFailed: 0,
      gamesPlayersQueuedForBackfill: 0,
      gamesBatchErrors: [],
      gamesCursor: null,
      gamesCursorAdvanced: false,
      gamesCursorSeeded: false,
      backfillPlayers: 0,
      backfillPagesRead: 0,
      backfillPending: 0,
      apiNotice: null,
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
    // `streamsError` va en el mismo grupo por la misma razón, y con un caso que
    // importa más: **la falta de `YOUTUBE_API_KEY` es permanente**, así que si
    // contara, un torneo entero con la detección de YouTube apagada se publicaría
    // como sincronizador roto desde el día que se puso en marcha.
    assert.equal(
      salida(
        { ...buena, streamsError: "sin YOUTUBE_API_KEY no se comprueba YouTube" },
        { ...buena, lastSuccessAt: buena.finishedAt },
      ),
      buena.finishedAt,
      "no comprobar los directos tampoco lo mueve",
    );
    // Y `discordError` también, por el mismo motivo y con la misma permanence: sin
    // `DISCORD_BOT_TOKEN` o `DISCORD_GUILD_ID` la pertenencia al servidor no se
    // comprueba nunca, y eso no ha parado ni una partida.
    assert.equal(
      salida(
        {
          ...buena,
          discordError: "sin DISCORD_BOT_TOKEN no se comprueba la pertenencia a Discord",
        },
        { ...buena, lastSuccessAt: buena.finishedAt },
      ),
      buena.finishedAt,
      "no comprobar la pertenencia a Discord tampoco lo mueve",
    );
    // Y `announceError`, con el mismo motivo y la misma permanencia: sin
    // `DISCORD_ANNOUNCE_CHANNEL_ID` los avisos del comienzo y el final del torneo no
    // salen nunca, y eso tampoco ha parado ni una partida.
    assert.equal(
      salida(
        {
          ...buena,
          announceError: "sin DISCORD_ANNOUNCE_CHANNEL_ID no se avisa del comienzo del torneo",
        },
        { ...buena, lastSuccessAt: buena.finishedAt },
      ),
      buena.finishedAt,
      "no poder avisar del torneo tampoco lo mueve",
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
      scoringSkipped: false,
      alertsError: null,
      historyError: null,
      discordError: null,
      streamsError: null,
      mapPoolError: null,
      summariesError: null,
      announceError: null,
      gamesPagesRead: 0,
      gamesBatchesIncomplete: 0,
      gamesBatchesFailed: 0,
      gamesPlayersQueuedForBackfill: 0,
      gamesBatchErrors: [],
      gamesCursor: null,
      gamesCursorAdvanced: false,
      gamesCursorSeeded: false,
      backfillPlayers: 0,
      backfillPagesRead: 0,
      backfillPending: 0,
      apiNotice: null,
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
    // El `null` es el `Player.registeredAt` ausente, que es el caso de todo el que ya
    // estaba en la base. El corte de inscripción se comprueba al final de esta misma
    // comprobación.
    assert.equal(
      countsAsRanked(resuelta(milisegundoAntes(from)), ventana, null, SIN_EQUIPOS),
      false,
      "un milisegundo antes de `from` no cuenta",
    );
    assert.equal(countsAsRanked(resuelta(from), ventana, null, SIN_EQUIPOS), true, "`from` es inclusivo");
    assert.equal(
      countsAsRanked(resuelta(milisegundoAntes(to)), ventana, null, SIN_EQUIPOS),
      true,
      "un milisegundo antes de `to` todavía cuenta",
    );
    assert.equal(
      countsAsRanked(resuelta(to), ventana, null, SIN_EQUIPOS),
      false,
      "`to` es exclusivo: una partida empezada exactamente ahí ya es de la siguiente",
    );
    assert.equal(
      countsAsRanked(resuelta(new Date(Date.parse(to) + 1).toISOString()), ventana, null, SIN_EQUIPOS),
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
      countsAsRanked(empezadaDentroTerminadaDespues, ventana, null, SIN_EQUIPOS),
      true,
      "empezada dentro de la ventana cuenta aunque termine fuera",
    );

    // `to: null` deja la ventana abierta por la derecha: es lo que permite fijar
    // el fin del torneo más tarde sin tocar código.
    const abierta = { from, to: null };
    assert.equal(
      countsAsRanked(resuelta("2031-06-01T12:00:00.000Z"), abierta, null, SIN_EQUIPOS),
      true,
      "con `to: null` no hay corte por la derecha",
    );
    assert.equal(
      countsAsRanked(resuelta(milisegundoAntes(from)), abierta, null, SIN_EQUIPOS),
      false,
      "`from` sigue cortando por la izquierda con la ventana abierta",
    );

    // Y el corte de inscripción, que es el mismo `max` por jugador: con el alta a
    // mitad de ventana, lo anterior a ella deja de contar aunque siga dentro.
    const alta = new Date((Date.parse(from) + Date.parse(to)) / 2);
    assert.equal(
      countsAsRanked(resuelta(new Date(alta.getTime() - 1).toISOString()), ventana, alta, SIN_EQUIPOS),
      false,
      "con `registeredAt` a mitad de ventana, lo anterior al alta no cuenta",
    );
    assert.equal(
      countsAsRanked(resuelta(alta.toISOString()), ventana, alta, SIN_EQUIPOS),
      true,
      "el corte de inscripción es inclusivo, como `from`",
    );
    assert.equal(
      countsAsRanked(resuelta(to), ventana, alta, SIN_EQUIPOS),
      false,
      "el corte no mueve el `to` exclusivo",
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
 * Las etiquetas de formato que ve la gente, sin tocar la base de datos.
 *
 * `describeMode` y `describeTeamSize` son el punto donde lo que publica la API se
 * convierte en texto ("1vs1", "2v2", "Por equipos", "FFA") y, por lo tanto, donde
 * una partida se puede etiquetar con algo falso: ocho equipos de uno no son un
 * "1vs1", aunque los ocho tengan el mismo tamaño, y una FFA de quick match no
 * puede rotularse con el literal `qm_ffa`. Son funciones puras, así que se
 * comprueban con nombres de ladder y con números de bandos, sin filas ni consulta.
 */
async function checkFormatLabels(): Promise<void> {
  console.log("Etiquetas de formato");

  await check("el tamaño solo se afirma si hay dos bandos del mismo tamaño", () => {
    assert.equal(describeTeamSize([1, 1]), "1vs1");
    assert.equal(describeTeamSize([2, 2]), "2v2");
    assert.equal(describeTeamSize([3, 3]), "3v3");
    assert.equal(describeTeamSize([4, 4]), "4v4");

    // El caso que motivó el arreglo: ocho bandos de uno salen con ocho nombres
    // debajo, y "1vs1" es una etiqueta que no se puede sostener delante de ellos.
    assert.equal(describeTeamSize([1, 1, 1, 1, 1, 1, 1, 1]), null, "ocho bandos de uno no son un 1vs1");
    assert.equal(describeTeamSize([2, 2, 2, 2, 2, 2, 2, 2]), null, "ocho bandos de dos no son un 2v2");
    assert.equal(describeTeamSize([1, 1, 1]), null);

    // Lo que tampoco se puede asegurar: equipos desiguales por un abandono, un
    // bando vacío o un solo bando.
    assert.equal(describeTeamSize([1, 2]), null);
    assert.equal(describeTeamSize([0, 0]), null);
    assert.equal(describeTeamSize([1]), null);
    assert.equal(describeTeamSize([]), null);
  });

  await check("la FFA se rotula por familia y no con el literal de la API", () => {
    assert.equal(describeMode("qm_ffa", "qm_ffa"), "FFA");
    assert.equal(describeMode("ffa_ffa", "ffa_ffa"), "FFA");

    // La API nombra la FFA de más de una manera, y la variante llega cuando el
    // único campo es `kind`: mismo formato, otro nombre.
    assert.equal(describeMode("qm_ffa_nomad", "qm_ffa_nomad"), "FFA");

    assert.equal(describeMode("qm_ffa", null), "FFA", "basta con que lo diga el mode");
    assert.equal(describeMode(null, "qm_ffa"), "FFA", "basta con que lo diga el leaderboard");
  });

  await check("ninguna familia de ladder pasa por la rama de la FFA", () => {
    const LADDER: readonly (readonly [name: string, etiqueta: string])[] = [
      ["rm_solo", "1vs1"],
      ["rm_1v1", "1vs1"],
      ["rm_team", "Por equipos"],
      ["rm_2v2", "2v2"],
      ["rm_3v3", "3v3"],
      ["rm_4v4", "4v4"],
    ];

    for (const [name, etiqueta] of LADDER) {
      assert.equal(describeMode(name, name), etiqueta, `${name} no cambia de etiqueta`);
    }
  });

  await check("lo que no se conoce se devuelve tal cual", () => {
    for (const name of ["qm_1v1", "qm_2v2", "qm_3v3", "qm_4v4", "ew_1v1", "custom_8v8"]) {
      assert.equal(
        describeMode(name, name),
        name,
        "mejor un código raro que un dato que no cuadra",
      );
    }

    assert.equal(describeMode("qm_2v2", null), "qm_2v2");
    assert.equal(describeMode(null, "qm_2v2"), "qm_2v2");
    assert.equal(describeMode(null, null), "", "una fila de objetivo no tiene formato que decir");
  });

  await check("una FFA de ocho en `rawJson` no acaba rotulada como 1vs1", () => {
    const ffa = {
      teams: Array.from({ length: 8 }, (_, index) => [
        { player: { profile_id: SAMPLE_PROFILE_ID + index } },
      ]),
    };
    const sizes = teamSizesFromRawJson(ffa);

    assert.deepEqual(sizes, [1, 1, 1, 1, 1, 1, 1, 1]);

    // El camino que sigue el historial del panel: el recuento de bandos no da un
    // tamaño y la etiqueta sale de la familia, que es lo único que sí sabemos.
    assert.equal(describeTeamSize(sizes) ?? describeMode("qm_ffa", "qm_ffa"), "FFA");
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
    JUGON_ID,
    OBJECTIVE_COUNT,
    OBJECTIVE_DEFINITIONS,
    OBJECTIVE_GROUP_LABELS,
    OBJECTIVE_POINTS,
    POLIFACETICO_ID,
    computeObjectives,
    hasFixedPrize,
  } = await import("@/lib/objectives");
  const { DEFAULT_MAP_POOL } = await import("@/lib/map-pool");

  await check(`el catálogo tiene los ${EXPECTED_OBJECTIVE_COUNT} objetivos de docs/OBJETIVOS.md`, () => {
    assert.equal(OBJECTIVE_COUNT, EXPECTED_OBJECTIVE_COUNT);
    assert.equal(OBJECTIVE_DEFINITIONS.length, EXPECTED_OBJECTIVE_COUNT);
    assert.equal(
      new Set(OBJECTIVE_DEFINITIONS.map((definition) => definition.id)).size,
      EXPECTED_OBJECTIVE_COUNT,
      "los ids del catálogo no se repiten",
    );
    assert.deepEqual(
      [...new Set(OBJECTIVE_DEFINITIONS.map((definition) => definition.group))],
      ["actividad", "racha", "hazanas", "formato", "civilizacion"],
      "los grupos salen en el orden documentado, sin intercalarse",
    );
  });

  await check("cada objetivo trae rótulo, descripción, tipo y grupo con rótulo", () => {
    for (const definition of OBJECTIVE_DEFINITIONS) {
      assert.ok(definition.label.trim().length > 0, `${definition.id}: falta el rótulo`);
      assert.ok(
        definition.description.trim().length > 0,
        `${definition.id}: falta la descripción de la regla`,
      );
      assert.ok(definition.points > 0, `${definition.id}: los puntos por defecto son positivos`);
      assert.ok(
        definition.kind === "competition" || definition.kind === "achievement",
        `${definition.id}: el tipo no es válido`,
      );
      assert.equal(
        definition.group in OBJECTIVE_GROUP_LABELS,
        true,
        `${definition.id}: el grupo no tiene rótulo`,
      );
    }
  });

  await check("las familias de civilización: cabeza, hijos y umbral", () => {
    const polifacetico = OBJECTIVE_DEFINITIONS.find(
      (definition) => definition.id === POLIFACETICO_ID,
    );
    const jugon = OBJECTIVE_DEFINITIONS.find((definition) => definition.id === JUGON_ID);

    assert.ok(polifacetico !== undefined, "existe la cabeza polifacetico");
    assert.ok(jugon !== undefined, "existe la cabeza jugon");
    assert.equal(polifacetico.kind, "achievement");
    assert.equal(jugon.kind, "achievement");
    assert.equal(polifacetico.parent, null);
    assert.equal(jugon.parent, null);

    const lideres = OBJECTIVE_DEFINITIONS.filter(
      (definition) => definition.parent === POLIFACETICO_ID,
    );
    const acolitos = OBJECTIVE_DEFINITIONS.filter(
      (definition) => definition.parent === JUGON_ID,
    );

    assert.equal(lideres.length, CIVILIZATIONS.length, "un lider-* por civilización");
    assert.equal(acolitos.length, CIVILIZATIONS.length, "un acolito-* por civilización");
    assert.equal(
      lideres.every((definition) => definition.kind === "achievement"),
      true,
    );
    assert.equal(
      acolitos.every((definition) => definition.kind === "achievement"),
      true,
    );

    const indexOf = (id: string): number =>
      OBJECTIVE_DEFINITIONS.findIndex((definition) => definition.id === id);

    assert.ok(
      indexOf(POLIFACETICO_ID) < indexOf(lideres[0].id),
      "la cabeza se presenta antes que sus hijos",
    );
    assert.ok(
      indexOf(JUGON_ID) < indexOf(acolitos[0].id),
      "la cabeza se presenta antes que sus hijos",
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

  await check("los puntos del catálogo por grupo son los de `docs/OBJETIVOS.md`", () => {
    // Son los puntos que reparte **una** copia de cada objetivo de **premio fijo**. En
    // los logros el reparto se multiplica por el número de beneficiarios, así que la
    // suma no es un tope del torneo, solo la tabla del catálogo. `victorias` queda
    // fuera: paga `pointsPerWin` por victoria y no tiene tope, así que contarlo una vez
    // diría que el catálogo reparte una cifra que no reparte (ver `hasFixedPrize`).
    const porGrupo = new Map<string, number>();

    for (const definition of OBJECTIVE_DEFINITIONS) {
      if (!hasFixedPrize(definition)) {
        continue;
      }

      porGrupo.set(definition.group, (porGrupo.get(definition.group) ?? 0) + definition.points);
    }

    assert.equal(porGrupo.get("actividad"), 39, "Actividad");
    assert.equal(porGrupo.get("racha"), 138, "Racha");
    assert.equal(porGrupo.get("hazanas"), 119, "Hazañas");
    assert.equal(porGrupo.get("formato"), 360, "Formatos");
    assert.equal(porGrupo.get("civilizacion"), 2098, "Civilizaciones");
    assert.equal(
      [...porGrupo.values()].reduce((total, puntos) => total + puntos, 0),
      2754,
      "Total de puntos (sin el objetivo de victorias, que no es un premio fijo)",
    );
  });

  await check("sin partidas no hay cobradores, y el ranking sale vacío", () => {
    const { options, pointsByPlayer, holders } = computeObjectives(
      [],
      DEFAULT_RULESET,
      DEFAULT_MAP_POOL,
    );

    assert.equal(options.length, OBJECTIVE_COUNT, "los objetivos existen aunque no haya datos");
    assert.equal(holders, 0, "nadie cobra nada sin partidas");
    assert.equal(pointsByPlayer.size, 0, "y nadie suma puntos");
    assert.equal(
      options.every(
        (option) =>
          option.holder === null &&
          option.ranking.length === 0 &&
          option.beneficiaries.length === 0,
      ),
      true,
      "cada objetivo sale sin cobrador y con el ranking vacío, no relleno con ceros",
    );
  });
}

type FakeBulkHandler = (
  query: Aoe4WorldBulkGamesQuery,
) => Promise<Aoe4WorldGamesPage> | Aoe4WorldGamesPage;

type FakePlayerGamesHandler = (
  profileId: number,
  query: Aoe4WorldGamesQuery | undefined,
) => Promise<Aoe4WorldGamesPage> | Aoe4WorldGamesPage;

type FakeClientOverrides = {
  bulk?: FakeBulkHandler;
  playerGames?: FakePlayerGamesHandler;
  profileCalls?: number[];
  leaderboard?: (
    leaderboard: string,
    profileIds: number[],
  ) => Promise<Aoe4WorldLeaderboard> | Aoe4WorldLeaderboard;
};

/**
 * Cliente falso: no toca la red, solo sirve los payloads de ejemplo. El listado
 * y el detalle son independientes a propósito, para poder reproducir el caso en
 * el que el listado ya no alcanza una partida y solo el detalle la resuelve.
 *
 * `overrides` permite cambiar el masivo o el listado por jugador en cada
 * escenario (truncación, fallo de lote, aviso de la API, partida compartida).
 */
function createFakeClient(
  games: Aoe4WorldGame[],
  details: Map<string, Aoe4WorldGame> = new Map(),
  detailCalls: number[] = [],
  overrides: FakeClientOverrides = {},
): Aoe4WorldClient {
  return {
    async getPlayer(profileId) {
      overrides.profileCalls?.push(profileId);

      return {
        profileId,
        name: "Jugador Muestra Actualizado",
        steamId: null,
        siteUrl: null,
        country: "es",
        avatars: { small: null, medium: null, full: null },
      };
    },
    async getPlayerGames(profileId, query): Promise<Aoe4WorldGamesPage> {
      if (overrides.playerGames !== undefined) {
        return overrides.playerGames(profileId, query);
      }

      const filtered = games.filter((game) =>
        game.teams.some((team) =>
          team.some((side) => side.profileId === profileId),
        ),
      );

      return {
        page: 1,
        perPage: 100,
        totalCount: filtered.length,
        count: filtered.length,
        nextPage: null,
        notice: null,
        games: filtered,
      };
    },
    async getGamesBulk(query): Promise<Aoe4WorldGamesPage> {
      if (overrides.bulk !== undefined) {
        return overrides.bulk(query);
      }

      const ids = new Set(query.profileIds);
      const filtered = games.filter((game) =>
        game.teams.some((team) =>
          team.some((side) => side.profileId !== null && ids.has(side.profileId)),
        ),
      );

      return {
        page: query.page,
        perPage: 50,
        totalCount: filtered.length,
        count: filtered.length,
        nextPage: null,
        notice: null,
        games: filtered,
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
    async getLeaderboard(leaderboard, profileIds) {
      if (overrides.leaderboard !== undefined) {
        return overrides.leaderboard(leaderboard, profileIds);
      }

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
 * Una página del masivo para los escenarios del cliente falso.
 */
function fakePage(
  games: Aoe4WorldGame[],
  options: { page?: number; nextPage?: number | null; notice?: string | null } = {},
): Aoe4WorldGamesPage {
  return {
    page: options.page ?? 1,
    perPage: 50,
    totalCount: games.length,
    count: games.length,
    nextPage: options.nextPage ?? null,
    notice: options.notice ?? null,
    games,
  };
}

/** Cambia variables de entorno durante una comprobación y las devuelve como estaban. */
async function withEnv<T>(
  values: Readonly<Record<string, string>>,
  run: () => Promise<T>,
): Promise<T> {
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));

  for (const [key, value] of Object.entries(values)) {
    process.env[key] = value;
  }

  try {
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
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
function withinWindow(days: number, window: { from: string } = DEFAULT_RULESET.window): string {
  return new Date(Date.parse(window.from) + days * 86_400_000).toISOString();
}

function buildFixtureAt(now: Date, window: { from: string } = DEFAULT_RULESET.window) {
  const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
  const liveStartedAt = ago(10).toISOString();

  return {
    solo: { ...SOLO_WIN, started_at: withinWindow(2, window) },
    team: { ...TEAM_LOSS, started_at: withinWindow(3, window) },
    // 10 minutos dentro de la ventana de 60, con 50 de margen: aunque la
    // comprobación tardara media hora, la partida seguiría "en curso".
    live: { ...ONGOING_SOLO, started_at: liveStartedAt, updated_at: now.toISOString() },
    // La misma partida ya terminada: la API ahora sabe el resultado, así que
    // `result` y `duration` dejan de ser null y `state` pasa a `processed`.
    // Dura justo los 10 minutos que lleva jugada, así que acaba de terminar.
    liveFinished: {
      ...ONGOING_SOLO,
      started_at: liveStartedAt,
      updated_at: now.toISOString(),
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
 * Comprobaciones de la ventana de fechas y de la condición de equipos, contra la
 * base de datos de verdad.
 *
 * Usa un jugador aparte cuyas partidas están **justo en los bordes** de
 * `[from, to)`, y para el `to = null` y para la condición de equipos sustituye
 * temporalmente el documento guardado (ruleset o cortes) y lo deja como estaba (con
 * un `finally`, y recalculando al final para que la clasificación real no se quede
 * calculada con los valores de prueba).
 */
async function runWindowChecks(
  db: PrismaClient,
  jugadorMuestra: { id: string },
): Promise<void> {
  const { getObjectives, readRuleset, recomputeScores } = await import("@/lib/scoring");
  const { countsAsRanked } = await import("@/lib/ranked-match");
  const { readDivisionCutoffs, ALERTS_DIVISION_CUTOFFS_KEY } = await import("@/lib/alerts/settings");

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
            // `registeredAt` ausente: es lo que tiene el jugador de esta
            // comprobación, y el caso mayoritario de toda la base.
            null,
            SIN_EQUIPOS,
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
      const puntosPartidas = await db.match.aggregate({
        where: { playerId: jugador.id },
        _sum: { points: true },
      });
      assert.equal(
        puntosPartidas._sum.points,
        score.wins * DEFAULT_RULESET.pointsPerWin,
        "los puntos de partidas cuadran con las victorias de la ventana",
      );
    });

    await check("los objetivos cuentan las mismas partidas de la ventana", async () => {
      const { loadObjectivePlayers } = await import("@/lib/objectives");
      const dentro = casos.filter((caso) => caso.dentro).length;
      const agregados = await loadObjectivePlayers(db, await readRuleset(), await readDivisionCutoffs());
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

      const agregados = await loadObjectivePlayers(db, await readRuleset(), await readDivisionCutoffs());
      const suyo = agregados.find((agregado) => agregado.playerId === jugador.id);
      assert.equal(suyo?.matches, esperada, "los objetivos también las cuentan");

      if (rulesetGuardado === null) {
        await db.setting.deleteMany({ where: { key: SCORING_RULESET_KEY } });
      } else {
        await db.setting.update({
          where: { key: SCORING_RULESET_KEY },
          data: { value: rulesetGuardado.value as Prisma.InputJsonValue },
        });
      }
    });

    /**
     * El corte de inscripción, contra datos de verdad.
     *
     * Las tres traducciones de la regla se contrastan aquí a la vez, y no solo la
     * regla de partida: se le pone al jugador de la ventana un `registeredAt` a
     * mitad de torneo y se mira que el `UPDATE` de `Match.points` pone a 0 lo que
     * es anterior al alta, que el agregado de `PlayerScore` deja de contar esas
     * partidas y que los objetivos cuentan exactamente las mismas. Si alguna de las
     * tres se quedara sin el corte, es justo aquí donde se vería.
     *
     * El corte se pone **después** de comprobar que sin él todo cuadra, y se vuelve
     * a dejar en `null` al final para que la comprobación de `to: null` siga viendo
     * el caso mayoritario.
     */
    await check("un alta posterior no cuenta las partidas anteriores al alta", async () => {
      const { loadObjectivePlayers } = await import("@/lib/objectives");
      // Un milisegundo después de `from`: la partida de "justo en `from`" queda
      // justo fuera y la de "justo antes de `to`" justo dentro, así que el corte se
      // contrasta contra los dos bordes de la ventana a la vez.
      const alta = new Date(from + 1);

      await db.player.update({ where: { id: jugador.id }, data: { registeredAt: alta } });
      await recomputeScores();

      const puntos = await db.match.findMany({
        where: { playerId: jugador.id },
        orderBy: { startedAt: "asc" },
        select: { gameId: true, startedAt: true, points: true },
      });

      const despuesDelAlta = casos.filter((caso) => caso.at >= from + 1 && caso.at < to).length;
      assert.equal(
        puntos.filter((fila) => fila.points > 0).length,
        despuesDelAlta,
        "solo puntúan las partidas de después del alta",
      );
      assert.equal(
        puntos.find((fila) => fila.gameId === "9000102")?.points,
        0,
        "la partida de justo en `from`, un milisegundo antes del alta, deja de puntuar",
      );

      const score = await db.playerScore.findUnique({
        where: {
          playerId_ruleSetVersion: { playerId: jugador.id, ruleSetVersion: RULESET_VERSION },
        },
      });
      assert.equal(
        score?.matches,
        despuesDelAlta,
        "y la clasificación cuenta solo las de después del alta",
      );

      // Los objetivos van con el mismo corte: sin esto, un alta tardía con muchas
      // partidas se llevaría un objetivo por partidas que no puntúan.
      const agregados = await loadObjectivePlayers(db, await readRuleset(), await readDivisionCutoffs());
      const suyo = agregados.find((agregado) => agregado.playerId === jugador.id);
      assert.equal(
        suyo?.matches,
        despuesDelAlta,
        "los objetivos tampoco cuentan las partidas anteriores al alta",
      );

      // Y `countsAsRanked()`, que es lo que decide el botón de revertir del panel,
      // tiene que dar la misma respuesta fila a fila.
      const ventanaActiva = (await readRuleset()).window;
      const enJs = puntos.filter(
        (fila) =>
          countsAsRanked(
            {
              mode: "rm_solo",
              result: "WIN",
              startedAt: fila.startedAt,
              finishedAt: new Date(fila.startedAt.getTime() + 1_800_000),
              revertedAt: null,
            },
            ventanaActiva,
            alta,
            SIN_EQUIPOS,
          ),
      );
      assert.equal(enJs.length, despuesDelAlta, "las tres traducciones cuentan lo mismo");

      // Se deja como estaba: el resto de la comprobación usa el `null`.
      await db.player.update({ where: { id: jugador.id }, data: { registeredAt: null } });
    });

    /**
     * La condición de equipos, contra la base de datos.
     *
     * Es la única de las seis que el `where` de Prisma no puede escribir, así que su
     * contraste es el que más importa: se publican unos cortes **sintéticos** de
     * `rm_team` (100 de elo por subdivisión, 3 por división), se cuelgan del jugador
     * de la ventana dos partidas de equipo —una con un compañero al mismo escalón y
     * otra con uno a dos escalones— y se comprueba que las dos traducciones que sí
     * llevan la condición dicen lo mismo: el `UPDATE` de `Match.points` y el agregado
     * del motor (SQL) y `countsAsRanked()` (memoria). Con los cortes fuera, la misma
     * partida cuenta, que es la degradación acordada.
     *
     * Los cortes se publican en `Setting` y se devuelve el documento anterior al
     * terminar. Es el mismo trato que la ventana de fechas de arriba: la base es de
     * verdad y no puede quedar con valores de prueba.
     */
    await check("la condición de equipos deja fuera una partida con un compañero desequilibrado", async () => {
      const { countsAsRanked: cuentaFila } = await import("@/lib/ranked-match");

      const cortes = {
        ladders: {
          rm_team: {
            ladder: "rm_team",
            derivedAt: new Date(from).toISOString(),
            totalCount: 50_000,
            requests: 1,
            cutoffs: SUBDIVISION_RANK_LEVELS.map((rankLevel, index) => ({
              rankLevel,
              minRating: 3000 - index * 100,
            })),
          },
        },
      };

      const cortesGuardados = await db.setting.findUnique({
        where: { key: ALERTS_DIVISION_CUTOFFS_KEY },
      });

      const entrada = (profileId: number, rating: number) => ({
        player: { profile_id: profileId, name: "Jugador", rating, result: "win" },
      });

      /** Un 2v2 del jugador de la ventana con un compañero de rating dado. */
      const rawJson = (companero: number) => ({
        game_id: 9_001_020 + companero,
        started_at: new Date(from + 3_600_000).toISOString(),
        leaderboard: "rm_2v2",
        teams: [
          [entrada(WINDOW_PROFILE_ID, 2100), entrada(WINDOW_PROFILE_ID + 100, companero)],
          [entrada(WINDOW_PROFILE_ID + 200, 1500)],
        ],
      });

      // 2100 es oro (escalón 3). 1900 es oro también (el subrango no cuenta) y 1000
      // es bronce (escalón 5): dos escalones, la partida no puntúa.
      const desequilibrada = {
        gameId: "9001020",
        playerId: jugador.id,
        leaderboard: "rm_team",
        mode: "rm_team",
        civ: "english",
        result: "WIN" as const,
        startedAt: new Date(from + 3_600_000),
        finishedAt: new Date(from + 5_400_000),
        rawJson: rawJson(1000),
      };
      const equilibrada = {
        ...desequilibrada,
        gameId: "9001021",
        startedAt: new Date(from + 7_200_000),
        finishedAt: new Date(from + 9_000_000),
        rawJson: rawJson(1900),
      };

      try {
        await db.setting.upsert({
          where: { key: ALERTS_DIVISION_CUTOFFS_KEY },
          create: { key: ALERTS_DIVISION_CUTOFFS_KEY, value: cortes },
          update: { value: cortes },
        });

        await recomputeScores();
        const antes = await db.playerScore.findUnique({
          where: {
            playerId_ruleSetVersion: { playerId: jugador.id, ruleSetVersion: RULESET_VERSION },
          },
        });

        await db.match.createMany({ data: [desequilibrada, equilibrada] });
        await recomputeScores();

        const leidas = await db.match.findMany({
          where: { playerId: jugador.id, gameId: { in: ["9001020", "9001021"] } },
          select: {
            gameId: true,
            mode: true,
            startedAt: true,
            finishedAt: true,
            points: true,
            rawJson: true,
          },
        });
        const deEquipo = leidas.find((fila) => fila.gameId === "9001020");
        const equilibradaLeida = leidas.find((fila) => fila.gameId === "9001021");

        assert.ok(deEquipo !== undefined && equilibradaLeida !== undefined, "faltan las partidas");

        // El SQL: la desequilibrada se queda a 0 y la equilibrada puntúa.
        assert.equal(deEquipo.points, 0, "un compañero a dos escalones deja la partida sin puntos");
        assert.equal(
          equilibradaLeida.points,
          DEFAULT_RULESET.pointsPerWin,
          "un compañero al mismo escalón no la toca",
        );

        // La memoria: `countsAsRanked()` fila a fila dice lo mismo, con los cortes
        // cacheados (los de la prueba) y sin ellos (la degradación).
        const cutoffs = await readDivisionCutoffs();
        assert.ok(cutoffs !== null, "los cortes de la prueba deberían leerse");

        for (const [fila, esperado] of [
          [deEquipo, false],
          [equilibradaLeida, true],
        ] as const) {
          assert.equal(
            cuentaFila(
              { ...fila, result: "WIN", revertedAt: null },
              ventana,
              null,
              { profileId: WINDOW_PROFILE_ID, cutoffs },
            ),
            esperado,
            `las dos traducciones discrepan en la partida ${fila.gameId}`,
          );
          assert.equal(
            cuentaFila(
              { ...fila, result: "WIN", revertedAt: null },
              ventana,
              null,
              { profileId: WINDOW_PROFILE_ID, cutoffs: null },
            ),
            true,
            "sin cortes la partida cuenta, que es la degradación acordada",
          );
        }

        // El agregado de la clasificación cuenta las mismas partidas que el `UPDATE`.
        const despues = await db.playerScore.findUnique({
          where: {
            playerId_ruleSetVersion: { playerId: jugador.id, ruleSetVersion: RULESET_VERSION },
          },
        });
        assert.ok(antes !== null && despues !== null, "el jugador de la ventana está en la tabla");
        assert.equal(
          despues.matches,
          antes.matches + 1,
          "solo la partida equilibrada entra a contar para la clasificación",
        );
        assert.equal(despues.wins, antes.wins + 1, "y la ganada es la que entra");
      } finally {
        await db.match.deleteMany({ where: { playerId: jugador.id, gameId: { in: ["9001020", "9001021"] } } });

        if (cortesGuardados === null) {
          await db.setting.deleteMany({ where: { key: ALERTS_DIVISION_CUTOFFS_KEY } });
        } else {
          await db.setting.update({
            where: { key: ALERTS_DIVISION_CUTOFFS_KEY },
            data: { value: cortesGuardados.value as Prisma.InputJsonValue },
          });
        }
      }
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

type ApprovedStateSnapshot = {
  id: string;
  profileId: number;
  status: PlayerStatus;
  windowComplete: boolean;
  backfillPage: number;
  windowCheckedAt: Date | null;
  profileCheckedAt: Date | null;
};

type SettingSnapshot = {
  key: string;
  value: Prisma.JsonValue;
};

type DatabaseSnapshot = {
  approved: ApprovedStateSnapshot[];
  cursor: SettingSnapshot | null;
  lastRun: SettingSnapshot | null;
  scoringLastRun: SettingSnapshot | null;
  sampleStates: SettingSnapshot[];
};

async function snapshotDatabaseState(
  db: PrismaClient,
  cursorKey: string,
  lastRunKey: string,
  scoringLastRunKey: string,
  sampleIds: readonly number[],
  playerSyncKey: (profileId: number) => string,
): Promise<DatabaseSnapshot> {
  const approved = await db.player.findMany({
    where: { status: PlayerStatus.APPROVED },
    select: {
      id: true,
      profileId: true,
      status: true,
      windowComplete: true,
      backfillPage: true,
      windowCheckedAt: true,
      profileCheckedAt: true,
    },
  });
  const fixedKeys = [cursorKey, lastRunKey, scoringLastRunKey];
  const keys = [...fixedKeys, ...sampleIds.map(playerSyncKey)];
  const settings = await db.setting.findMany({ where: { key: { in: keys } } });
  const byKey = new Map(settings.map((setting) => [setting.key, setting]));

  return {
    approved,
    cursor: byKey.get(cursorKey) ?? null,
    lastRun: byKey.get(lastRunKey) ?? null,
    scoringLastRun: byKey.get(scoringLastRunKey) ?? null,
    sampleStates: settings.filter((setting) => !fixedKeys.includes(setting.key)),
  };
}

async function restoreSetting(
  db: PrismaClient,
  key: string,
  setting: SettingSnapshot | null,
): Promise<void> {
  if (setting === null) {
    await db.setting.deleteMany({ where: { key } });
    return;
  }

  await db.setting.upsert({
    where: { key },
    create: { key, value: setting.value as Prisma.InputJsonValue },
    update: { value: setting.value as Prisma.InputJsonValue },
  });
}

async function restoreApprovedRows(
  db: PrismaClient,
  rows: readonly ApprovedStateSnapshot[],
  exceptProfileIds: readonly number[] = [],
): Promise<void> {
  const excluded = new Set(exceptProfileIds);

  for (const row of rows) {
    if (excluded.has(row.profileId)) {
      continue;
    }

    await db.player.updateMany({
      where: { id: row.id },
      data: {
        status: row.status,
        windowComplete: row.windowComplete,
        backfillPage: row.backfillPage,
        windowCheckedAt: row.windowCheckedAt,
        profileCheckedAt: row.profileCheckedAt,
      },
    });
  }
}

async function restoreDatabaseState(
  db: PrismaClient,
  snapshot: DatabaseSnapshot,
  cursorKey: string,
  lastRunKey: string,
  scoringLastRunKey: string,
  sampleIds: readonly number[],
  playerSyncKey: (profileId: number) => string,
): Promise<void> {
  await restoreApprovedRows(db, snapshot.approved);
  await restoreSetting(db, cursorKey, snapshot.cursor);
  await restoreSetting(db, lastRunKey, snapshot.lastRun);
  // Los dos tests de F3b escriben y borran esta clave: si no se restaurara, la
  // verificación dejaría la producción con el rastro de un recálculo que no fue.
  await restoreSetting(db, scoringLastRunKey, snapshot.scoringLastRun);

  await db.setting.deleteMany({
    where: { key: { in: sampleIds.map(playerSyncKey) } },
  });

  for (const setting of snapshot.sampleStates) {
    await restoreSetting(db, setting.key, setting);
  }
}

/**
 * Deja el roster real fuera de la pasada no dirigida: lo pasa a `PENDING`
 * temporalmente y lo restaura al terminar. Así el masivo solo ve a los dos
 * jugadores de muestra y el `backfillPending` de la pasada es el suyo.
 */
async function withIsolatedSampleRoster<T>(
  db: PrismaClient,
  snapshot: DatabaseSnapshot,
  sampleIds: readonly number[],
  run: () => Promise<T>,
): Promise<T> {
  await db.player.updateMany({
    where: {
      status: PlayerStatus.APPROVED,
      profileId: { notIn: [...sampleIds] },
    },
    data: { status: PlayerStatus.PENDING },
  });

  try {
    return await run();
  } finally {
    await restoreApprovedRows(db, snapshot.approved, sampleIds);
  }
}


async function runDatabaseChecks(): Promise<void> {
  // Importación diferida: las comprobaciones de normalización no tocan la base
  // de datos y así funcionan aunque `DATABASE_URL` no esté definida.
  const { syncApprovedPlayers } = await import("@/lib/aoe4world/sync");
  const {
    playerSyncKey,
    readGamesCursor,
    readPlayerSyncState,
    writeGamesCursor,
    SCORING_LAST_RUN_KEY,
    SYNC_GAMES_CURSOR_KEY,
    SYNC_LAST_RUN_KEY,
  } = await import("@/lib/settings");
  const { db } = await import("@/lib/db");
  const { getObjectives, readRuleset, recomputeScores } = await import("@/lib/scoring");
  const { readDivisionCutoffs } = await import("@/lib/alerts/settings");

  const now = new Date();
  const existing = await db.player.findMany({
    where: { profileId: { in: [...SAMPLE_PROFILE_IDS] } },
    select: { profileId: true },
  });
  assert.equal(
    existing.length,
    0,
    `ya existe un jugador de muestra (${existing.map((row) => row.profileId).join(", ")}); bórralo antes de repetir la verificación`,
  );
  const rulesetGuardado = await db.setting.findUnique({
    where: { key: SCORING_RULESET_KEY },
  });
  const ventanaActiva = {
    from: new Date(now.getTime() - 30 * 86_400_000).toISOString(),
    to: new Date(now.getTime() + 86_400_000).toISOString(),
  };
  const rulesetPrueba = { ...DEFAULT_RULESET, window: ventanaActiva };

  const fixture = buildFixtureAt(now, ventanaActiva);
  const soloStartedAt = new Date(fixture.solo.started_at);
  const liveStartedAt = new Date(fixture.live.started_at);

  console.log("Guardado en base de datos");

  const games: Aoe4WorldGame[] = [
    parsedGame(fixture.solo),
    parsedGame(fixture.team),
    parsedGame(fixture.live),
  ];

  const snapshot = await snapshotDatabaseState(
    db,
    SYNC_GAMES_CURSOR_KEY,
    SYNC_LAST_RUN_KEY,
    SCORING_LAST_RUN_KEY,
    TEST_PROFILE_IDS,
    playerSyncKey,
  );

  let player: Awaited<ReturnType<typeof db.player.create>>;

  try {
    await db.setting.upsert({
      where: { key: SCORING_RULESET_KEY },
      create: {
        key: SCORING_RULESET_KEY,
        value: rulesetPrueba as unknown as Prisma.InputJsonObject,
      },
      update: {
        value: rulesetPrueba as unknown as Prisma.InputJsonObject,
      },
    });

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

    player = await db.player.create({
      data: { profileId: SAMPLE_PROFILE_ID, name: "Jugador Muestra", status: "APPROVED" },
    });

    await db.player.create({
      data: {
        profileId: SAMPLE_BULK_SECOND_PROFILE_ID,
        name: "Jugador Muestra 2",
        status: "APPROVED",
      },
    });

    await check("la primera pasada inserta por el masivo y siembra el cursor global", async () => {
      await db.setting.deleteMany({ where: { key: SYNC_GAMES_CURSOR_KEY } });
      const finishedAt = new Date(now.getTime() - 2 * 60 * 60_000).toISOString();
      await db.setting.upsert({
        where: { key: SYNC_LAST_RUN_KEY },
        create: {
          key: SYNC_LAST_RUN_KEY,
          value: { startedAt: finishedAt, finishedAt },
        },
        update: { value: { startedAt: finishedAt, finishedAt } },
      });
      await db.player.updateMany({
        where: { profileId: { in: [...SAMPLE_PROFILE_IDS] } },
        data: { windowComplete: false, backfillPage: 1 },
      });

      const summary = await withIsolatedSampleRoster(
        db,
        snapshot,
        SAMPLE_PROFILE_IDS,
        () => syncApprovedPlayers({ client: createFakeClient(games) }),
      );
      const primero = summary.players.find((row) => row.profileId === SAMPLE_PROFILE_ID);
      const otro = summary.players.find(
        (row) => row.profileId === SAMPLE_BULK_SECOND_PROFILE_ID,
      );

      assert.ok(primero !== undefined && otro !== undefined, "los dos aprobados están en el resumen");
      assert.equal(summary.playersTotal, 2);
      assert.equal(primero.matchesInserted, 3);
      assert.equal(otro.matchesInserted, 0);
      assert.equal(summary.gamesPagesRead >= 1, true, "el masivo lee al menos una página");
      assert.equal(summary.gamesBatchesFailed, 0);
      assert.equal(summary.gamesBatchesIncomplete, 0);
      assert.equal(summary.gamesCursorSeeded, true);
      assert.equal(summary.gamesCursorAdvanced, true, "la partida nueva mueve el watermark");
      assert.equal(summary.backfillPending, 0, "la ventana de los dos muestras queda completa");
      assert.ok(summary.gamesCursor !== null, "el cursor global queda escrito");
      assert.equal(
        summary.scoringSkipped,
        false,
        "una pasada con partidas nuevas no puede saltarse el recálculo",
      );
      assert.ok(summary.scoring !== null, "y el resumen trae el recálculo");

      const cursor = await readGamesCursor();
      assert.ok(cursor !== null);
      assert.equal(cursor.seededFrom, "sync.lastRun.finishedAt");
      const seededAtMs = Date.parse(cursor.updatedAt);
      assert.ok(
        seededAtMs >= now.getTime() - 6 * 60 * 60_000 - 90 * 60_000 &&
          seededAtMs <= now.getTime() - 90 * 60_000,
        "la semilla nace entre el suelo de 6 h y el techo de ahora, menos el solape",
      );

      const fila = await db.player.findUnique({ where: { profileId: SAMPLE_PROFILE_ID } });
      assert.equal(fila?.windowComplete, true);
      assert.ok(fila?.windowCheckedAt !== null);

      const estado = await readPlayerSyncState(SAMPLE_PROFILE_ID);
      assert.ok(estado !== null);
      assert.equal(estado.since, ventanaActiva.from, "la auditoría usa el inicio de la ventana");
      assert.equal(
        estado.maxStartedAt,
        liveStartedAt.toISOString(),
        "la auditoría guarda el started_at más nuevo del relleno",
      );

      const rows = await db.match.findMany({
        where: { player: { profileId: SAMPLE_PROFILE_ID } },
        orderBy: { gameId: "asc" },
      });
      assert.equal(rows.length, 3);
      assert.equal(rows.find((row) => row.gameId === "9000001")?.result, "WIN");
      assert.equal(rows.find((row) => row.gameId === "9000002")?.mode, "rm_team");
      assert.equal(rows.find((row) => row.gameId === "9000003")?.finishedAt, null);
    });

    await check("la segunda pasada no duplica ni mueve el cursor dirigido", async () => {
      const cursorAntes = (await readGamesCursor())?.updatedAt;
      const sinDirecto = games.filter((game) => game.gameId !== 9_000_003);
      const summary = await syncApprovedPlayers({
        profileIds: [SAMPLE_PROFILE_ID],
        client: createFakeClient(sinDirecto),
      });
      const primero = summary.players[0];

      assert.ok(primero !== undefined);
      assert.equal(primero.matchesInserted, 0, "no debe insertar nada nuevo");
      assert.equal(primero.matchesUpdated, 0);
      assert.equal(summary.newMatches, 0);
      assert.equal(summary.gamesCursorAdvanced, false);
      assert.equal((await readGamesCursor())?.updatedAt, cursorAntes);
      assert.equal(
        await db.match.count({ where: { player: { profileId: SAMPLE_PROFILE_ID } } }),
        3,
        "sigue habiendo tres filas, no se duplica nada",
      );
    });

    await check("la partida en curso se resuelve y suma una nueva clasificatoria", async () => {
      const resuelta = parsedGame(fixture.liveFinished);
      const summary = await syncApprovedPlayers({
        profileIds: [SAMPLE_PROFILE_ID],
        client: createFakeClient([games[0] as Aoe4WorldGame, games[1] as Aoe4WorldGame, resuelta]),
      });
      const primero = summary.players[0];

      assert.ok(primero !== undefined);
      assert.equal(primero.matchesInserted, 0);
      assert.equal(primero.matchesUpdated, 1, "solo la que estaba en curso");
      assert.equal(
        summary.newMatches,
        1,
        "la partida en curso pasa a contar: es una transición, no una inserción",
      );

      const refrescada = await db.match.findFirst({
        where: { gameId: "9000003", player: { profileId: SAMPLE_PROFILE_ID } },
      });
      assert.equal(refrescada?.result, "WIN");
      assert.equal(refrescada?.finishedAt?.toISOString(), now.toISOString());
      assert.equal(refrescada?.durationSeconds, 600);
    });

    await check("una partida compartida deja una fila por jugador y una sola en la página", async () => {
      await db.player.updateMany({
        where: { profileId: { in: [...SAMPLE_PROFILE_IDS] } },
        data: { windowComplete: true },
      });

      const compartida = parsedGame({
        ...SOLO_WIN,
        game_id: 9_000_050,
        started_at: new Date(Date.parse(ventanaActiva.from) + 3_600_000).toISOString(),
        updated_at: now.toISOString(),
        teams: [
          [
            {
              player: samplePlayer({
                profile_id: SAMPLE_PROFILE_ID,
                result: "win",
                civilization: "english",
              }),
            },
          ],
          [
            {
              player: samplePlayer({
                profile_id: SAMPLE_BULK_SECOND_PROFILE_ID,
                result: "loss",
                civilization: "mongols",
              }),
            },
          ],
        ],
      });

      const summary = await syncApprovedPlayers({
        profileIds: [...SAMPLE_PROFILE_IDS],
        client: createFakeClient([compartida]),
      });
      const primero = summary.players.find((row) => row.profileId === SAMPLE_PROFILE_ID);
      const otro = summary.players.find(
        (row) => row.profileId === SAMPLE_BULK_SECOND_PROFILE_ID,
      );

      assert.ok(primero !== undefined && otro !== undefined);
      assert.equal(primero.matchesInserted, 1);
      assert.equal(otro.matchesInserted, 1);
      assert.equal(summary.gamesPagesRead, 1, "la página masiva trae la partida una sola vez");
      assert.equal(summary.newMatches, 2, "cuenta una vez por jugador, no una vez por fila de página");
      assert.equal(
        await db.match.count({ where: { gameId: "9000050" } }),
        2,
        "hay una fila Match por jugador",
      );
    });

    await check("una truncación avanza el cursor y no rebobina al que iba por la página 7", async () => {
      await db.player.updateMany({
        where: { profileId: SAMPLE_PROFILE_ID },
        data: { windowComplete: false, backfillPage: 7 },
      });
      await db.player.updateMany({
        where: { profileId: SAMPLE_BULK_SECOND_PROFILE_ID },
        data: { windowComplete: false, backfillPage: 1 },
      });

      const cursorAntes = await readGamesCursor();
      assert.ok(cursorAntes !== null);
      await writeGamesCursor({
        ...cursorAntes,
        updatedAt: new Date(now.getTime() - 4 * 60 * 60_000).toISOString(),
      });

      const compartida = parsedGame({
        ...SOLO_WIN,
        game_id: 9_000_050,
        started_at: new Date(Date.parse(ventanaActiva.from) + 3_600_000).toISOString(),
        updated_at: now.toISOString(),
        teams: [
          [
            {
              player: samplePlayer({
                profile_id: SAMPLE_PROFILE_ID,
                result: "win",
                civilization: "english",
              }),
            },
          ],
          [
            {
              player: samplePlayer({
                profile_id: SAMPLE_BULK_SECOND_PROFILE_ID,
                result: "loss",
                civilization: "mongols",
              }),
            },
          ],
        ],
      });

      const summary = await withIsolatedSampleRoster(
        db,
        snapshot,
        SAMPLE_PROFILE_IDS,
        () =>
          withEnv(
            {
              AOE4WORLD_SYNC_BULK_MAX_PAGES: "1",
              AOE4WORLD_SYNC_BACKFILL_MAX_PLAYERS: "1",
              AOE4WORLD_SYNC_BACKFILL_PAGES_PER_PLAYER: "1",
            },
            () =>
              syncApprovedPlayers({
                client: createFakeClient(
                  [compartida],
                  new Map(),
                  [],
                  {
                    bulk: (query) =>
                      fakePage([compartida], { page: query.page, nextPage: 2 }),
                  },
                ),
              }),
          ),
      );

      assert.equal(summary.gamesBatchesIncomplete, 1);
      assert.equal(summary.gamesCursorAdvanced, true, "una truncación no bloquea el cursor");
      assert.equal(summary.gamesPlayersQueuedForBackfill, 2);
      assert.equal(summary.backfillPending, 1, "queda pendiente el que iba por la página 7");

      const fila7 = await db.player.findUnique({ where: { profileId: SAMPLE_PROFILE_ID } });
      const fila1 = await db.player.findUnique({
        where: { profileId: SAMPLE_BULK_SECOND_PROFILE_ID },
      });
      assert.equal(fila7?.backfillPage, 7, "keepPage conserva la página del que iba a medias");
      assert.equal(fila7?.windowComplete, false);
      assert.equal(fila1?.windowComplete, true);

      const segunda = await withIsolatedSampleRoster(
        db,
        snapshot,
        SAMPLE_PROFILE_IDS,
        () =>
          syncApprovedPlayers({
            client: createFakeClient([compartida]),
          }),
      );
      assert.equal(segunda.gamesBatchesIncomplete, 0);
      assert.equal(segunda.backfillPending, 0);

      const fila7Final = await db.player.findUnique({
        where: { profileId: SAMPLE_PROFILE_ID },
      });
      assert.equal(fila7Final?.backfillPage, 7, "la siguiente pasada no rebobina");
      assert.equal(fila7Final?.windowComplete, true);
    });

    await check("un lote que falla bloquea el cursor y deja su número y su rango", async () => {
      await db.player.updateMany({
        where: { profileId: { in: [...SAMPLE_PROFILE_IDS] } },
        data: { windowComplete: true },
      });

      const cursorAntes = (await readGamesCursor())?.updatedAt;
      const summary = await withIsolatedSampleRoster(
        db,
        snapshot,
        SAMPLE_PROFILE_IDS,
        () =>
          syncApprovedPlayers({
            client: createFakeClient(
              [],
              new Map(),
              [],
              {
                bulk: () => {
                  throw new Aoe4WorldError("fallo de lote de prueba", {
                    status: 503,
                    retryable: true,
                  });
                },
              },
            ),
          }),
      );

      assert.equal(summary.gamesBatchesFailed, 1);
      assert.equal(summary.gamesBatchErrors.length, 1);
      assert.equal(summary.gamesBatchErrors[0]?.batch, 1);
      assert.equal(summary.gamesBatchErrors[0]?.firstProfileId, SAMPLE_PROFILE_ID);
      assert.equal(
        summary.gamesBatchErrors[0]?.lastProfileId,
        SAMPLE_BULK_SECOND_PROFILE_ID,
      );
      assert.equal(summary.playersFailed, 2);
      assert.deepEqual(
        summary.players.filter((row) => row.status === "failed").map((row) => row.profileId).sort(),
        [...SAMPLE_PROFILE_IDS].sort(),
      );
      assert.equal(summary.gamesCursorAdvanced, false);
      assert.equal((await readGamesCursor())?.updatedAt, cursorAntes);
    });

    await check("la siembra acotada no nace más atrás de la cota de la semilla", async () => {
      await db.setting.deleteMany({ where: { key: SYNC_GAMES_CURSOR_KEY } });
      const finishedAt = new Date(now.getTime() - 2 * 24 * 60 * 60_000).toISOString();
      await db.setting.upsert({
        where: { key: SYNC_LAST_RUN_KEY },
        create: {
          key: SYNC_LAST_RUN_KEY,
          value: { startedAt: finishedAt, finishedAt },
        },
        update: { value: { startedAt: finishedAt, finishedAt } },
      });

      const fallaRelleno = () => {
        throw new Aoe4WorldError("fallo de relleno de prueba", {
          status: 503,
          retryable: true,
        });
      };

      const summary = await withIsolatedSampleRoster(
        db,
        snapshot,
        SAMPLE_PROFILE_IDS,
        () =>
          withEnv({ AOE4WORLD_SYNC_SEED_MAX_AGE_MINUTES: "360" }, () =>
            syncApprovedPlayers({
              profileIds: [SAMPLE_PROFILE_ID],
              client: createFakeClient([], new Map(), [], { playerGames: fallaRelleno }),
            }),
          ),
      );
      const cursor = await readGamesCursor();
      assert.ok(cursor !== null);
      assert.equal(cursor.seededFrom, "sync.lastRun.finishedAt");
      assert.equal(summary.gamesCursorSeeded, true);
      assert.equal(summary.gamesCursorAdvanced, false);
      const seededMs = Date.parse(cursor.updatedAt);
      assert.ok(
        seededMs >= now.getTime() - 6 * 60 * 60_000 - 90 * 60_000 - 60_000 &&
          seededMs <= now.getTime() - 6 * 60 * 60_000 - 90 * 60_000 + 60_000,
        "el rastro de hace dos días se sube al suelo de seis horas",
      );

      const filas = await db.player.findMany({
        where: { profileId: { in: [...SAMPLE_PROFILE_IDS] } },
        select: { windowComplete: true, backfillPage: true },
      });
      assert.equal(
        filas.every((row) => row.windowComplete === false && row.backfillPage === 1),
        true,
        "la siembra reencola al roster",
      );

      await db.setting.deleteMany({ where: { key: SYNC_GAMES_CURSOR_KEY } });
      await db.setting.deleteMany({ where: { key: SYNC_LAST_RUN_KEY } });

      const catchUp = await withIsolatedSampleRoster(
        db,
        snapshot,
        SAMPLE_PROFILE_IDS,
        () =>
          syncApprovedPlayers({
            profileIds: [SAMPLE_PROFILE_ID],
            client: createFakeClient([], new Map(), [], { playerGames: fallaRelleno }),
          }),
      );
      const cursorCatchUp = await readGamesCursor();
      assert.ok(cursorCatchUp !== null);
      assert.equal(cursorCatchUp.seededFrom, "catch-up");
      assert.equal(catchUp.gamesCursorSeeded, true);
      const catchUpMs = Date.parse(cursorCatchUp.updatedAt);
      assert.ok(
        catchUpMs >= now.getTime() - 90 * 60_000 - 60_000 &&
          catchUpMs <= now.getTime() - 90 * 60_000 + 60_000,
        "sin rastro la semilla nace en now menos el solape",
      );
    });

    await check("el aviso de updated_since recupera el cursor y no entra en bucle", async () => {
      const cursor = await readGamesCursor();
      assert.ok(cursor !== null);
      await writeGamesCursor({
        ...cursor,
        updatedAt: new Date(now.getTime() - 21 * 24 * 60 * 60_000).toISOString(),
      });

      const compartida = parsedGame({
        ...SOLO_WIN,
        game_id: 9_000_050,
        started_at: new Date(Date.parse(ventanaActiva.from) + 3_600_000).toISOString(),
        updated_at: now.toISOString(),
        teams: [
          [
            {
              player: samplePlayer({
                profile_id: SAMPLE_PROFILE_ID,
                result: "win",
                civilization: "english",
              }),
            },
          ],
          [
            {
              player: samplePlayer({
                profile_id: SAMPLE_BULK_SECOND_PROFILE_ID,
                result: "loss",
                civilization: "mongols",
              }),
            },
          ],
        ],
      });
      const aviso =
        "updated_since=.. is too long ago, are you keeping it up to date?... and msg us on discord ~ aoe4world devs";
      const handler = (query: Aoe4WorldBulkGamesQuery) => {
        if (now.getTime() - query.updatedSince.getTime() > 20 * 24 * 60 * 60_000) {
          return fakePage([], { notice: aviso });
        }

        return fakePage([compartida]);
      };
      const fallaRelleno = () => {
        throw new Aoe4WorldError("fallo de relleno de prueba", {
          status: 503,
          retryable: true,
        });
      };

      const summary = await withIsolatedSampleRoster(
        db,
        snapshot,
        SAMPLE_PROFILE_IDS,
        () =>
          syncApprovedPlayers({
            client: createFakeClient([compartida], new Map(), [], {
              bulk: handler,
              playerGames: fallaRelleno,
            }),
          }),
      );

      assert.equal(summary.apiNotice, aviso);
      assert.equal(summary.gamesCursorSeeded, true, "el aviso vuelve a sembrar");
      assert.equal(summary.gamesCursorAdvanced, false);
      const recuperado = await readGamesCursor();
      assert.ok(recuperado !== null);
      assert.equal(recuperado.seededFrom, "catch-up");
      assert.ok(
        Date.parse(recuperado.updatedAt) > now.getTime() - 2 * 60 * 60_000,
        "el cursor recuperado es reciente",
      );
      assert.equal(summary.backfillPending, 2);

      const segunda = await withIsolatedSampleRoster(
        db,
        snapshot,
        SAMPLE_PROFILE_IDS,
        () =>
          syncApprovedPlayers({
            client: createFakeClient([compartida], new Map(), [], { bulk: handler }),
          }),
      );
      assert.equal(segunda.gamesCursorSeeded, false);
      assert.equal(segunda.apiNotice, null);
      assert.equal(segunda.gamesBatchesIncomplete, 0);
    });

    await check("una pasada dirigida no mueve el cursor pero sí avanza su relleno", async () => {
      await db.player.updateMany({
        where: { profileId: SAMPLE_PROFILE_ID },
        data: { windowComplete: false, backfillPage: 1 },
      });
      const cursorAntes = (await readGamesCursor())?.updatedAt;
      const summary = await withEnv({ AOE4WORLD_SYNC_BACKFILL_PAGES_PER_PLAYER: "1" }, () =>
        syncApprovedPlayers({
          profileIds: [SAMPLE_PROFILE_ID],
          client: createFakeClient([games[0] as Aoe4WorldGame], new Map(), [], {
            playerGames: (_profileId, query) =>
              fakePage([games[0] as Aoe4WorldGame], {
                page: query?.page ?? 1,
                nextPage: 2,
              }),
          }),
        }),
      );
      const primero = summary.players[0];

      assert.ok(primero !== undefined);
      assert.equal(primero.backfillPage, 2, "la página del relleno avanza");
      assert.equal(summary.gamesCursorAdvanced, false);
      assert.equal((await readGamesCursor())?.updatedAt, cursorAntes);
    });

    await check("releer una ventana ya leída no inserta ni cuenta de más", async () => {
      await db.player.updateMany({
        where: { profileId: SAMPLE_PROFILE_ID },
        data: { windowComplete: false, backfillPage: 1 },
      });
      const summary = await syncApprovedPlayers({
        profileIds: [SAMPLE_PROFILE_ID],
        client: createFakeClient(games),
      });
      const primero = summary.players[0];

      assert.ok(primero !== undefined);
      assert.equal(primero.matchesInserted, 0);
      assert.equal(primero.matchesUpdated, 0);
      assert.equal(summary.newMatches, 0);
      assert.equal(summary.backfillPlayers, 1);
      assert.equal(
        (await db.player.findUnique({ where: { profileId: SAMPLE_PROFILE_ID } }))
          ?.windowComplete,
        true,
      );
    });

    await check("F2b vuelve a leer una ventana completa caducada y no una reciente", async () => {
      const hace31Dias = new Date(now.getTime() - 31 * 86_400_000);

      await db.player.updateMany({
        where: { profileId: SAMPLE_PROFILE_ID },
        data: { windowComplete: true, backfillPage: 1, windowCheckedAt: hace31Dias },
      });

      const summary = await syncApprovedPlayers({
        profileIds: [SAMPLE_PROFILE_ID],
        client: createFakeClient(games),
      });
      const primero = summary.players[0];

      assert.ok(primero !== undefined);
      assert.equal(summary.backfillPlayers, 1, "la ventana caducada vuelve a leerse");
      assert.equal(primero.matchesInserted, 0, "releerla no duplica nada");

      const recheckado = await db.player.findUnique({ where: { profileId: SAMPLE_PROFILE_ID } });
      assert.equal(recheckado?.windowComplete, true);
      assert.ok(recheckado?.windowCheckedAt !== null);
      assert.ok(
        recheckado.windowCheckedAt.getTime() > now.getTime() - 60_000,
        "el sello de la comprobación avanza a un valor reciente",
      );

      const segunda = await syncApprovedPlayers({
        profileIds: [SAMPLE_PROFILE_ID],
        client: createFakeClient(games),
      });

      assert.equal(segunda.backfillPlayers, 0, "una ventana recién comprobada no se rechecka");
      assert.equal(
        (await db.player.findUnique({ where: { profileId: SAMPLE_PROFILE_ID } }))
          ?.windowCheckedAt?.toISOString(),
        recheckado.windowCheckedAt.toISOString(),
        "sin recheck el sello no se mueve",
      );
    });

    await check("F2b: con 0 días la revisión queda desactivada", async () => {
      const hace31Dias = new Date(now.getTime() - 31 * 86_400_000);

      await db.player.updateMany({
        where: { profileId: SAMPLE_PROFILE_ID },
        data: { windowComplete: true, backfillPage: 1, windowCheckedAt: hace31Dias },
      });

      const summary = await withEnv({ AOE4WORLD_SYNC_RECHECK_MAX_AGE_DAYS: "0" }, () =>
        syncApprovedPlayers({
          profileIds: [SAMPLE_PROFILE_ID],
          client: createFakeClient(games),
        }),
      );

      assert.equal(summary.backfillPlayers, 0, "con 0 días no se rechecka nada");

      const sinMover = await db.player.findUnique({ where: { profileId: SAMPLE_PROFILE_ID } });
      assert.equal(sinMover?.windowCheckedAt?.toISOString(), hace31Dias.toISOString());
      assert.equal(sinMover?.windowComplete, true);
    });

    await check("F2b: el recheck no desplaza a un pendiente", async () => {
      const hace31Dias = new Date(now.getTime() - 31 * 86_400_000);

      await db.player.updateMany({
        where: { profileId: SAMPLE_PROFILE_ID },
        data: { windowComplete: true, backfillPage: 1, windowCheckedAt: hace31Dias },
      });
      await db.player.updateMany({
        where: { profileId: SAMPLE_BULK_SECOND_PROFILE_ID },
        data: { windowComplete: false, backfillPage: 1 },
      });

      const summary = await withEnv({ AOE4WORLD_SYNC_BACKFILL_MAX_PLAYERS: "1" }, () =>
        syncApprovedPlayers({
          profileIds: [...SAMPLE_PROFILE_IDS],
          client: createFakeClient(games),
        }),
      );

      assert.equal(summary.backfillPlayers, 1, "solo hay hueco para un jugador por pasada");
      assert.equal(summary.backfillPending, 0, "el hueco se lo lleva la ventana pendiente");
      assert.equal(
        (await db.player.findUnique({ where: { profileId: SAMPLE_BULK_SECOND_PROFILE_ID } }))
          ?.windowComplete,
        true,
        "el pendiente se completa",
      );
      assert.equal(
        (await db.player.findUnique({ where: { profileId: SAMPLE_PROFILE_ID } }))
          ?.windowCheckedAt?.toISOString(),
        hace31Dias.toISOString(),
        "el completo caducado se queda para la pasada siguiente",
      );

      // Las comprobaciones que vienen después no tienen por qué arrastrar una
      // ventana caducada: se deja el sello reciente para que no la rechecken.
      await db.player.update({
        where: { profileId: SAMPLE_PROFILE_ID },
        data: { windowCheckedAt: new Date(now.getTime() - 60_000) },
      });
    });

    await check("el refetch resuelve una partida en vivo que el listado ya no devuelve", async () => {
      // La partida 9000010 se guardó en vivo hace 90 min, pero el masivo ya no
      // la alcanza: el detalle tiene que resolverla.
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
      assert.ok(playerResult !== undefined);
      assert.equal(summary.resolvedByRefetch, 1);
      assert.equal(playerResult.matchesResolvedByRefetch, 1);
      assert.equal(playerResult.matchesAbandoned, 0, "una partida resuelta no se descarta");
      assert.deepEqual(detailCalls, [9_000_010], "solo se pide el detalle de la partida afectada");

      const resuelta = await db.match.findFirst({
        where: { gameId: "9000010", playerId: player.id },
      });
      assert.equal(resuelta?.result, "WIN");
      assert.equal(resuelta?.durationSeconds, 3300);
      assert.equal(
        resuelta?.finishedAt?.toISOString(),
        new Date(startedAt.getTime() + 3300_000).toISOString(),
      );
    });

    await check("una partida abandonada definitivamente se borra y queda anotada", async () => {
      // 9000011: la API la sigue dando en curso (nunca publica el desenlace).
      // 9000012: la API ya no la conoce (404).
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
      assert.ok(playerResult !== undefined);
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

      const abandonedAt = Date.parse(state.lastAbandonedAt ?? "");
      assert.ok(!Number.isNaN(abandonedAt), "lastAbandonedAt debe ser una fecha válida");
      assert.ok(
        abandonedAt >= now.getTime() && abandonedAt <= Date.now() + 60_000,
        "lastAbandonedAt debe ser de esta ejecución",
      );
    });

    await check("una partida sin resolver fuera de la ventana de directo se abandona", async () => {
      const startedAt = new Date(now.getTime() - 70 * 60_000);

      await db.match.create({
        data: {
          gameId: "9000013",
          playerId: player.id,
          leaderboard: "rm_solo",
          result: null,
          startedAt,
          finishedAt: null,
          rawJson: fixture.live,
        },
      });

      const details = new Map<string, Aoe4WorldGame>([
        [
          "9000013",
          parsedGame({
            ...fixture.live,
            game_id: 9_000_013,
            started_at: startedAt.toISOString(),
          }),
        ],
      ]);

      const summary = await syncApprovedPlayers({
        profileIds: [SAMPLE_PROFILE_ID],
        client: createFakeClient(games, details),
      });

      const playerResult = summary.players[0];
      assert.ok(playerResult !== undefined);
      assert.equal(playerResult.matchesAbandoned, 1);
      assert.equal(
        await db.match.count({ where: { playerId: player.id, gameId: "9000013" } }),
        0,
        "la fila abandonada no puede quedar con finishedAt = null",
      );
    });

    await check("un perfil fresco no llama a getPlayer", async () => {
      await db.player.update({
        where: { profileId: SAMPLE_PROFILE_ID },
        data: { profileCheckedAt: new Date(now.getTime() - 5 * 60_000) },
      });
      const profileCalls: number[] = [];

      await syncApprovedPlayers({
        profileIds: [SAMPLE_PROFILE_ID],
        client: createFakeClient(games, new Map(), [], { profileCalls }),
      });

      assert.deepEqual(profileCalls, [], "la caché de una hora evita la petición");
    });

    await check("un perfil sin sello o caducado se pide y se sella", async () => {
      for (const checkedAt of [null, new Date(now.getTime() - 2 * 60 * 60_000)]) {
        await db.player.update({
          where: { profileId: SAMPLE_PROFILE_ID },
          data: { profileCheckedAt: checkedAt, aoe4WorldName: null },
        });
        const profileCalls: number[] = [];

        await syncApprovedPlayers({
          profileIds: [SAMPLE_PROFILE_ID],
          client: createFakeClient(games, new Map(), [], { profileCalls }),
        });

        assert.equal(
          profileCalls.includes(SAMPLE_PROFILE_ID),
          true,
          `un sello ${checkedAt === null ? "nulo" : "caducado"} tiene que pedir el perfil`,
        );

        const fila = await db.player.findUnique({ where: { profileId: SAMPLE_PROFILE_ID } });
        assert.ok(fila?.profileCheckedAt !== null, "una llamada correcta sella la columna");
        assert.equal(fila?.aoe4WorldName, "Jugador Muestra Actualizado");
        assert.equal(fila?.name, "Jugador Muestra", "el nombre de display no se pisa");
      }
    });

    await check("la ladder sella el perfil y evita getPlayer", async () => {
      await db.player.update({
        where: { profileId: SAMPLE_PROFILE_ID },
        data: { profileCheckedAt: null, aoe4WorldName: null },
      });
      const profileCalls: number[] = [];
      const leaderboard = async (
        key: string,
        profileIds: number[],
      ): Promise<Aoe4WorldLeaderboard> => ({
        key,
        name: key,
        season: 14,
        totalCount: profileIds.length,
        players: profileIds.map((profileId) => ({
          profileId,
          name: "Nombre desde la ladder",
          country: "es",
          rating: 1_500,
          rank: 1,
          rankLevel: "gold_1",
          streak: 1,
          gamesCount: 10,
          winsCount: 5,
          lossesCount: 5,
          twitchUrl: null,
          twitchIsLive: false,
          avatars: { small: null, medium: null, full: null },
          lastGameAt: null,
        })),
      });

      await syncApprovedPlayers({
        profileIds: [SAMPLE_PROFILE_ID],
        client: createFakeClient(games, new Map(), [], { profileCalls, leaderboard }),
      });

      assert.deepEqual(profileCalls, [], "la ladder ya selló el perfil en esta pasada");
      const fila = await db.player.findUnique({ where: { profileId: SAMPLE_PROFILE_ID } });
      assert.equal(fila?.aoe4WorldName, "Nombre desde la ladder");
      assert.ok(fila?.profileCheckedAt !== null, "la ladder sella profileCheckedAt");

      // Las comprobaciones que vienen después esperan el nombre que dejó el
      // camino de perfil. La ladder de este escenario es sintética, así que se
      // deshace al terminar para no contaminar el resto de la verificación.
      await db.player.update({
        where: { profileId: SAMPLE_PROFILE_ID },
        data: { aoe4WorldName: "Jugador Muestra Actualizado" },
      });
    });

    await check("la clave de Setting es la documentada y el cursor es global", async () => {
      const cursor = await db.setting.findUnique({ where: { key: SYNC_GAMES_CURSOR_KEY } });
      const auditoria = await db.setting.findUnique({
        where: { key: playerSyncKey(SAMPLE_PROFILE_ID) },
      });

      assert.ok(cursor !== null, "sync.gamesCursor está en Setting");
      assert.ok(auditoria !== null, "aoe4world.sync.player.<id> queda como auditoría");
    });

    /* ---------------------------------------------------------------------- */
    /* F3b: no recalcular lo que no ha cambiado                                */
    /* ---------------------------------------------------------------------- */

    /**
     * Repite la misma pasada hasta encontrar una que no tenga nada que hacer.
     *
     * La primera puede tener trabajo residual (un summary pendiente de la cola
     * global, el nombre que dejó una comprobación anterior) y lo que se quiere
     * medir es una **pasada idéntica que además se salte el recálculo**. Con tres
     * intentos sobra y, si no sale ninguna, el fallo lo dice en vez de dar por
     * buena una pasada con trabajo.
     */
    async function syncHastaPasadaOciosa(): Promise<{
      summary: Awaited<ReturnType<typeof syncApprovedPlayers>>;
      lastRunBefore: { updatedAt: Date; value: Prisma.JsonValue } | null;
    }> {
      for (let intento = 0; intento < 3; intento += 1) {
        const lastRunBefore = await db.setting.findUnique({
          where: { key: SCORING_LAST_RUN_KEY },
        });
        const summary = await withIsolatedSampleRoster(
          db,
          snapshot,
          SAMPLE_PROFILE_IDS,
          () => syncApprovedPlayers({ client: createFakeClient(games) }),
        );
        const nadaQueHacer =
          summary.newMatches === 0 &&
          summary.updatedMatches === 0 &&
          summary.resolvedByRefetch === 0 &&
          summary.abandonedMatches === 0 &&
          (summary.summaries?.fetched ?? 0) === 0 &&
          summary.mapPool?.status !== "updated";

        if (nadaQueHacer && summary.scoringSkipped) {
          return {
            summary,
            lastRunBefore:
              lastRunBefore === null
                ? null
                : { updatedAt: lastRunBefore.updatedAt, value: lastRunBefore.value },
          };
        }
      }

      throw new Error(
        "tres pasadas idénticas seguidas han recalculado: el salto del recálculo no está funcionando",
      );
    }

    await check("una pasada ociosa se salta el recálculo y no toca scoring.lastRun", async () => {
      await db.player.updateMany({
        where: { profileId: { in: [...SAMPLE_PROFILE_IDS] } },
        data: { windowComplete: true },
      });

      const { summary, lastRunBefore } = await syncHastaPasadaOciosa();

      assert.ok(lastRunBefore !== null, "antes de la pasada tiene que existir scoring.lastRun");
      assert.equal(summary.scoringSkipped, true, "sin novedades no se recalcula");
      assert.equal(summary.scoring, null, "el resumen no trae recálculo");
      assert.equal(summary.scoringError, null, "saltárselo no es un fallo");

      const lastRunAfter = await db.setting.findUnique({
        where: { key: SCORING_LAST_RUN_KEY },
      });
      assert.ok(lastRunAfter !== null);
      assert.equal(
        lastRunAfter.updatedAt.getTime(),
        lastRunBefore.updatedAt.getTime(),
        "el rastro del recálculo no se reescribe si no se recalcula",
      );
      assert.deepEqual(lastRunAfter.value, lastRunBefore.value);
    });

    await check("sin rastro del recálculo o con otra versión de caché, se recalcula", async () => {
      await db.setting.deleteMany({ where: { key: SCORING_LAST_RUN_KEY } });

      const sinRastro = await withIsolatedSampleRoster(
        db,
        snapshot,
        SAMPLE_PROFILE_IDS,
        () => syncApprovedPlayers({ client: createFakeClient(games) }),
      );

      assert.equal(sinRastro.scoringSkipped, false, "sin rastro se recalcula");
      assert.ok(sinRastro.scoring !== null, "y el resumen trae el recálculo");

      const guardado = await db.setting.findUnique({ where: { key: SCORING_LAST_RUN_KEY } });
      assert.ok(guardado !== null, "el recálculo vuelve a dejar el rastro");
      const valor = guardado.value as unknown as Record<string, unknown>;

      assert.equal(valor["cacheVersion"], SCORING_CACHE_VERSION);

      // Una versión de caché vieja (lo que deja un despliegue con otra lista de
      // dependencias) tiene que forzar un recálculo aunque no haya cambiado nada.
      await db.setting.update({
        where: { key: SCORING_LAST_RUN_KEY },
        data: {
          value: {
            ...valor,
            cacheVersion: SCORING_CACHE_VERSION + 1,
          } as unknown as Prisma.InputJsonValue,
        },
      });

      const versionVieja = await withIsolatedSampleRoster(
        db,
        snapshot,
        SAMPLE_PROFILE_IDS,
        () => syncApprovedPlayers({ client: createFakeClient(games) }),
      );

      assert.equal(versionVieja.scoringSkipped, false, "otra versión de caché se recalcula");
      assert.ok(versionVieja.scoring !== null);
    });

    await check("un cambio de metadato de la ladder fuerza el recálculo", async () => {
      const nombreNuevo = "Nombre desde la ladder (F3b)";
      const leaderboard = async (
        key: string,
        profileIds: number[],
      ): Promise<Aoe4WorldLeaderboard> => ({
        key,
        name: key,
        season: 14,
        totalCount: profileIds.length,
        players: profileIds.map((profileId) => ({
          profileId,
          name: nombreNuevo,
          country: "es",
          rating: 1_600,
          rank: 1,
          rankLevel: "platinum_1",
          streak: 1,
          gamesCount: 10,
          winsCount: 5,
          lossesCount: 5,
          twitchUrl: null,
          twitchIsLive: false,
          avatars: { small: null, medium: null, full: null },
          lastGameAt: null,
        })),
      });

      const summary = await withIsolatedSampleRoster(
        db,
        snapshot,
        SAMPLE_PROFILE_IDS,
        () => syncApprovedPlayers({ client: createFakeClient(games, new Map(), [], { leaderboard }) }),
      );

      assert.equal(
        summary.ladder.playersChanged > 0,
        true,
        "el nombre y la división nuevos cuentan como cambio",
      );
      assert.equal(summary.scoringSkipped, false, "un metadato que lee el motor fuerza el recálculo");
      assert.ok(summary.scoring !== null);

      // Las comprobaciones que vienen después esperan el nombre que dejó el camino
      // de perfil, igual que el escenario de la ladder de más arriba.
      await db.player.update({
        where: { profileId: SAMPLE_PROFILE_ID },
        data: { aoe4WorldName: "Jugador Muestra Actualizado" },
      });
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
      assert.equal(score.wins, 4);
      assert.equal(score.matches, 5, "cinco partidas clasificatorias resueltas: 4 ganadas y la perdida");

      const breakdown = score.breakdown as {
        ruleSetVersion: number;
        rule: string;
        byMode: Record<string, { wins: number; points: number; matches: number }>;
        objectives: {
          points: number;
          earned: string[];
          awards: Record<string, { points: number; count: number }>;
        };
      };

      const puntosDePartidas = DEFAULT_RULESET.pointsPerWin * score.wins;

      // Con las reglas actuales todo punto de un jugador sale de sus objetivos: las
      // victorias se cobran por el objetivo `victorias`, así que el total de la fila es
      // el reparto de objetivos y `Match.points` es solo auditoría.
      assert.equal(
        score.total,
        breakdown.objectives.points,
        "el total de la fila es el reparto de objetivos",
      );
      assert.deepEqual(
        breakdown.objectives.awards.victorias,
        { points: puntosDePartidas, count: score.wins },
        "el objetivo de victorias paga pointsPerWin por victoria",
      );
      assert.equal(
        breakdown.objectives.points,
        Object.values(breakdown.objectives.awards).reduce(
          (sum, award) => sum + award.points,
          0,
        ),
        "los puntos de objetivos son la suma de sus importes reales",
      );

      // Los puntos de la tabla y los de las partidas tienen que cuadrar.
      const puntosEnPartidas = await db.match.aggregate({
        where: { playerId: player.id },
        _sum: { points: true },
      });
      assert.equal(
        puntosEnPartidas._sum.points,
        puntosDePartidas,
        "Match.points suma lo mismo que los puntos por victoria del desglose",
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
        wins: 4,
        points: 4 * DEFAULT_RULESET.pointsPerWin,
        matches: 4,
      });
      assert.deepEqual(breakdown.byMode.rm_team, { wins: 0, points: 0, matches: 1 });

      // Los objetivos del desglose tienen que existir y cada uno llevar su importe: los
      // puntos de la sección son la suma de los `awards`, no de los precios del catálogo
      // (que en `imparable` es el tope y en `victorias`, el precio por unidad).
      assert.equal(
        breakdown.objectives.earned.every((id) => id in DEFAULT_RULESET.objectives),
        true,
        `objetivos desconocidos en el desglose: ${breakdown.objectives.earned.join(", ")}`,
      );
      assert.deepEqual(
        breakdown.objectives.earned.slice().sort(),
        Object.keys(breakdown.objectives.awards).slice().sort(),
        "cada objetivo anotado en el desglose tiene su importe real",
      );

      // Los puntos de auditoría de las partidas cuadran con el desglose por modo: ya no
      // suman en el total, pero tienen que seguir describiendo lo que dice `Match.points`.
      const partidasAprobados = await db.match.aggregate({
        where: { player: { status: "APPROVED" }, mode: { in: DEFAULT_RULESET.modes } },
        _sum: { points: true },
      });
      assert.equal(
        (await db.playerScore.findMany({
          where: { ruleSetVersion: RULESET_VERSION },
          select: { breakdown: true },
        })).reduce((sum, fila) => {
          const byMode =
            (fila.breakdown as { byMode?: Record<string, { points?: number }> } | null)?.byMode ??
            {};

          return (
            sum +
            Object.values(byMode).reduce((porModo, modo) => porModo + (modo.points ?? 0), 0)
          );
        }, 0),
        partidasAprobados._sum.points ?? 0,
        "los puntos por modo de la tabla cuadran con la suma de Match.points",
      );

      assert.equal(
        primera.totalPoints,
        primera.objectivesPoints + primera.eventsPoints,
        "todo punto de la tabla sale de los objetivos más el bono de los eventos",
      );

      // Los puestos de toda la tabla tienen que ser coherentes con el orden.
      const todas = await db.playerScore.findMany({
        where: { ruleSetVersion: RULESET_VERSION },
        orderBy: { rank: "asc" },
        select: { rank: true, total: true, wins: true, matches: true },
      });

      // El `rank` ya **no** es un 1..N denso: dos filas con el mismo total, tasa de
      // victorias, victorias y partidas comparten puesto (1, 2, 2, 4) y el hueco se
      // pierde. Lo que sí se cumple —y es lo que se comprueba— es que la tabla
      // empieza en 1, que el puesto no retrocede y que solo avanza con la primera
      // fila de una tupla distinta.
      assert.equal(
        todas.length === 0 || todas[0]?.rank === 1,
        true,
        "la clasificación empieza en el puesto 1",
      );
      assert.equal(
        todas.every((row, index) => index === 0 || row.rank >= (todas[index - 1]?.rank ?? 0)),
        true,
        "los puestos no decrecen",
      );
      assert.equal(
        todas.every((row, index) => {
          const anterior = todas[index - 1];

          if (anterior === undefined) {
            return true;
          }

          // Con la misma tupla el puesto se comparte; con una distinta, la fila
          // abre grupo y toma su posición natural.
          const mismaTupla =
            anterior.total === row.total &&
            anterior.wins === row.wins &&
            anterior.matches === row.matches;

          return mismaTupla ? row.rank === anterior.rank : row.rank === index + 1;
        }),
        true,
        "el puesto se comparte con la tupla idéntica y avanza con la primera fila de la siguiente",
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
      // lo mismo que el agregado y que el `UPDATE` de `Match.points`, que son sus
      // dos traducciones a SQL. Es la comprobación que avisa si las tres se
      // desincronizan: se recorren todas las partidas del jugador de muestra y se
      // comparan las dos cuentas. El `registeredAt` del jugador va en la llamada
      // porque es la condición que depende de él, y los cortes cacheados van en el
      // contexto porque son la condición de equipos: es la única de las seis que el
      // `where` de Prisma no puede escribir, así que este contraste es el único que
      // puede pillar una discrepancia entre el SQL y la memoria.
      const ventana = (await readRuleset()).window;
      const cutoffs = await readDivisionCutoffs();
      const { registeredAt } = await db.player.findUniqueOrThrow({
        where: { id: player.id },
        select: { registeredAt: true },
      });
      const equipo: TeamTierContext = { profileId: player.profileId, cutoffs };
      const filas = await db.match.findMany({
        where: { playerId: player.id },
        select: {
          mode: true,
          result: true,
          startedAt: true,
          finishedAt: true,
          revertedAt: true,
          rawJson: true,
          points: true,
        },
      });
      const enJs = filas.filter((fila) => countsAsRanked(fila, ventana, registeredAt, equipo));

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
      // `Match.points` ya no suma en la clasificación (todo punto sale de los
      // objetivos), pero tiene que seguir cuadrando con la auditoría del desglose.
      assert.equal(
        enJs.reduce((sum, fila) => sum + fila.points, 0),
        Object.values(breakdown.byMode).reduce((sum, modo) => sum + modo.points, 0),
        "los puntos de `Match.points` son los que anota la auditoría por modo",
      );
      assert.equal(
        filas.filter((fila) => !countsAsRanked(fila, ventana, registeredAt, equipo)).every(
          (fila) => fila.points === 0,
        ),
        true,
        "ninguna partida que no cuenta puede tener puntos",
      );
    });

    await check("los objetivos se publican con el contrato previsto", async () => {
      const {
        IMPARABLE_ID,
        JUGON_ID,
        OBJECTIVE_COUNT,
        OBJECTIVE_GROUP_LABELS,
        POLIFACETICO_ID,
        VICTORIAS_ID,
      } = await import("@/lib/objectives");

      const view = unwrapRead(await getObjectives(), "verify:objetivos/contrato");
      // La etiqueta ya no es una constante: se calcula con los objetivos activos del
      // ruleset publicado, así que se compara contra el activo y no contra el código.
      const activo = await readRuleset();

      assert.equal(view.ruleSetVersion, RULESET_VERSION);
      assert.equal(view.rule, activo.label, "la etiqueta pública es la del ruleset activo");
      assert.deepEqual(
        view.window,
        activo.window,
        "la vista publica la ventana activa, para que el copy no lleve fechas escritas a mano",
      );
      assert.equal(
        view.pointsPerWin,
        DEFAULT_RULESET.pointsPerWin,
        "los puntos por victoria salen del ruleset activo",
      );
      assert.equal(
        Array.isArray(view.mapPool) && view.mapPool.length > 0,
        true,
        "la vista publica el pool de mapas activo",
      );
      assert.equal(
        view.options.length,
        OBJECTIVE_COUNT,
        `hay los ${OBJECTIVE_COUNT} objetivos de docs/OBJETIVOS.md`,
      );

      const groups = view.options.map((option) => option.group);
      assert.deepEqual(
        [...new Set(groups)],
        ["actividad", "racha", "hazanas", "formato", "civilizacion"],
        "los grupos salen en el orden documentado, sin intercalarse",
      );
      assert.deepEqual(
        view.options.slice(0, 5).map((option) => option.id),
        ["loco-por-ganar", "imparable", "victorias", "bienhadado", "imbatible"],
        "Actividad y Racha salen en el orden documentado",
      );
      assert.equal(
        groups.every((group) => group in OBJECTIVE_GROUP_LABELS),
        true,
        "todo grupo tiene rótulo",
      );

      // Las familias de civilización: cabeza, hijos y sus etiquetas.
      const porId = new Map(view.options.map((option) => [option.id, option]));
      const polifacetico = porId.get(POLIFACETICO_ID);
      const jugon = porId.get(JUGON_ID);

      assert.ok(polifacetico !== undefined, "polifacetico existe");
      assert.ok(jugon !== undefined, "jugon existe");
      assert.equal(polifacetico.kind, "achievement");
      assert.equal(jugon.kind, "achievement");
      assert.equal(polifacetico.parent, null);
      assert.equal(
        view.options.filter((option) => option.parent === POLIFACETICO_ID).length,
        CIVILIZATIONS.length,
        "los lider-* apuntan a polifacetico",
      );
      assert.equal(
        view.options.filter((option) => option.parent === JUGON_ID).length,
        CIVILIZATIONS.length,
        "los acolito-* apuntan a jugon",
      );
      assert.equal(porId.get("masterizando-japanese")?.kind, "competition");
      assert.equal(
        porId.get("lider-japanese")?.label.includes("Japoneses"),
        true,
        "el rótulo de un lider-* nombra la civilización",
      );

      const holders = new Set<string>();

      for (const option of view.options) {
        assert.equal(
          option.points,
          option.id === VICTORIAS_ID
            ? DEFAULT_RULESET.pointsPerWin
            : DEFAULT_RULESET.objectives[option.id],
          `${option.id}: los puntos salen del ruleset`,
        );
        assert.ok(
          option.description.trim().length > 0,
          `${option.id}: la descripción de la regla no está vacía`,
        );
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
            `${option.id}: eligible es un booleano`,
          );
          assert.equal(
            contender.profileUrl,
            `https://aoe4world.com/players/${contender.profileId}`,
            `${option.id}: profileUrl con el mismo criterio que la clasificación`,
          );
        }

        if (option.kind === "competition") {
          assert.equal(option.target, null, `${option.id}: una competición no tiene umbral`);
          assert.equal(
            option.beneficiaries.length,
            0,
            `${option.id}: una competición no reparte entre varios`,
          );

          if (option.holder !== null) {
            holders.add(option.id);
            assert.equal(
              option.holder.eligible,
              true,
              `${option.id}: el poseedor cumple la condición`,
            );
            assert.ok(
              option.ranking.some(
                (contender) => contender.profileId === option.holder?.profileId,
              ),
              `${option.id}: el poseedor aparece en el ranking, marcado por holder`,
            );
          }
        } else {
          assert.equal(option.holder, null, `${option.id}: un logro no tiene poseedor único`);
          // Todo logro tiene umbral salvo el de victorias, que no se completa: se
          // repite con cada victoria y no tiene tope.
          assert.ok(
            option.target !== null || option.id === VICTORIAS_ID,
            `${option.id}: un logro tiene umbral (salvo el de victorias, sin tope)`,
          );
          assert.equal(
            new Set(option.beneficiaries.map((beneficiary) => beneficiary.profileId)).size,
            option.beneficiaries.length,
            `${option.id}: los beneficiarios no se repiten`,
          );

          if (option.beneficiaries.length > 0) {
            holders.add(option.id);
          }

          for (const beneficiary of option.beneficiaries) {
            assert.ok(
              beneficiary.points > 0,
              `${option.id}: un beneficiario cobra puntos positivos`,
            );
            assert.ok(
              beneficiary.count >= 1,
              `${option.id}: un beneficiario ha conseguido el objetivo al menos una vez`,
            );
            assert.equal(
              option.id === VICTORIAS_ID || option.id === IMPARABLE_ID
                ? beneficiary.count >= 1
                : beneficiary.count === 1,
              true,
              `${option.id}: solo los logros repetibles publican más de una repetición`,
            );
            assert.ok(
              option.ranking.some(
                (contender) =>
                  contender.profileId === beneficiary.profileId && contender.eligible,
              ),
              `${option.id}: todo beneficiario aparece en el ranking como cumplido`,
            );
          }
        }
      }

      // Lo que el motor anotó en el desglose tiene que coincidir con lo que
      // publica la vista: mismos objetivos, mismos poseedores.
      const score = await db.playerScore.findUnique({
        where: { playerId_ruleSetVersion: { playerId: player.id, ruleSetVersion: RULESET_VERSION } },
      });

      assert.ok(score !== null);
      const breakdown = score.breakdown as { rule: string; objectives: { earned: string[] } };
      const reglasActivas = await readRuleset();
      assert.equal(
        breakdown.rule,
        reglasActivas.label,
        "el desglose guarda la etiqueta del ruleset activo",
      );
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
        reglasActivas.label,
        "el label guardado en scoring.ruleset es el que calcula el código",
      );
    });

    await check("la clasificación pública solo muestra a los aprobados", async () => {
      const { getStandings, getLiveMatches, getTwitchChannels } = await import("@/lib/public");

      // Un segundo jugador, aprobado, sin partidas: sale con todo a cero.
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

        // El `vacio` acaba de nacer, así que su fila en `PlayerScore` no existe
        // hasta que el motor recalcule. Se recálcula aquí para poder comprobar la
        // regla nueva: todo aprobado tiene fila, aunque no haya jugado.
        await recomputeScores();

        const standings = unwrapRead(await getStandings(), "verify:clasificacion").rows;
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
        assert.equal(fila.wins + fila.losses, 5);
        assert.equal(
          fila.points >= 3 * DEFAULT_RULESET.pointsPerWin,
          true,
          "con los objetivos no se puede sumar menos que con las partidas solas",
        );
        const vacioFila = standings.find((row) => row.profileId === vacio.profileId);

        assert.ok(
          vacioFila !== undefined,
          "un aprobado sin partidas clasificatorias también sale en la clasificación",
        );
        assert.equal(vacioFila.points, 0, "y con 0 puntos");
        assert.equal(vacioFila.wins, 0);
        assert.equal(vacioFila.losses, 0);
        // Con puestos compartidos, el último puesto ya no es `standings.length`:
        // si otra fila también está a cero comparte puesto con él. Lo que sí se
        // puede afirmar es que es el mayor de la tabla y que todos los que están a
        // cero (0 puntos, 0 victorias, 0 derrotas) lo comparten.
        const puestos = standings.map((row) => row.rank);
        const ultimo = Math.max(...puestos);

        assert.equal(vacioFila.rank, ultimo, "aparece en el último puesto: no ha puntuado nada");
        assert.equal(
          fila.rank < vacioFila.rank,
          true,
          "el jugador que ha puntuado va por delante del que no ha jugado",
        );
        assert.equal(
          standings
            .filter((row) => row.points === 0 && row.wins === 0 && row.losses === 0)
            .every((row) => row.rank === ultimo),
          true,
          "los aprobados sin ninguna partida comparten el último puesto",
        );
        assert.equal(
          standings.some((row) => row.profileId === SAMPLE_PENDING_PROFILE_ID),
          false,
          "un jugador pendiente no tiene fila",
        );
        // Como arriba: el `rank` es de competición, no un 1..N denso. Se comprueba
        // que empieza en 1, que no retrocede y que solo avanza con la primera fila
        // de una tupla distinta (aquí las partidas se reconstruyen de
        // `wins + losses`, que es todo lo que publica `StandingRow`).
        assert.equal(
          standings.every((row, index) => {
            const anterior = standings[index - 1];

            if (anterior === undefined) {
              return row.rank === 1;
            }

            const mismaTupla =
              anterior.points === row.points &&
              anterior.wins === row.wins &&
              anterior.wins + anterior.losses === row.wins + row.losses;

            return mismaTupla ? row.rank === anterior.rank : row.rank === index + 1;
          }),
          true,
          "los puestos se comparten con la tupla idéntica y no retroceden",
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
    await db.player.deleteMany({ where: { profileId: { in: [...TEST_PROFILE_IDS] } } });
    await db.setting.deleteMany({
      where: { key: { in: TEST_PROFILE_IDS.map(playerSyncKey) } },
    });
    await restoreSetting(db, SCORING_RULESET_KEY, rulesetGuardado);
    await restoreApprovedRows(db, snapshot.approved);
    await recomputeScores();
    await restoreDatabaseState(
      db,
      snapshot,
      SYNC_GAMES_CURSOR_KEY,
      SYNC_LAST_RUN_KEY,
      SCORING_LAST_RUN_KEY,
      TEST_PROFILE_IDS,
      playerSyncKey,
    );
    console.log("  --    datos de prueba borrados y estado de producción restaurado");
  }
}

/**
 * La lista de países de la inscripción, sin tocar la base de datos.
 *
 * Lo que decide qué países admite el torneo es un documento de `Setting` que la
 * organización cambia sin desplegar, así que hay tres cosas que comprobar aquí y
 * ninguna necesita `--db`:
 *
 * - que la lista por defecto del código sea la de `paises.txt`, la fuente de verdad
 *   para sembrarla, y que las dos no divergan;
 * - que la validación del documento sea **de todo o nada**: un array vacío, un
 *   elemento que no es texto o un país repetido se descartan enteros, no a medias;
 * - que `parseCountry()` resuelva el valor escrito al rótulo canónico, incluidos
 *   los casos en los que está escrito de otra manera (sin tilde, con espacios).
 * - que `findCountryIsoConflict()` solo diga que hay contradicción cuando los dos
 *   países se han resuelto: ISO que coincide, ISO que contradice, ISO que no se
 *   puede traducir y perfil sin país. Y que la tabla de ISO y la lista por defecto
 *   no puedan divergir sin que se note.
 *
 * Lo que sí necesita la base es que la lista **publicada** sea la que se está
 * usando, y eso lo comprueba `--db`.
 */
async function checkRegistrationCountries(): Promise<void> {
  console.log("Países de la inscripción");

  const { DEFAULT_COUNTRIES, REGISTRATION_COUNTRIES_KEY, mergeCountries } = await import(
    "@/lib/countries"
  );
  const { parseCountry } = await import("@/lib/player-input");

  await check(
    `la lista por defecto son los ${EXPECTED_COUNTRIES.length} países de paises.txt, en su orden`,
    () => {
      assert.deepEqual([...DEFAULT_COUNTRIES], EXPECTED_COUNTRIES);
      assert.equal(
        REGISTRATION_COUNTRIES_KEY,
        "registration.countries",
        "la clave de `Setting` es la que leen la inscripción y el panel",
      );
    },
  );

  await check("paises.txt y la lista por defecto del código no divergen", () => {
    // El fichero es lo que se versiona y lo que siembra `npm run countries:seed`;
    // la constante es lo que se usa antes de que haya lista publicada. Si divergen,
    // el primer despliegue sin sembrar ofrecería una lista que no es la del
    // repositorio, y nadie se enteraría hasta que alguien mirara el desplegable.
    const delFichero = readFileSync(PAISES_FILE, "utf8")
      .replace(/^\uFEFF/, "")
      .split(/\r?\n/)
      .map((linea) => linea.trim())
      .filter((linea) => linea !== "");

    assert.deepEqual(delFichero, [...DEFAULT_COUNTRIES]);
  });

  await check("la lista por defecto pasa su propia validación", () => {
    const propia = mergeCountries(DEFAULT_COUNTRIES);

    assert.deepEqual(propia.warnings, [], "si avisara, el respaldo se descartaría a sí mismo");
    assert.deepEqual(propia.countries, [...DEFAULT_COUNTRIES]);
  });

  await check("una lista publicada válida se respeta tal cual, con sus espacios", () => {
    const buena = mergeCountries(["España", "Colombia", "República Dominicana"]);

    assert.deepEqual(buena.countries, ["España", "Colombia", "República Dominicana"]);
    assert.deepEqual(buena.warnings, []);

    // Los espacios de fuera se recortan en vez de invalidar el documento: es lo que
    // hace falta para tolerar que alguien edite el JSON a mano en el panel de
    // Supabase. El **rótulo** que sale es el recortado, que es el que se guarda.
    const conEspacios = mergeCountries([" España ", "  Colombia"]);

    assert.deepEqual(conEspacios.countries, ["España", "Colombia"]);
    assert.deepEqual(conEspacios.warnings, []);
  });

  await check("un documento que no se entiende se descarta entero, no a medias", () => {
    const porDefecto = [...DEFAULT_COUNTRIES];
    const invalidos: Array<{ valor: unknown; motivo: string }> = [
      { valor: "España", motivo: "un texto suelto" },
      { valor: { paises: ["España"] }, motivo: "un objeto" },
      { valor: [], motivo: "una lista vacía" },
      { valor: ["España", 42], motivo: "un elemento que no es texto" },
      { valor: ["España", null], motivo: "un elemento nulo" },
      { valor: ["España", "   "], motivo: "un elemento en blanco" },
      { valor: ["España", "España"], motivo: "un país repetido" },
      {
        valor: ["España", "  España  "],
        motivo: "un repetido que solo cambia en el espaciado",
      },
      { valor: ["España", " españa"], motivo: "un repetido que solo cambia en la tilde" },
      {
        valor: ["España", " ESPANA".normalize("NFD")],
        motivo: "un repetido con la ñ descompuesta",
      },
    ];

    for (const { valor, motivo } of invalidos) {
      const resultado = mergeCountries(valor);

      assert.deepEqual(
        resultado.countries,
        porDefecto,
        `${motivo} debería caer a la lista por defecto entera`,
      );
      assert.equal(
        resultado.warnings.length > 0,
        true,
        `${motivo} debería avisar, y el aviso es lo único que avisa de que la lista publicada no sirve`,
      );
    }
  });

  await check("parseCountry devuelve el rótulo canónico de la lista", () => {
    assert.equal(parseCountry("España", DEFAULT_COUNTRIES), "España");
    assert.equal(parseCountry("Colombia", DEFAULT_COUNTRIES), "Colombia");
    assert.equal(parseCountry("Puerto Rico", DEFAULT_COUNTRIES), "Puerto Rico");

    // Elegido bien y escrito de otra manera: no está mal, está escrito distinto, y
    // guardarlo tal cual haría que el mismo país tuviera dos formas en la tabla.
    assert.equal(parseCountry("Republica Dominicana", DEFAULT_COUNTRIES), "República Dominicana");
    assert.equal(parseCountry(" PUERTO RICO ", DEFAULT_COUNTRIES), "Puerto Rico");
    assert.equal(parseCountry("  españa  ", DEFAULT_COUNTRIES), "España");
    assert.equal(parseCountry("guinea ecuatorial", DEFAULT_COUNTRIES), "Guinea Ecuatorial");

    // La `ñ` se dobla como cualquier otro diacrítico (en Unicode es una `n` con
    // tilde), y da igual si el texto la traía compuesta o descompuesta: sin el
    // `NFC` previo de `foldCountryName`, "ESPANA" descompuesta no se reconocería
    // como "España" y el mismo país dependería de quién lo escribió.
    assert.equal(parseCountry("Espana", DEFAULT_COUNTRIES), "España");
    assert.equal(parseCountry("Panama", DEFAULT_COUNTRIES), "Panamá");
    assert.equal(
      parseCountry("Espan\u0303a", DEFAULT_COUNTRIES),
      "España",
      "la ñ descompuesta resuelve al mismo rótulo",
    );

    // Lo que no está en la lista no se admite, por escrito parecido que sea: un
    // desplegable de 22 países no puede convertirse en "cualquier texto que se
    // parezca a uno de ellos".
    assert.equal(parseCountry("Estados Unidos", DEFAULT_COUNTRIES), null);
    assert.equal(parseCountry("Espana", ["Colombia", "España"]), "España");
    assert.equal(parseCountry("España", []), null, "sin lista no se admite nada");

    // Vacío y no admitido devuelven ambos `null`, y quien llama los distingue
    // mirando el valor crudo: el campo es opcional en el alta de admin.
    assert.equal(parseCountry("", DEFAULT_COUNTRIES), null);
    assert.equal(parseCountry("   ", DEFAULT_COUNTRIES), null);
    assert.equal(parseCountry(null, DEFAULT_COUNTRIES), null);
  });

  await checkCountryIsoConflict();
}

/**
 * El contraste entre el país de AoE4World y el que eligió la persona.
 *
 * Son cuatro casos y solo uno bloquea, que es el sentido de toda la regla: el
 * formulario **no** puede afirmar que alguien se equivoca de país si no ha sido
 * capaz de resolver los dos.
 *
 * 1. Los dos países se resuelven y son el mismo → pasa.
 * 2. Los dos se resuelven y son distintos → contradicción, con los dos rótulos.
 * 3. El ISO no se puede traducir a un rótulo de la lista admitida (`"gb"`) → pasa.
 * 4. El perfil no trae país → pasa.
 *
 * Y con ellos, las dos cosas que pueden hacer que la comparación diga algo que no
 * es: un ISO escrito con otros espacios o en mayúsculas (la API manda minúsculas,
 * pero el valor viene de fuera), y un ISO que sí se traduce pero cuyo rótulo ya no
 * está en la lista publicada, que es el caso de una organización que ha acortado la
 * lista.
 */
async function checkCountryIsoConflict(): Promise<void> {
  const { DEFAULT_COUNTRIES, findCountryIsoConflict } = await import("@/lib/countries");

  await check("la tabla de ISO cubre la lista por defecto, país por país", () => {
    const conIso = EXPECTED_COUNTRIES.filter((pais) => pais in EXPECTED_COUNTRY_ISOS);
    const sinIso = EXPECTED_COUNTRIES.filter((pais) => !(pais in EXPECTED_COUNTRY_ISOS));

    assert.deepEqual(
      sinIso,
      [],
      `países de la lista sin ISO en la tabla: ${sinIso.join(", ")}`,
    );
    assert.deepEqual(
      Object.keys(EXPECTED_COUNTRY_ISOS).filter((pais) => !DEFAULT_COUNTRIES.includes(pais)),
      [],
      "la tabla de ISO trae países que no están en la lista",
    );
    assert.equal(conIso.length, DEFAULT_COUNTRIES.length);

    // Cada ISO resuelve a su propio país y solo a su propio país: es la condición
    // para que comparar dos rótulos plegados no produzca ni un falso positivo ni un
    // falso negativo. Los dos códigos que más se confunden van comprobados por su
    // nombre, porque son los que se escriben mal.
    for (const [pais, iso] of Object.entries(EXPECTED_COUNTRY_ISOS)) {
      const otros = EXPECTED_COUNTRIES.filter((otro) => otro !== pais);

      for (const otro of otros) {
        assert.deepEqual(
          findCountryIsoConflict({
            aoe4WorldCountry: iso,
            selectedCountry: otro,
            allowed: DEFAULT_COUNTRIES,
          }),
          { aoe4WorldCountry: pais, selectedCountry: otro },
          `el ISO "${iso}" debería señalar solo a ${pais}`,
        );
      }
    }

    assert.equal(
      findCountryIsoConflict({
        aoe4WorldCountry: "pr",
        selectedCountry: "República Dominicana",
        allowed: DEFAULT_COUNTRIES,
      })?.aoe4WorldCountry,
      "Puerto Rico",
      "pr es Puerto Rico, no República Dominicana",
    );
    assert.equal(
      findCountryIsoConflict({
        aoe4WorldCountry: "do",
        selectedCountry: "Puerto Rico",
        allowed: DEFAULT_COUNTRIES,
      })?.aoe4WorldCountry,
      "República Dominicana",
      "do es República Dominicana, no Puerto Rico",
    );
  });

  await check("un ISO que coincide con lo elegido no da contradicción", () => {
    assert.equal(
      findCountryIsoConflict({
        aoe4WorldCountry: "co",
        selectedCountry: "Colombia",
        allowed: DEFAULT_COUNTRIES,
      }),
      null,
    );
    assert.equal(
      findCountryIsoConflict({
        aoe4WorldCountry: "do",
        selectedCountry: "República Dominicana",
        allowed: DEFAULT_COUNTRIES,
      }),
      null,
    );

    // El valor viene de la API y de un perfil escrito por el jugador, así que se
    // resuelve con el mismo criterio plegado que el resto de países: con espacios o
    // en mayúsculas sigue siendo el mismo código.
    assert.equal(
      findCountryIsoConflict({
        aoe4WorldCountry: " ES ",
        selectedCountry: "España",
        allowed: DEFAULT_COUNTRIES,
      }),
      null,
    );

    // Y una lista publicada con otra capitalización no es una contradicción: es el
    // mismo país escrito de otra manera.
    assert.equal(
      findCountryIsoConflict({
        aoe4WorldCountry: "mx",
        selectedCountry: "mexico",
        allowed: ["mexico"],
      }),
      null,
      "el rótulo de la lista manda, no el que escribió la persona",
    );
  });

  await check("un ISO que contradice lo elegido se señala con los dos países", () => {
    const conflicto = findCountryIsoConflict({
      aoe4WorldCountry: "mx",
      selectedCountry: "Colombia",
      allowed: DEFAULT_COUNTRIES,
    });

    assert.deepEqual(conflicto, {
      aoe4WorldCountry: "México",
      selectedCountry: "Colombia",
    });

    // El mensaje se compone con esos dos rótulos, así que tienen que ser los
    // canónicos y estar los dos: sin el del perfil el error no explica el motivo.
    assert.equal(
      conflicto?.aoe4WorldCountry,
      "México",
      "el país de AoE4World se nombra con el rótulo de la lista, no con el ISO",
    );
  });

  await check("un ISO que no se puede traducir se deja pasar", () => {
    for (const iso of ["gb", "us", "fr", "de", "zz", "", "   "]) {
      assert.equal(
        findCountryIsoConflict({
          aoe4WorldCountry: iso,
          selectedCountry: "Colombia",
          allowed: DEFAULT_COUNTRIES,
        }),
        null,
        `"${iso}" no se puede traducir a un país de la lista y no debe bloquear`,
      );
    }

    // Las claves del prototipo tampoco: el valor viene de un perfil escrito por
    // quien sea, y "constructor" no es un ISO.
    assert.equal(
      findCountryIsoConflict({
        aoe4WorldCountry: "constructor",
        selectedCountry: "Colombia",
        allowed: DEFAULT_COUNTRIES,
      }),
      null,
    );

    // Se traduce, pero el rótulo ya no está en la lista publicada: solo se compara
    // contra la lista que se está aplicando.
    assert.equal(
      findCountryIsoConflict({
        aoe4WorldCountry: "mx",
        selectedCountry: "Colombia",
        allowed: ["Colombia", "España"],
      }),
      null,
      "un país que la lista vigente ya no admite no puede contradecir a otro",
    );
  });

  await check("un perfil sin país se deja pasar", () => {
    assert.equal(
      findCountryIsoConflict({
        aoe4WorldCountry: null,
        selectedCountry: "Colombia",
        allowed: DEFAULT_COUNTRIES,
      }),
      null,
      "sin país en el perfil no se afirma nada",
    );
  });
}

/**
 * Los canales de YouTube y de Kick, sin base de datos y sin red.
 *
 * Son los parsers que comparten los dos formularios (el alta de admin y la
 * inscripción pública) y los normalizadores que usa el DAL, así que lo que se
 * comprueba aquí son dos cosas distintas que tienen que seguir de acuerdo:
 *
 * - **Lo que acepta un parser**: las tres formas que la gente pega de verdad (el
 *   `@nombre`, la URL del canal y la URL de un directo), con y sin esquema, con
 *   `www.`, con parámetros y con barra final, y siempre saliendo en la misma forma
 *   canónica. Y lo que **no** acepta: las URL `/c/…` y `/user/…` de YouTube, que
 *   no llevan el handle dentro, y el slug que se sale del rango de cada plataforma.
 * - **Que un `null` sea siempre un `null`**: los tres parsers reciben
 *   `FormDataEntryValue | null`, que también puede ser un `File` (`formData.get()`
 *   nunca garantiza un texto) y no a un `undefined` en un `FormData` hecho a mano.
 *   Si alguno de ellos lancera con un `File`, un envío manipulado tiraría el
 *   formulario con un 500 en lugar de un error de campo.
 *
 * Y una tercera, que es la que importa de verdad para la clasificación: el DAL
 * normaliza con `normalizeYoutubeChannel()` / `normalizeKickChannel()`, así que si
 * el parser guardara una forma que el normalizador no reconoce, el canal aparecería
 * como `null` en la tabla y el enlace no se podría componer. Aquí se comprueba que
 * **todo lo que los parsers aceptan también lo aceptan los normalizadores**.
 */
async function checkStreamChannels(): Promise<void> {
  console.log("Canales de YouTube y Kick");

  const {
    isLegacyYoutubeUrl,
    parseKickChannel,
    parseTwitchChannel,
    parseYoutubeChannel,
  } = await import("@/lib/player-input");
  const {
    normalizeKickChannel,
    normalizeTwitchChannel,
    normalizeYoutubeChannel,
  } = await import("@/lib/stream-channels");
  const { kickChannelUrl, twitchChannelUrl, youtubeChannelUrl } = await import("@/lib/format");

  await check("el handle de YouTube sale canónico, sin arroba y en minúsculas", () => {
    assert.equal(parseYoutubeChannel("@Beastyqt"), "beastyqt", "el @nombre de siempre");
    assert.equal(parseYoutubeChannel("  @BeastyQT  "), "beastyqt", "espacios de los dos lados");
    assert.equal(parseYoutubeChannel("beastyqt"), "beastyqt", "sin arroba también vale");
    assert.equal(parseYoutubeChannel("@canal.con.guion_bajo-1"), "canal.con.guion_bajo-1");
  });

  await check("la URL de YouTube se recorta a handle, con esquema o sin él", () => {
    assert.equal(parseYoutubeChannel("https://www.youtube.com/@Beastyqt"), "beastyqt");
    assert.equal(parseYoutubeChannel("http://youtube.com/@Beastyqt"), "beastyqt");
    assert.equal(parseYoutubeChannel("youtube.com/@Beastyqt"), "beastyqt", "sin esquema");
    assert.equal(parseYoutubeChannel("www.youtube.com/@Beastyqt"), "beastyqt", "con www.");
    assert.equal(parseYoutubeChannel("m.youtube.com/@Beastyqt"), "beastyqt", "con m.");
    assert.equal(
      parseYoutubeChannel("https://www.youtube.com/@Beastyqt/live"),
      "beastyqt",
      "la URL de un directo",
    );
    assert.equal(
      parseYoutubeChannel("https://www.youtube.com/@Beastyqt/streams?view=0&sort=d&flow=grid"),
      "beastyqt",
      "con pestaña y parámetros",
    );
    assert.equal(
      parseYoutubeChannel("https://www.youtube.com/@Beastyqt/"),
      "beastyqt",
      "con barra final",
    );
  });

  await check("las URL /c/ y /user/ de YouTube se rechazan con motivo explícito", () => {
    // No son derivables a un handle: el identificador del canal es un `UC…` que no
    // lo contiene, así que aceptarlas produciría un canal que no existe.
    const antiguas = [
      "https://www.youtube.com/c/Beastyqt",
      "youtube.com/user/Beastyqt",
      "https://youtube.com/user/Beastyqt/videos",
    ];

    for (const url of antiguas) {
      assert.equal(parseYoutubeChannel(url), null, `${url} no es un canal`);
      assert.equal(isLegacyYoutubeUrl(url), true, `${url} debe decir por qué`);
    }

    // Y una URL normal **no** se confunde con una antigua: si lo hiciera, el
    // formulario pediría el @nombre a quien ya lo había escrito.
    assert.equal(isLegacyYoutubeUrl("https://www.youtube.com/@beastyqt"), false);
    assert.equal(isLegacyYoutubeUrl("@beastyqt"), false);
    assert.equal(isLegacyYoutubeUrl("beastyqt"), false);
    assert.equal(isLegacyYoutubeUrl(""), false);
    assert.equal(isLegacyYoutubeUrl(null), false);
  });

  await check("lo que no es un handle de YouTube se rechaza", () => {
    const invalidos = [
      "@ab",
      `@${"a".repeat(31)}`,
      "@con espacio",
      "@con/barra",
      "https://www.youtube.com/live/abcdefgh",
      "https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv",
      "canal?t=123",
    ];

    for (const valor of invalidos) {
      assert.equal(parseYoutubeChannel(valor), null, `"${valor}" no es un handle`);
    }
  });

  await check("el slug de Kick sale canónico, con o sin URL", () => {
    assert.equal(parseKickChannel("beastyqt"), "beastyqt");
    assert.equal(parseKickChannel("  BEASTYQT "), "beastyqt", "en minúsculas");
    assert.equal(parseKickChannel("@beastyqt"), null, "Kick no lleva arroba");
    assert.equal(parseKickChannel("canal.con.guion_bajo-1"), "canal.con.guion_bajo-1");
    assert.equal(parseKickChannel("https://www.kick.com/Beastyqt"), "beastyqt");
    assert.equal(parseKickChannel("http://kick.com/beastyqt"), "beastyqt");
    assert.equal(parseKickChannel("kick.com/beastyqt"), "beastyqt", "sin esquema");
    assert.equal(parseKickChannel("www.kick.com/beastyqt"), "beastyqt", "con www.");
    assert.equal(
      parseKickChannel("https://www.kick.com/beastyqt?lang=es"),
      "beastyqt",
      "con parámetros",
    );
    assert.equal(parseKickChannel("https://www.kick.com/beastyqt/"), "beastyqt", "con barra final");
  });

  await check("lo que no es un slug de Kick se rechaza", () => {
    const invalidos = [
      "ab",
      "a".repeat(26),
      "canal con espacio",
      "canal/barra",
      "https://kick.com/",
      "otro-sitio.com/beastyqt",
    ];

    for (const valor of invalidos) {
      assert.equal(parseKickChannel(valor), null, `"${valor}" no es un slug`);
    }
  });

  await check("los tres canales devuelven null ante vacío, null y valores raros", () => {
    // Un `File` es un `FormDataEntryValue` perfectamente legal: `String(file)` vale
    // `"[object File]"`, que ningún patrón acepta, así que el resultado es `null` y
    // no una excepción. Es el caso que separa "un parser que lanza" de uno que no.
    // `null` va aparte porque es lo que devuelve `formData.get()` cuando el campo
    // no está en el formulario.
    const raros: FormDataEntryValue[] = ["", "   ", new File(["contenido"], "canal.txt")];

    for (const valor of raros) {
      assert.equal(parseYoutubeChannel(valor), null, "YouTube con un valor raro");
      assert.equal(parseKickChannel(valor), null, "Kick con un valor raro");
      assert.equal(parseTwitchChannel(valor), null, "Twitch con un valor raro");
    }

    for (const parser of [parseYoutubeChannel, parseKickChannel, parseTwitchChannel]) {
      assert.equal(parser(null), null, "campo ausente");
    }
  });

  await check("los normalizadores del DAL aceptan lo que los parsers guardan", () => {
    // Es el contrato entre las dos capas: lo que el parser escribe en la columna
    // tiene que ser algo que el DAL sepa convertir en un enlace, o el canal
    // desaparecería de la clasificación sin que nada fallara.
    const guardados = [
      parseYoutubeChannel("@Beastyqt"),
      parseYoutubeChannel("https://www.youtube.com/@Beastyqt/live"),
      parseKickChannel("Beastyqt"),
      parseKickChannel("https://www.kick.com/Beastyqt"),
      parseTwitchChannel("@Beastyqt"),
    ];

    for (const canal of guardados) {
      assert.ok(canal !== null, "el parser debería devolver un canal");

      assert.equal(normalizeYoutubeChannel(canal), canal, `YouTube: "${canal}"`);
      assert.equal(normalizeKickChannel(canal), canal, `Kick: "${canal}"`);
      assert.equal(normalizeTwitchChannel(canal), canal, `Twitch: "${canal}"`);
    }

    assert.equal(normalizeYoutubeChannel(null), null);
    assert.equal(normalizeKickChannel(null), null);
    assert.equal(normalizeTwitchChannel(null), null);
    assert.equal(normalizeTwitchChannel(undefined), null);
    assert.equal(normalizeYoutubeChannel(""), null);
    assert.equal(normalizeKickChannel("  "), null);
  });

  await check("el DAL acepta una URL guardada a mano, y una antigua de YouTube no", () => {
    // Una fila puede traer una URL si alguien la escribió directamente en la base o
    // desde una versión anterior del panel. El normalizador la recorta, igual que
    // el parser; y la `/c/` se queda en `null`, por el motivo de siempre.
    assert.equal(normalizeYoutubeChannel("https://www.youtube.com/@Beastyqt/streams"), "beastyqt");
    assert.equal(normalizeKickChannel("https://kick.com/Beastyqt"), "beastyqt");
    assert.equal(normalizeTwitchChannel("https://www.twitch.tv/Beastyqt"), "beastyqt");
    assert.equal(normalizeYoutubeChannel("https://www.youtube.com/c/Beastyqt"), null);
    assert.equal(normalizeYoutubeChannel("https://www.youtube.com/user/Beastyqt"), null);
  });

  await check("las tres plataformas componen su URL con el mismo criterio", () => {
    assert.equal(twitchChannelUrl("beastyqt"), "https://twitch.tv/beastyqt");
    assert.equal(youtubeChannelUrl("beastyqt"), "https://www.youtube.com/@beastyqt");
    assert.equal(kickChannelUrl("beastyqt"), "https://www.kick.com/beastyqt");

    // La única diferencia entre las tres es dónde va la arroba, y por eso la URL
    // se compone en un sitio y no repetida en cada componente.
    for (const url of [twitchChannelUrl("x"), youtubeChannelUrl("x"), kickChannelUrl("x")]) {
      assert.equal(url.startsWith("https://"), true, "todas por https");
      assert.equal(url.includes(" "), false, "ninguna lleva espacios que puedan romper el href");
    }
  });
}

/**
 * La lectura de las respuestas de Kick y el recorrido de YouTube contra un cliente
 * HTTP falso.
 *
 * Son las dos piezas más frágiles de la integración y las dos que no se pueden
 * comprobar de otra manera:
 *
 * - **Kick** usa un endpoint no documentado, así que su payload no tiene contrato
 *   ninguno: lo que se comprueba aquí es que se lee lo que se ve hoy y que lo que no
 *   se entiende se convierte en `null` (no se comprobará) en lugar de interpretar a
 *   medias. Un `404` sí es una respuesta —el canal no existe— y un `false`.
 * - **YouTube** pasó de `search.list` (cuota propia de 100 al día) a la playlist de
 *   subidas del canal. Lo que se comprueba aquí es **el recorrido**: que las dos
 *   llamadas van a los endpoints correctos con los parámetros que exige la API
 *   —playlist de subidas primero, y detalles de los ids en **una** llamada—, que es
 *   justo lo que no se ve en una función pura. El **parseo** de cada payload (qué
 *   forma tiene un canal, cuándo un vídeo está emitiéndose y qué se hace con lo que
 *   no se entiende) vive en `tests/unit/lib/streams/youtube.test.ts`, que es
 *   puro y no necesita ni red ni base.
 *
 * Con un cliente falso no sale nada a la red: la clave que se le pasa es de mentira
 * y solo se comprueba que viaja en la `key` de la URL.
 */
async function checkStreamPayloads(): Promise<void> {
  console.log("Respuestas de YouTube y Kick");

  const { isKickChannelLive } = await import("@/lib/streams/kick");
  const { isYoutubeStreamLive } = await import("@/lib/streams/youtube");
  const { getStreamsConfig } = await import("@/lib/streams/env");
  const { StreamsError } = await import("@/lib/streams/http");

  const config = {
    ...getStreamsConfig(),
    youtubeApiKey: "clave-de-prueba",
    timeoutMs: 1,
    minRequestIntervalMs: 0,
    maxRetries: 0,
  };

  /**
   * La forma del cliente falso: lo que usan las funciones de plataforma (`fetchJson`
   * y `stats`), más las URLs que ha pedido, que es lo que miran estas comprobaciones.
   */
  type ClienteFalso = {
    fetchJson: (url: URL, options?: { signal?: AbortSignal }) => Promise<unknown>;
    pedidos: URL[];
    stats: {
      requests: number;
      retries: number;
      rateLimitResponses: number;
      rateLimitPausesMs: number;
    };
    drain: () => Promise<void>;
  };

  /**
   * Cliente falso: responde con el payload que le pasen, siempre el mismo.
   */
  const cliente = (
    payload: unknown,
    error?: unknown,
  ): ClienteFalso => {
    const pedidos: URL[] = [];

    return {
      pedidos,
      stats: { requests: 0, retries: 0, rateLimitResponses: 0, rateLimitPausesMs: 0 },
      drain: async () => undefined,
      fetchJson: (url: URL) => {
        pedidos.push(url);

        return error === undefined
          ? Promise.resolve(payload)
          : Promise.reject(error);
      },
    };
  };

  /**
   * Cliente falso que responde **por endpoint**, que es lo que necesita YouTube:
   * `playlistItems` primero y `videos` después, cada uno con su payload.
   */
  const clienteYoutube = (porRuta: {
    playlistItems?: unknown;
    videos?: unknown;
  }): ClienteFalso => {
    const pedidos: URL[] = [];

    return {
      pedidos,
      stats: { requests: 0, retries: 0, rateLimitResponses: 0, rateLimitPausesMs: 0 },
      drain: async () => undefined,
      fetchJson: (url: URL) => {
        pedidos.push(url);

        const payload = url.pathname.endsWith("/playlistItems")
          ? porRuta.playlistItems
          : porRuta.videos;

        return Promise.resolve(payload);
      },
    };
  };

  await check(
    "YouTube: las subidas se piden a la playlist y los detalles, en una sola llamada",
    async () => {
      const falso = clienteYoutube({
        playlistItems: {
          items: [{ contentDetails: { videoId: "v1" } }, { contentDetails: { videoId: "v2" } }],
        },
        videos: {
          items: [
            { id: "v1", snippet: { liveBroadcastContent: "none" } },
            {
              id: "v2",
              snippet: { liveBroadcastContent: "live" },
              liveStreamingDetails: { actualStartTime: "2026-10-12T20:00:00Z" },
            },
          ],
        },
      });

      assert.equal(await isYoutubeStreamLive("UU123", falso, config, {}), true);
      assert.equal(falso.pedidos.length, 2, "una llamada por endpoint, no una por vídeo");

      const [subidas, detalles] = falso.pedidos;

      assert.equal(subidas?.hostname, "www.googleapis.com", "va a la Data API");
      assert.equal(subidas?.pathname, "/youtube/v3/playlistItems");
      assert.equal(subidas?.searchParams.get("part"), "contentDetails");
      assert.equal(subidas?.searchParams.get("playlistId"), "UU123");
      assert.equal(
        subidas?.searchParams.get("maxResults"),
        "5",
        "cinco subidas: el directo no siempre es la primera",
      );
      assert.equal(subidas?.searchParams.get("key"), "clave-de-prueba");

      assert.equal(detalles?.pathname, "/youtube/v3/videos");
      assert.equal(
        detalles?.searchParams.get("part"),
        "snippet,liveStreamingDetails",
        "el `snippet` es la mitad del criterio: `liveBroadcastContent`",
      );
      assert.equal(
        detalles?.searchParams.get("id"),
        "v1,v2",
        "todos los ids en una llamada: `videos.list` cobra por llamada",
      );
      assert.equal(detalles?.searchParams.get("key"), "clave-de-prueba");
    },
  );

  await check("YouTube: una emisión terminada no se pinta como directo", async () => {
    const falso = clienteYoutube({
      playlistItems: { items: [{ contentDetails: { videoId: "v1" } }] },
      videos: {
        items: [
          {
            id: "v1",
            snippet: { liveBroadcastContent: "none" },
            liveStreamingDetails: {
              actualStartTime: "2026-10-12T18:00:00Z",
              actualEndTime: "2026-10-12T19:30:00Z",
            },
          },
        ],
      },
    });

    assert.equal(await isYoutubeStreamLive("UU123", falso, config, {}), false);
  });

  await check("YouTube: sin subidas no hay directo, y no se pregunta por detalles", async () => {
    const falso = clienteYoutube({ playlistItems: { items: [] } });

    assert.equal(await isYoutubeStreamLive("UU123", falso, config, {}), false);
    assert.equal(falso.pedidos.length, 1, "sin ids no hay segunda llamada que hacer");
  });

  await check("Kick: el estado sale de livestream.is_live", async () => {
    assert.equal(
      await isKickChannelLive("canal", cliente({ livestream: { is_live: true } }), config, {}),
      true,
    );
    assert.equal(
      await isKickChannelLive("canal", cliente({ livestream: { is_live: false } }), config, {}),
      false,
    );
    assert.equal(
      await isKickChannelLive("canal", cliente({ livestream: null }), config, {}),
      null,
      "un canal sin emisión es null, no false",
    );
    assert.equal(
      await isKickChannelLive("canal", cliente({ is_live: true }), config, {}),
      true,
      "el campo también se acepta en la raíz",
    );
  });

  await check("Kick: lo que no se entiende es null y un 404 es un canal que no existe", async () => {
    for (const raro of [{}, { livestream: "sí" }, { livestream: { is_live: "sí" } }, null]) {
      assert.equal(
        await isKickChannelLive("canal", cliente(raro), config, {}),
        null,
        `un payload raro (${JSON.stringify(raro)}) no se interpreta`,
      );
    }

    const falso = cliente(null, new StreamsError("no existe", { status: 404 }));

    assert.equal(
      await isKickChannelLive("canal", falso, config, {}),
      false,
      "un 404 es una respuesta, no un fallo",
    );
    assert.equal(
      falso.pedidos[0]?.pathname,
      "/api/v2/channels/canal",
      "la ruta es la del endpoint no documentado",
    );

    // Cualquier otro error sí se propaga: el llamante lo registra y no escribe nada.
    const roto = cliente(null, new StreamsError("se cayó la red", { retryable: true }));

    await assert.rejects(
      isKickChannelLive("canal", roto, config, {}),
      (error: unknown) => error instanceof StreamsError,
      "un fallo de red no se convierte en un `false`",
    );
  });
}

/**
 * Parámetros de la URL del panel: los filtros y el orden de las tres listas paginadas.
 *
 * Sin base de datos, y sin tocar ninguna: son funciones puras del DAL, y lo que se
 * comprueba es la parte del contrato que decide **qué hace una URL manipulada**. El
 * criterio es el del DAL —un valor que no se entiende es ausencia, nunca error ni "cero
 * resultados"—, y estas comprobaciones son las que lo fijan para que no se pueda relajar
 * sin que se note.
 *
 * El script corre con `--conditions=react-server` (ver `package.json`) porque el DAL es
 * `server-only`. Importarlo no toca la base de datos: el cliente de Prisma es perezoso y
 * solo se crea en la primera consulta.
 */
async function checkAdminQueryParams(): Promise<void> {
  console.log("Parámetros del panel: filtros y orden");

  await check("sin parámetros, las tres listas salen por fecha descendente", () => {
    assert.deepEqual(readAlertsSort({}), { key: "fecha", dir: "desc" });
    assert.deepEqual(readHistorySort({}), { key: "fecha", dir: "desc" });
    assert.deepEqual(readActionsSort({}), { key: "fecha", dir: "desc" });
  });

  await check("toda columna admitida, en los dos sentidos", () => {
    for (const key of ["fecha", "jugador", "regla", "sujeto", "conteo"] as const) {
      assert.deepEqual(readAlertsSort({ sort: key, dir: "asc" }), { key, dir: "asc" });
      assert.deepEqual(readAlertsSort({ sort: key, dir: "desc" }), { key, dir: "desc" });
    }

    assert.deepEqual(readHistorySort({ sort: "fecha", dir: "asc" }), { key: "fecha", dir: "asc" });
    assert.deepEqual(readHistorySort({ sort: "fecha", dir: "desc" }), {
      key: "fecha",
      dir: "desc",
    });

    for (const key of ["fecha", "tipo", "admin"] as const) {
      assert.deepEqual(readActionsSort({ sort: key, dir: "asc" }), { key, dir: "asc" });
      assert.deepEqual(readActionsSort({ sort: key, dir: "desc" }), { key, dir: "desc" });
    }
  });

  await check("una columna que no es de esa lista cae al orden por defecto", () => {
    // El nombre técnico de la columna, una columna de otra lista y una inventada.
    assert.deepEqual(readAlertsSort({ sort: "subjectName" }), { key: "fecha", dir: "desc" });
    assert.deepEqual(readAlertsSort({ sort: "resultado" }), { key: "fecha", dir: "desc" });
    assert.deepEqual(readAlertsSort({ sort: "admin" }), { key: "fecha", dir: "desc" });
    assert.deepEqual(readHistorySort({ sort: "conteo" }), { key: "fecha", dir: "desc" });
    assert.deepEqual(readHistorySort({ sort: "jugador" }), { key: "fecha", dir: "desc" });
    assert.deepEqual(readHistorySort({ sort: "resultado" }), { key: "fecha", dir: "desc" });
    assert.deepEqual(readActionsSort({ sort: "jugador" }), { key: "fecha", dir: "desc" });
    assert.deepEqual(readAlertsSort({ sort: "" }), { key: "fecha", dir: "desc" });
  });

  await check("mayúsculas y acentos no son la misma columna", () => {
    // Los valores de `sort` los escriben los enlaces de la propia tabla, así que la
    // comparación es literal: aquí no se resuelve el texto como en `parseCountry()`.
    assert.deepEqual(readAlertsSort({ sort: "FECHA" }), { key: "fecha", dir: "desc" });
    assert.deepEqual(readAlertsSort({ sort: "Jugador" }), { key: "fecha", dir: "desc" });
    assert.deepEqual(readActionsSort({ sort: "Ádmin" }), { key: "fecha", dir: "desc" });
  });

  await check("un `dir` que no vale es el sentido por defecto", () => {
    assert.deepEqual(readAlertsSort({ sort: "conteo", dir: "arriba" }), {
      key: "conteo",
      dir: "desc",
    });
    assert.deepEqual(readAlertsSort({ sort: "conteo", dir: "ASC" }), {
      key: "conteo",
      dir: "desc",
    });
    assert.deepEqual(readAlertsSort({ sort: "conteo", dir: "" }), { key: "conteo", dir: "desc" });
    assert.deepEqual(readAlertsSort({ sort: "conteo", dir: "1" }), { key: "conteo", dir: "desc" });
  });

  await check("`dir` sin `sort` es la columna por defecto en ese sentido", () => {
    // Los dos parámetros son independientes: un enlace de "quitar orden" puede borrar
    // solo `sort` y dejar `dir=desc` sin que eso sea un estado imposible.
    assert.deepEqual(readAlertsSort({ dir: "asc" }), { key: "fecha", dir: "asc" });
    assert.deepEqual(readHistorySort({ dir: "asc" }), { key: "fecha", dir: "asc" });
    assert.deepEqual(readActionsSort({ dir: "asc" }), { key: "fecha", dir: "asc" });
  });

  await check("un parámetro repetido se queda con el primero", () => {
    assert.deepEqual(readAlertsSort({ sort: ["conteo", "regla"], dir: "asc" }), {
      key: "conteo",
      dir: "asc",
    });
    assert.deepEqual(readHistorySort({ sort: ["resultado", "fecha"] }), {
      key: "fecha",
      dir: "desc",
    });
  });

  await check("filtro de jugador: un `Player.id` con forma, o nada", () => {
    assert.equal(readPlayerIdFilter("clx123abc"), "clx123abc");
    assert.equal(readPlayerIdFilter("noSoyUnCuid"), null);
    assert.equal(readPlayerIdFilter("CLX123ABC"), null);
    assert.equal(readPlayerIdFilter("clx-123"), null);
    assert.equal(readPlayerIdFilter(""), null);
    assert.equal(readPlayerIdFilter(undefined), null);
    assert.equal(readPlayerIdFilter(["clx1", "clx2"]), "clx1");
  });

  await check("filtro de regla: allowlist de los ocho `AlertRule`", () => {
    for (const regla of Object.values(AlertRule)) {
      assert.equal(readAlertsFilters({ regla }).regla, regla, `la regla ${regla} se admite`);
    }

    assert.equal(readAlertsFilters({}).regla, null);
    assert.equal(readAlertsFilters({ regla: "" }).regla, null);
    assert.equal(readAlertsFilters({ regla: "short_match_streak" }).regla, null);
    assert.equal(readAlertsFilters({ regla: "INVENTADA" }).regla, null);
    assert.equal(readAlertsFilters({ regla: "TEAMMATE_ELO_GAP " }).regla, "TEAMMATE_ELO_GAP");
  });

  await check("filtro de tipo: allowlist de los tres `AlertKind`", () => {
    for (const tipo of Object.values(AlertKind)) {
      assert.equal(readAlertsFilters({ tipo }).kind, tipo, `el tipo ${tipo} se admite`);
    }

    assert.equal(readAlertsFilters({}).kind, null);
    assert.equal(readAlertsFilters({ tipo: "streak_closed" }).kind, null);
    assert.equal(readAlertsFilters({ tipo: "GANADOR" }).kind, null);
  });

  await check("rango de fechas: `from` inclusivo y `to` con el día entero dentro", () => {
    const desde = readAlertsFilters({ from: "2026-09-01" }).rango;
    const hasta = readAlertsFilters({ to: "2026-09-30" }).rango;

    assert.equal(desde.gte?.toISOString(), "2026-09-01T00:00:00.000Z");
    assert.equal(desde.lt, undefined);
    assert.equal(hasta.lt?.toISOString(), "2026-10-01T00:00:00.000Z");
    assert.equal(hasta.gte, undefined);
  });

  await check("una fecha imposible es ausencia de filtro, no un rango desplazado", () => {
    assert.deepEqual(readAlertsFilters({ from: "2026-02-31" }).rango, {});
    assert.deepEqual(readAlertsFilters({ to: "2026-13-01" }).rango, {});
    assert.deepEqual(readAlertsFilters({ from: "ayer" }).rango, {});
    // Un instante sin zona no se admite: se interpretaría en hora local.
    assert.deepEqual(readAlertsFilters({ from: "2026-09-01T10:00:00" }).rango, {});
    // Con zona explícita se usa tal cual, sin desplazarlo.
    assert.equal(
      readAlertsFilters({ from: "2026-09-01T10:00:00Z" }).rango.gte?.toISOString(),
      "2026-09-01T10:00:00.000Z",
    );
  });

  await check("los cuatro filtros de alertas se combinan y no se pisan", () => {
    const filtros = readAlertsFilters({
      playerId: "clx1",
      from: "2026-09-01",
      to: "2026-09-30",
      regla: AlertRule.REPEATED_OPPONENT_STREAK,
      tipo: AlertKind.STREAK_CLOSED,
    });

    assert.equal(filtros.playerId, "clx1");
    assert.equal(filtros.rango.gte?.toISOString(), "2026-09-01T00:00:00.000Z");
    assert.equal(filtros.rango.lt?.toISOString(), "2026-10-01T00:00:00.000Z");
    assert.equal(filtros.regla, "REPEATED_OPPONENT_STREAK");
    assert.equal(filtros.kind, "STREAK_CLOSED");
  });

  await check("el orden y los filtros del historial se resuelven por separado", () => {
    // El historial solo se ordena por fecha; el jugador y las fechas recortan. Un
    // `sort` que no sea `fecha` se comporta como si no estuviera.
    assert.deepEqual(readHistorySort({ sort: "fecha", dir: "asc" }), {
      key: "fecha",
      dir: "asc",
    });
    assert.deepEqual(readHistorySort({ sort: "resultado", dir: "asc" }), {
      key: "fecha",
      dir: "asc",
    });

    const conTodo = readHistoryFilters({ playerId: "clx1", from: "2026-09-01" });

    assert.equal(conTodo.playerId, "clx1");
    assert.equal(conTodo.rango.gte?.toISOString(), "2026-09-01T00:00:00.000Z");
  });
}

/**
 * Una fila del feed mezclado del historial, con lo mínimo para poder compararla.
 *
 * Solo el `resultado`, el `objetivo` o el `lead` la convierten en una cosa u otra: el feed
 * real ya viene de `partidaEnFila()`, de `eventosDeObjetivo()` y de `liderazgosDeObjetivo()`,
 * y aquí solo hace falta que el comparador tenga filas de las tres clases con instantes
 * repetidos, que es donde se comprueba que el orden es total.
 */
function filaHistorial(row: {
  id: string;
  fecha: string;
  resultado?: "WIN" | "LOSS" | null;
  objetivo?: string;
  lead?: ObjectiveLeadKind;
  profileId?: number;
}): AdminMatchHistoryRow {
  const esPartida = row.objetivo === undefined && row.lead === undefined;

  return {
    id: row.id,
    startedAt: new Date(row.fecha),
    playerId: "clx1",
    playerName: "Jugador",
    playerProfileId: row.profileId ?? 9_000_001,
    points: 0,
    objective:
      row.objetivo === undefined && row.lead === undefined
        ? null
        : {
            id: row.objetivo ?? "loco-por-ganar",
            label: row.objetivo ?? "Competición",
            group: "actividad",
            metric: "partidas",
            points: 40,
            count: 1,
            lead: row.lead ?? null,
          },
    gameId: esPartida ? "9000001" : null,
    opponentName: null,
    opponentProfileId: null,
    result: esPartida ? (row.resultado ?? "WIN") : null,
    teamSize: esPartida ? "1vs1" : null,
    mode: esPartida ? "rm_solo" : null,
    leaderboard: esPartida ? "rm_solo" : null,
    map: null,
    revertedAt: null,
  };
}

/** Fechas de las filas sintéticas: tres días, con instantes repetidos a propósito. */
const H1 = "2026-09-01T10:00:00.000Z";
const H2 = "2026-09-02T10:00:00.000Z";
const H3 = "2026-09-03T10:00:00.000Z";

/**
 * Orden del feed mezclado del historial: el comparador que sostiene la paginación.
 *
 * Sin base de datos, porque las tres propiedades de las que depende que una página sea
 * una ventana real del feed son de comparación de filas y se pueden comprobar con filas
 * sintéticas. Son exactamente las que seonthrow: **totalidad** (sin desempate, dos filas
 * del mismo instante podrían salir en cualquier orden entre sí y una página podría
 * repetir o perder filas), **inversión** (`asc` es el reverso exacto de `desc`) y
 * **consistencia con las consultas** (el merge solo es correcto si las fuentes llegan ya
 * ordenadas como el comparador las ordena).
 */
/**
 * Paginar el feed mezclado con la aritmética de `historyFeedWindows()`, sin base de datos.
 *
 * Reproduce lo que hacen `getAdminMatchHistory()` y `loadPointHistory()` —contar las tres
 * fuentes (partidas, logros y liderazgos), calcular la ventana de cada una, pedirlas,
 * mezclar con el comparador y recortar la página— y comprueba que recorriendo **todas** las
 * páginas salen exactamente las filas del feed, en su orden y sin repeticiones. Es la
 * comprobación que respalda que la aritmética es independiente del sentido del orden: si
 * dependiera del eje, aquí se vería con solo cambiar `sort`.
 */
async function checkHistoryPaging(): Promise<void> {
  // Doce partidas, cinco logros y tres cambios de poseedor repartidos por tres días, con
  // empates de fecha y con hitos intercalados, que es la forma de que las ventanas tengan
  // que trabajar de verdad.
  const instantes = [
    "2026-09-01T09:00:00.000Z",
    "2026-09-01T15:00:00.000Z",
    "2026-09-02T09:00:00.000Z",
    "2026-09-02T15:00:00.000Z",
    "2026-09-03T09:00:00.000Z",
    "2026-09-03T15:00:00.000Z",
  ];

  const partidas = instantes.flatMap((fecha, i) => [
    filaHistorial({ id: `m${i}a`, fecha, resultado: i % 3 === 0 ? "LOSS" : "WIN" }),
    filaHistorial({ id: `m${i}b`, fecha, resultado: i % 3 === 0 ? "WIN" : "LOSS" }),
  ]);

  const objetivosLogro = [0, 1, 2, 3, 4].map((i) =>
    filaHistorial({
      id: `o${i}`,
      fecha: instantes[i % instantes.length],
      objetivo: `objetivo-${i}`,
    }),
  );

  // Y tres cambios de poseedor, con la pareja de un mismo cambio —misma competición y mismo
  // instante— para que las ventanas cuenten también las filas del log de liderazgos. Van en
  // su propia fuente, como en las consultas reales.
  const liderazgos = [
    filaHistorial({
      id: "lead:rey-1v1:GAINED:11",
      fecha: instantes[0],
      objetivo: "rey-1v1",
      lead: ObjectiveLeadKind.GAINED,
      profileId: 11,
    }),
    filaHistorial({
      id: "lead:rey-1v1:LOST:12",
      fecha: instantes[0],
      objetivo: "rey-1v1",
      lead: ObjectiveLeadKind.LOST,
      profileId: 12,
    }),
    filaHistorial({
      id: "lead:loco-por-ganar:GAINED:13",
      fecha: instantes[2],
      objetivo: "loco-por-ganar",
      lead: ObjectiveLeadKind.GAINED,
      profileId: 13,
    }),
  ];

  const fuentes = [partidas, objetivosLogro, liderazgos];
  const total = fuentes.reduce((sum, fuente) => sum + fuente.length, 0);

  await check(
    "paginar el feed no repite ni pierde filas, en los dos ejes de orden",
    () => {
      for (const sort of [
        { key: "fecha", dir: "desc" },
        { key: "fecha", dir: "asc" },
      ] satisfies AdminHistorySort[]) {
        for (const pageSize of [1, 2, 5, 25]) {
          // El feed entero, que es contra lo que se compara lo que sale de paginar.
          const feed = fuentes.flat().sort(historyComparator(sort)).map((row) => row.id);

          const recorrido: string[] = [];
          const pageCount = Math.ceil(total / pageSize);

          for (let page = 1; page <= pageCount; page += 1) {
            const skip = (page - 1) * pageSize;
            const { windows, offset } = historyFeedWindows(
              skip,
              pageSize,
              fuentes.map((fuente) => fuente.length),
            );

            // Lo que devolverían las tres consultas con ese `orderBy`: cada fuente ordenada
            // como el comparador y recortada a su ventana.
            const ventanas = fuentes.map((fuente, i) =>
              [...fuente]
                .sort(historyComparator(sort))
                .slice(windows[i].skip, windows[i].skip + windows[i].take),
            );

            const pagina = historyFeedPage(ventanas, {
              offset,
              pageSize,
              compare: historyComparator(sort),
            }).map((row) => row.id);

            const etiqueta = `sort=${sort.key}&dir=${sort.dir}&pageSize=${pageSize}&pagina=${page}`;

            assert.deepEqual(
              pagina,
              feed.slice(skip, skip + pageSize),
              `${etiqueta}: la página no es una ventana del feed`,
            );
            recorrido.push(...pagina);
          }

          assert.deepEqual(
            recorrido,
            feed,
            `sort=${sort.key}&dir=${sort.dir}&pageSize=${pageSize}: recorrido con huecos o repeticiones`,
          );
          assert.equal(new Set(recorrido).size, total, "alguna fila sale repetida");
        }
      }
    },
  );
}

async function checkHistoryOrder(): Promise<void> {
  console.log("Orden del feed mezclado del historial");

  await checkHistoryPaging();

  // Dos días con empates de fecha y las dos clases de fila, que es la peor combinación
  // posible para el comparador.
  const partidas = [
    filaHistorial({ id: "m1", fecha: H3, resultado: "WIN" }),
    filaHistorial({ id: "m2", fecha: H3, resultado: "LOSS" }),
    filaHistorial({ id: "m3", fecha: H2, resultado: "LOSS" }),
    filaHistorial({ id: "m4", fecha: H1, resultado: "WIN" }),
  ];

  const objetivos = [
    filaHistorial({ id: "o1", fecha: H3, objetivo: "loco-por-ganar" }),
    filaHistorial({ id: "o2", fecha: H2, objetivo: "lider-french" }),
  ];

  const todas = [...partidas, ...objetivos];

  const orden = (sort: AdminHistorySort, filas: AdminMatchHistoryRow[]) =>
    [...filas].sort(historyComparator(sort));

  await check("el comparador no deja dos filas empatadas", () => {
    for (const key of ["fecha"] as const) {
      for (const dir of ["asc", "desc"] as const) {
        const comparar = historyComparator({ key, dir });

        for (const a of todas) {
          for (const b of todas) {
            if (a.id === b.id) {
              continue;
            }

            assert.notEqual(
              comparar(a, b),
              0,
              `${a.id} y ${b.id} empatan con sort=${key}&dir=${dir}`,
            );
            assert.equal(
              comparar(a, b),
              -comparar(b, a),
              `${a.id} y ${b.id} no son simétricos con sort=${key}&dir=${dir}`,
            );
          }
        }
      }
    }
  });

  await check("asc es el inverso exacto de desc", () => {
    for (const key of ["fecha"] as const) {
      const asc = orden({ key, dir: "asc" }, todas).map((row) => row.id);
      const desc = orden({ key, dir: "desc" }, todas).map((row) => row.id);

      assert.deepEqual(asc, [...desc].reverse(), `sort=${key} no se invierte entero`);
    }
  });

  await check("por fecha, la partida va delante del objetivo del mismo instante", () => {
    // Descendente y con la clave de desempate también descendente: en H3 son `m2`, `m1` y
    // `o1`, y la partida que explica el hito va delante de él.
    assert.deepEqual(
      orden({ key: "fecha", dir: "desc" }, todas).map((row) => row.id),
      ["m2", "m1", "o1", "m3", "o2", "m4"],
    );
  });

  await check("las dos filas de un cambio desempatan por signo, y asc las invierte", () => {
    // Es el caso que no existía antes: dos filas de la misma competición y el mismo instante
    // que solo se separan por el `lead` (la ganancia delante en descendente). Sin ese
    // desempate, el comparador devolvería 0 y la paginación podría repetir una y perder la
    // otra. El ganador tiene el `profileId` **mayor** para que se vea que manda el signo y no
    // el jugador.
    const ganancia = filaHistorial({
      id: "lead:rey-1v1:GAINED:9",
      fecha: H3,
      objetivo: "rey-1v1",
      lead: ObjectiveLeadKind.GAINED,
      profileId: 9,
    });
    const perdida = filaHistorial({
      id: "lead:rey-1v1:LOST:1",
      fecha: H3,
      objetivo: "rey-1v1",
      lead: ObjectiveLeadKind.LOST,
      profileId: 1,
    });
    const cambio = [ganancia, perdida];

    const comparar = historyComparator({ key: "fecha", dir: "desc" });

    assert.notEqual(comparar(ganancia, perdida), 0, "las dos filas del cambio empatan");
    assert.equal(comparar(ganancia, perdida), -comparar(perdida, ganancia), "no son simétricas");

    assert.deepEqual(
      orden({ key: "fecha", dir: "desc" }, cambio).map((row) => row.id),
      ["lead:rey-1v1:GAINED:9", "lead:rey-1v1:LOST:1"],
    );
    assert.deepEqual(
      orden({ key: "fecha", dir: "asc" }, cambio).map((row) => row.id),
      ["lead:rey-1v1:LOST:1", "lead:rey-1v1:GAINED:9"],
    );
  });

  await check("dos logros del mismo objetivo desempatan por profileId numérico", () => {
    // La consulta ordena por `profileId`, no por el texto del id de la fila: con un id
    // lexicográfico, `999999` iría antes que `1000000` y la ventana dejaría de coincidir
    // con el orden del comparador.
    const mayor = filaHistorial({
      id: "objective:rey-1v1:1000000",
      fecha: H3,
      objetivo: "rey-1v1",
      profileId: 1_000_000,
    });
    const menor = filaHistorial({
      id: "objective:rey-1v1:999999",
      fecha: H3,
      objetivo: "rey-1v1",
      profileId: 999_999,
    });
    const logros = [mayor, menor];
    const comparar = historyComparator({ key: "fecha", dir: "desc" });

    assert.notEqual(comparar(mayor, menor), 0, "los dos logros empatan");
    assert.equal(comparar(mayor, menor), -comparar(menor, mayor), "no son simétricos");
    assert.deepEqual(
      orden({ key: "fecha", dir: "desc" }, logros).map((row) => row.id),
      [mayor.id, menor.id],
    );
    assert.deepEqual(
      orden({ key: "fecha", dir: "asc" }, logros).map((row) => row.id),
      [menor.id, mayor.id],
    );
  });

  await check("comparar no reordena las fuentes que ya llegan ordenadas", () => {
    // Es la condición del merge: las dos consultas traen sus filas en el orden del
    // comparador, así que mezclar las fuentes solo puede **intercalar** filas, nunca
    // cambiar el orden dentro de una de ellas. Si el comparador contradijera al `orderBy`
    // de alguna consulta, la página dejaría de ser una ventana del feed real.
    for (const sort of [
      { key: "fecha", dir: "desc" },
      { key: "fecha", dir: "asc" },
    ] satisfies AdminHistorySort[]) {
      // Cada mitad, ordenada como su consulta. Es una copia de los `orderBy` de
      // `admin.ts` a propósito, porque es lo que hay que comprobar que no se contradiga:
      // las dos mitades terminan en su clave, ambas en el sentido del orden.
      // `signo` aquí es el del `orderBy` escrito al revés: estas diferencias van en
      // ascendente, así que `desc` es el que multiplica por `-1`.
      const signo = sort.dir === "desc" ? -1 : 1;

      const mitadPartidas = [...partidas].sort((a, b) => {
        const porFecha = (a.startedAt.getTime() - b.startedAt.getTime()) * signo;

        return porFecha !== 0 ? porFecha : (a.id < b.id ? -1 : 1) * signo;
      });

      const mitadObjetivos = [...objetivos].sort(
        (a, b) =>
          (a.startedAt.getTime() - b.startedAt.getTime()) * signo ||
          (a.id < b.id ? -1 : 1) * signo,
      );

      const mezcladas = orden(sort, [...mitadPartidas, ...mitadObjetivos]);
      const ids = (filas: AdminMatchHistoryRow[]) => filas.map((row) => row.id);

      assert.deepEqual(
        ids(mezcladas.filter((row) => row.objective === null)),
        ids(mitadPartidas),
        `sort=${sort.key}&dir=${sort.dir} reordena las partidas`,
      );
      assert.deepEqual(
        ids(mezcladas.filter((row) => row.objective !== null)),
        ids(mitadObjetivos),
        `sort=${sort.key}&dir=${sort.dir} reordena los objetivos`,
      );

      // Y ninguna fila se pierde ni se repite en el merge, que es lo que la paginación
      // necesita para que dos páginas no se solapen.
      assert.equal(mezcladas.length, todas.length, "el merge pierde o repite filas");
      assert.equal(new Set(ids(mezcladas)).size, todas.length, "el merge repite una fila");
    }
  });
}

async function main(): Promise<void> {
  await checkNormalization();
  console.log("");
  await checkFormatLabels();
  console.log("");
  await checkObjectiveCatalogue();
  console.log("");
  await checkRegistrationCountries();
  console.log("");
  await checkStreamChannels();
  console.log("");
  await checkStreamPayloads();
  console.log("");
  await checkAdminQueryParams();
  console.log("");
  await checkHistoryOrder();
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
