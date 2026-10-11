import "server-only";

import { Prisma } from "@/generated/prisma/client";
import { AlertKind, AlertRule, PlayerStatus } from "@/generated/prisma/enums";
import { buildTriggeredAlert, SELF_SUBJECT, type TriggeredAlert } from "@/lib/alerts";
import { getAoe4WorldConfig, type Aoe4WorldConfig } from "@/lib/aoe4world/env";
import { DEFAULT_LEADERBOARD } from "@/lib/aoe4world/types";
import { db } from "@/lib/db";
import {
  HISTORY_PROBE_GAMES,
  LADDER_PUBLICATION_LAG_MINUTES,
  MISSING_MATCHES_MIN_GAMES,
  historyCheckIsDue,
  historyProbeCandidates,
  ladderGapVerdict,
  planHistoryCheck,
  probeHistoryVisibility,
  type HistoryProbeMatch,
} from "@/lib/history-visibility";
import { windowBounds, type ScoringWindow } from "@/lib/ranked-match";
import { readRuleset, type ScoringRuleset } from "@/lib/scoring";

/**
 * Las dos reglas de la transparencia del historial, desde el worker.
 *
 * ## Qué es este módulo y por qué vive aquí y no en el motor de alertas
 *
 * El motor de alertas (`src/lib/alerts/compute.ts`) es **puro** y se comprueba con
 * secuencias sintéticas. Estas dos reglas no encajan ahí:
 *
 * - `HISTORY_NOT_PUBLIC` necesita **salir a la red**: un `HEAD` a una ruta del sitio de
 *   AoE4World que no es la API, que es la única forma de saber si el historial de un
 *   jugador es público (`src/lib/history-visibility.ts`).
 * - Las dos leen **columnas de `Player`** (`ladderGamesCount`, `ladderLastGameAt`,
 *   `historyCheckedAt`), no `Match`.
 *
 * Así que quien las llama es el sincronizador, que ya sale a la red una vez por pasada.
 * Lo que sí vive en el dominio de alertas es el **valor del enum y la frase**, en
 * `src/lib/alerts/rules.ts`: `Alert.summary` se pinta tal cual y el `switch` de frases
 * es exhaustivo para que una regla sin frase no pueda llegar a la base.
 *
 * ## Las dos reglas
 *
 * | Regla | Qué mira | De dónde sale |
 * |---|---|---|
 * | `HISTORY_NOT_PUBLIC` | si el toggle "Share History" del jugador es público | `HEAD` al sitio, tres partidas como mucho |
 * | `MISSING_LADDER_MATCHES` | si la ladder registra una partida que no nos ha llegado | columnas de `Player` y nuestra `rm_solo` más reciente |
 *
 * ## Por qué la segunda, cuando la primera ya cubre el caso
 *
 * Porque la primera tiene un agujero exacto: solo puede mirar partidas que ya
 * tenemos. Si alguien cerrara su historial **y** sus partidas dejaran de aparecer en la
 * API, no habría ningún `gameId` que sondear y no se comprobaría nada. La segunda mira
 * el otro lado —lo que AoE4World **sí** publica de ese jugador, su fila de la ladder— y
 * lo compara con lo que nosotros tenemos.
 *
 * ## La fila de alerta se escribe junto a las columnas, y por qué
 *
 * En el mismo sitio, a propósito. La corrección de un estado **es** una columna: el
 * jugador abre el historial y se ve en `Player.historyPublic` sin recalcular nada.
 * `Alert` es *append-only* como todas las alertas (nadie edita filas), así que la fila
 * dice "esto se comprobó y era así" y el estado de ahora se lee de `Player`. Escribirlas
 * en sitios distintos obligaría a cruzar dos tablas para responder "¿esto sigue
 * pasando?", que es la pregunta de la organización cuando ve un aviso.
 *
 * ## Idempotencia
 *
 * Las dos se reevalúan en cada pasada (la del historial, con su caché de 12 h) y
 * escriben con `createMany({ skipDuplicates: true })` sobre `Alert.dedupeKey`. Para las
 * reglas de estado la clave **no lleva partida ni número** (ver `alertDedupeKey()`): una
 * alerta por jugador y por hecho, insertada la primera vez.
 *
 * ## Lo que falla aquí no tumba la pasada
 *
 * Un `unknown` del sondeo no escribe ni columnas ni alerta: no se ha podido comprobar, y
 * publicar "cerrado" por un corte de red sería una acusación que no se sabe. Un fallo de
 * la base va al aviso de la pasada y se sigue, como en el resto del sincronizador.
 */

