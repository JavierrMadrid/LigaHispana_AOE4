import "server-only";

import type { Prisma } from "@/generated/prisma/client";
import { AlertKind, AlertRule } from "@/generated/prisma/enums";
import { db } from "@/lib/db";
import { readFromDatabase, unwrapRead } from "@/lib/db-errors";
import { isRecord } from "@/lib/json";
import { readInstant, type ScoringWindow } from "@/lib/ranked-match";
import { readRuleset } from "@/lib/scoring";
import type { OpenStreak } from "./compute";
import { evaluateAlerts } from "./evaluate";
import {
  alertSummary,
  ALERTS_RULE_LABEL,
  ALERT_KIND_LABELS,
  ALERT_RULE_LABELS,
  type AlertTriggerInput,
} from "./rules";

/**
 * Informe descargable de las alertas de comportamiento, en CSV para Excel.
 *
 * ## Qué es y qué no es
 *
 * Es el documento que se le pasa a la organización para revisar una tanda de avisos, no
 * una pantalla: no está paginado, no tiene filtros y sale entero. Lo consume
 * `GET /admin/alertas/reporte`, detrás de `requireAdmin()`.
 *
 * ## Por qué hace la comprobación completa antes de escribir nada
 *
 * El informe tiene que describir el estado **recién calculado**. Sin evaluarlo, un
 * fichero descargado a las once de la noche podría traer los avisos de una pasada que
 * se ejecutó a las nueve, o no traer los de una partida que entró a las diez y media, y
 * no habría forma de saberlo mirando el fichero. `evaluateAlerts({ full: true })` es
 * idempotente (`skipDuplicates` sobre `dedupeKey`), así que repetirlo no inventa nada:
 * inserta solo lo que no estaba y devuelve además las rachas que siguen abiertas.
 *
 * ## Los dos bloques
 *
 * | Bloque | De dónde sale |
 * |---|---|
 * | alertas disparadas | de la tabla `Alert`, de la más reciente a la más antigua |
 * | rachas abiertas en curso | de `openStreaks`, el resultado del motor de esta misma pasada |
 *
 * Las rachas abiertas **no son alertas**: son tramos que todavía no han terminado y que
 * solo avisan cuando se rompen. Salen en su propio bloque y con `Estado` = "En curso"
 * para que nadie las cuente como avisos ya dados, ni como hallazgos: están para ver
 * hacia dónde va cada jugador, que es lo mismo que imprime `npm run alerts:check`.
 *
 * ## Nada se inventa
 *
 * Lo que el motor no da, se deja en blanco. Concretamente la fecha de la partida
 * ancla: sale de `details.anchorStartedAt`, que es un `Json` y puede ser de una versión
 * antigua del código, así que se valida con `readInstant()` en vez de castearse. Una
 * fecha inventada en un informe que se usa para tomar decisiones es peor que una celda
 * vacía.
 *
 * ## Por qué este módulo y no `src/lib/admin.ts`
 *
 * El DAL publica filas paginadas para pintar una tabla y degrade cuando la base falla,
 * y un informe descargado no puede degradarse: o sale el fichero entero o no sale nada,
 * porque "no se ha podido leer" en forma de un CSV a medias sería un informe falso. Aquí
 * un fallo de base se registra con su prefijo `[db]` y aborta la generación, que es lo
 * que ya hace `unwrapRead()`.
 */

/** Alcance de las lecturas, para el log: describe la lectura, no la pantalla. */
const REPORT_SCOPE = "alerts/report";

/** Las dos mitades de una fila del informe, ya en texto. */
export type AlertsReport = {
  /** Nombre del fichero, con el día de generación (`alertas-liga-hispana-AAAA-MM-DD.csv`). */
  filename: string;
  /** El CSV entero: con BOM, con `sep=;` en la primera línea y con CRLF al final. */
  csv: string;
};

/**
 * Zona horaria de las fechas del informe.
 *
 * El torneo es de aquí y el fichero lo va a leer alguien de aquí, así que las fechas se
 * escriben en hora de Madrid (con su horario de verano) en vez de en UTC o en la del
 * servidor, que además cambia entre `next dev` y el Worker. La cabecera dice en qué zona
 * están para que no haya que suponerlo.
 */
const TIME_ZONE = "Europe/Madrid";

/**
 * Formateador de las fechas del informe. Solo se usa por sus partes, a través de
 * `reportParts()`.
 *
 * Se escriben mes, día, hora y minuto a dos dígitos en vez de usar `dateStyle`/`timeStyle`
 * porque el destino es una celda de Excel y no un texto junto a otros: con los estilos
 * "cortos" de `es-ES` salen el año de dos dígitos ("21/9/26, 22:43"), que ordena mal.
 */
