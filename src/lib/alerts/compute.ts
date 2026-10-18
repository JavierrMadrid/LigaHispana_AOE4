import { parseTeamView } from "@/lib/aoe4world/parse";
import type { ScoringWindow } from "@/lib/ranked-match";
import {
  buildTriggeredAlert,
  SELF_SUBJECT,
  type AlertAnchorDetail,
  type AlertSubject,
  type AlertsRuleName,
  type AlertsRuleset,
  type StreakAlertRule,
  type TriggeredAlert,
} from "./rules";

/**
 * Motor de alertas: qué comportamientos anómalos se ven en las partidas
 * clasificatorias de un jugador. **Módulo puro**: no toca la base de datos ni
 * sale a la red, para que `compute.test.ts` (vía `npm test`) pueda comprobarlo con
 * secuencias sintéticas y sin nada preparado.
 *
 * ## El modelo, que es el mismo para las seis reglas
 *
 * Para cada regla hay un **flag por partida** sobre la secuencia de
 * clasificatorias del jugador ordenada por `startedAt`. Una **racha** es un
 * tramo maximal de partidas consecutivas con el flag, y el aviso sale **cuando
 * la racha se rompe** (llega una clasificatoria sin el flag), diciendo cuántas
 * duró. Si el torneo se cierra con la racha abierta, sale con el conteo que
 * tenga, como `STREAK_AT_TOURNAMENT_END`. Los **acumulados** se cuentan sobre
 * todas las clasificatorias de la ventana y avisan al cruzar el umbral.
 *
 * Que la unidad de "consecutiva" sea la secuencia completa de clasificatorias y
 * no un subconjunto por modo es deliberado: una partida 1v1 en medio rompe la
 * racha de "tres de equipo seguidas con este compañero", porque lo que se vigila
 * es el comportamiento seguido y no el orden en que llegaron las partidas. Lo
 * que **no** rompe una racha son las partidas no clasificatorias, y eso está
 * resuelto antes de llegar aquí: la secuencia que recibe esta función ya viene
 * filtrada con `rankedMatchWhere()` **y** con la condición de equipos
 * (`teammatesWithinTier()`), que no cabe en ese filtro y la aplica quien llama.
 *
 * ## Las seis reglas
 *
 * | Regla | Modo | Flag por partida | Racha | Acumulado |
 * |---|---|---|---|---|
 * | R1 `SHORT_MATCH_*` | 1v1 y equipos | `durationSeconds < shortMatchSeconds` | 2 | cada 5 |
 * | R2 `REPEATED_OPPONENT_*` | solo `rm_solo` | la partida tiene rival con `opponentProfileId` | 3 con el mismo rival | cada 10 con el mismo rival |
 * | R3 `REPEATED_TEAMMATE_*` | solo `rm_team` | el mismo compañero está en mi equipo | 3 con ese compañero | 7 con ese compañero, una vez |
 *
 * Fueron ocho: `TEAMMATE_ELO_GAP` (R4) y `LOW_DIVISION_TEAM_GAME` (R5) se
 * retiraron porque su caso pasó a ser una condición de **puntuación** —una partida
 * de equipo con un compañero a dos escalones o más no cuenta, ver
 * `src/lib/ranked-match.ts`—, así que ya no hay nada que avisar. Sus valores del
 * enum y sus frases siguen, por las filas históricas (ver `rules.ts`).
 *
 * R2 y R3 llevan **sujeto** (el rival, el compañero), así que sus rachas y sus
 * acumulados son *por sujeto*: tres partidas seguidas contra el mismo rival, no
 * tres contra cualquiera. El resto habla del jugador y su sujeto es él mismo.
 *
 * ## La partida que ancla la alerta
 *
 * De una racha rota se ancla **la partida que la rompió** (la primera clasificatoria
 * sin el patrón), que es la evidencia de que el tramo terminó. De un tramo que solo
 * cerró el fin del torneo no hay partida que rompa nada, así que se ancla la última
 * del tramo. De un acumulado se ancla la partida en la que se cruzó el umbral.
 *
 * ## Lo que degrada sin romper
 *
 * Un `rawJson` ilegible no lanza: esa partida no aporta flags, y se cuenta en
 * `unreadableMatches`. Es la dirección segura, porque una regla que no puede
 * evaluarse no puede acusar a nadie.
 */

