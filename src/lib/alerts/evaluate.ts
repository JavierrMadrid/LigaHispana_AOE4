import "server-only";

import { PlayerStatus } from "@/generated/prisma/enums";
import { db } from "@/lib/db";
import { readEditionConfig } from "@/lib/edition";
import { countsWithinWindow, rankedMatchWhere, teammatesWithinTier } from "@/lib/ranked-match";
import { readRuleset, type ScoringRuleset } from "@/lib/scoring";
import { computePlayerAlerts, type AlertMatch, type AlertPlayer, type OpenStreak } from "./compute";
import type { LadderCutoffsTable } from "./division-cutoffs";
import {
  buildTriggeredAlert,
  hasStreamChannel,
  SELF_SUBJECT,
  type AlertsRuleset,
  type TriggeredAlert,
} from "./rules";
import {
  ensureAlertsRuleset,
  readDivisionCutoffs,
  readTournamentCloseMark,
  writeTournamentCloseMark,
} from "./settings";

/**
 * Evaluación de las alertas contra la base de datos. **Idempotente**: se puede
 * ejecutar tantas veces como haga falta y el resultado es el mismo, porque lo
 * único que inserta son las alertas que no existían (`skipDuplicates` sobre
 * `Alert.dedupeKey`).
 *
 * ## Tres modos de trabajo
 *
 * | Quién llama | Qué evalúa |
 * |---|---|
 * | el sincronizador, tras `recomputeScores()` | **solo los jugadores tocados** en la pasada, y solo si alguna de sus partidas ha cambiado |
 * | el panel, al revertir o restaurar una partida | ese jugador, porque su conjunto de clasificatorias ha cambiado |
 * | `npm run alerts:check` y el cierre de torneo | todos los aprobados |
 *
 * El coste de evaluar a un jugador es leer sus clasificatorias y pasarlas por un
 * módulo puro: con unos 30 jugadores y 1 500 partidas, de milisegundos. En la
 * pasada del sincronizador se limita a los tocados, y no porque la evaluación
 * entera sea cara sino porque no hace falta repetirla 288 veces al día para
 * obtener el mismo resultado.
 *
 * ## Qué NO hace
 *
 * **No sale a la red.** Todo sale de `Match` y de su `rawJson`, con la única
 * excepción de los cortes de división, que no se derivan aquí sino que se leen de
 * `Setting` (ver `derive-cutoffs.ts`): derivarlos son del orden de 130 llamadas
 * por familia de ladder, y esto corre cada 10 minutos. Esos cortes no son para
 * ninguna regla de alertas, sino para el **filtro**: el motor de alertas solo
 * puede mirar las partidas que puntúan, y la condición de equipos de
 * `ranked-match.ts` es parte de lo que decide eso. Sin cortes, las partidas de
 * equipo cuentan (como en el motor de puntos) y la evaluación sigue.
 *
 * ## La única regla que no mira partidas
 *
 * `NO_STREAM_CHANNEL` (un aprobado sin ningún canal de directo) se decide con las
 * columnas de canal de `Player` y solo si la edición exige retransmisión
 * (`Setting["edition.config"]`). Va aquí y no en el worker del sincronizador —donde
 * viven las otras reglas de estado, ver `src/lib/history-checks.ts`— porque este
 * motor ya lee a todos los aprobados en cada pasada y la condición es una columna
 * que ya tiene delante; lo que la hace distinta es que solo se evalúa cuando la
 * edición la pide.
 */

export type EvaluateAlertsOptions = {
  /** Limita la evaluación a estos `profileId`. Por defecto, todos los aprobados. */
  profileIds?: number[];
  /**
   * Fuerza la evaluación de **todos** los aprobados aunque la pasada del
   * sincronizador solo haya tocado unos pocos. Es lo que usa el panel y el cierre
   * de torneo.
   */
  full?: boolean;
  /** "Ahora" de la evaluación; se pasa para que el cierre sea reproducible. */
  now?: Date;
};

