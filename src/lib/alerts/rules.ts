import type { Prisma } from "@/generated/prisma/client";
import { isRecord } from "@/lib/json";

/**
 * Umbrales y frases de las alertas de comportamiento. **Módulo puro**: no toca
 * la base de datos ni sale a la red, para que `computePlayerAlerts()` y
 * `npm run verify:alerts` se puedan comprobar con secuencias sintéticas.
 *
 * ## Las tres piezas
 *
 * | Pieza | Qué es |
 * |---|---|
 * | `AlertsRuleset` | los umbrales, versionados en `Setting["alerts.ruleset"]` |
 * | `alertSummary()` | la frase en español que se escribe en `Alert.summary` |
 * | `alertDedupeKey()` | la clave que hace la evaluación idempotente |
 *
 * ## Qué NO vive aquí
 *
 * - **Qué cuenta como partida clasificatoria**: está en
 *   `src/lib/ranked-match.ts`. Aquí no se filtra nada.
 * - **La ventana y los modos**: también. El ruleset de alertas tiene solo
 *   umbrales, así que quien evalúa recibe el alcance del ruleset de **puntuación**
 *   aparte. Duplicarlos aquí sería tener dos verdades sobre qué se está midiendo.
 * - **El cálculo**: en `compute.ts`.
 *
 * ## Por qué las frases se escriben aquí y no en el informe
 *
 * Igual que en `AdminAction`: `Alert.summary` se pinta tal cual. Si el modelo de
 * cada frase viviera en el informe, un nombre con comillas o un número en
 * cualquiera de los dos sitios acabarían dando textos distintos, y el rastro
 * mentiría. Aquí no entra el nombre del jugador (la fila ya es de ese jugador y
 * el panel hace el `join`): un nombre guardado se quedaría congelado el día que
 * alguien se renombre, y eso sí que sería mentir.
 *
 * ## El sujeto de una regla
 *
 * Tres reglas hablan de **alguien**: R2 del rival (`opponentProfileId`) y R3 del
 * compañero (`profileId` de `rawJson.teams`). Las demás hablan del jugador, y su
 * sujeto es `null`. El sujeto se identifica por `profileId` y no por nombre,
 * porque el nombre cambia y el `profileId` no; y puede ser de alguien que no está
 * en la liga, que es lo normal en un torneo individual.
 */

export { SUBDIVISION_RANK_LEVELS, type SubdivisionRankLevel } from "@/lib/divisions";

/* -------------------------------------------------------------------------- */
/* Ruleset                                                                     */
/* -------------------------------------------------------------------------- */

/** Clave de `Setting` donde vive el ruleset de alertas. */
export const ALERTS_RULESET_KEY = "alerts.ruleset";

/**
 * Versión de la forma de las reglas de alertas. La fija **el código**, como
 * `RULESET_VERSION` en el motor de puntos: cambiar un umbral no requiere
 * despliegue (es una reconfiguración de `Setting`), pero cambiar la estructura
 * del documento sí, y para eso sube esta constante.
 */
export const ALERTS_RULESET_VERSION = 1;

/** Texto de producto: lo fija el código y describe qué se está vigilando. */
export const ALERTS_RULE_LABEL = "Alertas de comportamiento sobre partidas clasificatorias";

/** Reglas que miran una racha de partidas consecutivas. */
export type StreakAlertRule =
  | "SHORT_MATCH_STREAK"
  | "REPEATED_OPPONENT_STREAK"
  | "REPEATED_TEAMMATE_STREAK"
  | "TEAMMATE_ELO_GAP"
  | "LOW_DIVISION_TEAM_GAME";

/** Reglas que miran un acumulado sobre toda la ventana. */
export type TotalAlertRule =
  | "SHORT_MATCH_TOTAL"
  | "REPEATED_OPPONENT_TOTAL"
  | "REPEATED_TEAMMATE_TOTAL";

export type AlertsRuleName = StreakAlertRule | TotalAlertRule;

