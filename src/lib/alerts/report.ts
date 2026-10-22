import "server-only";

import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { readFromDatabase, unwrapRead } from "@/lib/db-errors";
import { readRuleset } from "@/lib/scoring";
import { evaluateAlerts } from "./evaluate";
import {
  alertRow,
  buildAlertsArchive,
  streakRow,
  type AlertReportRow,
  type AlertsReport,
} from "./report-archive";

/**
 * Informe descargable de las alertas de comportamiento: comprobación, lectura y archivo.
 *
 * ## Qué es y qué no es
 *
 * Es el documento que se le pasa a la organización para revisar una tanda de avisos, no
 * una pantalla: no está paginado, no tiene filtros y sale entero. Lo consume
 * `GET /admin/alertas/reporte`, detrás de `requireAdmin()`. El fichero en sí —tres CSV
 * estándar dentro de un ZIP— lo construye `report-archive.ts`, que es puro; aquí se
 * decide **qué** lleva dentro.
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
 * ## Las dos tablas del informe
 *
 * | Tabla | De dónde sale |
 * |---|---|
 * | alertas disparadas | de la tabla `Alert`, de la más reciente a la más antigua |
 * | rachas abiertas en curso | de `openStreaks`, el resultado del motor de esta misma pasada |
 *
 * Las rachas abiertas **no son alertas**: son tramos que todavía no han terminado y que
 * solo avisan cuando se rompen. Salen en su propio CSV y con `Estado` = "En curso"
 * para que nadie las cuente como avisos ya dados, ni como hallazgos: están para ver
 * hacia dónde va cada jugador, que es lo mismo que imprime `npm run alerts:check`.
 *
 * ## Nada se inventa
 *
 * Lo que el motor no da, se deja en blanco. Concretamente la fecha de la partida
 * ancla: sale de `details.anchorStartedAt`, que es un `Json` y puede ser de una versión
 * antigua del código, así que se valida con `anchorInstant()` en vez de castearse. Una
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
 * Genera el informe completo: comprueba, lee y devuelve el archivo con su nombre.
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

  const alerts: AlertReportRow[] = disparadas.map(alertRow);
  // En el orden del motor (por jugador y luego por regla): el motor ya ha evaluado a
  // todos los aprobados en el mismo criterio que usaron las filas disparadas.
  const openStreaks: AlertReportRow[] = evaluation.openStreaks.map((streak) =>
    streakRow(streak, scoring.window),
  );

  return buildAlertsArchive({
    window: scoring.window,
    rulesetVersion: evaluation.alertsRulesetVersion,
    now,
    playersEvaluated: evaluation.playersEvaluated,
    alertsCreated: evaluation.alertsCreated,
    alerts,
    openStreaks,
  });
}
