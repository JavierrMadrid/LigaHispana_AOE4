import "dotenv/config";

import assert from "node:assert/strict";

import {
  computePlayerAlerts,
  type AlertMatch,
  type AlertPlayer,
  type ComputeAlertsInput,
} from "@/lib/alerts/compute";
import {
  readCutoffsTable,
  subdivisionForRating,
  type LadderCutoffsTable,
} from "@/lib/alerts/division-cutoffs";
import {
  ALERTS_RULE_LABEL,
  ALERTS_RULESET_KEY,
  ALERTS_RULESET_VERSION,
  DEFAULT_ALERTS_RULESET,
  alertDedupeKey,
  mergeAlertsRuleset,
  type AlertsRuleset,
  type TriggeredAlert,
} from "@/lib/alerts/rules";
import { SUBDIVISION_RANK_LEVELS, subdivisionIndex } from "@/lib/divisions";
import type { ScoringWindow } from "@/lib/ranked-match";

/**
 * Verificación del motor de alertas, **sin base de datos**.
 *
 *   npm run verify:alerts
 *
 * Todo lo que decide el motor es una función pura sobre secuencias de partidas, y
 * eso es justo lo que permite comprobarlo aquí: no hay nada preparado, no hay red
 * y no hay que dejar nada limpio. Las comprobaciones que sí necesitan la base de
 * datos (que la inserción sea idempotente de verdad, que el rastro del sync lo
 * refleje) están en `npm run alerts:check` y en `verify:sync --db`.
 *
 * Cada bloque cubre una regla con la secuencia mínima que la pone a prueba:
 *
 * | Bloque | Qué comprueba |
 * |---|---|
 * | reglas | R1 rachas, ruptura y múltiplos de 5 |
 * | R2 | rival repetido, por rival, solo 1v1, y el acumulado cada 10 |
 * | R3 | compañeros por pareja, racha y el aviso único de 7 |
 * | R4 | el borde 499/500 y que solo mire las de equipo |
 * | R5 | el borde de escalones, la ladder de la partida y la ausencia de cortes |
 * | cierre | racha abierta que solo avisa al terminar el torneo |
 * | dedupe | que dos evaluaciones den exactamente las mismas claves |
 * | ruleset | umbrales y `warnings` de un documento guardado |
 * | cortes | lectura de la caché de cortes y su validación |
 */

/* -------------------------------------------------------------------------- */
/* Utilidades de las comprobaciones                                            */
/* -------------------------------------------------------------------------- */

const PLAYER_PROFILE_ID = 9_100_001;
const ALLY_ID = 9_100_002;
const ALLY_2_ID = 9_100_003;
const OPPONENT_ID = 9_100_004;
const OPPONENT_2_ID = 9_100_005;
/** Rival que no está en la liga, que es lo normal en un torneo individual. */
const EXTERNAL_RIVAL_ID = 9_100_006;

const PLAYER_ID = "jugador-alertas";

/** Ventana del torneo de las comprobaciones, con las dos esquinas. */
const WINDOW: ScoringWindow = { from: "2026-09-15T00:00:00.000Z", to: "2026-10-15T00:00:00.000Z" };

/** Antes de `to`: el torneo sigue abierto. */
const NOW_DURANTE = new Date("2026-10-01T12:00:00.000Z");
/** Después de `to`: el torneo ha terminado. */
const NOW_DESPUES = new Date("2026-10-20T12:00:00.000Z");

const PLAYER: AlertPlayer = {
  id: PLAYER_ID,
  profileId: PLAYER_PROFILE_ID,
  name: "Jugador Alertas",
  rankLevel: "gold_3",
};

let gameCounter = 0;

/** Reloj fijo para que las secuencias no dependan del día en que se ejecuten. */
function startedAt(index: number): Date {
  return new Date(Date.parse(WINDOW.from) + (index + 1) * 3_600_000);
}

type SoloOptions = {
  durationSeconds?: number | null;
  opponentProfileId?: number | null;
  opponentName?: string | null;
  index?: number;
};

type TeamOptions = {
  /** Elo del jugador de esta fila en esa partida. */
  selfRating?: number | null;
  /** `[profileId, nombre, rating]` de cada compañero, en su mismo equipo. */
  teammates: [number, string, number | null][];
  /** `average_mmr` del payload. */
  averageMmr?: number | null;
  /** Ladder literal de la partida; R5 usa sus cortes. */
  leaderboard?: string;
  index?: number;
};

type RawPlayer = {
  profileId: number;
  name: string;
  rating: number | null;
  result: "win" | "loss";
};

/**
 * Payload de partida en la forma en que la API lo manda (equipos anidados, tal y
 * como los deja `rawJson`). Se construye a mano y **no** con `normalizeGame`, para
 * que las comprobaciones midan el motor de alertas y no el normalizador.
 *
 * El jugador de esta fila va **con sus compañeros en el mismo equipo**, que es como
 * llega de verdad y lo que hace que R3 y R4 tengan algo que mirar.
 */
function gamePayload(options: {
  index: number;
  kind: "rm_1v1" | "rm_2v2";
  averageMmr?: number | null;
  /** El equipo del jugador: él primero y después sus compañeros. */
  ownTeam: RawPlayer[];
  /** El equipo contrario. */
  otherTeam: RawPlayer[];
}): Record<string, unknown> {
  const envolver = (players: RawPlayer[]) =>
    players.map((player) => ({
      player: {
        profile_id: player.profileId,
        name: player.name,
        rating: player.rating,
        result: player.result,
        civilization: "english",
        civilization_randomized: false,
      },
    }));

  return {
    game_id: 8_000_000 + options.index,
    started_at: startedAt(options.index).toISOString(),
    duration: 1800,
    map: "High View",
    state: "processed",
    kind: options.kind,
    leaderboard: options.kind === "rm_1v1" ? "rm_solo" : "rm_team",
    ongoing: false,
    just_finished: false,
    ...(options.averageMmr === undefined || options.averageMmr === null
      ? {}
      : { average_mmr: options.averageMmr }),
    teams: [envolver(options.otherTeam), envolver(options.ownTeam)],
  };
}

function soloMatch(options: SoloOptions = {}): AlertMatch {
  const index = options.index ?? (gameCounter += 1);
  const opponentProfileId = options.opponentProfileId === undefined ? OPPONENT_ID : options.opponentProfileId;
  const opponentName = options.opponentName === undefined ? "Rival Fijo" : options.opponentName;

  return {
    gameId: String(800_000 + index),
    mode: "rm_solo",
    leaderboard: "rm_solo",
    opponentProfileId,
    opponentName,
    startedAt: startedAt(index),
    durationSeconds: options.durationSeconds === undefined ? 1800 : options.durationSeconds,
    rawJson: gamePayload({
      index,
      kind: "rm_1v1",
      ownTeam: [
        { profileId: PLAYER_PROFILE_ID, name: PLAYER.name, rating: 1500, result: "win" },
      ],
      otherTeam: [
        {
          profileId: opponentProfileId ?? OPPONENT_ID,
          name: opponentName ?? "Rival Fijo",
          rating: 1500,
          result: "loss",
        },
      ],
    }),
  };
}

