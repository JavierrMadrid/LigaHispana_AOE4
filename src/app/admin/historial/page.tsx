import type { Metadata } from "next";
import { revertMatchPoints, restoreMatchPoints } from "@/app/admin/actions";
import { ActionFeedbackProvider } from "@/components/action-feedback";
import { ConfirmAction } from "@/components/confirm-action";
import { EmptyState } from "@/components/empty-state";
import {
  getAdminMatchHistory,
  getAdminParticipants,
  type AdminMatchHistoryRow,
} from "@/lib/admin";
import { requireAdmin } from "@/lib/auth";
import { describeMode, formatAbsoluteTime } from "@/lib/format";
import { MatchHistoryFilters } from "./match-history-filters";
import { Pagination } from "../pagination";

export const metadata: Metadata = {
  title: { absolute: "Historial de partidas · Admin" },
};

/** `1 punto` / `10 puntos`: el plural importa en un registro que se lee. */
function puntos(count: number): string {
  return count === 1 ? "1 punto" : `${count} puntos`;
}

/**
 * La frase de una partida en el historial.
 *
 * La fila es la del jugador de la liga, así que el resultado manda la forma y el
 * sujeto siempre es él: una victoria dice a quién ganó y cuánto sumó; una
 * derrota dice contra quién perdió y deja claro que sumó cero, que es el
 * resultado real y no un dato que falte. Si la API no dio el nombre del rival, la
 * frase sigue siendo correcta sin él ("ganó la partida") en vez de quedarse a
 * medias ("ganó a ").
 *
 * Una partida revertida se describe sin cifra: el motor ya le ha puesto los
 * puntos a cero, así que afirmar "sin puntos" confundiría el estado actual con lo
 * que valía. La marca de revertida, en la misma celda, es la que aclara que esos
 * puntos se quitaron a mano.
 */
function describeResult(row: AdminMatchHistoryRow): string {
  const rival = row.opponentName;
  const reverted = row.revertedAt !== null;

  if (row.result === "WIN") {
    const outcome = rival === null ? "ganó la partida" : `ganó a ${rival}`;

    return reverted
      ? `${row.playerName} ${outcome}`
      : `${row.playerName} ${outcome}: +${puntos(row.points)}`;
  }

  if (row.result === "LOSS") {
    const outcome = rival === null ? "perdió la partida" : `perdió contra ${rival}`;

    return reverted ? `${row.playerName} ${outcome}` : `${row.playerName} ${outcome}: 0 puntos`;
  }

  return `${row.playerName} tiene una partida sin resultado resuelto`;
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
  };
  const hasFilters =
    query.playerId !== undefined || query.from !== undefined || query.to !== undefined;

  return (
    <div className="flex flex-col gap-6">
      <section>
        <h1 className="text-2xl font-semibold">Historial de partidas</h1>
        <p className="mt-1 max-w-[70ch] text-sm text-muted">
          Solo partidas clasificatorias, de la más reciente a la más antigua.
          Revertir los puntos no borra la partida: la marca como no puntuable y se
          puede restaurar cuando haga falta.
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
                    ? "Ninguna partida coincide con los filtros"
                    : "Todavía no hay partidas clasificatorias"
                }
                body={
                  hasFilters
                    ? "Prueba con otro jugador o amplía el rango de fechas. El filtro de fechas incluye el día final completo."
                    : "Aquí aparecerán las partidas que cuentan para la clasificación en cuanto el sincronizador las importe."
                }
              />
            ) : (
              <>
                <div className="overflow-x-auto overscroll-x-contain rounded-lg border border-line">
                  <table className="w-full text-left text-sm">
                    <caption className="sr-only">
                      Partidas clasificatorias: fecha, descripción con los puntos que
                      aporta y la acción de revertir o restaurar sus puntos. Por debajo
                      de la pantalla mediana la fecha se lee dentro de la descripción.
                    </caption>
                    <thead className="bg-surface text-muted">
                      <tr>
                        <th scope="col" className="hidden w-44 px-4 py-3 font-medium md:table-cell">
                          Fecha
                        </th>
                        <th scope="col" className="px-4 py-3 font-medium">
                          Descripción
                        </th>
                        <th scope="col" className="px-4 py-3 text-right font-medium">
                          Acciones
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {history.data.rows.map((row) => {
                        const reverted = row.revertedAt !== null;

                        return (
                          <tr key={row.id} className={reverted ? "bg-surface/40" : undefined}>
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
                              <p
                                title={`Partida ${row.gameId}`}
                                className={reverted ? "text-muted" : "text-foreground"}
                              >
                                {describeResult(row)}
                              </p>
                              <p className="mt-0.5 text-xs text-muted">
                                {describeMode(row.mode, row.leaderboard)}
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
                            </td>

                            <td className="px-4 py-3 text-right align-top">
                              {reverted ? (
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

                <Pagination
                  page={history.data.page}
                  pageCount={history.data.pageCount}
                  shown={history.data.rows.length}
                  total={history.data.total}
                  basePath="/admin/historial"
                  query={query}
                />
              </>
            )}
          </div>
        </ActionFeedbackProvider>
      )}
    </div>
  );
}