const reportInstant = new Intl.DateTimeFormat("es-ES", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: TIME_ZONE,
});

/** Las partes de una fecha en la zona del informe. */
type ReportInstant = {
  day: string;
  month: string;
  year: string;
  hour: string;
  minute: string;
};

/**
 * Las partes de `value`, ya en la zona del informe.
 *
 * Se leen de `formatToParts()` y no se usa `format()` porque `es-ES` mete una coma entre
 * la fecha y la hora ("21/09/2026, 22:43") y una celda de Excel con una coma dentro se
 * ordena mal en cuanto alguien la usa como columna. Con las partes se escribe el formato
 * que se quiere, sin depender del patrón que traiga el locale.
 */
function reportParts(value: Date): ReportInstant {
  const parts = reportInstant.formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";

  return {
    day: part("day"),
    month: part("month"),
    year: part("year"),
    hour: part("hour"),
    minute: part("minute"),
  };
}

/**
 * `AAAA-MM-DD` del día de `date` **en la zona del informe**, para el nombre del fichero.
 *
 * Sale de las mismas partes que las celdas y no de `toISOString()` porque el nombre del
 * fichero y la fecha de la cabecera tienen que ser el mismo día: a las 00:30 en Madrid
 * son las 22:30 del día anterior en UTC, y un fichero con el día equivocado es de esos
 * detalles que después nadie sabe si fueron un error o no.
 */
function reportDay(date: Date): string {
  const { year, month, day } = reportParts(date);

  return `${year}-${month}-${day}`;
}

/** `21/09/2026 22:43`, o cadena vacía si el instante no se puede leer. */
function formatInstant(value: Date | null): string {
  if (value === null) {
    return "";
  }

  const { day, month, year, hour, minute } = reportParts(value);

  return `${day}/${month}/${year} ${hour}:${minute}`;
}

/**
 * El instante de la partida que ancla la alerta, leído de `details.anchorStartedAt`.
 *
 * `details` es un `Json` escrito por el motor, y una fila puede ser de una versión
 * anterior del código: se valida en vez de castearse. Sin instante legible la celda se
 * queda vacía.
 */
function anchorInstant(details: unknown): Date | null {
  if (!isRecord(details) || typeof details.anchorStartedAt !== "string") {
    return null;
  }

  return readInstant(details.anchorStartedAt);
}

/* -------------------------------------------------------------------------- */
/* El CSV                                                                      */
/* -------------------------------------------------------------------------- */

const SEPARATOR = ";";

/** Excel en Windows es el destinatario, así que el fin de línea es CRLF y no `\n`. */
const EOL = "\r\n";

/**
 * Byte Order Mark.
 *
 * Sin él, Excel abre un CSV UTF-8 con acentos como si fueran caracteres mal
 * codificados, y un informe cuyo texto sale corrupto no sirve para nada.
 */
const BOM = "\uFEFF";

/**
 * Un campo entrecomillado cuando lo necesita, y las comillas del interior duplicadas.
 *
 * Solo se entrecomilla si el texto lleva comilla, separador o salto de línea: es lo que
 * espera el analizador de Excel y no ensucia las celdas que no lo necesitan.
 */