/** Lo mínimo que hace falta de un jugador. */
export type AlertPlayer = {
  id: string;
  profileId: number;
  name: string;
};

/**
 * Lo que se lee de cada partida clasificatoria.
 *
 * `rawJson` entra como `unknown` a propósito: en la base es un `Json` que
 * escribió la API, y lo que el motor necesita de él (los compañeros de la regla
 * de compañero repetido) se vuelve a validar con `parseGame()` en cada evaluación
 * en vez de fiarse de que esté intacto.
 */
export type AlertMatch = {
  gameId: string;
  mode: string | null;
  opponentProfileId: number | null;
  opponentName: string | null;
  startedAt: Date;
  durationSeconds: number | null;
  rawJson: unknown;
};

export type ComputeAlertsInput = {
  player: AlertPlayer;
  /**
   * **Solo clasificatorias**, ya filtradas con `rankedMatchWhere()` —y con la
   * condición de equipos que ese filtro no puede escribir— y ordenadas por
   * `startedAt`. Quien llama decide el filtro, y así las seis reglas comparten la
   * única definición de "clasificatoria" que hay en el proyecto.
   */
  matches: AlertMatch[];
  /** Umbrales activos (`Setting["alerts.ruleset"]`). */
  ruleset: AlertsRuleset;
  /**
   * Alcance de la puntuación: `modes` y `window` del ruleset de puntos.
   *
   * Solo se usa la ventana, y para una cosa: saber si el torneo ya ha terminado
   * (`now >= window.to`), que es lo que convierte una racha abierta en un aviso
   * de cierre. Los modos no se vuelven a aplicar porque `matches` ya viene
   * filtrado con ellos, y por eso no se duplican en el ruleset de alertas.
   */
  scoring: { modes: string[]; window: ScoringWindow };
  now: Date;
};

/** Racha que sigue abierta: el informe la enseña aunque todavía no avise. */
export type OpenStreak = {
  /** Del jugador a quien pertenece la racha: el informe los mezcla en un mismo bloque. */
  playerId: string;
  playerProfileId: number;
  playerName: string;
  rule: StreakAlertRule;
  subject: AlertSubject;
  /** Partidas que lleva así. */
  count: number;
  /**
   * El mínimo con el que se comparó el tramo, o sea el umbral de la regla. Lo
   * lleva para que el informe pueda decir con qué criterio se contaría, en vez
   * de tener que deducir el número de la regla otra vez en quien escribe.
   */
  threshold: number;
  lastGameId: string;
  lastStartedAt: string;
};

export type PlayerAlertsEvaluation = {
  /** Alertas **disparadas** por esta evaluación, listas para insertar. */
  alerts: TriggeredAlert[];
  /** Rachas que no han terminado: todavía no avisan de nada. */
  openStreaks: OpenStreak[];
  /** Cuántas de las anteriores se han avisado por cierre de torneo. */
  closedAtTournamentEnd: number;
  /**
   * Partidas clasificatorias cuyo `rawJson` no se ha podido leer para las reglas
   * de equipo. No es un fallo: es la degradación acordada, y sale en el resumen
   * para que se pueda ver cuántas hay.
   */
  unreadableMatches: number;
  /** Lo que a este jugador no se le ha podido mirar. El log le pone su nombre. */
  warnings: string[];
  /**
   * Lo que **a toda la evaluación** no se le ha podido mirar. No lleva nombre de
   * jugador porque no es culpa de ninguno, y repetirlo treinta veces en el log no
   * informa de nada.
   *
   * Hoy ningún aviso lo usa: el hueco que sí afecta a toda la evaluación —no tener
   * los cortes de división— lo dice el rastro del recálculo
   * (`Setting["scoring.lastRun"]`, ver `recomputeScores()`), que es donde ese dato
   * falta para toda la puntuación y no solo para las alertas.
   */
  globalWarnings: string[];
};

