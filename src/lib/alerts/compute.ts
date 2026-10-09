import { subdivisionForRating } from "@/lib/alerts/division-cutoffs";
import type { LadderCutoffsTable } from "@/lib/alerts/division-cutoffs";
import { parseGame } from "@/lib/aoe4world/parse";
import type { Aoe4WorldGamePlayer } from "@/lib/aoe4world/types";
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
 * ## El modelo, que es el mismo para las ocho reglas
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
 * filtrada con `rankedMatchWhere()`.
 *
 * ## Las ocho reglas
 *
 * | Regla | Modo | Flag por partida | Racha | Acumulado |
 * |---|---|---|---|---|
 * | R1 `SHORT_MATCH_*` | 1v1 y equipos | `durationSeconds < shortMatchSeconds` | 2 | cada 5 |
 * | R2 `REPEATED_OPPONENT_*` | solo `rm_solo` | la partida tiene rival con `opponentProfileId` | 3 con el mismo rival | cada 10 con el mismo rival |
 * | R3 `REPEATED_TEAMMATE_*` | solo `rm_team` | el mismo compañero está en mi equipo | 3 con ese compañero | 7 con ese compañero, una vez |
 * | R4 `TEAMMATE_ELO_GAP` | solo `rm_team` | algún compañero está a `teammateEloGap` de elo o más | 1 | — |
 * | R5 `LOW_DIVISION_TEAM_GAME` | solo `rm_team` | la división de la partida difiere `lowDivisionSteps` escalones o más (en cualquiera de los dos sentidos) de la del jugador en esa misma partida | 1 | — |
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
 * evaluarse no puede acusar a nadie. R5 se omite (sin aviso) en las partidas en
 * las que falte el rating del jugador o la media de rating de la partida, y las
 * partidas cuya
 * familia de ladder no tiene cortes cacheados se saltan sin más.
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
 * escribió la API, y lo que el motor necesita de él (los compañeros, el elo de
 * cada uno, la media de la partida) se vuelve a validar con `parseGame()` en
 * cada evaluación en vez de fiarse de que esté intacto.
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
   * **Solo clasificatorias**, ya filtradas con `rankedMatchWhere()` y ordenadas
   * por `startedAt`. Quien llama decide el filtro, y así las ocho reglas
   * comparten la única definición de "clasificatoria" que hay en el proyecto.
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
  /** Cortes rating → subdivisión por familia de ladder, o `null` si no hay ninguno cacheados. */
  cutoffs: LadderCutoffsTable | null;
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
   * Lo que **a toda la evaluación** no se le ha podido mirar (por ahora, que no
   * hay cortes de división). No lleva nombre de jugador porque no es culpa de
   * ninguno, y repetirlo treinta veces en el log no informa de nada.
   */
  globalWarnings: string[];
};

/* -------------------------------------------------------------------------- */
/* Lectura del payload de la partida                                            */
/* -------------------------------------------------------------------------- */

type TeamView = {
  /** El jugador de esta fila, con su elo en esa partida. */
  self: Aoe4WorldGamePlayer | null;
  /** Los que estaban en su mismo equipo, él excluido. */
  teammates: Aoe4WorldGamePlayer[];
  /**
   * Media de **rating** de la partida (`average_rating`), tal y como la publica
   * el payload. Es la escala de la ladder, la misma que el `rating` del jugador;
   * la media de `mmr` es otra y no se usa.
   */
  averageRating: number | null;
};

/**
 * Localiza al jugador dentro de `rawJson.teams` y devuelve su equipo.
 *
 * Pasa por `parseGame()` y no por una lectura propia de `rawJson`, y el motivo
 * es que ese lector **ya existe** y ya acepta las dos formas en que la API
 * manda los equipos (anidada en el listado, plana en el detalle) y ya valida la
 * forma de cada jugador. Reimplementarlo aquí sería una tercera copia de un
 * lector que ya se rompe de una manera conocida.
 *
 * Devuelve `null` cuando el payload no se puede leer, y eso es un resultado
 * normal: la partida no aporta flags a las reglas de equipo.
 */