export type EvaluateAlertsResult = {
  /** Alcance de esta evaluación. */
  scope: "jugadores" | "completa";
  playersEvaluated: number;
  /** Clasificatorias leídas de `Match`. */
  matchesRead: number;
  /** Alertas que ha disparado esta evaluación, antes de deduplicar. */
  alertsTriggered: number;
  /** Filas nuevas de `Alert`: lo que no existía, que es lo que importa. */
  alertsCreated: number;
  /** Rachas abiertas que todavía no avisan de nada. */
  openStreaks: OpenStreak[];
  /** Cuántas de esas rachas se han avisado por fin de torneo. */
  closedAtTournamentEnd: number;
  /** Clasificatorias con `rawJson` ilegible para las reglas de equipo. */
  unreadableMatches: number;
  warnings: string[];
  globalWarnings: string[];
  alertsRulesetVersion: number;
  /**
   * Ladders de las que hay cortes cacheados. Son los que usa el filtro de la
   * condición de equipos, así que sin cortes de una familia sus partidas se miran
   * como las cuenta el motor de puntos: cuentan.
   */
  cutoffsLadders: string[];
  /** `true` si esta evaluación ha sido la del cierre de torneo. */
  tournamentClose: boolean;
  durationMs: number;
};

type EvaluationContext = {
  alertsRuleset: AlertsRuleset;
  scoring: ScoringRuleset;
  cutoffs: LadderCutoffsTable | null;
  /**
   * ¿La edición declara la retransmisión obligatoria?
   *
   * Es lo que decide si se evalúa `NO_STREAM_CHANNEL`. Se lee **una vez** por pasada
   * y no por jugador: es configuración, no un dato del torneo.
   */
  streamingRequired: boolean;
  now: Date;
};

type PlayerPass = {
  playersEvaluated: number;
  matchesRead: number;
  triggered: TriggeredAlert[];
  created: number;
  openStreaks: OpenStreak[];
  closedAtTournamentEnd: number;
  unreadableMatches: number;
  warnings: string[];
  globalWarnings: string[];
};

/** Fila de `Match` tal y como la necesita el motor puro. */
type MatchRow = {
  playerId: string;
  gameId: string;
  mode: string | null;
  opponentProfileId: number | null;
  opponentName: string | null;
  startedAt: Date;
  durationSeconds: number | null;
  rawJson: unknown;
};

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : `Error desconocido: ${String(error)}`;
}

/**
 * Evalúa a estos jugadores y **escribe solo lo que no estaba**.
 *
 * La escritura es un `createMany` con `skipDuplicates`: por eso no hace falta leer
 * antes las alertas existentes para saber cuáles son nuevas, y por eso dos
 * evaluaciones seguidas (el cron, el panel y el cierre a la vez) no pueden
 * duplicar nada.
 */