function teamMatch(options: TeamOptions): AlertMatch {
  const index = options.index ?? (gameCounter += 1);
  const selfRating = options.selfRating === undefined ? 1500 : options.selfRating;
  const averageMmr = options.averageMmr === undefined ? 1500 : options.averageMmr;

  return {
    gameId: String(800_000 + index),
    mode: "rm_team",
    leaderboard: options.leaderboard ?? "rm_team",
    opponentProfileId: EXTERNAL_RIVAL_ID,
    opponentName: "Rival Externo",
    startedAt: startedAt(index),
    durationSeconds: 1800,
    rawJson: gamePayload({
      index,
      kind: "rm_2v2",
      ...(averageMmr === null ? {} : { averageMmr }),
      ownTeam: [
        { profileId: PLAYER_PROFILE_ID, name: PLAYER.name, rating: selfRating, result: "win" },
        ...options.teammates.map(([profileId, name, rating]) => ({
          profileId,
          name,
          rating,
          result: "win" as const,
        })),
      ],
      otherTeam: [
        { profileId: EXTERNAL_RIVAL_ID, name: "Rival Externo", rating: 1500, result: "loss" as const },
      ],
    }),
  };
}

function evaluate(options: {
  matches: AlertMatch[];
  ruleset?: AlertsRuleset;
  cutoffs?: LadderCutoffsTable | null;
  player?: AlertPlayer;
  window?: ScoringWindow;
  now?: Date;
}): {
  alerts: TriggeredAlert[];
  openStreaks: { rule: string; subject: { name: string | null }; count: number }[];
  warnings: string[];
  globalWarnings: string[];
} {
  const input: ComputeAlertsInput = {
    player: options.player ?? PLAYER,
    matches: options.matches,
    ruleset: options.ruleset ?? DEFAULT_ALERTS_RULESET,
    scoring: { modes: ["rm_solo", "rm_team"], window: options.window ?? WINDOW },
    cutoffs: options.cutoffs ?? null,
    now: options.now ?? NOW_DURANTE,
  };

  const result = computePlayerAlerts(input);

  return {
    alerts: result.alerts,
    openStreaks: result.openStreaks.map((streak) => ({
      rule: streak.rule,
      subject: { name: streak.subject.name },
      count: streak.count,
    })),
    warnings: result.warnings,
    globalWarnings: result.globalWarnings,
  };
}

/** Filtra las alertas disparadas por una regla. */
function de(alerts: TriggeredAlert[], rule: string): TriggeredAlert[] {
  return alerts.filter((alert) => alert.rule === rule);
}

/** Las frases, que es lo que va a leer el informe. */
function frases(alerts: TriggeredAlert[]): string[] {
  return alerts.map((alert) => alert.summary);
}

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

/* -------------------------------------------------------------------------- */
/* R1 — partidas cortas                                                        */
/* -------------------------------------------------------------------------- */

async function checkShortMatches(): Promise<void> {
  console.log("R1 — partidas cortas");

  await check("dos cortas seguidas avisan cuando llega la larga", () => {
    const corta = (index: number) => soloMatch({ index, durationSeconds: 120 });
    const { alerts } = evaluate({
      matches: [corta(1), corta(2), soloMatch({ index: 3, durationSeconds: 1800 })],
    });

    assert.deepEqual(frases(de(alerts, "SHORT_MATCH_STREAK")), ["2 partidas cortas seguidas"]);
    const alerta = de(alerts, "SHORT_MATCH_STREAK")[0];
    assert.equal(alerta?.kind, "STREAK_CLOSED");
    assert.equal(alerta?.count, 2);
    assert.equal(alerta?.threshold, DEFAULT_ALERTS_RULESET.thresholds.shortMatchStreak);
    assert.equal(alerta?.subjectProfileId, null, "una regla sin sujeto no inventa uno");
  });

  await check("179 s cuenta como corta y 180 s no", () => {
    const { alerts } = evaluate({
      matches: [
        soloMatch({ index: 1, durationSeconds: 179 }),
        soloMatch({ index: 2, durationSeconds: 180 }),
        soloMatch({ index: 3, durationSeconds: 180 }),
      ],
    });

    assert.deepEqual(de(alerts, "SHORT_MATCH_STREAK"), [], "180 s es exactamente el umbral, no corta");
  });

  await check("una racha sin romper no avisa, y sale como racha abierta", () => {
    const { alerts, openStreaks } = evaluate({
      matches: [
        soloMatch({ index: 1, durationSeconds: 100 }),
        soloMatch({ index: 2, durationSeconds: 100 }),
        soloMatch({ index: 3, durationSeconds: 100 }),
      ],
    });

    assert.deepEqual(de(alerts, "SHORT_MATCH_STREAK"), [], "una racha abierta todavía no avisa");
    const abierta = openStreaks.filter((streak) => streak.rule === "SHORT_MATCH_STREAK");
    assert.equal(abierta.length, 1);
    assert.equal(abierta[0]?.count, 3, "el informe ve las tres, aunque aún no avise");
  });

  await check("el acumulado avisa en cada múltiplo de 5, aunque no sean seguidas", () => {
    // Cortas, larga, corta, larga, corta, larga, corta, larga, corta.
    const matches: AlertMatch[] = [];

    for (let index = 1; index <= 9; index += 1) {
      matches.push(
        soloMatch({ index, durationSeconds: index % 2 === 1 ? 90 : 1800 }),
      );
    }

    const { alerts } = evaluate({ matches });
    const totales = de(alerts, "SHORT_MATCH_TOTAL");

    assert.deepEqual(
      totales.map((alert) => alert.count),
      [5],
      "cinco cortas avisan una vez; con cinco cortas y cuatro largas no hay segundo múltiplo",
    );
    assert.equal(totales[0]?.kind, "TOTAL_REACHED");
    assert.equal(totales[0]?.threshold, 5);
  });

  await check("diez cortas dan dos avisos de acumulado, uno por múltiplo", () => {
    const matches: AlertMatch[] = [];

    for (let index = 1; index <= 10; index += 1) {
      matches.push(soloMatch({ index, durationSeconds: 90 }));
    }

    const { alerts } = evaluate({ matches });
    const totales = de(alerts, "SHORT_MATCH_TOTAL");

    assert.deepEqual(
      totales.map((alert) => alert.count),
      [5, 10],
      "uno al cruzar 5 y otro al cruzar 10",
    );
  });

  await check("la racha de cortas y su acumulado no se pisan entre sí", () => {
    // Once partidas: la séptima y la última son largas, así que los dos tramos de
    // cortas quedan cerrados por una larga y ninguno se queda abierto.
    const matches: AlertMatch[] = [];

    for (let index = 1; index <= 11; index += 1) {
      matches.push(
        soloMatch({ index, durationSeconds: index === 7 || index === 11 ? 1800 : 60 }),
      );
    }

    const { alerts } = evaluate({ matches });
    const rachas = de(alerts, "SHORT_MATCH_STREAK");

    assert.deepEqual(
      rachas.map((alert) => alert.count),
      [6, 3],
      "dos tramos: seis antes de la larga del 7 y tres entre la 8 y la 10",
    );
    assert.deepEqual(
      de(alerts, "SHORT_MATCH_TOTAL").map((alert) => alert.count),
      [5],
      "nueve cortas dan un solo aviso de acumulado, aunque haya dos rachas",
    );
  });

  await check("una partida sin duración no cuenta como corta y rompe la racha", () => {
    const { alerts } = evaluate({
      matches: [
        soloMatch({ index: 1, durationSeconds: 60 }),
        soloMatch({ index: 2, durationSeconds: null }),
        soloMatch({ index: 3, durationSeconds: 60 }),
      ],
    });

    assert.deepEqual(
      de(alerts, "SHORT_MATCH_STREAK"),
      [],
      "no se puede afirmar que sea corta, así que no hay racha que afirmar",
    );
  });
}