export type AlertKindName = "STREAK_CLOSED" | "STREAK_AT_TOURNAMENT_END" | "TOTAL_REACHED";

/* -------------------------------------------------------------------------- */
/* Las etiquetas                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Cómo se llama cada regla en español, en **un solo sitio**.
 *
 * Vive aquí y no en quien la pinta, por el mismo motivo que `alertSummary()`: si el
 * panel y el informe tuvieran cada uno su texto, bastaría retocar uno para que el
 * mismo comportamiento tuviera dos nombres según por dónde se mirara, y en un informe
 * que se envía a la organización eso es una contradicción, no un detalle de estilo.
 *
 * El `satisfies Record<AlertsRuleName, string>` hace que una regla nueva no pueda
 * entrar sin decidir aquí su etiqueta, igual que el `switch` de `alertSummary()`
 * obliga a decidir su frase. La diferencia entre las dos es que la etiqueta **no**
 * lleva el nombre del jugador ni ningún número: describe la regla, no el hallazgo.
 */
export const ALERT_RULE_LABELS = {
  SHORT_MATCH_STREAK: "Partidas cortas seguidas",
  SHORT_MATCH_TOTAL: "Partidas cortas en total",
  REPEATED_OPPONENT_STREAK: "Rival repetido, en rachas",
  REPEATED_OPPONENT_TOTAL: "Rival repetido, en total",
  REPEATED_TEAMMATE_STREAK: "Compañero repetido, en rachas",
  REPEATED_TEAMMATE_TOTAL: "Compañero repetido, en total",
  TEAMMATE_ELO_GAP: "Brecha de elo con un compañero",
  LOW_DIVISION_TEAM_GAME: "Equipo por debajo de la división",
} as const satisfies Record<AlertsRuleName, string>;

/**
 * Cuándo se detectó, en español, con el mismo criterio que `ALERT_RULE_LABELS`: el
 * enum describe el dato y el mapa lo traduce una sola vez.
 */
export const ALERT_KIND_LABELS = {
  STREAK_CLOSED: "Racha rota",
  STREAK_AT_TOURNAMENT_END: "Racha cerrada por fin de torneo",
  TOTAL_REACHED: "Acumulado alcanzado",
} as const satisfies Record<AlertKindName, string>;

export type AlertsThresholds = {
  /** R1: por debajo de estos segundos la partida se considera corta. */
  shortMatchSeconds: number;
  /** R1: partidas cortas seguidas para avisar de la racha. */
  shortMatchStreak: number;
  /** R1: cada cuántas partidas cortas totales se avisa (5, 10, 15…). */
  shortMatchTotalStep: number;
  /** R2: partidas 1v1 seguidas contra el mismo rival para avisar de la racha. */
  repeatedOpponentStreak: number;
  /** R2: cada cuántas partidas contra el mismo rival se avisa (10, 20, 30…). */
  repeatedOpponentTotalStep: number;
  /** R3: partidas de equipo seguidas con el mismo compañero. */
  repeatedTeammateStreak: number;
  /** R3: partidas con el mismo compañero en total, un único aviso al llegar. */
  repeatedTeammateTotal: number;
  /** R4: diferencia de elo con un compañero, en valor absoluto, para avisar. */
  teammateEloGap: number;
  /** R5: escalones de subdivisión por debajo de la división del jugador. */
  lowDivisionSteps: number;
};

export type AlertsRuleset = {
  version: number;
  label: string;
  thresholds: AlertsThresholds;
};

/**
 * Los valores con los que se publica el ruleset la primera vez.
 *
 * Son los que acordaron cliente y organización: 3 minutos, rachas de 2 y 3,
 * acumulados cada 5 y cada 10, 7 partidas con el mismo compañero, 500 de elo y
 * 3 escalones de división. Se cambian en `Setting["alerts.ruleset"]` sin
 * desplegar, igual que los puntos por victoria del motor de puntuación.
 */
