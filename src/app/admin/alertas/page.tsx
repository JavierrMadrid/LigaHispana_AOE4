import type { Metadata } from "next";
import { AlertKind, AlertRule } from "@/generated/prisma/enums";
import { EmptyState } from "@/components/empty-state";
import { PageSizeSelect } from "@/components/page-size-select";
import { SortableHeaderLink } from "@/components/sortable-header";
import {
  getAdminAlertRules,
  getAdminAlerts,
  getAdminParticipants,
  type AdminAlertRow,
} from "@/lib/admin";
import { ALERT_KIND_LABELS, ALERT_RULE_LABELS, DEFAULT_ALERTS_RULESET } from "@/lib/alerts";
import { requireAdmin } from "@/lib/auth";
import { aoe4WorldProfileUrl, formatAbsoluteTime } from "@/lib/format";
import { AlertFilters } from "./alert-filters";
import { AlertRulesDialog } from "./alert-rules-dialog";
import { Pagination } from "../pagination";

export const metadata: Metadata = {
  title: { absolute: "Alertas · Admin" },
};

/** Un valor de `searchParams` reducido a texto, para los enlaces de paginación. */
function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Pestaña de alertas: avisos de comportamiento de los participantes.
 *
 * El motor de F9 escribe una fila en `Alert` cuando una racha se rompe o se cruza un
 * umbral, y aquí se leen **de la más reciente a la más antigua**, paginadas en servidor
 * como el resto del panel. Las cifras de las reglas no se escriben a mano: la ventana
 * "Reglas" las toma de los umbrales vivos, para que el copy no mienta si la organización
 * retoca `Setting["alerts.ruleset"]`.
 *
 * ## Filtros y orden
 *
 * La tabla tiene los mismos filtros que el historial —jugador, rango de fechas— más los
 * dos propios de las alertas: **regla** (las diez del enum) y **tipo** (las cuatro clases
 * de hallazgo). Todos viven en la URL, junto con el orden por columna
 * (`fecha`, `jugador`, `regla`, `sujeto`, `conteo`). No hay filtro por sujeto, detalle ni
 * conteo: el sujeto es un rival que puede no estar en la liga (no hay lista de la que
 * elegir), el detalle es una frase del motor y el conteo se escanea con la vista. Detalle
 * y distintivo de tipo tampoco son columnas ordenables, por el mismo motivo.
 *
 * El estado del sincronizador **no** está aquí: es salud del sistema y no una anomalía
 * de un jugador, y vive en `getSyncHealth()` y en el aviso de `/admin` (ver
 * `src/lib/admin.ts`).
 *
 * Una lectura `degraded` se pinta como "no se han podido leer", **nunca** como "no hay
 * alertas": un corte de la base dejaría la pantalla limpia y parecería que el torneo
 * está en orden, que es la afirmación más falsa que puede hacer esta pestaña. El informe
 * descargable y las reglas se siguen ofreciendo aunque la tabla degrade, porque son
 * acciones independientes de la lectura del listado.
 */