/* -------------------------------------------------------------------------- */
/* Tramos y acumulados                                                          */
/* -------------------------------------------------------------------------- */

const TEAM_MODE = "rm_team";
const SOLO_MODE = "rm_solo";

/**
 * Las reglas de racha que el motor **calcula hoy**: `StreakAlertRule` sin las dos
 * retiradas (R4 y R5, que siguen en el enum por las filas históricas).
 *
 * Es un tipo y no una lista de comprobaciones para que el `switch` de
 * `ruleBits()` siga siendo exhaustivo: con el tipo ancho habría que dar una rama a
 * dos reglas que ya no se pueden planificar, y el compilador dejaría de avisar el
 * día que se añada una de verdad.
 */
type ComputedStreakRule =
  | "SHORT_MATCH_STREAK"
  | "REPEATED_OPPONENT_STREAK"
  | "REPEATED_TEAMMATE_STREAK";

/** Un sujeto y las posiciones de la secuencia en las que tiene el flag. */
type SubjectHits = {
  subject: AlertSubject;
  positions: number[];
};

/**
 * Flags de una regla de racha, ya resueltos sobre la secuencia.
 *
 * El umbral **no** vive aquí: viene del ruleset en `plannedRules()`, y meterlo en
 * las dos filas sería tener el número en dos sitios a los que no puede tocar la
 * validación del ruleset.
 */
type FlagRow = {
  rule: ComputedStreakRule;
  /** Sujetos con flag, por posición de la secuencia. */
  subjects: AlertSubject[][];
  /** Dato a destacar de la partida, para `details`. */
  details: (AlertAnchorDetail | undefined)[];
};

/** Un tramo con su remate y la partida que lo ancla. */
type ResolvedRun = {
  subject: AlertSubject;
  length: number;
  /** Última partida del tramo (la última con el flag). */
  endIndex: number;
  /**
   * Partida que ancla la alerta: la que **rompió** el tramo, o la última del tramo
   * si lo que lo cerró fue el fin del torneo (que es el único caso en el que no hay
   * partida que rompa nada).
   */
  anchorIndex: number;
};

/** Convierte las filas de flags en `{ sujeto, posiciones }`, en orden estable. */
function toSubjectHits(subjects: AlertSubject[][]): SubjectHits[] {
  const porClave = new Map<string, SubjectHits>();

  for (const [position, sujtos] of subjects.entries()) {
    for (const subject of sujtos) {
      const existing = porClave.get(subject.key);

      if (existing === undefined) {
        porClave.set(subject.key, { subject, positions: [position] });
      } else {
        existing.positions.push(position);
      }
    }
  }

  return [...porClave.values()];
}

/**
 * Agrupa por sujeto y devuelve sus rachas: tramos maximales de posiciones
 * **consecutivas**.
 *
 * Un mismo partido puede cerrar dos rachas a la vez (el compañero de un lado y
 * el del otro en un 2v2), y por eso se agrupa por sujeto en vez de recorrer la
 * secuencia una sola vez.
 */
function groupRuns(hits: SubjectHits[]): { subject: AlertSubject; from: number; to: number }[] {
  const runs: { subject: AlertSubject; from: number; to: number }[] = [];

  for (const { subject, positions } of hits) {
    let start = 0;

    for (let index = 1; index <= positions.length; index += 1) {
      const ultimo = index === positions.length;

      if (ultimo || positions[index] !== positions[index - 1] + 1) {
        runs.push({ subject, from: positions[start], to: positions[index - 1] });
        start = index;
      }
    }
  }

  return runs;
}