/** Una fila de `Player` tal y como la necesitan las dos reglas. */
type CheckPlayerRow = {
  id: string;
  profileId: number;
  name: string;
  /** `games_count` de la ladder: cuántas partidas lleva en la temporada. */
  ladderGamesCount: number | null;
  /** `last_game_at` de la ladder. */
  ladderLastGameAt: Date | null;
  /** Cuándo se comprobó el historial por última vez; `null` = nunca. */
  historyCheckedAt: Date | null;
};

/** Cómo terminó la comprobación del historial de un jugador. */
export type HistoryVerdictName = "public" | "closed" | "unknown";

export type HistoryChecksResult = {
  /** Participantes aprobados leídos. */
  players: number;
  /** A quién le vencía la caché de 12 h. */
  dueForCheck: number;
  /** Comprobaciones hechas de verdad (una por jugador, con hasta tres `HEAD`). */
  checked: number;
  /** Veredictos: historial público, cerrado y sin respuesta. */
  verdicts: Record<HistoryVerdictName, number>;
  /** Filas de `Player` escritas por la regla del historial. */
  playersUpdated: number;
  /** Cuántos quedaron sin comprobar por el tope de la pasada o por el plazo. */
  skippedByBudget: number;
  /** La regla de la ladder, contada aparte porque no sale a la red. */
  ladder: {
    /** Jugadores a los que se les miró la ladder por llegar al mínimo de partidas. */
    considered: number;
    /** Con la ladder más de `LADDER_PUBLICATION_LAG_MINUTES` por delante. */
    ahead: number;
  };
  /** Filas nuevas de `Alert` entre las dos reglas. */
  alertsCreated: number;
  /** Lo que no se ha podido hacer, en texto legible para el rastro. */
  warnings: string[];
  durationMs: number;
};

/**
 * Tope de jugadores comprobados por pasada.
 *
 * Existe por el despliegue, no por el diseño. Al poner esto en marcha **todas** las
 * filas tienen `historyCheckedAt = null`, así que la primera pasada tendría a todo el
 * torneo venciendo la caché a la vez: treinta jugadores por tres `HEAD` son noventa
 * peticiones de golpe contra un sitio al que no se le ha pedido permiso. Con seis por
 * pasada, el despliegue se escalona en cinco pasadas (unos 25 minutos) y a partir de
 * ahí el ritmo es de uno por jugador cada 12 horas.
 *
 * Con el cron de 5 minutos, seis por pasada dan 1 728 comprobaciones al día, que
 * mantienen ese ritmo hasta unos 860 participantes. Si algún día el torneo fuera más
 * grande, el tope es lo primero que habría que tocar, y subirlo no cuesta nada.
 */
export const HISTORY_CHECK_MAX_PER_RUN = 6;

/**
 * Cuántas partidas `rm_solo` se leen por jugador para buscar candidatas a sondear.
 *
 * Tres son las que hacen falta, y se piden ocho porque el filtro de `processed` puede
 * descartar algunas: una partida en curso o una con el replay invalidado no sirve para
 * el sondeo. Si de ocho no salen tres, `planHistoryCheck()` dice `sin-candidatas` y el
 * jugador se vuelve a mirar en la siguiente pasada —que es lo que toca, porque ocho
 * filas con su `rawJson` son lo que se quiere gastar en una comprobación cada doce horas,
 * no en cada una de las 288 pasadas diarias—.
 */
export const HISTORY_CANDIDATE_SCAN = 8;

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : `Error desconocido: ${String(error)}`;
}

