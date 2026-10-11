import "server-only";

import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { isRecord } from "@/lib/json";
import {
  mergeAlertsRuleset,
  ALERTS_RULESET_KEY,
  ALERTS_RULESET_VERSION,
  DEFAULT_ALERTS_RULESET,
  type AlertsRuleset,
} from "./rules";
import {
  readCutoffsTable,
  type LadderCutoffsTable,
  type StoredDivisionCutoffs,
} from "./division-cutoffs";

/**
 * Lectura y escritura de las tres claves de `Setting` que son de alertas.
 *
 * | Clave | Qué guarda | Quién la escribe |
 * |---|---|---|
 * | `alerts.ruleset` | los umbrales, con la versión fijada por el código | `ensureAlertsRuleset()`, una vez |
 * | `alerts.divisionCutoffs` | los cortes rating → subdivisión por familia de ladder | `npm run alerts:cutoffs`, a mano |
 * | `alerts.tournamentClose` | la marca de que el cierre de torneo ya se evaluó | `evaluateAlerts()`, una vez por ventana |
 *
 * `Setting` es el sitio donde ya vive la memoria del worker (`sync.lastRun`), el
 * rastro del motor (`scoring.lastRun`) y el cursor por jugador, así que los
 * umbrales de las alertas van allí y no en una tabla nueva: son un documento
 * entero que se edita o no se edita, y una tabla por umbral sería media regla.
 *
 * Las tres lecturas **nunca lanzan**. Un documento retocado a mano que no se
 * entiende se descarta y se avisa, y el motor sigue funcionando con los valores
 * por defecto: es el mismo criterio que `readRuleset()` del motor de puntos, y la
 * razón por la que un `Setting` mal escrito no puede dejar el torneo sin
 * alertas.
 */

/** Cliente con la única tabla que necesitan estas lecturas (`db` o una `tx`). */
export type AlertsSettingWriter = Pick<Prisma.TransactionClient, "setting">;

/* -------------------------------------------------------------------------- */
/* alerts.ruleset                                                              */
/* -------------------------------------------------------------------------- */

function reportWarnings(warnings: readonly string[]): void {
  for (const warning of warnings) {
    console.warn(`[alerts] ${ALERTS_RULESET_KEY}: ${warning}`);
  }
}

/**
 * Umbrales activos, leyendo `Setting` si existe.
 *
 * Si nadie ha publicado aún `alerts.ruleset`, devuelve los valores por defecto
 * sin escribir nada: leer no debería modificar la base.
 */
export async function readAlertsRuleset(client: AlertsSettingWriter = db): Promise<AlertsRuleset> {
  const setting = await client.setting.findUnique({ where: { key: ALERTS_RULESET_KEY } });

  if (setting === null) {
    return {
      ...DEFAULT_ALERTS_RULESET,
      thresholds: { ...DEFAULT_ALERTS_RULESET.thresholds },
    };
  }

  const merged = mergeAlertsRuleset(setting.value);
  reportWarnings(merged.warnings);

  return merged.ruleset;
}

/** Como `readAlertsRuleset`, pero publica el documento por defecto si no existe. */
export async function ensureAlertsRuleset(client: AlertsSettingWriter = db): Promise<AlertsRuleset> {
  const ruleset = await readAlertsRuleset(client);
  const setting = await client.setting.findUnique({ where: { key: ALERTS_RULESET_KEY } });

  if (setting === null) {
    // `update: {}` no pisa nada: si otro proceso lo publicó entre la lectura y esta
    // escritura, se queda el documento que ya estaba.
    await client.setting.upsert({
      where: { key: ALERTS_RULESET_KEY },
      create: { key: ALERTS_RULESET_KEY, value: DEFAULT_ALERTS_RULESET },
      update: {},
    });
    console.info(
      `[alerts] Publicado ${ALERTS_RULESET_KEY} (versión ${ALERTS_RULESET_VERSION}).`,
    );
  }

  return ruleset;
}

/* -------------------------------------------------------------------------- */
/* alerts.divisionCutoffs                                                      */
/* -------------------------------------------------------------------------- */

/** Clave de `Setting` con los cortes rating → subdivisión de cada ladder. */
export const ALERTS_DIVISION_CUTOFFS_KEY = "alerts.divisionCutoffs";