function readTeamView(rawJson: unknown, profileId: number): TeamView | null {
  const game = parseGame(rawJson);

  if (game === null) {
    return null;
  }

  for (const team of game.teams) {
    const index = team.findIndex((player) => player.profileId === profileId);

    if (index === -1) {
      continue;
    }

    return {
      self: team[index] ?? null,
      teammates: team.filter((_, position) => position !== index),
      averageRating: game.averageRating,
    };
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/* Tramos y acumulados                                                          */
/* -------------------------------------------------------------------------- */

const TEAM_MODE = "rm_team";
const SOLO_MODE = "rm_solo";

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
  rule: StreakAlertRule;
  /** Sujetos con flag, por posición de la secuencia. */
  subjects: AlertSubject[][];
  /** Dato a destacar de la partida, para `details`. */
  details: (AlertAnchorDetail | undefined)[];
  /** Familia de ladder de la partida (`Match.mode`), para las reglas que la necesitan (R5). */
  ladders: (string | undefined)[];
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
 * torneo terminó se cuenta una sola vez, como cierre de torneo. Y es también lo que
 * hace que una regla de umbral 1 (R4, R5) **no avise todavía**: su única partida
 * con el flag es el último tramo de la secuencia, así que está abierta. Avisa
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
  cutoffs: LadderCutoffsTable | null;
  unreadable: number;
};

/** Fila vacía, para las partidas que la regla no mira. */
function emptyRow(rule: StreakAlertRule, length: number): FlagRow {
  return {
    rule,
    subjects: Array.from({ length }, () => []),
    details: Array.from({ length }, () => undefined),
    ladders: Array.from({ length }, () => undefined),
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

    const team = readTeamView(match.rawJson, player.profileId);

    if (team === null) {
      context.unreadable += 1;
      continue;
    }

    // Un compañero sin `profile_id` no tiene identidad con la que contar, así que
    // no puede ser sujeto: se pierde para R3, pero sigue contando para R4 (allí
    // solo importa su elo).
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

/** R4: de equipo, algún compañero a `teammateEloGap` de elo o más. */
function teammateEloGapFlags(context: RuleContext): FlagRow {
  const { matches, player, thresholds } = context;
  const row = emptyRow("TEAMMATE_ELO_GAP", matches.length);

  for (const [index, match] of matches.entries()) {
    if (match.mode !== TEAM_MODE) {
      continue;
    }

    const team = readTeamView(match.rawJson, player.profileId);

    if (team === null) {
      context.unreadable += 1;
      continue;
    }

    const ratingPropio = team.self?.rating ?? null;

    // Sin rating propio no hay contra qué comparar, y sin rating del compañero
    // no hay diferencia. En los dos casos la partida no aporta flag, que es
    // distinto de que la diferencia resultara pequeña.
    const brecha =
      ratingPropio === null
        ? null
        : team.teammates.reduce<number | null>((mayor, mate) => {
            if (mate.rating === null) {
              return mayor;
            }

            const diferencia = Math.abs(mate.rating - ratingPropio);

            return mayor === null || diferencia > mayor ? diferencia : mayor;
          }, null);

    if (brecha === null) {
      continue;
    }

    row.details[index] = { eloGap: brecha };

    if (brecha >= thresholds.teammateEloGap) {
      row.subjects[index] = [SELF_SUBJECT];
    }
  }

  return row;
}

/**
 * R5: de equipo, la división de la partida y la del jugador (en esa misma
 * partida) distan `lowDivisionSteps` escalones o más, en cualquiera de los dos
 * sentidos.
 *
 * ## Las dos magnitudes son de la misma escala: **rating**, no `mmr`
 *
 * El lado del jugador es `team.self.rating` y el de la partida es
 * `average_rating`, la media de **rating** de la partida. Los cortes de división
 * se derivan del campo `rating` de la ladder (`derive-cutoffs.ts`) y el
 * `rank_level` que publica la API sale de ese mismo rating, así que
 * rating ↔ rating es la única comparación que se traduce bien con los mismos
 * cortes.
 *
 * **No se usa `average_mmr`**. El `mmr` es la escala interna del MMR de la
 * partida (~1200 en adelante) y el `rating` la de la ladder (~700-900 en la zona
 * baja): son dos escalas distintas y traducir el `mmr` con los cortes de rating
 * sitúa la media de `mmr` uno o más escalones por encima de donde está de
 * verdad. Ese desajuste produjo alertas falsas: una partida de media de rating
 * 851 jugada por un jugador de 727 (dos escalones, por debajo del umbral) salía
 * como si la partida estuviera muy por encima de él al compararla con su
 * `average_mmr` de 1254.
 *
 * La referencia es el **rating del jugador en esa misma partida de equipo**, no
 * su división 1v1: las dos magnitudes son rating de la misma familia de ladder,
 * así que se traducen con los **mismos** cortes y la comparación de escalones es
 * homogénea.
 */
function lowDivisionFlags(context: RuleContext): FlagRow {
  const { matches, player, cutoffs, thresholds } = context;
  const row = emptyRow("LOW_DIVISION_TEAM_GAME", matches.length);

  for (const [index, match] of matches.entries()) {
    if (match.mode !== TEAM_MODE || cutoffs === null) {
      continue;
    }

    const team = readTeamView(match.rawJson, player.profileId);

    if (team === null) {
      context.unreadable += 1;
      continue;
    }

    const propia = team.self?.rating ?? null;
    const media = team.averageRating;

    // Sin el rating del jugador o sin la media de rating de la partida no hay
    // contra qué comparar, y la partida se omite sin avisar: es un hueco de
    // datos, no un comportamiento.
    if (propia === null || media === null) {
      continue;
    }

    // Los cortes se buscan por la **familia** resuelta (`match.mode`, que aquí ya
    // es `rm_team`), no por el literal `match.leaderboard`: un ranked por equipos
    // puede venir con `leaderboard: "rm_2v2"`/`"rm_3v3"`/`"rm_4v4"` y los cortes
    // se guardan por familia, así que indexar por el literal se saltaría la
    // partida aunque sus cortes estén cacheados.
    const ladder = cutoffs[match.mode];

    if (ladder === undefined) {
      continue;
    }

    const subdivisionPropia = subdivisionForRating(ladder, propia);
    const subdivisionPartida = subdivisionForRating(ladder, media);

    if (subdivisionPropia === null || subdivisionPartida === null) {
      continue;
    }

    // `steps` va de la subdivisión del jugador a la de la partida, y el índice
    // **crece al bajar**: el escalón 0 es `conqueror_3`. Positivo es que la
    // partida está por debajo, negativo que está por encima; el flag sale con el
    // valor absoluto, porque la regla vigila las dos direcciones.
    const steps = subdivisionPartida.index - subdivisionPropia.index;

    if (Math.abs(steps) < thresholds.lowDivisionSteps) {
      continue;
    }

    row.subjects[index] = [SELF_SUBJECT];
    row.ladders[index] = match.mode;
    row.details[index] = {
      steps,
      averageRating: media,
      selfRating: propia,
      gameSubdivision: subdivisionPartida.rankLevel,
      playerSubdivision: subdivisionPropia.rankLevel,
    };
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
  rule: StreakAlertRule;
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
    { rule: "TEAMMATE_ELO_GAP", min: 1, total: null },
    { rule: "LOW_DIVISION_TEAM_GAME", min: 1, total: null },
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
  const { player, matches, ruleset, scoring, cutoffs, now } = input;
  const to = scoring.window.to;
  const tournamentEnded = to !== null && now.getTime() >= Date.parse(to);

  const context: RuleContext = {
    player,
    matches,
    thresholds: ruleset.thresholds,
    cutoffs,
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
          anchorLadder: bits.ladders[run.endIndex] ?? null,
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
          anchorLadder: bits.ladders[crossing.anchorIndex] ?? null,
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

  if (cutoffs === null) {
    // Aviso de la evaluación, no del jugador: lo dice aunque no haya ninguna
    // partida de equipo, porque quien lee el resumen tiene que saber que hay una
    // regla sin evaluar en vez de deducirlo de que no salió.
    globalWarnings.push(
      "R5 omitida: no hay cortes de división cacheados (derívalos con `npm run alerts:cutoffs`)",
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
function ruleBits(rule: StreakAlertRule, context: RuleContext): FlagRow {
  switch (rule) {
    case "SHORT_MATCH_STREAK":
      return shortMatchFlags(context);
    case "REPEATED_OPPONENT_STREAK":
      return repeatedOpponentFlags(context);
    case "REPEATED_TEAMMATE_STREAK":
      return repeatedTeammateFlags(context);
    case "TEAMMATE_ELO_GAP":
      return teammateEloGapFlags(context);
    case "LOW_DIVISION_TEAM_GAME":
      return lowDivisionFlags(context);
  }
}