/**
 * `rm_solo` dentro de la ventana, como `where` de Prisma.
 *
 * **Y no "clasificatoria".** `rankedMatchWhere()` incluye las partidas de equipos, y
 * eso taparía la regla de la ladder: si un jugador juega `rm_team` y lo que le falta
 * son las de `rm_solo`, comparar contra su última de equipos —que sí nos habría
 * llegado— daría "estamos al día" y la alarma no saltaría nunca.
 *
 * Usa `mode` y no `leaderboard` porque `mode` es la familia **resuelta**
 * (`rm_1v1` -> `rm_solo`), así que también cubre el caso de que la API mande `kind`
 * sin `leaderboard`, y es la columna que tiene índice.
 */
function rmSoloInWindow(window: ScoringWindow): Prisma.MatchWhereInput {
  const { from, to } = windowBounds(window);

  return {
    mode: DEFAULT_LEADERBOARD,
    startedAt: to === null ? { gte: from } : { gte: from, lt: to },
  };
}

/**
 * Candidatas a sondear de un jugador, con su `rawJson` para leer el `state`.
 *
 * `rawJson` entra por la puerta de atrás, pero es la única fuente del `state`: la API no
 * lo publica en ninguna columna de `Match` y no hay nada que pedirle a nadie. Vuelve a
 * pasar por `parseGame()`, igual que el motor de alertas, en vez de leer el JSON a pelo.
 *
 * Se piden `HISTORY_CANDIDATE_SCAN` en vez de las tres justas porque el filtro de
 * `processed` descarta algunas; las que no sirvan no llegan a la sonda.
 */
function readCandidateMatches(
  playerId: string,
  window: ScoringWindow,
): Promise<HistoryProbeMatch[]> {
  return db.match
    .findMany({
      where: { playerId, ...rmSoloInWindow(window) },
      // De más reciente a más antigua, que es el orden en que `historyProbeCandidates()`
      // quiere recibirlas; y `gameId` de desempate para que la lista no dependa del
      // planificador (dos participantes en la misma partida comparten `startedAt`).
      orderBy: [{ startedAt: "desc" }, { gameId: "asc" }],
      take: HISTORY_CANDIDATE_SCAN,
      select: { gameId: true, leaderboard: true, startedAt: true, rawJson: true },
    })
    .then((filas) =>
      filas.map((fila) => ({
        gameId: fila.gameId,
        leaderboard: fila.leaderboard,
        startedAt: fila.startedAt,
        rawJson: fila.rawJson,
      })),
    );
}

/**
 * Nuestra partida `rm_solo` más reciente de la ventana, por jugador.
 *
 * Una consulta para todos los jugadores a la vez, con `DISTINCT ON` en el mismo orden
 * que el índice `(playerId, startedAt)`: una fila por jugador y sin grouped scan. Es la
 * agregación que la regla de la ladder necesita y la que el worker **no** hacía: la del
 * cursor (`maxStartedAt`) solo mira la última pasada, así que no puede decir cuál es la
 * partida más reciente de todo el torneo.
 *
 * **Sin `revertedAt`**, a diferencia de `rankedMatchWhere()`. Una partida revertida
 * existe, la hemos visto y la ladder la cuenta igual: aquí se pregunta qué sabemos de
 * las partidas del jugador, no cuáles puntúan. Incluir el filtro dejaría invisible la
 * partida más reciente de alguien a quien el panel le acaba de revertir una, y la
 * alarma saltaría sin motivo.
 */
async function readNewestRmSoloPerPlayer(
  playerIds: string[],
  window: ScoringWindow,
): Promise<Map<string, Date>> {
  const porJugador = new Map<string, Date>();

  if (playerIds.length === 0) {
    return porJugador;
  }

  const { from, to } = windowBounds(window);
  const limiteInferior = utcTimestamp(from);
  const limiteSuperior = to === null ? null : utcTimestamp(to);

  // `Match.startedAt` es `timestamp` **sin zona** que Prisma guarda en UTC, así que los
  // límites van como texto UTC sin zona y con el cast explícito: es lo mismo que hace
  // `rankedMatchSql()` en `ranked-match.ts`, y por el mismo motivo (una conversión
  // depende de la zona de la sesión).
  const filas = await db.$queryRaw<{ playerId: string; startedAt: Date }[]>(Prisma.sql`
    select distinct on ("playerId") "playerId", "startedAt"
    from "Match"
    where "playerId" = any(${playerIds}::text[])
      and "mode" = ${DEFAULT_LEADERBOARD}
      and "startedAt" >= ${limiteInferior}::timestamp
      ${limiteSuperior === null ? Prisma.empty : Prisma.sql`and "startedAt" < ${limiteSuperior}::timestamp`}
    order by "playerId", "startedAt" desc
  `);

  for (const fila of filas) {
    porJugador.set(fila.playerId, fila.startedAt);
  }

  return porJugador;
}

