import type { AlertKind, AlertRule } from "@/generated/prisma/enums";
import { isRecord } from "@/lib/json";
import { readInstant, type ScoringWindow } from "@/lib/ranked-match";
import type { OpenStreak } from "./compute";
import {
  alertSummary,
  ALERTS_RULE_LABEL,
  ALERT_KIND_LABELS,
  ALERT_RULE_LABELS,
  type AlertTriggerInput,
} from "./rules";
import { buildZip, type ZipEntry } from "./zip";

/**
 * El informe de alertas como archivo descargable: tres CSV estándar dentro de un ZIP.
 *
 * **Módulo puro**: no toca la base de datos, no sale a la red y no importa
 * `server-only`, así que `npm test` puede construir el archivo entero y abrirlo. Lo
 * que se lee de la base y la evaluación del motor viven en `report.ts`, que llama aquí
 * con los datos ya en la mano.
 *
 * ## Por qué tres CSV y no uno
 *
 * El informe anterior era un único CSV con `sep=;` y varios bloques pegados: metadatos,
 * título de bloque, tabla de alertas, otro título y tabla de rachas. Eso no es un CSV
 * (RFC 4180 habla de una tabla, no de un documento con secciones) y hacía que la
 * herramienta que lo abriera tuviera que adivinar dónde acaba cada cosa. Aquí cada
 * tabla es un fichero:
 *
 * | Fichero | Contenido |
 * |---|---|
 * | `resumen.csv` | los metadatos, en dos columnas `Campo,Valor` |
 * | `alertas-disparadas.csv` | las filas de `Alert`, con la cabecera de doce columnas |
 * | `rachas-abiertas.csv` | las rachas en curso, con la misma cabecera |
 *
 * Los dos últimos comparten columnas a propósito: son la misma tabla partida por
 * estado, y así se pueden apilar o comparar sin renombrar nada. Y un bloque sin filas
 * sale con su cabecera y nada más, no con una celda `(ninguna)`: una fila con una sola
 * celda en una tabla de doce columnas es un dato desalineado, y una cabecera sola se
 * entiende como "no hay ninguna".
 *
 * ## El separador es la coma
 *
 * CSV es coma y el entrecomillado de RFC 4180. Se fue el `sep=;` porque era una
 * extensión de Excel que ningún otro lector entiende, y obligaba a que cada celda con
 * coma se rompiera. Lo que lleva coma, comilla o salto de línea va entre comillas
 * dobles, con las comillas del interior duplicadas, y el fichero lleva BOM UTF-8 para
 * que Excel no abra los acentos como caracteres mal codificados.
 */

/** Una entrada del ZIP: el nombre del CSV y su texto completo, BOM incluido. */
export type AlertsArchiveFile = {
  name: string;
  csv: string;
};

