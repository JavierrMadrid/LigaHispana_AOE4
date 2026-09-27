import "server-only";

import { MatchResult, PlayerStatus } from "@/generated/prisma/enums";
import { db } from "@/lib/db";

/**
 * Motor de puntuación — versión MVP (F3-lite).
 *
 * La regla que se aplica hoy es la más simple que cumple el encargo del cliente:
 * **cada victoria en partida clasificatoria (ranked) otorga 1 punto**. No hay
 * ventana de fechas, ni duración mínima, ni categorías, ni desempate por rating.
 * Todo eso es diseño cerrado y pendiente de que la comunidad fije las reglas
 * definitivas; la estructura que lo soportará está en `docs/MODELO-DATOS.md`.
 *
 * Lo que sí está ya resuelto de forma definitiva, porque no depende de las reglas:
 *
 * - Un `ruleset` con número de versión, y el agregado (`PlayerScore`) lleva ese
 *   número. Cuando las reglas cambien se publica la versión 2 y las dos conviven.
 * - Los puntos por partida se materializan en `Match.points`, así que se pueden
 *   auditar sin volver a agregarlos.
 * - El desempate provisional es `total desc, wins desc, profileId asc`, que
 *   termina en un valor único (`profileId` es único), de modo que el puesto es
 *   un entero denso y estable.
 */

/**
 * Versión de las reglas con la que se etiqueta la clasificación.
 *
 * El `1` es provisional: representa "un punto por victoria clasificatoria", no el
 * ruleset Wololo del diseño. Cuando la comunidad cierre las reglas se publica la
 * versión `2` con su propio documento en `Setting` y se recalcula al lado.
 */
export const MVP_RULESET_VERSION = 1;

/** Puntos que otorga una victoria clasificatoria. */
export const POINTS_PER_RANKED_WIN = 1;

/**
 * Familias de ladder que cuentan como partida clasificatoria.
 *
 * Son las dos ladders *ranked* del modo competitivo: 1v1 y por equipos (2v2, 3v3
 * y 4v4 comparten familia y por eso `Match.mode` las colapsa en `rm_team`).
 */
export const RANKED_MODES = ["rm_solo", "rm_team"] as const;

export type RankedMode = (typeof RANKED_MODES)[number];

/** Etiqueta legible de la regla activa; aparece en `breakdown` y en los logs. */
export const MVP_RULE_LABEL = "un punto por victoria en partida clasificatoria (ranked)";

/** Desglose por modo de una fila de `PlayerScore`. */
export type ScoreBreakdownMode = {
  /** Victorias clasificatorias en este modo. */
  wins: number;
  /** Puntos aportados por este modo (coincide con `wins` en el MVP). */
  points: number;
  /** Partidas clasificatorias resueltas en este modo, ganadas y perdidas. */
  matches: number;
};

/**
 * Forma exacta de `PlayerScore.breakdown`.
 *
 * Es JSON y no columnas a propósito: el número de categorías cambia con cada
 * versión de las reglas y migrar columnas en cada versión no es una opción. Las
 * dos familias clasificatorias siempre están presentes (con ceros si no aplican),
 * para que quien lo lea no tenga queecase de un objeto que puede faltar.
 *
 * ```json
 * {
 *   "ruleSetVersion": 1,
 *   "rule": "un punto por victoria en partida clasificatoria (ranked)",
 *   "byMode": {
 *     "rm_solo": { "wins": 3, "points": 3, "matches": 5 },
 *     "rm_team": { "wins": 1, "points": 1, "matches": 2 }
 *   }
 * }
 * ```
 */
export type ScoreBreakdown = {
  ruleSetVersion: number;
  rule: string;
  byMode: Record<RankedMode, ScoreBreakdownMode>;
};

export type RecomputeScoresResult = {
  ruleSetVersion: number;
  /** Partidas que han pasado a puntuar (victorias clasificatorias resueltas). */
  matchesScored: number;
  /**
   * Filas que tenían puntos y se han puesto a cero antes de volver a marcar. Se
   * incluye alguna que acto seguido recupera el punto, así que no es "partidas
   * que han dejado de puntuar", sino el tamaño del trabajo de reinicio.
   */
  matchesReset: number;
  /** Jugadores con fila en la clasificación. */
  playersRanked: number;
  /** Jugadores cuya fila anterior se ha retirado (ya no rankean). */
  playersUnranked: number;
  /** Suma de `PlayerScore.total`, para contrastar con `Match.points`. */
  totalPoints: number;
  durationMs: number;
};

export function isRankedMode(mode: string | null): mode is RankedMode {
  return mode === "rm_solo" || mode === "rm_team";
}

/**
 * ¿Cuenta esta partida?
 *
 * Solo si está **resuelta** y es de una familia rankeada. Las dos condiciones
 * son necesarias: `finishedAt IS NULL` significa "en curso" (y la API todavía no
 * ha publicado el desenlace), y una partida sin resolver nunca puntúa ni en
 * positivo ni en negativo.
 */
export function countsAsRanked(match: { mode: string | null; result: MatchResult | null; finishedAt: Date | null }): boolean {
  return match.finishedAt !== null && match.result !== null && isRankedMode(match.mode);
}

type AggregatedRow = {
  total: number;
  wins: number;
  matches: number;
  byMode: Record<RankedMode, ScoreBreakdownMode>;
};