export const DEFAULT_ALERTS_RULESET: AlertsRuleset = {
  version: ALERTS_RULESET_VERSION,
  label: ALERTS_RULE_LABEL,
  thresholds: {
    shortMatchSeconds: 180,
    shortMatchStreak: 2,
    shortMatchTotalStep: 5,
    repeatedOpponentStreak: 3,
    repeatedOpponentTotalStep: 10,
    repeatedTeammateStreak: 3,
    repeatedTeammateTotal: 7,
    teammateEloGap: 500,
    lowDivisionSteps: 3,
  },
};

function defaultAlertsRuleset(): AlertsRuleset {
  return {
    ...DEFAULT_ALERTS_RULESET,
    thresholds: { ...DEFAULT_ALERTS_RULESET.thresholds },
  };
}

/** Un entero del ruleset: solo se acepta si es un entero positivo. */
function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

const THRESHOLD_KEYS = [
  "shortMatchSeconds",
  "shortMatchStreak",
  "shortMatchTotalStep",
  "repeatedOpponentStreak",
  "repeatedOpponentTotalStep",
  "repeatedTeammateStreak",
  "repeatedTeammateTotal",
  "teammateEloGap",
  "lowDivisionSteps",
] as const satisfies readonly (keyof AlertsThresholds)[];

export type AlertsRulesetMergeResult = {
  ruleset: AlertsRuleset;
  /** Ajustes que no se han podido aplicar; se avisa y se queda el valor por defecto. */
  warnings: string[];
};

/**
 * Combina el documento guardado con los valores por defecto. **Nunca lanza.**
 *
 * Mismo criterio que `mergeRuleset()` del motor de puntos, incluida la decisión
 * de que una `version` que no es la del código invalida el documento entero: si
 * el documento describe otra estructura, aplicar "lo que se parezca" sería peor
 * que usar los valores por defecto y decirlo.
 */
export function mergeAlertsRuleset(stored: unknown): AlertsRulesetMergeResult {
  const warnings: string[] = [];
  const ruleset = defaultAlertsRuleset();

  if (!isRecord(stored)) {
    warnings.push("el valor no es un objeto; se usan los valores por defecto");
    return { ruleset, warnings };
  }

  const version = positiveInt(stored.version);

  if (version !== ALERTS_RULESET_VERSION) {
    warnings.push(
      `la versión guardada (${String(stored.version)}) no es ${ALERTS_RULESET_VERSION}; se ignoran los umbrales guardados`,
    );
    return { ruleset, warnings };
  }

  if (stored.label !== undefined && stored.label !== ALERTS_RULE_LABEL) {
    warnings.push("label se ignora: el texto lo fija el código (ALERTS_RULE_LABEL)");
  }

  if (stored.thresholds !== undefined) {
    if (isRecord(stored.thresholds)) {
      for (const key of THRESHOLD_KEYS) {
        const raw = stored.thresholds[key];

        if (raw === undefined) {
          continue;
        }

        const parsed = positiveInt(raw);

        if (parsed === null) {
          warnings.push(`thresholds.${key} no es un entero positivo: ${JSON.stringify(raw)}`);
        } else {
          ruleset.thresholds[key] = parsed;
        }
      }
    } else {
      warnings.push("thresholds no es un objeto");
    }
  }

  return { ruleset, warnings };
}

/* -------------------------------------------------------------------------- */
/* Lo que dispara una alerta                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Sujeto de una regla: de quién habla la alerta, o `null` si habla del jugador.
 *
 * `key` es la identidad estable dentro de la evaluación (para el jugador es un
 * centinela fijo) y es lo que va en la `dedupeKey`, así que **no** puede ser el
 * nombre: el nombre de un rival puede cambiar y la clave tiene que ser la misma
 * para que el dedupe funcione.
 */
export type AlertSubject = {
  key: string;
  profileId: number | null;
  name: string | null;
};

/** El sujeto de las reglas que hablan del propio jugador. */
export const SELF_SUBJECT: AlertSubject = { key: "yo", profileId: null, name: null };