/**
 * Cortes cacheados, ya validados. `null` si no hay ninguno o si lo que hay
 * guardado no sirve.
 *
 * Devolver `null` (y no un objeto vacío) es lo que permite que R5 se omita con
 * un aviso claro: "no hay cortes" y "hay cortes pero no de esta ladder" son el
 * mismo hueco para el motor, y se dicen igual.
 */
export async function readDivisionCutoffs(
  client: AlertsSettingWriter = db,
): Promise<LadderCutoffsTable | null> {
  const setting = await client.setting.findUnique({ where: { key: ALERTS_DIVISION_CUTOFFS_KEY } });

  return setting === null ? null : readCutoffsTable(setting.value);
}

export async function writeDivisionCutoffs(
  table: LadderCutoffsTable,
  client: AlertsSettingWriter = db,
): Promise<void> {
  const document = toInputJson({ ladders: table });

  await client.setting.upsert({
    where: { key: ALERTS_DIVISION_CUTOFFS_KEY },
    create: { key: ALERTS_DIVISION_CUTOFFS_KEY, value: document },
    update: { value: document },
  });
}

/**
 * El documento a JSON de entrada, **sin castear a ciegas**.
 *
 * Se construye con un `JSON.parse(JSON.stringify(...))` en vez de con un `as`
 * porque los cortes los escribe un script de terminal: pasan por el
 * `LadderCutoffs` de TypeScript pero no por el validador de la frontera, y un `as`
 * ahí sería exactamente el tipo de atajo que este proyecto no se permite en
 * ninguna parte. El viaje por `JSON` además falla ruidosamente si algún día se
 * cuela un `undefined` o una función, en vez de guardarlos como `null` sin que
 * nadie se entere.
 */
function toInputJson(value: StoredDivisionCutoffs): Prisma.InputJsonObject {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;
}

/* -------------------------------------------------------------------------- */
/* alerts.tournamentClose                                                       */
/* -------------------------------------------------------------------------- */

/** Clave de `Setting` con la marca del cierre de torneo ya evaluado. */
export const ALERTS_TOURNAMENT_CLOSE_KEY = "alerts.tournamentClose";

/**
 * Qué es lo que hay que recordar para saber si el cierre ya se hizo.
 *
 * Se guarda **la ventana**, no solo una fecha: si la organización mueve el
 * `window.to`, el corte vuelve a estar pendiente y hay que reevaluar entero. Sin
 * eso, un torneo al que se le alarga el final cerraría con las rachas que hubiera
 * en el momento del `to` viejo, y nadie volvería a mirar.
 */
export type TournamentCloseMark = {
  windowFrom: string;
  windowTo: string | null;
  evaluatedAt: string;
  alertsCreated: number;
  playersEvaluated: number;
};

function readCloseMarkValue(value: unknown): TournamentCloseMark | null {
  if (!isRecord(value)) {
    return null;
  }

  const { windowFrom, evaluatedAt } = value;

  if (typeof windowFrom !== "string" || typeof evaluatedAt !== "string") {
    return null;
  }

  return {
    windowFrom,
    windowTo: typeof value.windowTo === "string" ? value.windowTo : null,
    evaluatedAt,
    alertsCreated:
      typeof value.alertsCreated === "number" && Number.isInteger(value.alertsCreated)
        ? value.alertsCreated
        : 0,
    playersEvaluated:
      typeof value.playersEvaluated === "number" && Number.isInteger(value.playersEvaluated)
        ? value.playersEvaluated
        : 0,
  };
}

export async function readTournamentCloseMark(
  client: AlertsSettingWriter = db,
): Promise<TournamentCloseMark | null> {
  const setting = await client.setting.findUnique({
    where: { key: ALERTS_TOURNAMENT_CLOSE_KEY },
  });

  return setting === null ? null : readCloseMarkValue(setting.value);
}

export async function writeTournamentCloseMark(
  mark: TournamentCloseMark,
  client: AlertsSettingWriter = db,
): Promise<void> {
  await client.setting.upsert({
    where: { key: ALERTS_TOURNAMENT_CLOSE_KEY },
    create: { key: ALERTS_TOURNAMENT_CLOSE_KEY, value: mark },
    update: { value: mark },
  });
}