/** El informe listo para descargar. */
export type AlertsReport = {
  /** Nombre del fichero, con el día de generación (`alertas-liga-hispana-AAAA-MM-DD.zip`). */
  filename: string;
  /** El ZIP entero, con los tres CSV dentro. */
  bytes: Uint8Array<ArrayBuffer>;
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
 * porque el destino es una celda de una hoja de cálculo y no un texto junto a otros: con
 * los estilos "cortos" de `es-ES` salen el año de dos dígitos ("21/9/26, 22:43"), que
 * ordena mal.
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
 * la fecha y la hora ("21/09/2026, 22:43"), y esa coma dentro de una celda acabaría
 * pidiendo comillas en todas las fechas del fichero. Con las partes se escribe el formato
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
 * fichero y la fecha del resumen tienen que ser el mismo día: a las 00:30 en Madrid
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
 *
 * Lo comparten el informe (para la celda "Fecha de partida") y el panel
 * (`admin.ts`, para el ancla de la alerta), para que la fila que se pinta y la que
 * se descarga lean el JSON con el mismo criterio.
 */
export function anchorInstant(details: unknown): Date | null {
  if (!isRecord(details) || typeof details.anchorStartedAt !== "string") {
    return null;
  }

  return readInstant(details.anchorStartedAt);
}

/* -------------------------------------------------------------------------- */
/* El CSV                                                                      */
/* -------------------------------------------------------------------------- */

const SEPARATOR = ",";

/** RFC 4180 pide CRLF, y además es lo que espera cualquier hoja de cálculo. */
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
 * manda RFC 4180 y no ensucia las celdas que no lo necesitan. Un campo vacío se escribe
 * vacío, no entrecomillado.
 */
function csvField(value: string | number): string {
  const text = String(value);

  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csvRow(fields: readonly (string | number)[]): string {
  return fields.map(csvField).join(SEPARATOR);
}

/**
 * Un CSV completo: BOM, filas con CRLF y un CRLF al final.
 *
 * `rows` nunca viene vacío —todas las tablas llevan al menos su cabecera—, así que el
 * fichero siempre acaba en salto de línea y ninguna herramienta lee una última fila
 * partida.
 */
function csvDocument(rows: readonly (readonly (string | number)[])[]): string {
  return BOM + rows.map(csvRow).join(EOL) + EOL;
}

/** Cabecera de columnas de las dos tablas de filas. El orden es el contrato del fichero. */
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
export type AlertReportRow = {
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
 * Los `ALERT_KIND_LABELS` describen **cuándo se detectó**, así que ninguno le
 * sirve a un tramo que todavía no ha avisado: aquí va lo que es, una racha en curso.
 */
const TIPO_EN_CURSO = "Racha en curso";

function rowFields(row: AlertReportRow): (string | number)[] {
  return [
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
  ];
}

/* -------------------------------------------------------------------------- */
/* Las filas                                                                   */
/* -------------------------------------------------------------------------- */

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

/**
 * Lo que trae una fila de `Alert` para el informe.
 *
 * Es la forma que devuelve la consulta de `report.ts`, declarada aquí y no importada de
 * Prisma para que este módulo siga siendo puro.
 */
export type AlertReportSource = {
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
};

/** Una alerta disparada, tal y como está en la tabla. */
export function alertRow(row: AlertReportSource): AlertReportRow {
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
export function streakRow(streak: OpenStreak, window: ScoringWindow): AlertReportRow {
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
/* Los dos CSV de filas y el de metadatos                                      */
/* -------------------------------------------------------------------------- */

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

/** Las seis filas de `Campo,Valor` que describen la tanda. */
function metadataRows(input: {
  window: ScoringWindow;
  rulesetVersion: number;
  now: Date;
  playersEvaluated: number;
  alertsCreated: number;
}): (string | number)[][] {
  return [
    ["Informe de alertas de comportamiento", ALERTS_RULE_LABEL],
    // La notación es la del resto del proyecto: `[from, to)` sobre `Match.startedAt`, con
    // el límite superior excluido. La etiqueta lleva una coma, así que se entrecomilla.
    ["Ventana del torneo [inicio, fin)", windowText(input.window)],
    ["Versión de las reglas", String(input.rulesetVersion)],
    ["Generado", `${formatInstant(input.now)} (hora de ${TIME_ZONE})`],
    ["Jugadores comprobados", String(input.playersEvaluated)],
    ["Alertas nuevas en esta comprobación", String(input.alertsCreated)],
  ];
}

/** Nombre de cada CSV dentro del ZIP. */
export const ALERTS_ARCHIVE_SUMMARY = "resumen.csv";
export const ALERTS_ARCHIVE_ALERTS = "alertas-disparadas.csv";
export const ALERTS_ARCHIVE_STREAKS = "rachas-abiertas.csv";

/** Todo lo que hace falta para escribir el informe, ya calculado. */
export type AlertsArchiveInput = {
  window: ScoringWindow;
  rulesetVersion: number;
  now: Date;
  playersEvaluated: number;
  alertsCreated: number;
  /** Alertas disparadas, en el orden en que se quieren escribir. */
  alerts: readonly AlertReportRow[];
  /** Rachas en curso, en el orden del motor. */
  openStreaks: readonly AlertReportRow[];
};

/**
 * Los tres CSV, como texto. Es la mitad pura del archivo y la que se puede mirar a ojo.
 *
 * No hay línea de título de bloque en ningún sitio: el nombre del fichero ya dice qué
 * tabla es, y un título dentro del CSV sería una fila de una celda en medio de una
 * tabla de doce columnas.
 */
export function reportCsvFiles(input: AlertsArchiveInput): AlertsArchiveFile[] {
  return [
    {
      name: ALERTS_ARCHIVE_SUMMARY,
      csv: csvDocument([["Campo", "Valor"], ...metadataRows(input)]),
    },
    {
      name: ALERTS_ARCHIVE_ALERTS,
      csv: csvDocument([COLUMNS, ...input.alerts.map(rowFields)]),
    },
    {
      name: ALERTS_ARCHIVE_STREAKS,
      csv: csvDocument([COLUMNS, ...input.openStreaks.map(rowFields)]),
    },
  ];
}

/**
 * El informe completo: los tres CSV dentro de un ZIP con el día de generación.
 *
 * El ZIP va sin comprimir a propósito (ver `zip.ts`): el texto de tres tablas es pequeño
 * y el método *store* quita la única pieza que habría que implementar a mano con cuidado.
 */
export function buildAlertsArchive(input: AlertsArchiveInput): AlertsReport {
  const encoder = new TextEncoder();

  const entries: ZipEntry[] = reportCsvFiles(input).map((file) => ({
    name: file.name,
    bytes: encoder.encode(file.csv),
  }));

  return {
    filename: `alertas-liga-hispana-${reportDay(input.now)}.zip`,
    bytes: buildZip(entries, input.now),
  };
}