/* -------------------------------------------------------------------------- */
/* R2 — rival repetido (solo 1v1)                                             */
/* -------------------------------------------------------------------------- */

async function checkRepeatedOpponent(): Promise<void> {
  console.log("R2 — rival repetido");

  const contra = (opponentProfileId: number, opponentName: string, index: number): AlertMatch =>
    soloMatch({ index, opponentProfileId, opponentName });

  await check("tres seguidas contra el mismo rival avisan al romperse", () => {
    const { alerts } = evaluate({
      matches: [
        contra(OPPONENT_ID, "Rival Fijo", 1),
        contra(OPPONENT_ID, "Rival Fijo", 2),
        contra(OPPONENT_ID, "Rival Fijo", 3),
        contra(OPPONENT_2_ID, "Otro Rival", 4),
      ],
    });

    assert.deepEqual(frases(de(alerts, "REPEATED_OPPONENT_STREAK")), [
      "3 partidas seguidas contra Rival Fijo",
    ]);
    const alerta = de(alerts, "REPEATED_OPPONENT_STREAK")[0];
    assert.equal(alerta?.subjectProfileId, OPPONENT_ID, "el sujeto es el rival, no el jugador");
    assert.equal(alerta?.subjectName, "Rival Fijo", "y se guarda su nombre al escribirla");
  });

  await check("dos de un rival y dos de otro no forman ninguna racha", () => {
    const { alerts } = evaluate({
      matches: [
        contra(OPPONENT_ID, "Rival Fijo", 1),
        contra(OPPONENT_2_ID, "Otro Rival", 2),
        contra(OPPONENT_ID, "Rival Fijo", 3),
        contra(OPPONENT_2_ID, "Otro Rival", 4),
        contra(OPPONENT_ID, "Rival Fijo", 5),
      ],
    });

    // Tres de `Rival Fijo` no son seguidas: hay una del otro en medio.
    assert.deepEqual(de(alerts, "REPEATED_OPPONENT_STREAK"), []);
  });

  await check("tres seguidas contra A, dos contra B y otra contra A: solo A avisa", () => {
    const { alerts } = evaluate({
      matches: [
        contra(OPPONENT_ID, "Rival Fijo", 1),
        contra(OPPONENT_ID, "Rival Fijo", 2),
        contra(OPPONENT_ID, "Rival Fijo", 3),
        contra(OPPONENT_2_ID, "Otro Rival", 4),
        contra(OPPONENT_2_ID, "Otro Rival", 5),
        contra(OPPONENT_ID, "Rival Fijo", 6),
      ],
    });

    assert.deepEqual(
      frases(de(alerts, "REPEATED_OPPONENT_STREAK")),
      ["3 partidas seguidas contra Rival Fijo"],
      "las rachas son por rival, no sobre el total",
    );
  });

  await check("el acumulado es por rival y salta en cada múltiplo de 10", () => {
    // Diez contra `Rival Fijo` repartidos en cuatro tramos de dos, y tres contra
    // otro: solo el primero llega al múltiplo, y ninguna pareja llega a racha.
    const secuencia: [number, number][] = [
      [OPPONENT_ID, 1],
      [OPPONENT_ID, 2],
      [OPPONENT_2_ID, 3],
      [OPPONENT_ID, 4],
      [OPPONENT_ID, 5],
      [OPPONENT_2_ID, 6],
      [OPPONENT_ID, 7],
      [OPPONENT_ID, 8],
      [OPPONENT_2_ID, 9],
      [OPPONENT_ID, 10],
      [OPPONENT_ID, 11],
      [OPPONENT_ID, 12],
      [OPPONENT_ID, 13],
    ];

    const { alerts } = evaluate({
      matches: secuencia.map(([opponentProfileId, index]) =>
        contra(opponentProfileId, opponentProfileId === OPPONENT_ID ? "Rival Fijo" : "Otro Rival", index),
      ),
    });

    const totales = de(alerts, "REPEATED_OPPONENT_TOTAL");

    assert.equal(totales.length, 1, "solo hay un rival que llega a diez");
    assert.equal(totales[0]?.subjectProfileId, OPPONENT_ID);
    assert.equal(totales[0]?.count, 10);
    assert.deepEqual(
      de(alerts, "REPEATED_OPPONENT_STREAK"),
      [],
      "y ninguna pareja llega a tres seguidas, así que el acumulado va solo",
    );
  });

  await check("en equipo no se cuenta el rival, ni como racha ni como acumulado", () => {
    const { alerts } = evaluate({
      matches: [
        teamMatch({ teammates: [[ALLY_ID, "Compañero", 1500]], index: 1 }),
        teamMatch({ teammates: [[ALLY_ID, "Compañero", 1500]], index: 2 }),
        teamMatch({ teammates: [[ALLY_ID, "Compañero", 1500]], index: 3 }),
      ],
    });

    assert.deepEqual(
      de(alerts, "REPEATED_OPPONENT_STREAK"),
      [],
      "`opponentProfileId` en equipo es solo el primer rival del otro equipo",
    );
  });

  await check("una 1v1 sin rival conocido rompe la racha, porque no hay con quién seguir", () => {
    const sinRival = soloMatch({ index: 4, opponentProfileId: null, opponentName: null });
    const { alerts } = evaluate({
      matches: [
        contra(OPPONENT_ID, "Rival Fijo", 1),
        contra(OPPONENT_ID, "Rival Fijo", 2),
        contra(OPPONENT_ID, "Rival Fijo", 3),
        sinRival,
        contra(OPPONENT_ID, "Rival Fijo", 5),
      ],
    });

    assert.deepEqual(frases(de(alerts, "REPEATED_OPPONENT_STREAK")), [
      "3 partidas seguidas contra Rival Fijo",
    ]);
    assert.equal(
      de(alerts, "REPEATED_OPPONENT_STREAK")[0]?.anchorGameId,
      sinRival.gameId,
      "la racha se ancla en la partida sin rival, que es la que la rompió",
    );
  });
}

/* -------------------------------------------------------------------------- */
/* R3 — compañeros repetidos (solo equipos, por pareja)                        */
/* -------------------------------------------------------------------------- */