/** Reloj de pared UTC, `YYYY-MM-DD HH:MM:SS.mmm`, tal y como lo guarda Postgres. */
function utcTimestamp(value: Date): string {
  return value.toISOString().replace("T", " ").replace("Z", "");
}

/** La evidencia de la alerta de historial cerrado: qué se sondeó y qué respondió. */
function historialCerradoDetails(
  probes: readonly { gameId: string; outcome: string }[],
  ladder: CheckPlayerRow,
): Prisma.InputJsonObject {
  return {
    probedGameIds: probes
      .filter((probe) => probe.outcome === "closed")
      .map((probe) => probe.gameId),
    probedCount: probes.length,
    ladderGamesCount: ladder.ladderGamesCount,
    ...(ladder.ladderLastGameAt === null
      ? {}
      : { ladderLastGameAt: ladder.ladderLastGameAt.toISOString() }),
  };
}

/** La evidencia de la alerta de la ladder: las dos fechas comparadas y el margen. */
function ladderGapDetails(
  ladder: CheckPlayerRow,
  newestOurs: Date | null,
  lagMinutes: number,
): Prisma.InputJsonObject {
  return {
    ladderGamesCount: ladder.ladderGamesCount,
    ladderLastGameAt: ladder.ladderLastGameAt?.toISOString() ?? null,
    newestImportedAt: newestOurs === null ? null : newestOurs.toISOString(),
    lagMinutes,
    publicationLagMinutes: LADDER_PUBLICATION_LAG_MINUTES,
  };
}

/**
 * Las dos reglas, una vez por pasada del sincronizador.
 *
 * **Nunca lanza.** Cada paso va en su propio `try`: un jugador que falle no impide
 * comprobar al siguiente, y un fallo de la base se devuelve en `warnings` con la pasada
 * hecha todo lo demás. Es el mismo tratamiento que el resto del worker, y el motivo es
 * que esto es un aviso sobre la transparencia del torneo, no el torneo.
 *
 * ## El orden
 *
 * La regla de la ladder primero y sin red: lee columnas y una agregación, decide y
 * acumula sus alertas. Después la del historial, que sí sale a la red y cuyo resultado
 * escribe las columnas. Separadas y en ese orden porque si el plazo global de la pasada
 * se agota durante el sondeo, el aviso de la ladder —que no necesita red— ya está
 * decidido.
 */