/**
 * Resuelve los tramos de una regla: los que han terminado avisan, y el que está
 * al final de la secuencia sigue abierto salvo que el torneo ya haya acabado.
 *
 * Que sea "el último de la secuencia" lo que decide es lo que evita el doble
 * aviso: un tramo que llega hasta el final y que además está cerrado porque el
 * torneo terminó se cuenta una sola vez, como cierre de torneo. Y es lo que hace
 * que un tramo que llega al final de la secuencia **no avise todavía**: avisa
 * cuando llegue la siguiente clasificatoria, que es justo lo que significa "la
 * racha se rompe".
 */
function resolveRuns(
  runs: { subject: AlertSubject; from: number; to: number }[],
  lastIndex: number,
  min: number,
  tournamentEnded: boolean,
): { closed: ResolvedRun[]; open: ResolvedRun[] } {
  const closed: ResolvedRun[] = [];
  const open: ResolvedRun[] = [];

  for (const run of runs) {
    const length = run.to - run.from + 1;

    if (length < min) {
      continue;
    }

    const esElUltimo = run.to === lastIndex;

    if (esElUltimo && !tournamentEnded) {
      open.push({ subject: run.subject, length, endIndex: run.to, anchorIndex: run.to });
      continue;
    }

    closed.push({
      subject: run.subject,
      length,
      endIndex: run.to,
      anchorIndex: esElUltimo ? run.to : run.to + 1,
    });
  }

  return { closed, open };
}

/** Los cruces de umbral de un acumulado, en el orden en que ocurren. */
function totalCrossings(
  hits: SubjectHits[],
  step: number | null,
  oneShot: number | null,
): { subject: AlertSubject; count: number; anchorIndex: number }[] {
  const crossings: { subject: AlertSubject; count: number; anchorIndex: number }[] = [];

  for (const { subject, positions } of hits) {
    // R3: un único aviso al llegar al umbral, y ni uno más aunque se llegue a
    // catorce. La clave de dedupe lleva el número, así que reevaluar no lo repite.
    if (oneShot !== null) {
      if (positions.length >= oneShot) {
        crossings.push({ subject, count: oneShot, anchorIndex: positions[oneShot - 1] });
      }

      continue;
    }

    if (step === null) {
      continue;
    }

    for (let count = 1; count <= positions.length; count += 1) {
      if (count % step === 0) {
        crossings.push({ subject, count, anchorIndex: positions[count - 1] });
      }
    }
  }

  return crossings;
}

/* -------------------------------------------------------------------------- */
/* Flags por regla                                                              */
/* -------------------------------------------------------------------------- */

type RuleContext = {
  player: AlertPlayer;
  matches: AlertMatch[];
  thresholds: AlertsRuleset["thresholds"];
  unreadable: number;
};

/** Fila vacía, para las partidas que la regla no mira. */
function emptyRow(rule: ComputedStreakRule, length: number): FlagRow {
  return {
    rule,
    subjects: Array.from({ length }, () => []),
    details: Array.from({ length }, () => undefined),
  };
}

/** R1: la partida dura menos que el umbral. Aplica a 1v1 y a equipos. */
function shortMatchFlags(context: RuleContext): FlagRow {
  const { matches, thresholds } = context;
  const row = emptyRow("SHORT_MATCH_STREAK", matches.length);

  for (const [index, match] of matches.entries()) {
    if (match.durationSeconds === null) {
      // Sin duración no se puede decir que sea corta, y una partida que no se
      // puede juzgar **no** tiene el flag: rompe la racha, que es lo honesto.
      continue;
    }

    row.details[index] = { durationSeconds: match.durationSeconds };

    if (match.durationSeconds < thresholds.shortMatchSeconds) {
      row.subjects[index] = [SELF_SUBJECT];
    }
  }

  return row;
}

