import { describe, expect, it } from "vitest";

import type { OpenStreak } from "@/lib/alerts/compute";
import {
  alertRow,
  ALERTS_ARCHIVE_ALERTS,
  ALERTS_ARCHIVE_STREAKS,
  ALERTS_ARCHIVE_SUMMARY,
  buildAlertsArchive,
  reportCsvFiles,
  streakRow,
  type AlertReportSource,
  type AlertsArchiveInput,
} from "@/lib/alerts/report-archive";

/**
 * El informe descargable: los tres CSV y el ZIP que los envuelve.
 *
 * Lo que se prueba es el **formato**, que es lo que el usuario reportó roto: coma de
 * RFC 4180, sin `sep=;`, comillas duplicadas, BOM y CRLF, un fichero por tabla, y un ZIP
 * del que se puede recuperar el texto tal cual. El orden de las columnas también, porque
 * es el contrato que lee quien abra el fichero con un script.
 */

const VENTANA = { from: "2026-09-01T00:00:00.000Z", to: "2026-10-15T00:00:00.000Z" };
const AHORA = new Date("2026-10-20T21:05:00.000Z");

const BOM = "\uFEFF";
const CRLF = "\r\n";

const CABECERA =
  "Estado,Jugador,Perfil,Regla,Tipo,Sujeto,Conteo,Umbral,Partida,Fecha de partida,Detectada,Resumen";

const SUJETO: OpenStreak = {
  playerId: "jugador-alertas",
  playerProfileId: 9_100_001,
  playerName: "Jugador",
  rule: "REPEATED_OPPONENT_STREAK",
  subject: { key: "92000004", profileId: 9_200_004, name: "Rival Externo" },
  count: 2,
  threshold: 3,
  lastGameId: "800-006",
  lastStartedAt: "2026-10-18T18:00:00.000Z",
};

function fuente(overrides: Partial<AlertReportSource> = {}): AlertReportSource {
  return {
    rule: "REPEATED_OPPONENT_STREAK",
    kind: "STREAK_CLOSED",
    count: 3,
    threshold: 3,
    anchorGameId: "800-004",
    summary: "Tres partidas seguidas contra Rival Externo",
    createdAt: new Date("2026-10-18T10:00:00.000Z"),
    details: { anchorStartedAt: "2026-10-17T18:00:00.000Z" },
    subjectName: "Rival Externo",
    subjectProfileId: 9_200_004,
    player: { name: "Jugador", profileId: 9_100_001 },
    ...overrides,
  };
}

function entrada(overrides: Partial<AlertsArchiveInput> = {}): AlertsArchiveInput {
  return {
    window: VENTANA,
    rulesetVersion: 1,
    now: AHORA,
    playersEvaluated: 32,
    alertsCreated: 2,
    alerts: [alertRow(fuente())],
    openStreaks: [streakRow(SUJETO, VENTANA)],
    ...overrides,
  };
}

/** El CSV de un fichero del informe, por nombre. */
function csvDe(input: AlertsArchiveInput, name: string): string {
  const file = reportCsvFiles(input).find((candidate) => candidate.name === name);

  if (file === undefined) {
    throw new Error(`Falta el fichero ${name} en el informe`);
  }

  return file.csv;
}

/** Las líneas del CSV, sin el BOM de la primera. */
function lineas(csv: string): string[] {
  const texto = csv.startsWith(BOM) ? csv.slice(1) : csv;

  return texto.split(CRLF).slice(0, -1);
}