async function evaluatePlayers(
  profileIds: number[] | undefined,
  context: EvaluationContext,
): Promise<PlayerPass> {
  const pass: PlayerPass = {
    playersEvaluated: 0,
    matchesRead: 0,
    triggered: [],
    created: 0,
    openStreaks: [],
    closedAtTournamentEnd: 0,
    unreadableMatches: 0,
    warnings: [],
    globalWarnings: [],
  };

  const players = await db.player.findMany({
    where: {
      // Solo los aprobados: una solicitud pendiente no es un participante del
      // torneo, y sus partidas no pueden levantar una alerta de comportamiento.
      status: PlayerStatus.APPROVED,
      ...(profileIds === undefined ? {} : { profileId: { in: profileIds } }),
    },
    // `registeredAt` viene aquí y no en la consulta de partidas porque el corte de
    // inscripción no se puede escribir en un `where` de Prisma que abarca a todos los
    // jugadores (ver `ranked-match.ts`): se aplica por jugador, en memoria.
    //
    // Las cuatro columnas de canal entran por `NO_STREAM_CHANNEL`, que es la única
    // regla que se decide con una columna de `Player` en este motor.
    select: {
      id: true,
      profileId: true,
      name: true,
      registeredAt: true,
      twitchChannel: true,
      youtubeChannel: true,
      kickChannel: true,
      twitchUrl: true,
    },
    orderBy: { profileId: "asc" },
  });

  if (players.length === 0) {
    return pass;
  }

  const registeredAtPorJugador = new Map(players.map((row) => [row.id, row.registeredAt]));
  const profileIdPorJugador = new Map(players.map((row) => [row.id, row.profileId]));

  // **El filtro de clasificatorias sale de `rankedMatchWhere()`**, o sea de la única
  // definición que hay: familia del ruleset de puntos, partida resuelta, dentro de
  // la ventana y no revertida. El motor de alertas no vuelve a decidir qué cuenta,
  // y por eso no puede discrepar del motor de puntos.
  //
  // **El corte de inscripción no cabe en ese `where` y va justo después**, y por eso
  // el `null` de abajo es explícito: un `where` de Prisma que abarca a todos los
  // jugadores no puede compararlo (ver el docblock de `ranked-match.ts`). Lo que
  // decide es `countsWithinWindow()` con el `registeredAt` de cada uno —la misma
  // comparación en memoria—, así que una alerta no puede acusar a nadie de una
  // partida que tampoco puntúa.
  //
  // **Y la condición de equipos tampoco cabe** en un `where` de Prisma (necesita
  // `rawJson` y los cortes), así que se aplica aquí, con la **misma** función que
  // aplica el motor de puntos (`teammatesWithinTier()`): el motor de alertas tiene
  // que ver exactamente las partidas que puntúan, ni una más ni una menos. Sin
  // cortes cacheados la partida cuenta, que es lo que hace también el motor.
  const rows: MatchRow[] = await db.match.findMany({
    where: {
      playerId: { in: players.map((player) => player.id) },
      ...rankedMatchWhere(context.scoring.modes, context.scoring.window, null),
    },
    select: {
      playerId: true,
      gameId: true,
      mode: true,
      opponentProfileId: true,
      opponentName: true,
      startedAt: true,
      durationSeconds: true,
      rawJson: true,
    },
    // El desempate por `gameId` es lo que hace determinista la secuencia: dos
    // jugadores de la liga que juegan la misma partida tienen el mismo
    // `startedAt`, y sin ese desempate el orden dentro del empate dependería del
    // planificador, con lo que un tramo podría salir distinto en cada pasada.
    orderBy: [{ startedAt: "asc" }, { gameId: "asc" }],
  });

  const clasificatorias = rows.filter((row) => {
    if (
      !countsWithinWindow(
        row.startedAt,
        context.scoring.window,
        registeredAtPorJugador.get(row.playerId) ?? null,
      )
    ) {
      return false;
    }

    const profileId = profileIdPorJugador.get(row.playerId);

    // Las filas y el mapa salen de la misma lista de jugadores, así que siempre hay
    // entrada; sin ella la partida contaría, que es la degradación de siempre.
    return (
      profileId === undefined ||
      teammatesWithinTier(row.rawJson, row.mode, {
        profileId,
        cutoffs: context.cutoffs,
      })
    );
  });

  pass.matchesRead = clasificatorias.length;

  const porJugador = new Map<string, AlertMatch[]>();

  for (const row of clasificatorias) {
    const match: AlertMatch = {
      gameId: row.gameId,
      mode: row.mode,
      opponentProfileId: row.opponentProfileId,
      opponentName: row.opponentName,
      startedAt: row.startedAt,
      durationSeconds: row.durationSeconds,
      rawJson: row.rawJson,
    };

    const lista = porJugador.get(row.playerId);

    if (lista === undefined) {
      porJugador.set(row.playerId, [match]);
    } else {
      lista.push(match);
    }
  }

  for (const row of players) {
    const player: AlertPlayer = {
      id: row.id,
      profileId: row.profileId,
      name: row.name,
    };

    const evaluation = computePlayerAlerts({
      player,
      matches: porJugador.get(row.id) ?? [],
      ruleset: context.alertsRuleset,
      scoring: { modes: context.scoring.modes, window: context.scoring.window },
      now: context.now,
    });

    pass.playersEvaluated += 1;
    pass.triggered.push(...evaluation.alerts);
    pass.openStreaks.push(...evaluation.openStreaks);
    pass.closedAtTournamentEnd += evaluation.closedAtTournamentEnd;
    pass.unreadableMatches += evaluation.unreadableMatches;
    pass.warnings.push(...evaluation.warnings.map((warning) => `${row.name}: ${warning}`));
    pass.globalWarnings.push(...evaluation.globalWarnings);

    // La regla **condicional** de la edición: un aprobado sin ningún canal de directo.
    // Se decide aquí y no en `computePlayerAlerts()` porque no mira partidas, sino
    // columnas de la ficha que este bucle ya tiene delante, y solo cuando la edición
    // declara la retransmisión obligatoria.
    //
    // `count: 0` y `threshold: 1` es "cero canales de los uno que se pide", la misma
    // forma que usa `HISTORY_NOT_PUBLIC` (partidas sondeadas sin summary frente a las
    // exigidas). Sin ancla **ni ventana**, como `DISCORD_NOT_IN_GUILD`: no hay partida
    // que lo sostenga ni un periodo en el que se haya comprobado, y escribir la ventana
    // del torneo afirmaría un alcance que la comprobación no tiene.
    if (context.streamingRequired && !hasStreamChannel(row)) {
      pass.triggered.push(
        buildTriggeredAlert({
          rule: "NO_STREAM_CHANNEL",
          kind: "STATE_DETECTED",
          playerId: row.id,
          playerProfileId: row.profileId,
          subject: SELF_SUBJECT,
          count: 0,
          threshold: 1,
          anchorGameId: null,
          anchorStartedAt: null,
        }),
      );
    }
  }

  if (pass.triggered.length > 0) {
    const written = await db.alert.createMany({
      data: pass.triggered.map((alert) => ({
        rule: alert.rule,
        kind: alert.kind,
        playerId: alert.playerId,
        subjectProfileId: alert.subjectProfileId,
        subjectName: alert.subjectName,
        count: alert.count,
        threshold: alert.threshold,
        anchorGameId: alert.anchorGameId,
        dedupeKey: alert.dedupeKey,
        summary: alert.summary,
        details: alert.details,
      })),
      // La idempotencia entera sale de aquí: `dedupeKey` es único y una fila que ya
      // está simplemente no se inserta, sin necesidad de leer antes cuáles hay.
      skipDuplicates: true,
    });

    pass.created = written.count;
  }

  return pass;
}