/** R2: 1v1 contra un rival con `opponentProfileId`. El sujeto es el rival. */
function repeatedOpponentFlags(context: RuleContext): FlagRow {
  const { matches } = context;
  const row = emptyRow("REPEATED_OPPONENT_STREAK", matches.length);

  for (const [index, match] of matches.entries()) {
    // El filtro por `rm_solo` es lo que deja la regla fuera de las partidas de
    // equipo, donde `opponentProfileId` es solo el primer rival del otro equipo y
    // "tres veces contra el mismo" no significaría nada.
    if (match.mode !== SOLO_MODE || match.opponentProfileId === null) {
      continue;
    }

    row.subjects[index] = [
      {
        key: String(match.opponentProfileId),
        profileId: match.opponentProfileId,
        name: match.opponentName,
      },
    ];
  }

  return row;
}

/** R3: de equipo, por compañero. El sujeto es cada compañero con el que coincide. */
function repeatedTeammateFlags(context: RuleContext): FlagRow {
  const { matches, player } = context;
  const row = emptyRow("REPEATED_TEAMMATE_STREAK", matches.length);

  for (const [index, match] of matches.entries()) {
    if (match.mode !== TEAM_MODE) {
      continue;
    }

    const team = parseTeamView(match.rawJson, player.profileId);

    if (team === null) {
      context.unreadable += 1;
      continue;
    }

    // Un compañero sin `profile_id` no tiene identidad con la que contar, así que
    // no puede ser sujeto.
    row.subjects[index] = team.teammates
      .filter((mate) => mate.profileId !== null)
      .map((mate) => ({
        key: String(mate.profileId),
        profileId: mate.profileId,
        name: mate.name,
      }));
  }

  return row;
}

/* -------------------------------------------------------------------------- */
/* Evaluación                                                                  */
/* -------------------------------------------------------------------------- */

type TotalSpec = {
  rule: AlertsRuleName;
  /** Cada cuántas unidades se avisa (5, 10…). `null` si es un aviso único. */
  step: number | null;
  /** Umbral de un único aviso (R3). */
  oneShot: number | null;
};

type PlannedRule = {
  rule: ComputedStreakRule;
  min: number;
  total: TotalSpec | null;
};

/** Qué reglas se evalúan y con qué acumulado las acompaña. */
function plannedRules(ruleset: AlertsRuleset): PlannedRule[] {
  return [
    {
      rule: "SHORT_MATCH_STREAK",
      min: ruleset.thresholds.shortMatchStreak,
      total: {
        rule: "SHORT_MATCH_TOTAL",
        step: ruleset.thresholds.shortMatchTotalStep,
        oneShot: null,
      },
    },
    {
      rule: "REPEATED_OPPONENT_STREAK",
      min: ruleset.thresholds.repeatedOpponentStreak,
      total: {
        rule: "REPEATED_OPPONENT_TOTAL",
        step: ruleset.thresholds.repeatedOpponentTotalStep,
        oneShot: null,
      },
    },
    {
      rule: "REPEATED_TEAMMATE_STREAK",
      min: ruleset.thresholds.repeatedTeammateStreak,
      total: {
        rule: "REPEATED_TEAMMATE_TOTAL",
        step: null,
        oneShot: ruleset.thresholds.repeatedTeammateTotal,
      },
    },
  ];
}

/**
 * Alertas de un jugador sobre sus partidas clasificatorias.
 *
 * Determinista: las mismas entradas dan siempre las mismas alertas, y por eso
 * `compute.test.ts` puede comprobar cada regla con secuencias escritas a
 * mano. Lo único que depende del reloj es si una racha abierta se avisa por fin
 * de torneo, y para eso está `now`.
 */