describe("reportCsvFiles", () => {
  it("son tres ficheros con los nombres esperados y todos acaban en CRLF", () => {
    const files = reportCsvFiles(entrada());

    expect(files.map((file) => file.name)).toEqual([
      ALERTS_ARCHIVE_SUMMARY,
      ALERTS_ARCHIVE_ALERTS,
      ALERTS_ARCHIVE_STREAKS,
    ]);
    expect(files.map((file) => file.name)).toEqual([
      "resumen.csv",
      "alertas-disparadas.csv",
      "rachas-abiertas.csv",
    ]);

    for (const file of files) {
      expect(file.csv.startsWith(BOM)).toBe(true);
      expect(file.csv.endsWith(CRLF)).toBe(true);
    }
  });

  it("usa la coma y no deja rastro de sep=; ni de títulos de bloque", () => {
    const csv = csvDe(entrada(), ALERTS_ARCHIVE_ALERTS);

    expect(csv).not.toContain("sep=;");
    expect(lineas(csv)[0]).toBe(CABECERA);
    // El título de bloque del informe anterior era una fila de una celda con el
    // recuento; ahora ese recuento no vive dentro de la tabla.
    expect(csv).not.toContain("(ninguna)");
    expect(csv).not.toContain("Alertas disparadas (");
  });

  it("el resumen lleva su cabecera Campo,Valor y la ventana entrecomillada por la coma", () => {
    const lineasResumen = lineas(csvDe(entrada(), ALERTS_ARCHIVE_SUMMARY));

    expect(lineasResumen[0]).toBe("Campo,Valor");
    expect(lineasResumen).toContain(
      '"Ventana del torneo [inicio, fin)",01/09/2026 02:00 → 15/10/2026 02:00',
    );
    expect(lineasResumen).toContain("Versión de las reglas,1");
    expect(lineasResumen).toContain("Generado,20/10/2026 23:05 (hora de Europe/Madrid)");
    expect(lineasResumen).toContain("Jugadores comprobados,32");
    expect(lineasResumen).toContain("Alertas nuevas en esta comprobación,2");
  });

  it("entrecomilla lo que lleva coma, comilla o salto, y duplica las comillas", () => {
    const csv = csvDe(
      entrada({
        alerts: [
          alertRow(fuente({ summary: 'Con "comillas", coma\ny salto' })),
          alertRow(fuente({ summary: "Sin nada que entrecomillar" })),
        ],
      }),
      ALERTS_ARCHIVE_ALERTS,
    );

    // El campo incómodo va entre comillas dobles y las de dentro se duplican; el salto
    // de línea queda dentro del campo, así que la fila ocupa dos líneas del fichero.
    expect(csv).toContain('"Con ""comillas"", coma\ny salto"');
    expect(csv).toContain("Sin nada que entrecomillar" + CRLF);
  });

  it("la tabla de alertas lleva las doce columnas en el orden del contrato", () => {
    // Una regla y un tipo sin comas en la etiqueta, para poder comparar la fila entera
    // campo a campo; que una etiqueta con coma se entrecomille ya lo prueba el caso de
    // arriba.
    const fila = lineas(
      csvDe(
        entrada({
          alerts: [
            alertRow(
              fuente({
                rule: "SHORT_MATCH_STREAK",
                kind: "TOTAL_REACHED",
                summary: "Cinco partidas cortas acumuladas",
              }),
            ),
          ],
        }),
        ALERTS_ARCHIVE_ALERTS,
      ),
    )[1];

    expect(fila.split(",")).toEqual([
      "Disparada",
      "Jugador",
      "9100001",
      "Partidas cortas seguidas",
      "Acumulado alcanzado",
      "Rival Externo",
      "3",
      "3",
      "800-004",
      "17/10/2026 20:00",
      "18/10/2026 12:00",
      "Cinco partidas cortas acumuladas",
    ]);
  });

  it("las rachas abiertas van en su CSV, marcadas en curso y sin fecha de detección", () => {
    const lineasRachas = lineas(csvDe(entrada(), ALERTS_ARCHIVE_STREAKS));

    expect(lineasRachas[0]).toBe(CABECERA);
    expect(lineasRachas[1]).toContain("En curso,Jugador,9100001");
    expect(lineasRachas[1]).toContain(
      ",Racha en curso,Rival Externo,2,3,800-006,18/10/2026 20:00,",
    );
  });

  it("un bloque sin filas sale con la cabecera y nada más", () => {
    const vacio = entrada({ alerts: [], openStreaks: [] });

    expect(lineas(csvDe(vacio, ALERTS_ARCHIVE_ALERTS))).toEqual([CABECERA]);
    expect(lineas(csvDe(vacio, ALERTS_ARCHIVE_STREAKS))).toEqual([CABECERA]);
  });

  it("una alerta sin partida ancla deja las dos celdas del ancla en blanco", () => {
    const fila = lineas(
      csvDe(
        entrada({
          alerts: [
            alertRow(
              fuente({
                rule: "SHORT_MATCH_STREAK",
                kind: "TOTAL_REACHED",
                anchorGameId: null,
                details: { anchorStartedAt: "ayer" },
                summary: "Cinco partidas cortas acumuladas",
              }),
            ),
          ],
        }),
        ALERTS_ARCHIVE_ALERTS,
      ),
    )[1];

    // Ni un `gameId` ni una fecha que no se puede leer: dos celdas vacías en vez de un
    // dato inventado.
    expect(fila.split(",").slice(8, 10)).toEqual(["", ""]);
  });
});

describe("buildAlertsArchive", () => {
  it("el nombre del fichero lleva el día de Madrid y la extensión zip", () => {
    expect(buildAlertsArchive(entrada()).filename).toBe("alertas-liga-hispana-2026-10-20.zip");
  });

  it("el ZIP contiene los tres CSV con su texto intacto", () => {
    const input = entrada();
    const report = buildAlertsArchive(input);

    // El ZIP va sin comprimir, así que el texto de los CSV está literalmente dentro y se
    // puede comprobar sin descomprimir nada.
    const contenido = new TextDecoder().decode(report.bytes);
    const files = reportCsvFiles(input);

    expect(contenido.startsWith("PK\u0003\u0004")).toBe(true);

    for (const file of files) {
      expect(contenido).toContain(file.name);
      expect(contenido).toContain(file.csv);
    }
  });
});