/** Datos de la partida que ha cerrado la racha, para `details`. */
export type AlertAnchorDetail = {
  /** Duración en segundos, si la partida la trae. */
  durationSeconds?: number;
  /** Mayor brecha de elo con un compañero en esa partida (R4). */
  eloGap?: number;
  /** Escalones de subdivisión por debajo de la división del jugador (R5). */
  steps?: number;
  /** Media de elo de la partida (R5). */
  averageMmr?: number;
  /** Subdivisión a la que corresponde esa media, ya resuelta. */
  gameSubdivision?: string;
  /** Subdivisión 1v1 del jugador en el momento de la evaluación (R5). */
  playerSubdivision?: string;
};

export type AlertTriggerInput = {
  rule: AlertsRuleName;
  kind: AlertKindName;
  playerId: string;
  /** `profileId` del jugador, para el `details` (estable aunque se renombre). */
  playerProfileId: number;
  subject: AlertSubject;
  count: number;
  threshold: number;
  anchorGameId: string | null;
  anchorStartedAt: Date | null;
  /** Ladder de la partida, que es la de la que salen los cortes de R5. */
  anchorLadder?: string | null;
  window: { from: string; to: string | null };
  detail?: AlertAnchorDetail;
};

/** Una alerta tal y como la va a escribir el evaluador. */
export type TriggeredAlert = {
  rule: AlertsRuleName;
  kind: AlertKindName;
  playerId: string;
  subjectProfileId: number | null;
  subjectName: string | null;
  count: number;
  threshold: number;
  anchorGameId: string | null;
  dedupeKey: string;
  summary: string;
  details: Prisma.InputJsonObject;
};

/**
 * La clave que hace idempotente la evaluación.
 *
 * Con `createMany({ skipDuplicates: true })` sobre este único índice único, el
 * evaluador inserta "solo lo nuevo" sin leer antes lo que ya hay. Los
 * ingredientes:
 *
 * - **regla y tipo**: R1 de racha y R1 de total son hechos distintos, y una
 *   racha que se cierra y una que se cierra por fin de torneo también.
 * - **jugador y sujeto**: el mismo hecho de dos jugadores son dos alertas, y el
 *   mismo hecho con dos rivales distintos también. El sujeto va por su `key`
 *   estable, no por su nombre.
 * - **el remate**: la partida que cierra la racha, o el número que se ha
 *   cruzado. Es lo que distingue "la racha de 3 partidas cerradas por la
 *   partida X" de "la racha de 3 partidas cerradas por la partida Y", y es lo que
 *   hace que reevaluar los mismos datos no produzca nada nuevo.
 *
 * El prefijo de versión existe para que un cambio en la forma de la clave no
 * choque con lo ya escrito: si algún día la clave cambia de ingredientes, sube
 * el prefijo y se vuelve a evaluar desde cero en lugar de saltarse filas.
 */
export function alertDedupeKey(input: {
  rule: AlertsRuleName;
  kind: AlertKindName;
  playerId: string;
  subjectKey: string;
  anchorGameId: string | null;
  count: number;
}): string {
  const remate = input.kind === "TOTAL_REACHED" ? `total:${input.count}` : `partida:${input.anchorGameId ?? "-"}`;

  return [
    `v${ALERTS_RULESET_VERSION}`,
    input.rule,
    input.kind,
    input.playerId,
    input.subjectKey,
    remate,
  ].join("|");
}

/* -------------------------------------------------------------------------- */
/* Las frases                                                                  */
/* -------------------------------------------------------------------------- */

/** `1 partida` y `3 partidas`: el plural no es un detalle de estilo en un informe. */
export function partidas(count: number): string {
  return count === 1 ? "1 partida" : `${count} partidas`;
}

function conY(n: number): string {
  return n === 1 ? "1 escalón" : `${n} escalones`;
}

/**
 * La frase de una alerta, en la forma en que se pinta.
 *
 * El `switch` es exhaustivo sobre las reglas y no tiene `default`: si mañana
 * aparece una regla nueva, el compilador obliga a decidir aquí su frase en vez
 * de dejar que salga una por defecto que valdría para todo.
 */