async function checkRepeatedTeammate(): Promise<void> {
  console.log("R3 — compañeros repetidos");

  const con = (ally: [number, string, number | null][], index: number): AlertMatch =>
    teamMatch({ teammates: ally, index });

  await check("tres de equipo seguidas con el mismo compañero avisan al romperse", () => {
    const { alerts } = evaluate({
      matches: [
        con([[ALLY_ID, "Compañero", 1500]], 1),
        con([[ALLY_ID, "Compañero", 1500]], 2),
        con([[ALLY_ID, "Compañero", 1500]], 3),
        con([[ALLY_2_ID, "Otro", 1500]], 4),
      ],
    });

    assert.deepEqual(frases(de(alerts, "REPEATED_TEAMMATE_STREAK")), [
      "3 partidas de equipo seguidas con Compañero",
    ]);
    assert.equal(de(alerts, "REPEATED_TEAMMATE_STREAK")[0]?.subjectProfileId, ALLY_ID);
  });

  await check("cada compañero se cuenta por su cuenta", () => {
    const { alerts } = evaluate({
      matches: [
        con([[ALLY_ID, "Compañero", 1500], [ALLY_2_ID, "Otro", 1500]], 1),
        con([[ALLY_ID, "Compañero", 1500], [ALLY_2_ID, "Otro", 1500]], 2),
        con([[ALLY_ID, "Compañero", 1500], [ALLY_2_ID, "Otro", 1500]], 3),
        con([[9_100_009, "Tercero", 1500]], 4),
      ],
    });

    assert.deepEqual(
      de(alerts, "REPEATED_TEAMMATE_STREAK")
        .map((alert) => alert.subjectProfileId)
        .sort((a, b) => (a ?? 0) - (b ?? 0)),
      [ALLY_ID, ALLY_2_ID],
      "un mismo partido cierra la racha de los dos compañeros, y son dos alertas",
    );
  });

  await check("una 1v1 en medio rompe la racha de compañero", () => {
    const { alerts } = evaluate({
      matches: [
        con([[ALLY_ID, "Compañero", 1500]], 1),
        con([[ALLY_ID, "Compañero", 1500]], 2),
        soloMatch({ index: 3, opponentProfileId: OPPONENT_2_ID, opponentName: "Otro Rival" }),
        con([[ALLY_ID, "Compañero", 1500]], 4),
      ],
    });

    assert.deepEqual(
      de(alerts, "REPEATED_TEAMMATE_STREAK"),
      [],
      "lo que se vigila es el comportamiento seguido, no el orden de llegada",
    );
  });

  await check("siete partidas con el mismo compañero avisan una sola vez", () => {
    const ally: [number, string, number | null][] = [[ALLY_ID, "Compañero", 1500]];
    const matches: AlertMatch[] = [];

    for (let index = 1; index <= 9; index += 1) {
      matches.push(con(ally, index));
    }

    const { alerts } = evaluate({ matches });
    const totales = de(alerts, "REPEATED_TEAMMATE_TOTAL");

    assert.equal(totales.length, 1, "nueve partidas dan un aviso, no tres múltiplos");
    assert.equal(totales[0]?.count, 7);
    assert.equal(totales[0]?.threshold, 7);
    assert.deepEqual(frases(totales), ["7 partidas de equipo con Compañero en total"]);
  });

  await check("con seis no avisa: el acumulado necesita llegar a siete", () => {
    const ally: [number, string, number | null][] = [[ALLY_ID, "Compañero", 1500]];
    const matches: AlertMatch[] = [];

    for (let index = 1; index <= 6; index += 1) {
      matches.push(con(ally, index));
    }

    const { alerts } = evaluate({ matches });
    assert.deepEqual(de(alerts, "REPEATED_TEAMMATE_TOTAL"), []);
  });

  await check("el acumulado es por compañero: dos con siete, un solo aviso", () => {
    const matches: AlertMatch[] = [];

    for (let index = 1; index <= 7; index += 1) {
      matches.push(con([[ALLY_ID, "Compañero", 1500]], index));
    }

    for (let index = 8; index <= 14; index += 1) {
      matches.push(con([[ALLY_2_ID, "Otro", 1500]], index));
    }

    const { alerts } = evaluate({ matches });
    const totales = de(alerts, "REPEATED_TEAMMATE_TOTAL");

    assert.equal(totales.length, 2);
    assert.deepEqual(
      totales.map((alert) => alert.subjectProfileId).sort((a, b) => (a ?? 0) - (b ?? 0)),
      [ALLY_ID, ALLY_2_ID],
    );
  });
}

/* -------------------------------------------------------------------------- */
/* R4 — brecha de elo con un compañero                                        */
/* -------------------------------------------------------------------------- */

async function checkTeammateEloGap(): Promise<void> {
  console.log("R4 — brecha de elo con un compañero");

  await check("499 no avisa y 500 sí", () => {
    const justoDebajo = evaluate({
      matches: [
        teamMatch({ selfRating: 1500, teammates: [[ALLY_ID, "Compañero", 1999]], index: 1 }),
        teamMatch({ selfRating: 1500, teammates: [[ALLY_2_ID, "Tercero", 1500]], index: 2 }),
      ],
    });

    assert.deepEqual(de(justoDebajo.alerts, "TEAMMATE_ELO_GAP"), [], "499 está por debajo del umbral");

    const justo = evaluate({
      matches: [
        teamMatch({ selfRating: 1500, teammates: [[ALLY_ID, "Compañero", 2000]], index: 1 }),
        teamMatch({ selfRating: 1500, teammates: [[ALLY_2_ID, "Tercero", 1500]], index: 2 }),
      ],
    });

    assert.deepEqual(frases(de(justo.alerts, "TEAMMATE_ELO_GAP")), [
      "1 partida de equipo con un compañero a 500 de elo",
    ]);
  });

  await check("la diferencia es en valor absoluto: un compañero 500 por debajo también avisa", () => {
    const { alerts } = evaluate({
      matches: [
        teamMatch({ selfRating: 2000, teammates: [[ALLY_ID, "Compañero", 1500]], index: 1 }),
        teamMatch({ selfRating: 2000, teammates: [[ALLY_2_ID, "Tercero", 2000]], index: 2 }),
      ],
    });

    assert.equal(de(alerts, "TEAMMATE_ELO_GAP").length, 1, "500 por debajo es el mismo umbral");
  });

  await check("el elo es el de esa partida, no el de la ladder", () => {
    // El compañero sube 3000 de rating entre dos partidas: la diferencia con el
    // jugador también sube, y por eso la segunda avisa y la primera no.
    const { alerts } = evaluate({
      matches: [
        teamMatch({ selfRating: 1500, teammates: [[ALLY_ID, "Compañero", 1700]], index: 1 }),
        teamMatch({ selfRating: 1500, teammates: [[ALLY_ID, "Compañero", 1700]], index: 2 }),
        teamMatch({ selfRating: 1500, teammates: [[ALLY_ID, "Compañero", 3000]], index: 3 }),
        teamMatch({ selfRating: 1500, teammates: [[ALLY_ID, "Compañero", 1500]], index: 4 }),
      ],
    });

    const racha = de(alerts, "TEAMMATE_ELO_GAP");
    assert.equal(racha.length, 1, "solo el tramo de la tercera partida cumple el umbral");
    assert.equal(racha[0]?.count, 1);
  });

  await check("sin rating propio o sin rating del compañero no hay flag", () => {
    const { alerts, warnings } = evaluate({
      matches: [
        teamMatch({ selfRating: null, teammates: [[ALLY_ID, "Compañero", 3000]], index: 1 }),
        teamMatch({ selfRating: 1500, teammates: [[ALLY_ID, "Compañero", null]], index: 2 }),
        teamMatch({ selfRating: 1500, teammates: [[ALLY_ID, "Compañero", 1500]], index: 3 }),
      ],
      cutoffs: teamCutoffs(),
    });

    assert.deepEqual(de(alerts, "TEAMMATE_ELO_GAP"), []);
    assert.deepEqual(warnings, [], "no poder evaluar no es un aviso: es un dato que no hay");
  });

  await check("un rawJson ilegible no revienta y no aporta flags", () => {
    const roto: AlertMatch = {
      ...teamMatch({ teammates: [[ALLY_ID, "Compañero", 3000]], index: 1 }),
      rawJson: { game_id: 1, nada: "que ver" },
    };

    const { alerts } = evaluate({
      matches: [
        roto,
        teamMatch({ selfRating: 1500, teammates: [[ALLY_ID, "Compañero", 1500]], index: 2 }),
      ],
    });

    assert.deepEqual(de(alerts, "TEAMMATE_ELO_GAP"), []);
    assert.deepEqual(de(alerts, "REPEATED_TEAMMATE_STREAK"), []);
  });
}

