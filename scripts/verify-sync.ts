import "dotenv/config";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { isLiveGame, LIVE_GAME_WINDOW_MS, normalizeGame, readOwnCivRandomized, resolveGameMode } from "@/lib/aoe4world/normalize";
import { parseGame, parseGamePlayer, parseGamesPage } from "@/lib/aoe4world/parse";
import { Aoe4WorldNotFoundError } from "@/lib/aoe4world/http";

import { CIVILIZATIONS, isKnownCivilization } from "@/lib/civs";
import { unwrapRead } from "@/lib/db-errors";
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { AlertKind, AlertRule } from "@/generated/prisma/enums";
import {
  historyComparator,
  historyHole,
  readActionsSort,
  readAlertsFilters,
  readAlertsSort,
  readHistoryFilters,
  readHistorySort,
  readPlayerIdFilter,
  type AdminHistorySort,
  type AdminMatchHistoryRow,
} from "@/lib/admin";
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
      streamsError: null,
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
      streamsError: null,
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
 * La lectura de las respuestas de YouTube y de Kick, con un cliente HTTP falso.
 *
 * Son las dos piezas más frágiles de la integración y las dos que no se pueden
 * comprobar de otra manera:
 *
 * - **Kick** usa un endpoint no documentado, así que su payload no tiene contrato
 *   ninguno: lo que se comprueba aquí es que se lee lo que se ve hoy y que lo que no
 *   se entiende se convierte en `null` (no se comprobará) en lugar de interpretar a
 *   medias. Un `404` sí es una respuesta —el canal no existe— y un `false`.
 * - **YouTube** con `eventType=live` devuelve también las emisiones ya terminadas, así
 *   que decidir por el `liveBroadcastContent` del `snippet` es lo que separa "está
 *   emitiendo" de "emitió hace un rato". Sin ese campo se cae al criterio de la
 *   llamada, que es lo que hay que decidir explícitamente y no por descuido.
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
   * Cliente falso: responde con el payload que le pasen y anota la URL que le
   * pidieron, para poder comprobar los parámetros de la llamada. `stats` y `drain`
   * están porque son parte del tipo: el cliente real los lleva y las funciones de
   * plataforma no los usan, así que aquí solo tienen que existir.
   */
  const cliente = (
    payload: unknown,
    error?: unknown,
  ): {
    fetchJson: (url: URL, options?: { signal?: AbortSignal }) => Promise<unknown>;
    pedidos: URL[];
    stats: { requests: number; retries: number; rateLimitResponses: number; rateLimitPausesMs: number };
    drain: () => Promise<void>;
  } => {
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

  await check("YouTube: hay items con liveBroadcastContent=live, está en directo", async () => {
    const falso = cliente({
      items: [{ id: { videoId: "abc" }, snippet: { liveBroadcastContent: "live" } }],
    });

    assert.equal(
      await isYoutubeStreamLive("UC123", falso, config, {}),
      true,
    );
    assert.equal(falso.pedidos[0]?.hostname, "www.googleapis.com", "va a la Data API");
    assert.equal(falso.pedidos[0]?.searchParams.get("channelId"), "UC123");
    assert.equal(falso.pedidos[0]?.searchParams.get("eventType"), "live");
    assert.equal(falso.pedidos[0]?.searchParams.get("type"), "video");
    assert.equal(falso.pedidos[0]?.searchParams.get("maxResults"), "1");
    assert.equal(falso.pedidos[0]?.searchParams.get("key"), "clave-de-prueba");
  });

  await check("YouTube: una emisión ya terminada no se pinta como directo", async () => {
    // El caso que justifica mirar el `snippet`: `eventType=live` la devuelve igual.
    for (const estado of ["completed", "upcoming", "none"]) {
      const falso = cliente({ items: [{ snippet: { liveBroadcastContent: estado } }] });

      assert.equal(
        await isYoutubeStreamLive("UC123", falso, config, {}),
        false,
        `liveBroadcastContent=${estado} no es un directo en curso`,
      );
    }
  });

  await check("YouTube: sin items no hay directo, y un payload raro avisa", async () => {
    assert.equal(await isYoutubeStreamLive("UC123", cliente({ items: [] }), config, {}), false);

    // Sin `liveBroadcastContent` se cae al criterio de la llamada: hay resultado,
    // luego hay directo. Es una decisión explícita, no un descuido.
    assert.equal(
      await isYoutubeStreamLive("UC123", cliente({ items: [{ snippet: {} }] }), config, {}),
      true,
      "sin el campo se usa el criterio de la llamada",
    );
    assert.equal(
      await isYoutubeStreamLive("UC123", cliente({ items: [{}] }), config, {}),
      true,
      "un item sin snippet tampoco invalida la respuesta",
    );

    // Un payload que no tiene la forma de `search.list` sí es un fallo: no se puede
    // distinguir "no hay items" de "esto no es la respuesta que esperaba".
    await assert.rejects(
      isYoutubeStreamLive("UC123", cliente({ error: "nada" }), config, {}),
      (error: unknown) => error instanceof StreamsError,
      "un payload sin `items` se avisa, no se lee como que no hay directo",
    );
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

    for (const key of ["fecha", "resultado"] as const) {
      assert.deepEqual(readHistorySort({ sort: key, dir: "asc" }), { key, dir: "asc" });
      assert.deepEqual(readHistorySort({ sort: key, dir: "desc" }), { key, dir: "desc" });
    }

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
    assert.deepEqual(readHistorySort({ sort: ["resultado", "inventada"] }), {
      key: "resultado",
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

  await check("el filtro de resultado del historial y su orden no se pisan", () => {
    // `?resultado=WIN` recorta filas (y deja fuera los objetivos) y `?sort=resultado`
    // las ordena: dos parámetros distintos que pueden ir a la vez.
    assert.equal(readHistoryFilters({ resultado: "WIN" }).resultado, "WIN");
    assert.deepEqual(readHistorySort({ sort: "resultado", dir: "asc" }), {
      key: "resultado",
      dir: "asc",
    });
    assert.equal(readHistoryFilters({ resultado: "WIN", sort: "resultado" }).resultado, "WIN");

    assert.equal(readHistoryFilters({ resultado: "VICTORIA" }).resultado, null);
    assert.equal(readHistoryFilters({ resultado: "win" }).resultado, null);
    assert.equal(readHistoryFilters({}).resultado, null);

    // Y los otros filtros del historial son los mismos criterios, con los mismos bordes.
    const conTodo = readHistoryFilters({ playerId: "clx1", from: "2026-09-01", resultado: "LOSS" });

    assert.equal(conTodo.playerId, "clx1");
    assert.equal(conTodo.rango.gte?.toISOString(), "2026-09-01T00:00:00.000Z");
    assert.equal(conTodo.resultado, "LOSS");
  });
}

/**
 * Una fila del feed mezclado del historial, con lo mínimo para poder compararla.
 *
 * Solo el `resultado` o el `objetivo` la convierten en una cosa u otra: el feed real ya
 * viene de `partidaEnFila()` y de `eventosDeObjetivo()`, y aquí solo hace falta que el
 * comparador tenga filas de las dos clases con instantes repetidos, que es donde se
 * comprueba que el orden es total.
 */
function filaHistorial(row: {
  id: string;
  fecha: string;
  resultado?: "WIN" | "LOSS" | null;
  objetivo?: string;
}): AdminMatchHistoryRow {
  return {
    id: row.id,
    startedAt: new Date(row.fecha),
    playerId: "clx1",
    playerName: "Jugador",
    playerProfileId: 9_000_001,
    points: 0,
    objective:
      row.objetivo === undefined
        ? null
        : {
            id: row.objetivo,
            label: row.objetivo,
            group: "actividad",
            metric: "partidas",
            points: 40,
          },
    gameId: row.objetivo === undefined ? "9000001" : null,
    opponentName: null,
    opponentProfileId: null,
    result: row.objetivo === undefined ? (row.resultado ?? "WIN") : null,
    teamSize: row.objetivo === undefined ? "1vs1" : null,
    mode: row.objetivo === undefined ? "rm_solo" : null,
    leaderboard: row.objetivo === undefined ? "rm_solo" : null,
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
 * **consistencia con las consultas** (el merge solo es correcto si las dos mitadas
 * llegan ya ordenadas como el comparador las ordena).
 */
/**
 * Paginar el feed mezclado con la aritmética de `historyHole()`, sin base de datos.
 *
 * Reproduce lo que hace `getAdminMatchHistory()` —traer los objetivos enteros, acotar las
 * partidas con el hueco, mezclar con el comparador y recortar la página— y comprueba que
 * recorriendo **todas** las páginas salen exactamente las filas del feed, en su orden y
 * sin repeticiones. Es la comprobación que respalda que el orden por resultado puede
 * reutilizar el hueco del orden por fecha: si la aritmética dependiera del eje, aquí se
 * vería con solo cambiar `sort`.
 */
async function checkHistoryPaging(): Promise<void> {
  // Doce partidas y cinco objetivos repartidos por tres días, con empates de fecha y con
  // hitos intercalados, que es la forma de que el hueco tenga que trabajar de verdad.
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

  const objetivos = [0, 1, 2, 3, 4].map((i) =>
    filaHistorial({
      id: `o${i}`,
      fecha: instantes[i % instantes.length],
      objetivo: `objetivo-${i}`,
    }),
  );

  const total = partidas.length + objetivos.length;

  await check(
    "paginar el feed no repite ni pierde filas, en los dos ejes de orden",
    () => {
      for (const sort of [
        { key: "fecha", dir: "desc" },
        { key: "fecha", dir: "asc" },
        { key: "resultado", dir: "desc" },
        { key: "resultado", dir: "asc" },
      ] satisfies AdminHistorySort[]) {
        for (const pageSize of [1, 2, 5, 25]) {
          // El feed entero, que es contra lo que se compara lo que sale de paginar.
          const feed = [...partidas, ...objetivos]
            .sort(historyComparator(sort))
            .map((row) => row.id);

          const recorrido: string[] = [];
          const pageCount = Math.ceil(total / pageSize);
          const signo = sort.dir === "desc" ? -1 : 1;

          for (let page = 1; page <= pageCount; page += 1) {
            const skip = (page - 1) * pageSize;
            const eventos = [...objetivos].sort(historyComparator(sort));
            const { skipPartidas, takePartidas, desde } = historyHole(
              skip,
              pageSize,
              eventos.length,
            );

            // Lo que devolverían las dos consultas con ese `orderBy`: las partidas acotadas
            // por el hueco y todos los objetivos.
            const ventanaPartidas = [...partidas]
              .sort((a, b) => {
                if (sort.key === "resultado") {
                  const rango = (row: AdminMatchHistoryRow) => (row.result === "WIN" ? 1 : 2);
                  const diferencia = rango(a) - rango(b);

                  if (diferencia !== 0) {
                    return diferencia * signo;
                  }
                }

                const porFecha = (a.startedAt.getTime() - b.startedAt.getTime()) * signo;

                return porFecha !== 0 ? porFecha : (a.id < b.id ? -1 : 1) * signo;
              })
              .slice(skipPartidas, skipPartidas + takePartidas);

            const pagina = [...ventanaPartidas, ...eventos]
              .sort(historyComparator(sort))
              .slice(desde, desde + pageSize)
              .map((row) => row.id);

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

  // Dos días con empates de fecha, las dos clases de fila y los tres rangos de resultado,
  // que es la peor combinación posible para el comparador.
  const partidas = [
    filaHistorial({ id: "m1", fecha: H3, resultado: "WIN" }),
    filaHistorial({ id: "m2", fecha: H3, resultado: "LOSS" }),
    filaHistorial({ id: "m3", fecha: H2, resultado: "LOSS" }),
    filaHistorial({ id: "m4", fecha: H1, resultado: "WIN" }),
  ];

  const objetivos = [
    filaHistorial({ id: "o1", fecha: H3, objetivo: "loco-por-ganar" }),
    filaHistorial({ id: "o2", fecha: H2, objetivo: "otp" }),
  ];

  const todas = [...partidas, ...objetivos];

  const orden = (sort: AdminHistorySort, filas: AdminMatchHistoryRow[]) =>
    [...filas].sort(historyComparator(sort));

  await check("el comparador no deja dos filas empatadas", () => {
    for (const key of ["fecha", "resultado"] as const) {
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
    for (const key of ["fecha", "resultado"] as const) {
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

  await check("por resultado, los objetivos van delante de victorias y derrotas", () => {
    const asc = orden({ key: "resultado", dir: "asc" }, todas);
    const rangos = asc.map((row) => (row.objective !== null ? 0 : row.result === "WIN" ? 1 : 2));

    assert.deepEqual(rangos, [...rangos].sort((a, b) => a - b), "los rangos no salen agrupados");
    assert.equal(rangos[0], 0, "el primer rango de ascendente es el de objetivo");
    assert.equal(rangos[rangos.length - 1], 2, "el último rango de ascendente es el de derrota");

    // Dentro de cada rango se ordena por fecha **en el sentido del orden**, y `asc` es el
    // inverso entero de `desc`: o2 (2-sep) antes que o1 (3-sep), y al revés en `desc`.
    assert.deepEqual(
      asc.map((row) => row.id),
      ["o2", "o1", "m4", "m1", "m3", "m2"],
    );
  });

  await check("comparar no reordena las mitadas que ya llegan ordenadas", () => {
    // Es la condición del merge: las dos consultas traen sus filas en el orden del
    // comparador, así que mezclar las dos mitadas solo puede **intercalar** filas, nunca
    // cambiar el orden dentro de una de ellas. Si el comparador contradijera al `orderBy`
    // de alguna consulta, la página dejaría de ser una ventana del feed real.
    for (const sort of [
      { key: "fecha", dir: "desc" },
      { key: "fecha", dir: "asc" },
      { key: "resultado", dir: "desc" },
      { key: "resultado", dir: "asc" },
    ] satisfies AdminHistorySort[]) {
      // Cada mitad, ordenada como su consulta. Es una copia de los `orderBy` de
      // `admin.ts` a propósito, porque es lo que hay que comprobar que no se contradiga:
      // en `resultado` el `result` va primero, y las dos mitadas terminan en su clave,
      // ambas en el sentido del orden.
      // `signo` aquí es el del `orderBy` escrito al revés: estas diferencias van en
      // ascendente, así que `desc` es el que multiplica por `-1`.
      const signo = sort.dir === "desc" ? -1 : 1;

      const mitadPartidas = [...partidas].sort((a, b) => {
        if (sort.key === "resultado") {
          const rango = (row: AdminMatchHistoryRow) => (row.result === "WIN" ? 1 : 2);
          const diferencia = rango(a) - rango(b);

          if (diferencia !== 0) {
            return diferencia * signo;
          }
        }

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