export function alertSummary(input: AlertTriggerInput): string {
  const cierre = input.kind === "STREAK_AT_TOURNAMENT_END" ? " al cerrar el torneo" : "";

  switch (input.rule) {
    case "SHORT_MATCH_STREAK":
      return `${partidas(input.count)} cortas seguidas${cierre}`;
    case "SHORT_MATCH_TOTAL":
      return `${partidas(input.count)} cortas en total`;
    case "REPEATED_OPPONENT_STREAK":
      return `${partidas(input.count)} seguidas contra ${input.subject.name ?? "el mismo rival"}${cierre}`;
    case "REPEATED_OPPONENT_TOTAL":
      return `${partidas(input.count)} contra ${input.subject.name ?? "el mismo rival"} en total`;
    case "REPEATED_TEAMMATE_STREAK":
      return `${partidas(input.count)} de equipo seguidas con ${
        input.subject.name ?? "el mismo compañero"
      }${cierre}`;
    case "REPEATED_TEAMMATE_TOTAL":
      return `${partidas(input.count)} de equipo con ${input.subject.name ?? "el mismo compañero"} en total`;
    case "TEAMMATE_ELO_GAP": {
      const gap = input.detail?.eloGap;

      return (
        gap === undefined
          ? `${partidas(input.count)} de equipo con un compañero muy por encima o por debajo${cierre}`
          : `${partidas(input.count)} de equipo con un compañero a ${gap} de elo${cierre}`
      );
    }
    case "LOW_DIVISION_TEAM_GAME": {
      const steps = input.detail?.steps;

      return steps === undefined
        ? `${partidas(input.count)} de equipos muy por debajo de su división${cierre}`
        : `${partidas(input.count)} de equipos ${conY(steps)} por debajo de su división${cierre}`;
    }
  }
}

/**
 * Los mismos datos, estructurados, en `Alert.details`.
 *
 * No se lee para pintar el informe (eso es `summary`): es para el que tenga que
 * mirar por qué una partida concreta sale marcada. Lleva identificadores y no
 * solo frases, y **no lleva datos que ya no sean ciertos**: el nombre del
 * sujeto va en su propia columna, y el del jugador tampoco (el panel lo saca de
 * `Player`, que es donde vive y donde puede estar actualizado).
 */
export function alertDetails(input: AlertTriggerInput): Prisma.InputJsonObject {
  const detail = input.detail ?? {};

  return {
    rule: input.rule,
    kind: input.kind,
    playerProfileId: input.playerProfileId,
    count: input.count,
    threshold: input.threshold,
    ...(input.subject.profileId === null ? {} : { subjectProfileId: input.subject.profileId }),
    ...(input.anchorGameId === null ? {} : { anchorGameId: input.anchorGameId }),
    ...(input.anchorStartedAt === null ? {} : { anchorStartedAt: input.anchorStartedAt.toISOString() }),
    ...(input.anchorLadder === undefined || input.anchorLadder === null
      ? {}
      : { anchorLadder: input.anchorLadder }),
    windowFrom: input.window.from,
    ...(input.window.to === null ? {} : { windowTo: input.window.to }),
    ...detail,
  };
}

/** Monta la alerta completa: clave, frase y detalles, siempre del mismo tirón. */
export function buildTriggeredAlert(input: AlertTriggerInput): TriggeredAlert {
  return {
    rule: input.rule,
    kind: input.kind,
    playerId: input.playerId,
    subjectProfileId: input.subject.profileId,
    subjectName: input.subject.name,
    count: input.count,
    threshold: input.threshold,
    anchorGameId: input.anchorGameId,
    dedupeKey: alertDedupeKey({
      rule: input.rule,
      kind: input.kind,
      playerId: input.playerId,
      subjectKey: input.subject.key,
      anchorGameId: input.anchorGameId,
      count: input.count,
    }),
    summary: alertSummary(input),
    details: alertDetails(input),
  };
}