/* -------------------------------------------------------------------------- */
/* R5 — equipo en división muy inferior                                        */
/* -------------------------------------------------------------------------- */

/**
 * Cortes de la ladder `rm_team`.
 *
 * Los valores son inventados pero **monótonos y de la misma escala** que la ladder
 * real: lo que importa aquí es la aritmética de escalones, no el rating exacto. Se
 * construyen hacia abajo desde `conqueror_3` con pasos regulares de 100, para que
 * las cuentas salgan a mano y cada escalón valga exactamente 100 de elo.
 */
function teamCutoffs(): LadderCutoffsTable {
  const cutoffs = SUBDIVISION_RANK_LEVELS.map((rankLevel, index) => ({
    rankLevel,
    minRating: 3000 - index * 100,
  }));

  return { rm_team: { ladder: "rm_team", derivedAt: WINDOW.from, totalCount: 50_000, cutoffs, requests: 1 } };
}

/** El mismo `average_mmr` leído con los cortes de `rm_team`. */
function mediaComoSubdivision(cutoffs: LadderCutoffsTable, mmr: number): string | null {
  const ladder = cutoffs["rm_team"];

  return ladder === undefined ? null : (subdivisionForRating(ladder, mmr)?.rankLevel ?? null);
}

async function checkLowDivision(): Promise<void> {
  console.log("R5 — equipo en división muy inferior");

  const cutoffs = teamCutoffs();
  /**
   * R4 y R5 tienen umbral 1, así que su única partida con el flag es **el último
   * tramo de la secuencia** y no avisan hasta que llega la siguiente
   * clasificatoria: la racha se cierra cuando se rompe. Todas las secuencias de
   * este bloque terminan con una 1v1, que no aporta flag a R5 y cierra el tramo.
   */
  const cierraElTramo = (index: number): AlertMatch =>
    soloMatch({ index, durationSeconds: 1800, opponentProfileId: OPPONENT_2_ID, opponentName: "Otro Rival" });

  await check("el corte de subdivisión sale del rating, con la escala de la ladder", () => {
    assert.equal(mediaComoSubdivision(cutoffs, 3000), "conqueror_3");
    assert.equal(mediaComoSubdivision(cutoffs, 2999), "conqueror_2");
    assert.equal(mediaComoSubdivision(cutoffs, 2100), "gold_3");
    assert.equal(mediaComoSubdivision(cutoffs, 0), "bronze_1", "por debajo del último corte se recorta");
  });

  await check("tres escalones exactos avisan, dos no", () => {
    // gold_3 es el escalón 9. Tres escalones por debajo es silver_3 (escalón 12),
    // que con esta escala empieza en 1800; dos sería gold_1 (escalón 11), en 1900.
    const tresEscalones = evaluate({
      matches: [
        teamMatch({ teammates: [[ALLY_ID, "Compañero", 1500]], averageMmr: 1800, index: 1 }),
        teamMatch({ teammates: [[ALLY_2_ID, "Otro", 1500]], averageMmr: 1800, index: 2 }),
        cierraElTramo(3),
      ],
      cutoffs,
    });

    assert.deepEqual(frases(de(tresEscalones.alerts, "LOW_DIVISION_TEAM_GAME")), [
      "2 partidas de equipos 3 escalones por debajo de su división",
    ]);
    assert.equal(
      de(tresEscalones.alerts, "LOW_DIVISION_TEAM_GAME")[0]?.anchorGameId,
      cierraElTramo(3).gameId,
      "se ancla en la 1v1 que rompió el tramo",
    );

    const dosEscalones = evaluate({
      matches: [
        teamMatch({ teammates: [[ALLY_ID, "Compañero", 1500]], averageMmr: 1900, index: 1 }),
        teamMatch({ teammates: [[ALLY_2_ID, "Otro", 1500]], averageMmr: 1900, index: 2 }),
        cierraElTramo(3),
      ],
      cutoffs,
    });

    assert.equal(mediaComoSubdivision(cutoffs, 1900), "gold_1");
    assert.deepEqual(
      de(dosEscalones.alerts, "LOW_DIVISION_TEAM_GAME"),
      [],
      "dos escalones no llegan al umbral de tres",
    );
  });

  await check("una sola partida con el flag no avisa hasta que se rompe", () => {
    const suelta = [
      teamMatch({ teammates: [[ALLY_ID, "Compañero", 1500]], averageMmr: 1800, index: 1 }),
    ];

    const abierta = evaluate({ matches: suelta, cutoffs });
    assert.deepEqual(
      de(abierta.alerts, "LOW_DIVISION_TEAM_GAME"),
      [],
      "con el torneo abierto el tramo sigue vivo: no hay partida que lo haya roto",
    );
    assert.equal(
      abierta.openStreaks.filter((streak) => streak.rule === "LOW_DIVISION_TEAM_GAME").length,
      1,
    );

    const cerrada = evaluate({ matches: [...suelta, cierraElTramo(2)], cutoffs });
    assert.equal(de(cerrada.alerts, "LOW_DIVISION_TEAM_GAME").length, 1, "al llegar la 1v1, avisa");

    const finDeTorneo = evaluate({ matches: suelta, cutoffs, now: NOW_DESPUES });
    const porCierre = de(finDeTorneo.alerts, "LOW_DIVISION_TEAM_GAME");

    assert.equal(porCierre.length, 1, "con el torneo cerrado avisa aunque nadie rompa nada");
    assert.equal(porCierre[0]?.kind, "STREAK_AT_TOURNAMENT_END");
    assert.equal(porCierre[0]?.anchorGameId, suelta[0]?.gameId, "y se ancla en la última del tramo");
  });

  await check("los ejemplos del cliente: gold_3 → silver_3 y gold_1 → silver_1", () => {
    // gold_3 (escalón 9) contra silver_3 (escalón 12) son tres escalones, y
    // gold_1 (escalón 11) contra silver_1 (escalón 14) también tres.
    const gold3ContraSilver3 = evaluate({
      matches: [
        teamMatch({ teammates: [[ALLY_ID, "Compañero", 1500]], averageMmr: 1800, index: 1 }),
        teamMatch({ teammates: [[ALLY_2_ID, "Otro", 1500]], averageMmr: 1800, index: 2 }),
        cierraElTramo(3),
      ],
      cutoffs,
    });

    assert.equal(mediaComoSubdivision(cutoffs, 1800), "silver_3");
    assert.equal(de(gold3ContraSilver3.alerts, "LOW_DIVISION_TEAM_GAME").length, 1);

    const gold1ContraSilver1 = evaluate({
      player: { ...PLAYER, rankLevel: "gold_1" },
      matches: [
        teamMatch({ teammates: [[ALLY_ID, "Compañero", 1500]], averageMmr: 1600, index: 1 }),
        teamMatch({ teammates: [[ALLY_2_ID, "Otro", 1500]], averageMmr: 1600, index: 2 }),
        cierraElTramo(3),
      ],
      cutoffs,
    });

    assert.equal(mediaComoSubdivision(cutoffs, 1600), "silver_1");
    assert.equal(
      de(gold1ContraSilver1.alerts, "LOW_DIVISION_TEAM_GAME").length,
      1,
      "gold_1 contra silver_1 también son tres escalones",
    );

    const gold3ContraGold1 = evaluate({
      player: { ...PLAYER, rankLevel: "gold_3" },
      matches: [
        teamMatch({ teammates: [[ALLY_ID, "Compañero", 1500]], averageMmr: 1900, index: 1 }),
        teamMatch({ teammates: [[ALLY_2_ID, "Otro", 1500]], averageMmr: 1900, index: 2 }),
        cierraElTramo(3),
      ],
      cutoffs,
    });

    assert.equal(mediaComoSubdivision(cutoffs, 1900), "gold_1");
    assert.deepEqual(
      de(gold3ContraGold1.alerts, "LOW_DIVISION_TEAM_GAME"),
      [],
      "gold_3 contra gold_1 son dos escalones, no tres",
    );
  });

  await check("sin cortes cacheados R5 se omite entera, con aviso, y no rompe nada", () => {
    const { alerts, warnings, globalWarnings } = evaluate({
      matches: [
        teamMatch({ teammates: [[ALLY_ID, "Compañero", 1500]], averageMmr: 100, index: 1 }),
        teamMatch({ teammates: [[ALLY_2_ID, "Otro", 1500]], averageMmr: 100, index: 2 }),
        cierraElTramo(3),
      ],
      cutoffs: null,
    });

    assert.deepEqual(de(alerts, "LOW_DIVISION_TEAM_GAME"), []);
    assert.equal(
      globalWarnings.some((warning) => warning.includes("R5")),
      true,
      "el hueco de datos se dice, y es de la evaluación, no de un jugador",
    );
    assert.deepEqual(warnings, [], "los cortes no son culpa de este jugador");
  });

  await check("sin rankLevel 1v1 el jugador se omite, con aviso", () => {
    const { alerts, warnings } = evaluate({
      player: { ...PLAYER, rankLevel: null },
      matches: [
        teamMatch({ teammates: [[ALLY_ID, "Compañero", 1500]], averageMmr: 100, index: 1 }),
        teamMatch({ teammates: [[ALLY_2_ID, "Otro", 1500]], averageMmr: 100, index: 2 }),
      ],
      cutoffs,
    });

    assert.deepEqual(de(alerts, "LOW_DIVISION_TEAM_GAME"), []);
    assert.equal(
      warnings.some((warning) => warning.includes("rankLevel 1v1")),
      true,
    );
  });

  await check("sin average_mmr legible esa partida no aporta flag", () => {
    const { alerts } = evaluate({
      matches: [
        teamMatch({ teammates: [[ALLY_ID, "Compañero", 1500]], averageMmr: null, index: 1 }),
        teamMatch({ teammates: [[ALLY_2_ID, "Otro", 1500]], averageMmr: 1500, index: 2 }),
      ],
      cutoffs,
    });

    assert.deepEqual(de(alerts, "LOW_DIVISION_TEAM_GAME"), []);
  });

  await check("los cortes son los de la ladder de la partida, no los de rm_solo", () => {
    // Dos ladders con escalas distintas. Con la de `rm_solo` (5000 en cabeza) una
    // media de 1800 cae de sobra en plata, o sea **por encima** del oro del
    // jugador; con la de `rm_team` (3000 en cabeza) cae en silver_3, tres escalones
    // por debajo. Si el motor usara la escalera equivocada, saldría al revés.
    const rmSolo: LadderCutoffsTable = {
      rm_solo: {
        ladder: "rm_solo",
        derivedAt: WINDOW.from,
        totalCount: 23_000,
        cutoffs: SUBDIVISION_RANK_LEVELS.map((rankLevel, index) => ({
          rankLevel,
          minRating: 5000 - index * 100,
        })),
        requests: 1,
      },
      rm_team: {
        ladder: "rm_team",
        derivedAt: WINDOW.from,
        totalCount: 50_000,
        cutoffs: SUBDIVISION_RANK_LEVELS.map((rankLevel, index) => ({
          rankLevel,
          minRating: 3000 - index * 100,
        })),
        requests: 1,
      },
    };

    const conAmbas = evaluate({
      matches: [
        teamMatch({ teammates: [[ALLY_ID, "Compañero", 1500]], averageMmr: 1800, index: 1 }),
        teamMatch({ teammates: [[ALLY_2_ID, "Otro", 1500]], averageMmr: 1800, index: 2 }),
        cierraElTramo(3),
      ],
      cutoffs: rmSolo,
    });

    assert.equal(
      de(conAmbas.alerts, "LOW_DIVISION_TEAM_GAME").length,
      1,
      "con la escala de rm_team la media es silver_3 y son tres escalones",
    );

    // La misma partida, pero sin cortes de la ladder **de la partida** (que es
    // `rm_team`): esa partida no se evalúa y no avisa.
    const sinRmTeam: LadderCutoffsTable = { rm_solo: rmSolo["rm_solo"]! };

    const sinCortes = evaluate({
      matches: [
        teamMatch({ teammates: [[ALLY_ID, "Compañero", 1500]], averageMmr: 1800, index: 1 }),
        teamMatch({ teammates: [[ALLY_2_ID, "Otro", 1500]], averageMmr: 1800, index: 2 }),
        cierraElTramo(3),
      ],
      cutoffs: sinRmTeam,
    });

    assert.deepEqual(
      de(sinCortes.alerts, "LOW_DIVISION_TEAM_GAME"),
      [],
      "no hay cortes de la ladder de la partida, así que esa partida no se evalúa",
    );
  });

  await check("una 1v1 nunca dispara R5 aunque la media sea diminuta", () => {
    const { alerts } = evaluate({
      matches: [
        soloMatch({ index: 1, durationSeconds: 1800 }),
        soloMatch({ index: 2, durationSeconds: 1800 }),
      ],
      cutoffs,
    });

    assert.deepEqual(de(alerts, "LOW_DIVISION_TEAM_GAME"), []);
  });
}

