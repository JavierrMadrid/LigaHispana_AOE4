import type { Metadata } from "next";
import { revertMatchPoints, restoreMatchPoints } from "@/app/admin/actions";
import { ActionFeedbackProvider } from "@/components/action-feedback";
import { ConfirmAction } from "@/components/confirm-action";
import { EmptyState } from "@/components/empty-state";
import { ObjectiveIcon } from "@/components/objective-icon";
import { PageSizeSelect } from "@/components/page-size-select";
import { SortableHeaderLink } from "@/components/sortable-header";
import {
  getAdminMatchHistory,
  getAdminParticipants,
  type AdminMatchHistoryRow,
  type AdminObjectiveEvent,
} from "@/lib/admin";
import { requireAdmin } from "@/lib/auth";
import { describeMode, formatAbsoluteTime } from "@/lib/format";
import { OBJECTIVE_GROUP_LABELS } from "@/lib/objectives";
import { MatchHistoryFilters } from "./match-history-filters";
import { Pagination } from "../pagination";

export const metadata: Metadata = {
  title: { absolute: "Historial de partidas · Admin" },
};

/** `1 punto` / `2 puntos`: el plural importa en un registro que se lee. */
function puntos(count: number): string {
  return count === 1 ? "1 punto" : `${count} puntos`;
}

/**
 * Etiqueta y color de la columna de resultado.
 *
 * Va en su propia columna, y no solo dentro de la frase, porque la columna es lo que
 * permite recorrer el historial de un vistazo buscando «solo las que perdió» sin
 * tener que leer la descripción entera de cada fila. Es el mismo recurso que en
 * `/admin/acciones`: el color diferencia y la etiqueta confirma, para que el color no
 * sea lo único que transmite el dato.
 */
const RESULT_LABELS = { WIN: "Victoria", LOSS: "Derrota" } as const;

const RESULT_STYLES = {
  WIN: "border-win/40 text-win",
  LOSS: "border-loss/40 text-loss",
} as const;

/**
 * La marca de una fila de objetivo cumplido, en la misma columna.
 *
 * Un hito no es ni una victoria ni una derrota, pero desde fuera es lo que la
 * fila viene a contar, así que ocupa el mismo sitio y con el **oro de los
 * objetivos**: el mismo con el que el sitio viste las tarjetas de `/objetivos` y
 * el detalle desplegado en la clasificación. Así el panel se lee con el código
 * del resto de la web en vez de con una taxonomía propia.
 */
const OBJECTIVE_STYLE = "border-accent/40 text-accent";

/**
 * La etiqueta del formato de la partida, en un solo sitio.
 *
 * La usan la frase y la línea secundaria, y tienen que decir lo mismo: si la frase
 * dijera "ganó partida 2v2" y debajo pusiera "Por equipos", el historial estaría
 * contradiciéndose en la misma celda. `teamSize` es el recuento real de `rawJson` y
 * manda; `describeMode` es el respaldo para lo que el payload no permite asegurar.
 */
function formatLabel(row: AdminMatchHistoryRow): string {
  return row.teamSize ?? describeMode(row.mode, row.leaderboard);
}

/**
 * La frase de una fila de objetivo cumplido.
 *
 * El verbo va en pasado y sin gritar: el hito ya ocurrió en la fecha de la fila, no
 * es una celebración. No repite los puntos ni el grupo porque los pinta la línea
 * secundaria, y decirlos dos veces en la misma celda sobraría.
 */
function describeObjective(playerName: string, objective: AdminObjectiveEvent): string {
  return `${playerName} cumplió «${objective.label}»`;
}