function csvField(value: string | number): string {
  const text = String(value);

  return /[";\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csvRow(fields: readonly (string | number)[]): string {
  return fields.map(csvField).join(SEPARATOR);
}

/** Cabecera de columnas. El orden es el contrato del fichero. */
const COLUMNS = [
  "Estado",
  "Jugador",
  "Perfil",
  "Regla",
  "Tipo",
  "Sujeto",
  "Conteo",
  "Umbral",
  "Partida",
  "Fecha de partida",
  "Detectada",
  "Resumen",
] as const;

/** Una fila del informe, ya con todo en texto y sin `null`. */
type ReportRow = {
  estado: string;
  jugador: string;
  perfil: number;
  regla: string;
  tipo: string;
  sujeto: string;
  conteo: number;
  umbral: number;
  partida: string;
  fechaPartida: string;
  detectada: string;
  resumen: string;
};

/** Estado de una fila que ya está en la tabla `Alert`. */
const ESTADO_DISPARADA = "Disparada";

/**
 * Estado de una racha que aún no ha avisado de nada.
 *
 * Es un texto del informe, no una etiqueta de regla: la tabla `Alert` no tiene este
 * caso porque una racha abierta no es una fila.
 */
const ESTADO_EN_CURSO = "En curso";

/**
 * `Tipo` de una racha abierta.
 *
 * Los tres `ALERT_KIND_LABELS` describen **cuándo se detectó**, así que ninguno le
 * sirve a un tramo que todavía no ha avisado: aquí va lo que es, una racha en curso.
 */
const TIPO_EN_CURSO = "Racha en curso";

function csvFromRows(rows: readonly ReportRow[]): string[] {
  if (rows.length === 0) {
    // Una celda, no una fila de la tabla: un bloque vacío se dice con "(ninguna)" en vez
    // de dejar una tabla sin filas, que en Excel parece un fichero roto.
    return ["(ninguna)"];
  }

  return rows.map((row) =>
    csvRow([
      row.estado,
      row.jugador,
      row.perfil,
      row.regla,
      row.tipo,
      row.sujeto,
      row.conteo,
      row.umbral,
      row.partida,
      row.fechaPartida,
      row.detectada,
      row.resumen,
    ]),
  );
}

/**
 * La ventana del torneo en una celda, con el `to` abierto explícito si lo está.
 *
 * `readInstant()` solo devuelve `null` con un texto que no sea un instante con zona, que
 * el ruleset ya no deja pasar; cuando pasa, se cae al texto guardado en vez de a una
 * celda vacía, porque en la cabecera cabe mejor "lo que hay escrito" que un hueco.
 */
function windowText(window: ScoringWindow): string {
  const desde = formatInstant(readInstant(window.from));
  const hasta = window.to === null ? null : formatInstant(readInstant(window.to));

  return [
    desde === "" ? window.from : desde,
    window.to === null ? "sin fin" : hasta === "" ? window.to : hasta,
  ].join(" → ");
}

function metadataRows(input: {
  window: ScoringWindow;
  rulesetVersion: number;
  now: Date;
  playersEvaluated: number;
  alertsCreated: number;
}): string[] {
  return [
    csvRow(["Informe de alertas de comportamiento", ALERTS_RULE_LABEL]),
    // La notación es la del resto del proyecto: `[from, to)` sobre `Match.startedAt`, con
    // el límite superior excluido.
    csvRow(["Ventana del torneo [inicio, fin)", windowText(input.window)]),
    csvRow(["Versión de las reglas", String(input.rulesetVersion)]),
    csvRow(["Generado", `${formatInstant(input.now)} (hora de ${TIME_ZONE})`]),
    csvRow(["Jugadores comprobados", String(input.playersEvaluated)]),
    csvRow(["Alertas nuevas en esta comprobación", String(input.alertsCreated)]),
  ];
}

/* -------------------------------------------------------------------------- */
/* Las dos mitades                                                             */
/* -------------------------------------------------------------------------- */

/** Lo que se lee de cada fila de `Alert` para el informe. */
const ALERT_REPORT_SELECT = {
  rule: true,
  kind: true,
  count: true,
  threshold: true,
  anchorGameId: true,
  summary: true,
  createdAt: true,
  details: true,
  subjectName: true,
  subjectProfileId: true,
  player: { select: { name: true, profileId: true } },
} satisfies Prisma.AlertSelect;

/**
 * El sujeto, o su `profileId` si no se guardó el nombre.
 *
 * El nombre del sujeto se congela al escribir la alerta (es el único rastro de a quién
 * señalaba un rival o un compañero que puede no estar en la liga), así que puede faltar
 * si la partida no lo traía. En ese caso se dice `#12345` y no un nombre inventado: es
 * el mismo criterio que usa `npm run alerts:check`.
 */
function subjectText(name: string | null, profileId: number | null): string {
  if (name !== null && name !== "") {
    return name;
  }

  return profileId === null ? "" : `#${profileId}`;
}

/** Una alerta disparada, tal y como está en la tabla. */
function disparadaEnFila(row: {
  rule: AlertRule;
  kind: AlertKind;
  count: number;
  threshold: number;
  anchorGameId: string | null;
  summary: string;
  createdAt: Date;
  details: unknown;
  subjectName: string | null;
  subjectProfileId: number | null;
  player: { name: string; profileId: number };
}): ReportRow {
  return {
    estado: ESTADO_DISPARADA,
    // El nombre sale del `join` con `Player`, no de la alerta: `summary` no lo lleva a
    // propósito (ver `rules.ts`) y el que se pinta es el de ahora, que es el bueno.
    jugador: row.player.name,
    perfil: row.player.profileId,
    regla: ALERT_RULE_LABELS[row.rule],
    tipo: ALERT_KIND_LABELS[row.kind],
    sujeto: subjectText(row.subjectName, row.subjectProfileId),
    conteo: row.count,
    // El umbral con el que se avisó, congelado en la fila: aunque las reglas cambien
    // después, el informe dice con qué criterio se miró cada hallazgo.
    umbral: row.threshold,
    partida: row.anchorGameId ?? "",
    fechaPartida: formatInstant(anchorInstant(row.details)),
    detectada: formatInstant(row.createdAt),
    // La frase va tal cual, redactada al escribir la fila. Montarla aquí daría otro
    // texto para el mismo hallazgo en cuanto un nombre trajera una coma o un signo.
    resumen: row.summary,
  };
}

/**
 * La frase de una racha que todavía no ha avisado de nada.
 *
 * Reutiliza `alertSummary()` con `kind: "STREAK_CLOSED"` porque es la frase de "tramo de
 * N partidas con este patrón": lo único que la frase no dice —que el tramo no se ha
 * cerrado todavía— ya lo dice la columna `Estado`. Escribir aquí una frase nueva dejaría
 * dos redacciones para el mismo comportamiento, que es justo lo que `rules.ts` evita.
 */
function openStreakSummary(streak: OpenStreak, window: ScoringWindow): string {
  const input: AlertTriggerInput = {
    rule: streak.rule,
    kind: "STREAK_CLOSED",
    playerId: streak.playerId,
    playerProfileId: streak.playerProfileId,
    subject: streak.subject,
    count: streak.count,
    threshold: streak.threshold,
    anchorGameId: streak.lastGameId,
    anchorStartedAt: null,
    window,
  };

  return alertSummary(input);
}

/**
 * Una racha abierta, tal y como la devuelve el motor.
 *
 * La partida y su fecha son las de la **última** del tramo: es el mismo remate que usa
 * una alerta de cierre de torneo, porque es la única partida a la que se puede señalar
 * una racha que no ha roto ninguna.
 */
function rachaEnFila(streak: OpenStreak, window: ScoringWindow): ReportRow {
  return {
    estado: ESTADO_EN_CURSO,
    jugador: streak.playerName,
    perfil: streak.playerProfileId,
    regla: ALERT_RULE_LABELS[streak.rule],
    tipo: TIPO_EN_CURSO,
    sujeto: subjectText(streak.subject.name, streak.subject.profileId),
    conteo: streak.count,
    umbral: streak.threshold,
    partida: streak.lastGameId,
    fechaPartida: formatInstant(readInstant(streak.lastStartedAt)),
    // No hay nada detectado: la celda queda vacía en vez de poner la fecha del tramo,
    // que sugeriría un aviso que todavía no se ha dado.
    detectada: "",
    resumen: openStreakSummary(streak, window),
  };
}

/* -------------------------------------------------------------------------- */
/* El informe                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Genera el informe completo: comprueba, lee y devuelve el CSV con su nombre.
 *
 * El orden de los tres pasos es el que hace que el fichero sea coherente: primero la
 * comprobación (que inserta lo que faltaba), después la lectura de la tabla (que tiene
 * que ver ya esas filas) y la de la ventana del ruleset de puntos (que tiene que ser la
 * misma con la que se acaba de evaluar). La lectura va con `readFromDatabase()` +
 * `unwrapRead()` porque un informe a medias no es un informe degradado: es uno falso.
 */
export async function buildAlertsReport(now: Date = new Date()): Promise<AlertsReport> {
  const evaluation = await evaluateAlerts({ full: true, now });
  const scoring = await readRuleset();

  const disparadas = unwrapRead(
    await readFromDatabase(REPORT_SCOPE, () =>
      db.alert.findMany({
        // El mismo orden que la pestaña, y con `id` de desempate por el mismo motivo
        // que allí: dos filas del mismo milisegundo tienen que tener orden estable.
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: ALERT_REPORT_SELECT,
      }),
    ),
    REPORT_SCOPE,
  );

  const disparada = disparadas.map(disparadaEnFila);
  // En el orden del motor (por jugador y luego por regla): el motor ya ha evaluado a
  // todos los aprobados en el mismo criterio que usaron las filas disparadas.
  const enCurso = evaluation.openStreaks.map((streak) => rachaEnFila(streak, scoring.window));

  const lines = [
    "sep=;",
    ...metadataRows({
      window: scoring.window,
      rulesetVersion: evaluation.alertsRulesetVersion,
      now,
      playersEvaluated: evaluation.playersEvaluated,
      alertsCreated: evaluation.alertsCreated,
    }),
    "",
    csvRow(COLUMNS),
    "",
    `Alertas disparadas (${disparada.length})`,
    ...csvFromRows(disparada),
    "",
    `Rachas abiertas en curso (${enCurso.length})`,
    ...csvFromRows(enCurso),
  ];

  return {
    filename: `alertas-liga-hispana-${reportDay(now)}.csv`,
    csv: BOM + lines.join(EOL) + EOL,
  };
}