/* -------------------------------------------------------------------------- */
/* Cierre de torneo                                                            */
/* -------------------------------------------------------------------------- */

async function checkTournamentClose(): Promise<void> {
  console.log("Cierre de torneo");

  const tresCortas = [
    soloMatch({ index: 1, durationSeconds: 100 }),
    soloMatch({ index: 2, durationSeconds: 100 }),
    soloMatch({ index: 3, durationSeconds: 100 }),
  ];

  await check("con el torneo abierto la racha final no avisa", () => {
    const { alerts, openStreaks } = evaluate({ matches: tresCortas, now: NOW_DURANTE });

    assert.deepEqual(de(alerts, "SHORT_MATCH_STREAK"), []);
    assert.equal(openStreaks.filter((streak) => streak.rule === "SHORT_MATCH_STREAK").length, 1);
  });

  await check("cerrado el torneo, la racha abierta avisa una sola vez y como cierre", () => {
    const { alerts } = evaluate({ matches: tresCortas, now: NOW_DESPUES });
    const racha = de(alerts, "SHORT_MATCH_STREAK");

    assert.equal(racha.length, 1, "no se avisa dos veces de lo mismo");
    assert.equal(racha[0]?.kind, "STREAK_AT_TOURNAMENT_END");
    assert.equal(racha[0]?.count, 3);
    assert.equal(
      racha[0]?.anchorGameId,
      tresCortas[2]?.gameId,
      "al no haber partida que rompa nada, se ancla en la última de la racha",
    );
    assert.deepEqual(frases(racha), ["3 partidas cortas seguidas al cerrar el torneo"]);
  });

  await check("una racha rota por una partida posterior se ancla en la que la rompió", () => {
    const conLargaDespues = [...tresCortas, soloMatch({ index: 4, durationSeconds: 1800 })];
    const { alerts } = evaluate({ matches: conLargaDespues, now: NOW_DESPUES });
    const racha = de(alerts, "SHORT_MATCH_STREAK");

    assert.equal(racha.length, 1);
    assert.equal(racha[0]?.kind, "STREAK_CLOSED", "con una partida posterior, la racha se rompió");
    assert.equal(
      racha[0]?.anchorGameId,
      conLargaDespues[3]?.gameId,
      "y el ancla es la larga, no la última corta de la racha",
    );
  });

  await check("una ventana sin fin no se cierra nunca", () => {
    const { alerts } = evaluate({
      matches: tresCortas,
      window: { from: WINDOW.from, to: null },
      now: NOW_DESPUES,
    });

    assert.deepEqual(de(alerts, "SHORT_MATCH_STREAK"), [], "sin `to` no hay cierre que avisar");
  });

  await check("el acumulado no se ve afectado por el cierre", () => {
    const cincoCortas = Array.from({ length: 5 }, (_, index) =>
      soloMatch({ index: index + 1, durationSeconds: 90 }),
    );

    const durante = evaluate({ matches: cincoCortas, now: NOW_DURANTE });
    const despues = evaluate({ matches: cincoCortas, now: NOW_DESPUES });

    assert.deepEqual(
      de(durante.alerts, "SHORT_MATCH_TOTAL").map((alert) => alert.kind),
      de(despues.alerts, "SHORT_MATCH_TOTAL").map((alert) => alert.kind),
      "un acumulado es un acumulado, se avise cuando se avise",
    );
    assert.equal(de(despues.alerts, "SHORT_MATCH_TOTAL").length, 1);
  });
}