function emptyBreakdown(): Record<RankedMode, ScoreBreakdownMode> {
  return {
    rm_solo: { wins: 0, points: 0, matches: 0 },
    rm_team: { wins: 0, points: 0, matches: 0 },
  };
}

/**
 * Reescribe los puntos por partida y la clasificación completa.
 *
 * Es idempotente: se puede ejecutar tantas veces como haga falta y el resultado
 * es el mismo. Se hace un recálculo entero en vez de incremental porque el
 * volumen de un torneo son decenas de miles de partidas y dos sentencias resuelven
 * la tabla entera; la ventaja real de hacerlo así es que las reglas pueden cambiar
 * sin dejar residuos del cálculo anterior.
 *
 * Se ejecuta en una transacción para que nadie lea una clasificación a medio
 * escribir: sin ella, un visitante podía ver la tabla vacía entre el `delete` y el
 * `createMany`.
 */
export async function recomputeScores(): Promise<RecomputeScoresResult> {
  const startedAtMs = Date.now();

  const result = await db.$transaction(
    async (tx) => {
      // Primero se pone a cero todo lo que tuviera puntos y después se marcan las
      // victorias clasificatorias. Ese orden (y no el contrario) es lo que hace el
      // paso idempotente sin tener que distinguir "antes" de "después", y evita
      // depender de en qué estado quedó la tabla.
      const zeroed = await tx.match.updateMany({
        where: { points: { not: 0 } },
        data: { points: 0 },
      });

      const scored = await tx.match.updateMany({
        where: {
          mode: { in: [...RANKED_MODES] },
          result: MatchResult.WIN,
          finishedAt: { not: null },
        },
        data: { points: POINTS_PER_RANKED_WIN },
      });

      const aggregated = await tx.match.groupBy({
        by: ["playerId", "mode", "result"],
        where: {
          mode: { in: [...RANKED_MODES] },
          result: { not: null },
          finishedAt: { not: null },
          player: { status: PlayerStatus.APPROVED },
        },
        _count: { _all: true },
        _sum: { points: true },
      });

      const totals = new Map<string, AggregatedRow>();

      for (const row of aggregated) {
        if (!isRankedMode(row.mode)) {
          continue;
        }

        const count = row._count._all;
        const points = row._sum.points ?? 0;
        const won = row.result === MatchResult.WIN;
        const current = totals.get(row.playerId) ?? {
          total: 0,
          wins: 0,
          matches: 0,
          byMode: emptyBreakdown(),
        };

        current.total += points;
        current.matches += count;

        if (won) {
          current.wins += count;
        }

        current.byMode[row.mode].wins += won ? count : 0;
        current.byMode[row.mode].points += won ? points : 0;
        current.byMode[row.mode].matches += count;
        totals.set(row.playerId, current);
      }

      // Solo se consulta el perfil de quien tiene alguna partida clasificatoria:
      // los aprobados sin partidas no tienen fila (P-02 del modelo de datos).
      const players = await tx.player.findMany({
        where: { id: { in: [...totals.keys()] }, status: PlayerStatus.APPROVED },
        select: { id: true, profileId: true },
      });

      const profileIdByPlayer = new Map(players.map((player) => [player.id, player.profileId]));

      // Desempate provisional. `profileId` es único, así que el orden es total y
      // el puesto un entero denso: no hay empates que repartir. Una fila sin
      // `profileId` no se publica en lugar de publicarse con un desempate falso.
      const ranked = [...totals.entries()]
        .flatMap(([playerId, aggregate]) => {
          const profileId = profileIdByPlayer.get(playerId);

          return profileId === undefined ? [] : [{ playerId, profileId, ...aggregate }];
        })
        .sort((a, b) => b.total - a.total || b.wins - a.wins || a.profileId - b.profileId)
        .map((row, index) => ({ ...row, rank: index + 1 }));

      const previousCount = await tx.playerScore.count({
        where: { ruleSetVersion: MVP_RULESET_VERSION },
      });

      await tx.playerScore.deleteMany({ where: { ruleSetVersion: MVP_RULESET_VERSION } });

      if (ranked.length > 0) {
        await tx.playerScore.createMany({
          data: ranked.map((row) => ({
            playerId: row.playerId,
            ruleSetVersion: MVP_RULESET_VERSION,
            rank: row.rank,
            total: row.total,
            wins: row.wins,
            matches: row.matches,
            breakdown: {
              ruleSetVersion: MVP_RULESET_VERSION,
              rule: MVP_RULE_LABEL,
              byMode: row.byMode,
            } satisfies ScoreBreakdown,
          })),
        });
      }

      return {
        ruleSetVersion: MVP_RULESET_VERSION,
        matchesScored: scored.count,
        matchesReset: zeroed.count,
        playersRanked: ranked.length,
        playersUnranked: Math.max(previousCount - ranked.length, 0),
        totalPoints: ranked.reduce((sum, row) => sum + row.total, 0),
        durationMs: Date.now() - startedAtMs,
      };
    },
    // El recálculo escribe las dos tablas enteras; con el plazo por defecto de
    // Prisma (5 s) se quedaría corto en cuanto la base crezca.
    { timeout: 60_000, maxWait: 15_000 },
  );

  return result;
}