/**
 * Evalúa las alertas y deja solo lo nuevo.
 *
 * Un `rawJson` ilegible no propaga: degrada esa partida y sale en el resumen. Lo
 * que sí propaga es un fallo de la base de datos, que es lo que decide si el
 * sincronizador lo registra y sigue o si de verdad no pudo hacer su trabajo.
 */
export async function evaluateAlerts(
  options: EvaluateAlertsOptions = {},
): Promise<EvaluateAlertsResult> {
  const startedAtMs = Date.now();
  const now = options.now ?? new Date();

  // El ruleset de alertas se publica aquí (una sola vez) y el de puntuación se lee:
  // de este salen los `modes` y la `window` que definen qué es clasificatoria. Los
  // dos, y la configuración de la edición (que decide si se evalúa
  // `NO_STREAM_CHANNEL`), se leen fuera de cualquier transacción porque son
  // configuración, no datos del torneo, y su publicación no debe quedarse esperando al
  // resto. Las cuatro lecturas son independientes entre sí, así que van en paralelo:
  // son cuatro viajes a `Setting` y no hay razón para encadenarlos.
  const [alertsRuleset, scoring, edition, cutoffs] = await Promise.all([
    ensureAlertsRuleset(),
    readRuleset(),
    readEditionConfig(),
    readDivisionCutoffs(),
  ]);
  const { window } = scoring;
  const to = window.to;
  const tournamentEnded = to !== null && now.getTime() >= Date.parse(to);

  const context: EvaluationContext = {
    alertsRuleset,
    scoring,
    cutoffs,
    streamingRequired: edition.streamingRequired,
    now,
  };

  // **Cierre de torneo**: una única evaluación completa cuando la ventana ya ha
  // terminado, y se vuelve a hacer si la ventana cambia (por eso la marca guarda
  // la ventana y no solo una fecha). La marca va en `Setting`, así que el cron no
  // repite la pasada entera cada 10 minutos a partir del `to`.
  const mark = tournamentEnded ? await readTournamentCloseMark() : null;
  const closePending =
    tournamentEnded &&
    (mark === null || mark.windowFrom !== window.from || mark.windowTo !== window.to);

  const full = options.full === true || closePending;
  const profileIds = full ? undefined : options.profileIds;
  const pass = await evaluatePlayers(profileIds, context);

  if (closePending) {
    await writeTournamentCloseMark({
      windowFrom: window.from,
      windowTo: window.to,
      evaluatedAt: now.toISOString(),
      alertsCreated: pass.created,
      playersEvaluated: pass.playersEvaluated,
    });

    console.info(
      `[alerts] Cierre de torneo evaluado: ${pass.playersEvaluated} jugadores, ` +
        `${pass.created} alertas nuevas, ${pass.closedAtTournamentEnd} rachas cerradas por el cierre.`,
    );
  }

  // Los avisos de la evaluación entera son los mismos para todos los jugadores
  // (o no hay cortes para ninguno), así que se registran una vez: treinta líneas
  // iguales no informan de nada. Los de cada jugador sí llevan su nombre.
  for (const warning of new Set([...pass.globalWarnings, ...pass.warnings])) {
    console.warn(`[alerts] ${warning}`);
  }

  return {
    scope: full ? "completa" : "jugadores",
    playersEvaluated: pass.playersEvaluated,
    matchesRead: pass.matchesRead,
    alertsTriggered: pass.triggered.length,
    alertsCreated: pass.created,
    openStreaks: pass.openStreaks,
    closedAtTournamentEnd: pass.closedAtTournamentEnd,
    unreadableMatches: pass.unreadableMatches,
    warnings: pass.warnings,
    globalWarnings: pass.globalWarnings,
    alertsRulesetVersion: alertsRuleset.version,
    cutoffsLadders: cutoffs === null ? [] : Object.keys(cutoffs).sort(),
    tournamentClose: closePending,
    durationMs: Date.now() - startedAtMs,
  };
}