/* -------------------------------------------------------------------------- */
/* Idempotencia y claves de dedupe                                            */
/* -------------------------------------------------------------------------- */

async function checkDedupe(): Promise<void> {
  console.log("Idempotencia y claves de dedupe");

  const secuencia: AlertMatch[] = [
    soloMatch({ index: 1, durationSeconds: 60, opponentProfileId: OPPONENT_ID, opponentName: "Rival Fijo" }),
    soloMatch({ index: 2, durationSeconds: 60, opponentProfileId: OPPONENT_ID, opponentName: "Rival Fijo" }),
    soloMatch({ index: 3, durationSeconds: 60, opponentProfileId: OPPONENT_ID, opponentName: "Rival Fijo" }),
    soloMatch({ index: 4, durationSeconds: 1800, opponentProfileId: OPPONENT_2_ID, opponentName: "Otro" }),
    soloMatch({ index: 5, durationSeconds: 60, opponentProfileId: OPPONENT_ID, opponentName: "Rival Fijo" }),
    soloMatch({ index: 6, durationSeconds: 60, opponentProfileId: OPPONENT_ID, opponentName: "Rival Fijo" }),
    soloMatch({ index: 7, durationSeconds: 60, opponentProfileId: OPPONENT_ID, opponentName: "Rival Fijo" }),
    soloMatch({ index: 8, durationSeconds: 1800, opponentProfileId: OPPONENT_2_ID, opponentName: "Otro" }),
    teamMatch({ teammates: [[ALLY_ID, "Compañero", 2600]], index: 9 }),
    teamMatch({ teammates: [[ALLY_2_ID, "Otro", 1500]], index: 10 }),
    teamMatch({ teammates: [[ALLY_ID, "Compañero", 2600]], index: 11 }),
  ];

  await check("dos evaluaciones de los mismos datos dan las mismas claves", () => {
    const primera = evaluate({ matches: secuencia, cutoffs: teamCutoffs() });
    const segunda = evaluate({ matches: secuencia, cutoffs: teamCutoffs() });

    assert.deepEqual(
      primera.alerts.map((alert) => alert.dedupeKey),
      segunda.alerts.map((alert) => alert.dedupeKey),
      "sin claves distintas, `skipDuplicates` no puede saltarse nada",
    );
    assert.equal(primera.alerts.length, segunda.alerts.length);
  });

  await check("ninguna alerta repite su clave dentro de la misma evaluación", () => {
    const { alerts } = evaluate({ matches: secuencia, cutoffs: teamCutoffs() });
    const claves = alerts.map((alert) => alert.dedupeKey);

    assert.equal(new Set(claves).size, claves.length, "una clave repetida se perdería en el insert");
  });

  await check("la clave lleva regla, tipo, jugador, sujeto y remate", () => {
    const clave = alertDedupeKey({
      rule: "SHORT_MATCH_STREAK",
      kind: "STREAK_CLOSED",
      playerId: PLAYER_ID,
      subjectKey: "yo",
      anchorGameId: "800004",
      count: 2,
    });

    assert.equal(clave.includes("SHORT_MATCH_STREAK"), true);
    assert.equal(clave.includes("STREAK_CLOSED"), true);
    assert.equal(clave.includes(PLAYER_ID), true);
    assert.equal(clave.includes("800004"), true);
    assert.equal(clave.startsWith(`v${ALERTS_RULESET_VERSION}`), true);

    const total = alertDedupeKey({
      rule: "SHORT_MATCH_TOTAL",
      kind: "TOTAL_REACHED",
      playerId: PLAYER_ID,
      subjectKey: "yo",
      anchorGameId: null,
      count: 10,
    });

    assert.equal(total.includes("10"), true, "un acumulado se distingue por el número, no por la partida");
  });

  await check("dos rachas del mismo jugador con distinto remate son claves distintas", () => {
    const { alerts } = evaluate({ matches: secuencia });
    const rachas = de(alerts, "REPEATED_OPPONENT_STREAK");

    assert.equal(rachas.length, 2, "la secuencia tiene dos tramos de tres contra el mismo rival");
    assert.equal(
      new Set(rachas.map((alert) => alert.anchorGameId)).size,
      2,
      "cada tramo se ancla en la partida que lo cerró, y son distintas",
    );
    assert.equal(
      new Set(rachas.map((alert) => alert.dedupeKey)).size,
      2,
      "y con anclas distintas las claves no pueden coincidir",
    );
    assert.deepEqual(
      rachas.map((alert) => alert.kind),
      ["STREAK_CLOSED", "STREAK_CLOSED"],
      "las dos se rompieron con una partida posterior, ninguna por cierre de torneo",
    );
  });
}

/* -------------------------------------------------------------------------- */
/* Ruleset                                                                     */
/* -------------------------------------------------------------------------- */