/**
 * La frase de una partida en el historial.
 *
 * En un **1v1** se nombra al rival, que es lo que añade información: "ganó a X".
 *
 * En una partida **por equipos** no, y es importante: `Match` guarda un solo rival (el
 * primer jugador del equipo contrario), así que decir "ganó a X" en un 2v2 nombra a
 * uno de los dos y hace creer que era un 1v1. Se dice el **formato** en su lugar —
 * "ganó la partida 2v2"—, que es el dato que sí es cierto y completo. El tamaño sale
 * de `teamSize`, leído de `rawJson`, porque `leaderboard` publica `rm_team` sin decir
 * cuántos juegan.
 *
 * El sujeto siempre es el jugador de la liga. Una victoria dice cuánto sumó; una
 * derrota dice que sumó cero, que es el resultado real y no un dato que falte. Si la
 * API no dio el nombre del rival, la frase sigue siendo correcta sin él ("ganó la
 * partida") en vez de quedarse a medias ("ganó a ").
 *
 * Una partida revertida se describe sin cifra: el motor ya le ha puesto los puntos a
 * cero, así que afirmar "sin puntos" confundiría el estado actual con lo que valía. La
 * marca de revertida, en la misma columna, es la que aclara que esos puntos se
 * quitaron a mano.
 *
 * Un **objetivo cumplido** no tiene resultado de partida, así que se delega antes
 * de llegar a las ramas de `result`: sin esa salida temprana, `result === null`
 * haría que un hito se describiera como "una partida sin resultado resuelto".
 */
function describeResult(row: AdminMatchHistoryRow): string {
  if (row.objective !== null) {
    return describeObjective(row.playerName, row.objective);
  }

  const reverted = row.revertedAt !== null;

  if (row.result === null) {
    return `${row.playerName} tiene una partida sin resultado resuelto`;
  }

  const gano = row.result === "WIN";

  // `teamSize` manda sobre `describeMode` cuando existe: es el recuento real de
  // `rawJson`, no una etiqueta deducida. "1vs1" es individual; lo demás, por equipos.
  const formato = formatLabel(row);
  const individual = formato === "1vs1";

  const outcome = individual
    ? row.opponentName === null
      ? gano
        ? "ganó la partida"
        : "perdió la partida"
      : gano
        ? `ganó a ${row.opponentName}`
        : `perdió contra ${row.opponentName}`
    : gano
      ? `ganó partida ${formato}`
      : `perdió partida ${formato}`;

  if (reverted) {
    return `${row.playerName} ${outcome}`;
  }

  return gano
    ? `${row.playerName} ${outcome}: +${puntos(row.points)}`
    : `${row.playerName} ${outcome}: 0 puntos`;
}