/**
 * Reevalúa a un jugador porque **su conjunto de clasificatorias ha cambiado** sin
 * que haya pasado por el sincronizador.
 *
 * Es el caso de revertir o restaurar una partida: la fila no se toca, lo que
 * cambia es si cuenta o no, y eso mueve rachas y acumulados por las dos
 * direcciones. Sin esta llamada, el panel dejaría alertas que ya no se sostienen
 * (y de paso, ninguna de las que sí) hasta la siguiente pasada.
 *
 * **Nunca lanza.** El cambio de la partida ya está escrito y es reversible desde el
 * propio panel, así que un fallo de la base al evaluar alertas no puede convertirse
 * en un "no se ha aplicado nada" que no es cierto. Se registra y ya.
 */
export async function reevaluatePlayerAlerts(playerId: string): Promise<void> {
  try {
    const player = await db.player.findUnique({
      where: { id: playerId },
      select: { profileId: true },
    });

    if (player === null) {
      return;
    }

    const result = await evaluateAlerts({ profileIds: [player.profileId] });

    console.info(
      `[alerts] Reevaluado el jugador ${player.profileId}: ${result.alertsCreated} alertas nuevas.`,
    );
  } catch (error) {
    console.error(
      `[alerts] No se han podido reevaluar las alertas del jugador ${playerId}: ` +
        toErrorMessage(error),
    );
  }
}