export function computePlayerAlerts(input: ComputeAlertsInput): PlayerAlertsEvaluation {
  const { player, matches, ruleset, scoring, now } = input;
  const to = scoring.window.to;
  const tournamentEnded = to !== null && now.getTime() >= Date.parse(to);

  const context: RuleContext = {
    player,
    matches,
    thresholds: ruleset.thresholds,
    unreadable: 0,
  };

  const alerts: TriggeredAlert[] = [];
  const openStreaks: OpenStreak[] = [];
  const warnings: string[] = [];
  const globalWarnings: string[] = [];
  let closedAtTournamentEnd = 0;
  for (const plan of plannedRules(ruleset)) {
    const bits = ruleBits(plan.rule, context);
    const hits = toSubjectHits(bits.subjects);
    const lastIndex = matches.length - 1;
    const { closed, open } = resolveRuns(groupRuns(hits), lastIndex, plan.min, tournamentEnded);

    for (const run of closed) {
      // Solo hay cierre de torneo cuando el tramo llegaba al final de la
      // secuencia: si no, lo que lo cerró fue una partida posterior y el aviso es
      // una racha rota.
      const enCierre = run.endIndex === lastIndex;
      const anchor = matches[run.anchorIndex];
      const detail = bits.details[run.endIndex];

      if (enCierre) {
        closedAtTournamentEnd += 1;
      }

      alerts.push(
        buildTriggeredAlert({
          rule: plan.rule,
          kind: enCierre ? "STREAK_AT_TOURNAMENT_END" : "STREAK_CLOSED",
          playerId: player.id,
          playerProfileId: player.profileId,
          subject: run.subject,
          count: run.length,
          threshold: plan.min,
          anchorGameId: anchor?.gameId ?? null,
          anchorStartedAt: anchor?.startedAt ?? null,
          // La familia de ladder de la partida ancla: es un dato de la partida, no
          // de la regla, así que sale de la secuencia y no del flag.
          anchorLadder: anchor?.mode ?? null,
          window: scoring.window,
          ...(detail === undefined ? {} : { detail }),
        }),
      );
    }

    for (const run of open) {
      const anchor = matches[run.endIndex];

      openStreaks.push({
        playerId: player.id,
        playerProfileId: player.profileId,
        playerName: player.name,
        rule: plan.rule,
        subject: run.subject,
        count: run.length,
        threshold: plan.min,
        lastGameId: anchor?.gameId ?? "—",
        lastStartedAt: anchor?.startedAt.toISOString() ?? "—",
      });
    }

    if (plan.total === null) {
      continue;
    }

    for (const crossing of totalCrossings(hits, plan.total.step, plan.total.oneShot)) {
      const anchor = matches[crossing.anchorIndex];
      const detail = bits.details[crossing.anchorIndex];

      alerts.push(
        buildTriggeredAlert({
          rule: plan.total.rule,
          kind: "TOTAL_REACHED",
          playerId: player.id,
          playerProfileId: player.profileId,
          subject: crossing.subject,
          count: crossing.count,
          threshold: plan.total.oneShot ?? crossing.count,
          anchorGameId: anchor?.gameId ?? null,
          anchorStartedAt: anchor?.startedAt ?? null,
          anchorLadder: anchor?.mode ?? null,
          window: scoring.window,
          ...(detail === undefined ? {} : { detail }),
        }),
      );
    }
  }

  if (context.unreadable > 0) {
    warnings.push(
      `${context.unreadable} clasificatorias con rawJson ilegible no aportan flags a las reglas de equipo`,
    );
  }

  return {
    alerts,
    openStreaks,
    closedAtTournamentEnd,
    unreadableMatches: context.unreadable,
    warnings,
    globalWarnings,
  };
}

/** Calcula los flags de la regla indicada, ya sobre la secuencia completa. */
function ruleBits(rule: ComputedStreakRule, context: RuleContext): FlagRow {
  switch (rule) {
    case "SHORT_MATCH_STREAK":
      return shortMatchFlags(context);
    case "REPEATED_OPPONENT_STREAK":
      return repeatedOpponentFlags(context);
    case "REPEATED_TEAMMATE_STREAK":
      return repeatedTeammateFlags(context);
  }
}