export default async function AlertsPage({ searchParams }: PageProps<"/admin/alertas">) {
  await requireAdmin();

  const params = await searchParams;

  const [alerts, rulesRead, participantsRead] = await Promise.all([
    getAdminAlerts(params),
    getAdminAlertRules(),
    getAdminParticipants(),
  ]);

  // Si los umbrales vivos no se pueden leer, la ventana de reglas cae a los valores del
  // código y lo dice. `readAlertsRuleset()` ya hace ese respaldo en el servidor, así que
  // esto solo cubre el fallo de la lectura entera.
  const thresholds =
    rulesRead.status === "ok" ? rulesRead.data.thresholds : DEFAULT_ALERTS_RULESET.thresholds;

  const players =
    participantsRead.status === "ok"
      ? participantsRead.data.map((player) => ({ id: player.id, name: player.name }))
      : [];

  // Las etiquetas salen del dominio de alertas (`ALERT_RULE_LABELS`, `ALERT_KIND_LABELS`) y
  // el valor que viaja a la URL es el literal del enum: se comparan literales, no etiquetas.
  const ruleOptions = Object.values(AlertRule).map((value) => ({
    value,
    label: ALERT_RULE_LABELS[value],
  }));
  const kindOptions = Object.values(AlertKind).map((value) => ({
    value,
    label: ALERT_KIND_LABELS[value],
  }));

  const query = {
    playerId: single(params.playerId),
    regla: single(params.regla),
    tipo: single(params.tipo),
    from: single(params.from),
    to: single(params.to),
    sort: single(params.sort),
    dir: single(params.dir),
    pageSize: single(params.pageSize),
  };
  const hasFilters =
    query.playerId !== undefined ||
    query.regla !== undefined ||
    query.tipo !== undefined ||
    query.from !== undefined ||
    query.to !== undefined;

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold">Alertas</h1>
          <p className="mt-1 max-w-[70ch] text-sm text-muted">
            Comportamientos anómalos detectados en las partidas clasificatorias y avisos
            sobre el estado del historial de los participantes, de lo más reciente a lo
            más antiguo. El informe descargable incluye además las rachas que siguen
            abiertas.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <AlertRulesDialog thresholds={thresholds} fallback={rulesRead.status !== "ok"} />
          <a
            href="/admin/alertas/reporte"
            download
            className="inline-flex h-10 items-center rounded-md bg-accent px-4 text-sm font-semibold text-accent-ink transition-colors hover:bg-accent-strong"
          >
            Descargar informe
          </a>
        </div>
      </section>

      {alerts.status === "degraded" ? (
        <EmptyState
          title="No se han podido leer las alertas"
          body="La base de datos no ha respondido. Vuelve a intentarlo en unos minutos."
        />
      ) : (
        <div className="flex flex-col gap-4">
          <AlertFilters
            players={players}
            ruleOptions={ruleOptions}
            kindOptions={kindOptions}
          />

          {alerts.data.rows.length === 0 ? (
            <EmptyState
              title={
                hasFilters
                  ? "Ninguna alerta coincide con los filtros"
                  : "Todavía no hay alertas"
              }
              body={
                hasFilters
                  ? "Prueba con otro jugador, otra regla o amplía el rango de fechas. El filtro de fechas incluye el día final completo."
                  : "El motor crea un aviso cuando una racha se rompe, se alcanza un umbral o cambia un estado comprobado (como el historial de partidas no público). Aquí aparecerán, de lo más reciente a lo más antiguo."
              }
            />
          ) : (
            <>
              <div className="overflow-x-auto overscroll-x-contain rounded-lg border border-line">
                <table className="w-full text-left text-sm">
                  <caption className="sr-only">
                    Alertas de comportamiento: fecha, jugador, regla, sujeto de la alerta
                    (rival o compañero), detalle del hallazgo y número de partidas. Por
                    debajo de la pantalla grande la fecha, el jugador, la regla y el sujeto
                    se leen bajo el detalle.
                  </caption>
                  <thead className="bg-surface text-muted">
                    <tr>
                      <SortableHeaderLink
                        column="fecha"
                        label="Fecha"
                        sort={alerts.data.sort}
                        basePath="/admin/alertas"
                        query={query}
                        className="hidden w-44 px-4 py-3 font-medium md:table-cell"
                      />
                      <SortableHeaderLink
                        column="jugador"
                        label="Jugador"
                        sort={alerts.data.sort}
                        basePath="/admin/alertas"
                        query={query}
                        className="hidden px-4 py-3 font-medium lg:table-cell"
                      />
                      <SortableHeaderLink
                        column="regla"
                        label="Regla"
                        sort={alerts.data.sort}
                        basePath="/admin/alertas"
                        query={query}
                        className="hidden px-4 py-3 font-medium lg:table-cell"
                      />
                      <SortableHeaderLink
                        column="sujeto"
                        label="Sujeto"
                        sort={alerts.data.sort}
                        basePath="/admin/alertas"
                        query={query}
                        className="hidden px-4 py-3 font-medium lg:table-cell"
                      />
                      {/* El detalle es la frase del motor y el distintivo de tipo no es
                          una columna: no se ordenan. */}
                      <th scope="col" className="px-4 py-3 font-medium">
                        Detalle
                      </th>
                      <SortableHeaderLink
                        column="conteo"
                        label="Conteo"
                        sort={alerts.data.sort}
                        basePath="/admin/alertas"
                        query={query}
                        align="right"
                        className="px-4 py-3 font-medium"
                      />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {alerts.data.rows.map((alert) => (
                      <AlertRow key={alert.id} alert={alert} />
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <PageSizeSelect />
                <Pagination
                  page={alerts.data.page}
                  pageCount={alerts.data.pageCount}
                  shown={alerts.data.rows.length}
                  total={alerts.data.total}
                  basePath="/admin/alertas"
                  query={query}
                />
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Una alerta disparada.
 *
 * El `summary` lo redactó el motor al escribir la fila (`alertSummary()`) y se pinta
 * **tal cual**: montarlo en el componente daría dos frases para el mismo hallazgo. Las
 * columnas de jugador, regla y sujeto existen para poder recorrer la lista en diagonal
 * (quién, de qué regla, contra quién) sin leer el detalle entero; en pantalla pequeña se
 * pliegan bajo el detalle, que es el patrón de las demás tablas del panel.
 *
 * El sujeto es un `profileId` de AoE4World y puede no estar en la liga, así que el nombre
 * guardado en la fila es la única vía para nombrarlo; si falta, se enlaza el perfil por
 * su id. La cuenta la pinta el motor en el `summary`, pero viaja también como columna
 * numérica para poder escanear magnitudes de un vistazo.
 */
function AlertRow({ alert }: { alert: AdminAlertRow }) {
  const playerUrl = aoe4WorldProfileUrl(alert.playerProfileId);
  const subjectUrl =
    alert.subjectProfileId === null ? null : aoe4WorldProfileUrl(alert.subjectProfileId);
  const subjectText =
    alert.subjectName ??
    (alert.subjectProfileId === null ? null : `Perfil ${alert.subjectProfileId}`);

  return (
    <tr>
      <td className="hidden whitespace-nowrap px-4 py-3 align-top text-muted md:table-cell">
        <time
          dateTime={alert.createdAt.toISOString()}
          title={formatAbsoluteTime(alert.createdAt)}
          className="tabular-nums"
        >
          {formatAbsoluteTime(alert.createdAt)}
        </time>
      </td>

      <td className="hidden px-4 py-3 align-top lg:table-cell">
        <a
          href={playerUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="block max-w-[12rem] truncate font-medium text-foreground underline-offset-4 transition-colors hover:text-accent hover:underline"
        >
          {alert.playerName}
        </a>
      </td>

      <td className="hidden px-4 py-3 align-top lg:table-cell">
        <span className="block text-foreground">{alert.ruleLabel}</span>
        <KindBadge kind={alert.kind} className="mt-1" />
      </td>

      <td className="hidden px-4 py-3 align-top lg:table-cell">
        {subjectUrl === null || subjectText === null ? (
          <span className="text-muted">—</span>
        ) : (
          <a
            href={subjectUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="block max-w-[10rem] truncate text-foreground underline-offset-4 transition-colors hover:text-accent hover:underline"
          >
            {subjectText}
          </a>
        )}
      </td>

      <td className="px-4 py-3 align-top">
        {/* La fecha es una columna secundaria: por debajo de `md` se lee aquí. */}
        <div className="mb-1 text-xs text-muted md:hidden">
          <time
            dateTime={alert.createdAt.toISOString()}
            className="tabular-nums"
          >
            {formatAbsoluteTime(alert.createdAt)}
          </time>
        </div>

        {/* Jugador, regla y sujeto se pliegan aquí por debajo de `lg`, en la misma
            fila informativa que las columnas de escritorio. */}
        <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted lg:hidden">
          <a
            href={playerUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-foreground underline-offset-4 transition-colors hover:text-accent hover:underline"
          >
            {alert.playerName}
          </a>
          <span aria-hidden="true">·</span>
          <span>{alert.ruleLabel}</span>
          {subjectText !== null ? (
            <>
              <span aria-hidden="true">·</span>
              <span>{subjectText}</span>
            </>
          ) : null}
        </div>

        <p className="text-foreground">{alert.summary}</p>

        <div className="mt-1 lg:hidden">
          <KindBadge kind={alert.kind} />
        </div>
      </td>

      <td className="px-4 py-3 text-right align-top font-medium tabular-nums text-foreground">
        {alert.count}
      </td>
    </tr>
  );
}

/** Cuándo salió la alerta, en un distintivo; la etiqueta sale del dominio de alertas. */
function KindBadge({ kind, className }: { kind: AdminAlertRow["kind"]; className?: string }) {
  return (
    <span
      className={`inline-block rounded-full border border-line-strong px-2 py-0.5 text-xs text-muted ${
        className ?? ""
      }`}
    >
      {ALERT_KIND_LABELS[kind]}
    </span>
  );
}