/** Un valor de `searchParams` reducido a texto, para los enlaces de paginación. */
function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function MatchHistoryPage({ searchParams }: PageProps<"/admin/historial">) {
  await requireAdmin();

  const params = await searchParams;

  const [playersRead, history] = await Promise.all([
    getAdminParticipants(),
    getAdminMatchHistory(params),
  ]);

  const players =
    playersRead.status === "ok"
      ? playersRead.data.map((player) => ({ id: player.id, name: player.name }))
      : [];

  const query = {
    playerId: single(params.playerId),
    from: single(params.from),
    to: single(params.to),
    resultado: single(params.resultado),
    sort: single(params.sort),
    dir: single(params.dir),
    pageSize: single(params.pageSize),
  };
  const hasFilters =
    query.playerId !== undefined ||
    query.from !== undefined ||
    query.to !== undefined ||
    query.resultado !== undefined;

  // El filtro de resultado solo excluye los objetivos si es un valor real: el DAL
  // trata cualquier otra cosa como si no filtrara, y el mensaje de la tabla no puede
  // decir que se dejaron fuera los hitos cuando no se dejó fuera nada.
  const resultFilter = query.resultado === "WIN" || query.resultado === "LOSS";

  return (
    <div className="flex flex-col gap-6">
      <section>
        <h1 className="text-2xl font-semibold">Historial de partidas</h1>
        <p className="mt-1 max-w-[70ch] text-sm text-muted">
          Partidas clasificatorias y objetivos cumplidos, de lo más reciente a lo
          más antiguo; los objetivos que se resuelven en caliente se apuntan cuando
          termina el torneo. Revertir los puntos de una partida no la borra: la
          marca como no puntuable y se puede restaurar.
        </p>
      </section>

      {history.status === "degraded" ? (
        <EmptyState
          title="No se ha podido leer el historial"
          body="La base de datos no ha respondido. Vuelve a intentarlo en unos minutos."
        />
      ) : (
        <ActionFeedbackProvider>
          <div className="flex flex-col gap-4">
            <MatchHistoryFilters players={players} />

            {history.data.rows.length === 0 ? (
              <EmptyState
                title={
                  hasFilters
                    ? resultFilter
                      ? "Ninguna partida coincide con los filtros"
                      : "Ni partidas ni objetivos coinciden con los filtros"
                    : "Todavía no hay partidas ni objetivos cumplidos"
                }
                body={
                  hasFilters
                    ? resultFilter
                      ? "Prueba con otro jugador o amplía el rango de fechas. El filtro de fechas incluye el día final completo."
                      : "Prueba con otro jugador o amplía el rango de fechas. Los objetivos se filtran por la fecha en que se cumplieron y el día final entra completo."
                    : "Aquí aparecerán las partidas que cuentan para la clasificación y los objetivos cumplidos, de lo más reciente a lo más antiguo."
                }
              />
            ) : (
              <>
                <div className="overflow-x-auto overscroll-x-contain rounded-lg border border-line lg:max-h-[70vh] lg:overflow-y-auto">
                  <table className="w-full text-left text-sm">
                    <caption className="sr-only">
                      Partidas clasificatorias y objetivos cumplidos: fecha, resultado o
                      marca de objetivo, descripción con los puntos que aporta y, en las
                      partidas, la acción de revertir o restaurar sus puntos. Por debajo
                      de la pantalla mediana la fecha se lee dentro de la descripción.
                    </caption>
                    <thead className="bg-surface text-muted">
                      <tr>
                        <SortableHeaderLink
                          column="fecha"
                          label="Fecha"
                          sort={history.data.sort}
                          basePath="/admin/historial"
                          query={query}
                          className="hidden w-44 px-4 py-3 font-medium md:table-cell"
                        />
                        <SortableHeaderLink
                          column="resultado"
                          label="Resultado"
                          sort={history.data.sort}
                          basePath="/admin/historial"
                          query={query}
                          className="w-28 px-4 py-3 font-medium"
                        />
                        {/* La descripción es una frase montada en la interfaz y las
                            acciones no son un dato ordenable. */}
                        <th
                          scope="col"
                          className="bg-surface px-4 py-3 font-medium lg:sticky lg:top-0 lg:z-10"
                        >
                          Descripción
                        </th>
                        <th
                          scope="col"
                          className="bg-surface px-4 py-3 text-right font-medium lg:sticky lg:top-0 lg:z-10"
                        >
                          Acciones
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {history.data.rows.map((row) => {
                        const reverted = row.revertedAt !== null;
                        // Tres clases de fila, tres fondos: la partida normal va
                        // limpia, la revertida se apaga en gris y el objetivo se
                        // tiñe del oro de la liga. El chip y el icono confirman lo
                        // que el fondo ya insinúa, para que el color no sea la
                        // única señal.
                        const rowClassName =
                          row.objective !== null
                            ? "bg-accent/[0.06]"
                            : reverted
                              ? "bg-surface/40"
                              : undefined;

                        return (
                          <tr key={row.id} className={rowClassName}>
                            <td className="hidden whitespace-nowrap px-4 py-3 align-top text-muted md:table-cell">
                              <time
                                dateTime={row.startedAt.toISOString()}
                                title={formatAbsoluteTime(row.startedAt)}
                                className="tabular-nums"
                              >
                                {formatAbsoluteTime(row.startedAt)}
                              </time>
                            </td>

                            <td className="px-4 py-3 align-top">
                              {row.objective !== null ? (
                                <span
                                  className={`inline-block rounded-full border px-2 py-0.5 text-xs font-medium ${OBJECTIVE_STYLE}`}
                                >
                                  Objetivo
                                </span>
                              ) : row.result === null ? (
                                <span className="text-xs text-muted">—</span>
                              ) : (
                                <span
                                  className={`inline-block rounded-full border px-2 py-0.5 text-xs font-medium ${
                                    RESULT_STYLES[row.result]
                                  }`}
                                >
                                  {RESULT_LABELS[row.result]}
                                </span>
                              )}
                            </td>

                            <td className="px-4 py-3 align-top">
                              {/* La fecha es una columna secundaria: por debajo de `md`
                                  se lee aquí, bajo la descripción, en vez de forzar
                                  el scroll horizontal de una tabla de tres columnas. */}
                              <p className="mb-1 text-xs text-muted md:hidden">
                                <time
                                  dateTime={row.startedAt.toISOString()}
                                  className="tabular-nums"
                                >
                                  {formatAbsoluteTime(row.startedAt)}
                                </time>
                              </p>
                              {row.objective !== null ? (
                                <>
                                  <p className="flex items-start gap-2">
                                    <ObjectiveIcon
                                      option={row.objective}
                                      className="mt-0.5 size-5 shrink-0"
                                    />
                                    <span className="text-foreground">
                                      {describeResult(row)}
                                    </span>
                                  </p>
                                  <p className="mt-0.5 text-xs text-muted">
                                    {OBJECTIVE_GROUP_LABELS[row.objective.group]} ·{" "}
                                    <span className="font-medium tabular-nums text-accent">
                                      +{puntos(row.points)}
                                    </span>
                                  </p>
                                </>
                              ) : (
                                <>
                                  <p
                                    title={`Partida ${row.gameId}`}
                                    className={reverted ? "text-muted" : "text-foreground"}
                                  >
                                    {describeResult(row)}
                                  </p>
                                  <p className="mt-0.5 text-xs text-muted">
                                    {formatLabel(row)}
                                    {row.map !== null ? ` · ${row.map}` : ""}
                                  </p>
                                  {reverted && row.revertedAt !== null ? (
                                    <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                                      <span className="inline-block rounded-full border border-line-strong px-2 py-0.5 font-medium">
                                        Puntos revertidos
                                      </span>
                                      <span>el {formatAbsoluteTime(row.revertedAt)}</span>
                                    </p>
                                  ) : null}
                                </>
                              )}
                            </td>

                            <td className="px-4 py-3 text-right align-top">
                              {row.objective !== null ? (
                                // Un hito no tiene nada que revertir ni restaurar:
                                // esas acciones son de `Match`.
                                <span className="text-xs text-muted">—</span>
                              ) : reverted ? (
                                <ConfirmAction
                                  action={restoreMatchPoints}
                                  fields={{ matchId: row.id }}
                                  title="Restaurar puntos"
                                  body={
                                    <>
                                      La partida {row.gameId} de {row.playerName} volverá a
                                      contar en la clasificación con los puntos que le
                                      correspondan.
                                    </>
                                  }
                                  triggerLabel="Restaurar"
                                  triggerClassName="h-10 rounded-md border border-line-strong px-3 text-xs text-foreground transition-colors hover:border-accent/60 hover:text-accent"
                                  confirmLabel="Restaurar puntos"
                                  confirmPendingLabel="Restaurando…"
                                  confirmClassName="bg-accent text-accent-ink hover:bg-accent-strong"
                                />
                              ) : row.points > 0 ? (
                                <ConfirmAction
                                  action={revertMatchPoints}
                                  fields={{ matchId: row.id }}
                                  title="Revertir puntos"
                                  body={
                                    <>
                                      La partida {row.gameId} de {row.playerName} dejará de
                                      puntuar y saldrá de la clasificación, de los ratios
                                      y de los objetivos. Sigue en el histórico y se puede
                                      restaurar.
                                    </>
                                  }
                                  triggerLabel="Revertir"
                                  triggerClassName="h-10 rounded-md border border-loss/40 px-3 text-xs text-loss transition-colors hover:bg-loss/10"
                                  confirmLabel="Revertir puntos"
                                  confirmPendingLabel="Revirtiendo…"
                                  confirmClassName="bg-loss text-accent-ink hover:brightness-110"
                                />
                              ) : (
                                <span className="text-xs text-muted">—</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <PageSizeSelect />
                  <Pagination
                    page={history.data.page}
                    pageCount={history.data.pageCount}
                    shown={history.data.rows.length}
                    total={history.data.total}
                    basePath="/admin/historial"
                    query={query}
                  />
                </div>
              </>
            )}
          </div>
        </ActionFeedbackProvider>
      )}
    </div>
  );
}