export async function checkPlayerHistory(
  options: { signal?: AbortSignal; config?: Aoe4WorldConfig } = {},
): Promise<HistoryChecksResult> {
  const startedAtMs = Date.now();
  const config = options.config ?? getAoe4WorldConfig();
  const now = new Date();
  const warnings: string[] = [];
  const alerts: TriggeredAlert[] = [];

  const result: HistoryChecksResult = {
    players: 0,
    dueForCheck: 0,
    checked: 0,
    verdicts: { public: 0, closed: 0, unknown: 0 },
    playersUpdated: 0,
    skippedByBudget: 0,
    ladder: { considered: 0, ahead: 0 },
    alertsCreated: 0,
    warnings,
    durationMs: 0,
  };

  try {
    // El ruleset de **puntuación**, no el de alertas: la ventana del torneo sale de ahí,
    // igual que para el resto de reglas. Sin ella no hay forma de saber qué es "dentro
    // del torneo" y las dos comparaciones serían de fechas sin ventana.
    const scoring: ScoringRuleset = await readRuleset();
    const { window } = scoring;

    const players = await db.player.findMany({
      where: { status: PlayerStatus.APPROVED },
      select: {
        id: true,
        profileId: true,
        name: true,
        ladderGamesCount: true,
        ladderLastGameAt: true,
        historyCheckedAt: true,
      },
      orderBy: { profileId: "asc" },
    });

    result.players = players.length;

    if (players.length === 0) {
      result.durationMs = Date.now() - startedAtMs;

      return result;
    }

    /* -------------------------------------------------------------------- */
    /* Regla de la ladder: la ladder va por delante de lo que nos llega       */
    /* -------------------------------------------------------------------- */

    // Solo se miran los que llegan al mínimo de partidas, y es un filtro de columnas
    // aplicado **antes** de leer nada: no es una optimización, es la primera guarda de
    // la regla, y evita una agregación para quien no está jugando.
    const conLadder = players.filter(
      (player) =>
        player.ladderGamesCount !== null && player.ladderGamesCount >= MISSING_MATCHES_MIN_GAMES,
    );

    const newestPorJugador = await readNewestRmSoloPerPlayer(
      conLadder.map((player) => player.id),
      window,
    );

    for (const player of conLadder) {
      result.ladder.considered += 1;

      const newestOurs = newestPorJugador.get(player.id) ?? null;
      const verdict = ladderGapVerdict({
        gamesCount: player.ladderGamesCount,
        lastGameAt: player.ladderLastGameAt,
        newestOurs,
        window,
        now,
      });

      if (verdict.status !== "ahead") {
        continue;
      }

      result.ladder.ahead += 1;

      alerts.push(
        buildTriggeredAlert({
          rule: AlertRule.MISSING_LADDER_MATCHES,
          kind: AlertKind.STATE_DETECTED,
          playerId: player.id,
          playerProfileId: player.profileId,
          subject: SELF_SUBJECT,
          // La magnitud medida y el valor con el que se comparó, para que el informe
          // diga por qué se avisó sin deducirlo de la regla.
          count: verdict.lagMinutes,
          threshold: LADDER_PUBLICATION_LAG_MINUTES,
          anchorGameId: null,
          anchorStartedAt: null,
          window,
          detail: ladderGapDetails(player, newestOurs, verdict.lagMinutes),
        }),
      );
    }

    /* ---------------------------------------------------------------------- */
    /* Regla del historial: el toggle "Share History" del jugador             */
    /* ---------------------------------------------------------------------- */

    // El presupuesto se gasta con los que le vencía la caché, y eso se decide con las
    // columnas de `Player` sin leer una sola partida: al revés habría que traer los
    // `rawJson` de los treinta candidatos para descartar a veintinueve.
    const candidatos = players.filter((player) => historyCheckIsDue(player.historyCheckedAt, now));

    result.dueForCheck = candidatos.length;

    for (const player of candidatos) {
      if (result.checked >= HISTORY_CHECK_MAX_PER_RUN) {
        result.skippedByBudget += 1;

        continue;
      }

      if (options.signal?.aborted === true) {
        // Lo que queda sin mirar sale como omitido y se dirá en la siguiente pasada: el
        // jugador no está comprobado, pero tampoco está mal comprobado, porque no se
        // escribe nada.
        result.skippedByBudget += 1;

        break;
      }

      try {
        const candidatas = historyProbeCandidates(await readCandidateMatches(player.id, window), {
          window,
          limit: HISTORY_PROBE_GAMES,
        });

        const plan = planHistoryCheck({
          historyCheckedAt: player.historyCheckedAt,
          candidates: candidatas,
          now,
        });

        if (plan.action !== "check") {
          continue;
        }

        const sondeo = await probeHistoryVisibility({
          profileId: player.profileId,
          candidates: plan.candidates,
          config,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });

        result.checked += 1;
        result.verdicts[sondeo.verdict] += 1;
        warnings.push(...sondeo.warnings.map((warning) => `${player.name}: ${warning}`));

        // Un `unknown` no escribe nada. Ni columnas ni alerta: no se ha podido comprobar,
        // y publicar "cerrado" por un corte de red sería una afirmación que no se sabe.
        // El jugador vuelve a la cola en la siguiente pasada, porque su
        // `historyCheckedAt` sigue viejo.
        if (sondeo.verdict === "unknown") {
          continue;
        }

        await db.player.update({
          where: { id: player.id },
          data: {
            historyPublic: sondeo.verdict === "public",
            historyCheckedAt: now,
          },
        });

        result.playersUpdated += 1;

        if (sondeo.verdict === "closed") {
          alerts.push(
            buildTriggeredAlert({
              rule: AlertRule.HISTORY_NOT_PUBLIC,
              kind: AlertKind.STATE_DETECTED,
              playerId: player.id,
              playerProfileId: player.profileId,
              subject: SELF_SUBJECT,
              // Las partidas sondeadas sin summary y las que se exigen: el informe dice
              // "3 de 3" sin que haya que leer la regla.
              count: sondeo.probes.filter((probe) => probe.outcome === "closed").length,
              threshold: HISTORY_PROBE_GAMES,
              anchorGameId: null,
              anchorStartedAt: null,
              window,
              detail: historialCerradoDetails(sondeo.probes, player),
            }),
          );
        }
      } catch (error) {
        // Un fallo al leer o al escribir este jugador es un aviso más, no una razón para
        // dejar de comprobar a los demás: el siguiente puede funcionar.
        warnings.push(
          `${player.name}: no se ha podido comprobar su historial (${toErrorMessage(error)})`,
        );
        result.verdicts.unknown += 1;
      }
    }
  } catch (error) {
    // Aquí solo llega un fallo de la base o del ruleset, que son los pasos sin `try`
    // propio. Lo que ya se había comprobado no se pierde —sus columnas están
    // escritas— y el aviso va al rastro de la pasada.
    warnings.push(`No se han podido comprobar los historiales: ${toErrorMessage(error)}`);
  }

  /* ------------------------------------------------------------------ */
  /* Las alertas de las dos reglas, de golpe y solo si no están ya     */
  /* ------------------------------------------------------------------ */

  if (alerts.length > 0) {
    try {
      // `skipDuplicates` sobre `dedupeKey`: la idempotencia de las reglas de estado sale
      // de que su clave no lleve ni partida ni número (ver `alertDedupeKey()`), así que
      // reevaluarlas cada 5 minutos inserta 0 filas.
      const written = await db.alert.createMany({
        data: alerts.map((alert) => ({
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
        skipDuplicates: true,
      });

      result.alertsCreated = written.count;
    } catch (error) {
      // Las columnas ya están escritas y el aviso es un derivado: un fallo aquí se
      // registra y la siguiente pasada lo reintenta con la misma clave.
      warnings.push(`No se han podido escribir las alertas: ${toErrorMessage(error)}`);
    }
  }

  result.durationMs = Date.now() - startedAtMs;

  return result;
}

/**
 * La línea que va al rastro de la pasada (`historyError`), o `null` si no hay nada que
 * decir.
 *
 * **No** mueve `lastSuccessAt`, igual que `alertsError` y `streamsError`: que no se haya
 * podido comprobar si alguien tiene el historial abierto **no ha parado ni una partida**
 * de las que sí se han sincronizado. Mezclarlo daría "el torneo lleva roto desde las
 * 10:00" por un 404 del sitio de AoE4World, que es justo la confusión que ese marcador
 * existe para evitar.
 *
 * Lo que sí se escribe sin fallos es el recuento, porque es donde se ve que el sondeo
 * está funcionando —igual que el aviso de `YOUTUBE_API_KEY` en el de los directos—. Y
 * con los omitidos por el tope también hay línea: es el aviso de que el despliegue se
 * está escalonando, no de que algo falle.
 */
export function describeHistoryChecks(result: HistoryChecksResult): string | null {
  if (result.players === 0) {
    return null;
  }

  const partes = [
    result.dueForCheck === 0 ? null : `${result.dueForCheck} por comprobar`,
    result.checked > 0 ? `${result.checked} comprobados` : null,
    result.verdicts.closed > 0 ? `${result.verdicts.closed} cerrados` : null,
    result.verdicts.unknown > 0 ? `${result.verdicts.unknown} sin comprobar` : null,
    result.ladder.ahead > 0 ? `${result.ladder.ahead} con la ladder por delante` : null,
    result.skippedByBudget > 0 ? `${result.skippedByBudget} para la siguiente pasada` : null,
  ].filter((parte): parte is string => parte !== null);

  if (partes.length === 0 && result.warnings.length === 0) {
    return null;
  }

  return [`Historial de partidas: ${partes.join(", ")}.`, ...result.warnings].join(" ");
}