async function checkAlertsRuleset(): Promise<void> {
  console.log(`Ruleset (${ALERTS_RULESET_KEY})`);

  await check("sin documento guardado se usan los valores por defecto, sin avisar", () => {
    const ausente = mergeAlertsRuleset(undefined);

    assert.deepEqual(ausente.ruleset.thresholds, DEFAULT_ALERTS_RULESET.thresholds);
    assert.equal(ausente.warnings.length, 1, "un `undefined` sí es un documento que no se entiende");
  });

  await check("una versión que no es la del código invalida el documento entero", () => {
    const resultado = mergeAlertsRuleset({
      version: ALERTS_RULESET_VERSION + 1,
      thresholds: { shortMatchStreak: 9 },
    });

    assert.deepEqual(resultado.ruleset.thresholds, DEFAULT_ALERTS_RULESET.thresholds);
    assert.equal(
      resultado.warnings.some((warning) => warning.includes("se ignoran")),
      true,
    );
  });

  await check("un umbral guardado se aplica tal cual", () => {
    const resultado = mergeAlertsRuleset({
      version: ALERTS_RULESET_VERSION,
      label: ALERTS_RULE_LABEL,
      thresholds: { shortMatchStreak: 3, teammateEloGap: 750 },
    });

    assert.equal(resultado.ruleset.thresholds.shortMatchStreak, 3);
    assert.equal(resultado.ruleset.thresholds.teammateEloGap, 750);
    assert.deepEqual(resultado.warnings, []);
  });

  await check("un umbral inútil cae al valor por defecto y avisa, sin lanzar", () => {
    const invalidos: unknown[] = [0, -1, 2.5, "3", null, true, {}];

    for (const valor of invalidos) {
      const resultado = mergeAlertsRuleset({
        version: ALERTS_RULESET_VERSION,
        thresholds: { shortMatchStreak: valor },
      });

      assert.equal(
        resultado.ruleset.thresholds.shortMatchStreak,
        DEFAULT_ALERTS_RULESET.thresholds.shortMatchStreak,
        `shortMatchStreak: ${JSON.stringify(valor)} debería caer al valor por defecto`,
      );
      assert.equal(
        resultado.warnings.some((warning) => warning.includes("shortMatchStreak")),
        true,
        `shortMatchStreak: ${JSON.stringify(valor)} debería avisar`,
      );
    }

    for (const documento of [null, [], "texto", 42, { version: null }, { version: ALERTS_RULESET_VERSION, thresholds: "no" }]) {
      const resultado = mergeAlertsRuleset(documento);

      assert.deepEqual(resultado.ruleset.thresholds, DEFAULT_ALERTS_RULESET.thresholds);
      assert.ok(resultado.warnings.length > 0, `documento ${JSON.stringify(documento)} debería avisar`);
    }
  });

  await check("los umbrales por defecto son los acordados", () => {
    const { thresholds } = DEFAULT_ALERTS_RULESET;

    assert.equal(thresholds.shortMatchSeconds, 180);
    assert.equal(thresholds.shortMatchStreak, 2);
    assert.equal(thresholds.shortMatchTotalStep, 5);
    assert.equal(thresholds.repeatedOpponentStreak, 3);
    assert.equal(thresholds.repeatedOpponentTotalStep, 10);
    assert.equal(thresholds.repeatedTeammateStreak, 3);
    assert.equal(thresholds.repeatedTeammateTotal, 7);
    assert.equal(thresholds.teammateEloGap, 500);
    assert.equal(thresholds.lowDivisionSteps, 3);
  });

  await check("la etiqueta la fija el código, igual que en el motor de puntos", () => {
    const resultado = mergeAlertsRuleset({
      version: ALERTS_RULESET_VERSION,
      label: "otra cosa",
    });

    assert.equal(resultado.ruleset.label, ALERTS_RULE_LABEL);
    assert.equal(resultado.warnings.some((warning) => warning.includes("label")), true);
  });

  await check("las dieciocho subdivisiones van de la más fuerte a la más débil", () => {
    assert.equal(SUBDIVISION_RANK_LEVELS.length, 18);
    assert.equal(SUBDIVISION_RANK_LEVELS[0], "conqueror_3");
    assert.equal(SUBDIVISION_RANK_LEVELS[SUBDIVISION_RANK_LEVELS.length - 1], "bronze_1");

    // Los dos ejemplos que se acordaron con el cliente: desde gold_3, tres
    // escalones abajo es silver_3; desde gold_1, tres escalones abajo es silver_1.
    const gold3 = subdivisionIndex("gold_3");
    const gold1 = subdivisionIndex("gold_1");

    assert.equal(SUBDIVISION_RANK_LEVELS[gold3 === null ? 0 : gold3 + 3], "silver_3");
    assert.equal(SUBDIVISION_RANK_LEVELS[gold1 === null ? 0 : gold1 + 3], "silver_1");

    assert.equal(subdivisionIndex("GOLD_2"), subdivisionIndex("gold_2"), "se normaliza a minúsculas");
    assert.equal(subdivisionIndex("oro_2"), null, "un tier que no existe no se inventa");
    assert.equal(subdivisionIndex(null), null);
    assert.equal(subdivisionIndex(""), null);
  });
}

/* -------------------------------------------------------------------------- */
/* Cortes cacheados                                                            */
/* -------------------------------------------------------------------------- */

async function checkCutoffsCache(): Promise<void> {
  console.log("Cortes de división cacheados");

  await check("lo que se guarda se vuelve a leer igual", () => {
    const guardados = { ladders: teamCutoffs() };
    const leidos = readCutoffsTable(JSON.parse(JSON.stringify(guardados)));

    assert.ok(leidos !== null);
    assert.equal(leidos["rm_team"]?.cutoffs.length, 18);
    assert.equal(leidos["rm_team"]?.requests, 1);
  });

  await check("una caché vacía o sin ladders es `null`, no un objeto vacío", () => {
    assert.equal(readCutoffsTable(null), null);
    assert.equal(readCutoffsTable({}), null);
    assert.equal(readCutoffsTable({ ladders: {} }), null);
    assert.equal(readCutoffsTable("texto"), null);
  });

  await check("una ladder con una subdivisión fuera del catálogo se descarta", () => {
    const leidos = readCutoffsTable({
      ladders: {
        rm_team: {
          ladder: "rm_team",
          cutoffs: [
            { rankLevel: "plata_1", minRating: 1000 },
            { rankLevel: "gold_3", minRating: 900 },
          ],
        },
      },
    });

    assert.equal(leidos, null, "una subdivisión inventada hace inservible la ladder entera");
  });

  await check("una ladder desordenada se descarta, y no rompe la otra", () => {
    const leidos = readCutoffsTable({
      ladders: {
        rm_solo: {
          ladder: "rm_solo",
          cutoffs: [
            { rankLevel: "gold_2", minRating: 900 },
            { rankLevel: "conqueror_3", minRating: 3000 },
          ],
        },
        ...teamCutoffs(),
      },
    });

    assert.ok(leidos !== null);
    assert.equal(leidos["rm_solo"], undefined, "la ladder desordenada se cae");
    assert.equal(leidos["rm_team"]?.cutoffs.length, 18, "y la buena sigue sirviendo");
  });
}

/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  gameCounter = 0;

  await checkShortMatches();
  console.log("");
  await checkRepeatedOpponent();
  console.log("");
  await checkRepeatedTeammate();
  console.log("");
  await checkTeammateEloGap();
  console.log("");
  await checkLowDivision();
  console.log("");
  await checkTournamentClose();
  console.log("");
  await checkDedupe();
  console.log("");
  await checkAlertsRuleset();
  console.log("");
  await checkCutoffsCache();

  console.log("");
  console.log(`${passed} comprobaciones correctas, ${failures.length} con errores.`);

  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

void main();
