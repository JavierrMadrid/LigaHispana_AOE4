import type { Metadata } from "next";
import type { AdminActionType } from "@/generated/prisma/enums";
import { EmptyState } from "@/components/empty-state";
import { getAdminActions } from "@/lib/admin";
import { requireAdmin } from "@/lib/auth";
import { formatAbsoluteTime } from "@/lib/format";
import { Pagination } from "../pagination";

export const metadata: Metadata = {
  title: { absolute: "Historial de acciones · Admin" },
};

/**
 * Etiqueta corta por tipo de acción. El texto largo lo pone `summary`, que se
 * pinta tal cual; esto solo es el distintivo que permite leer la fila de un
 * vistazo.
 */
const ACTION_LABELS: Record<AdminActionType, string> = {
  PLAYER_CREATED: "Alta de jugador",
  PLAYER_REMOVED: "Baja de jugador",
  MATCH_POINTS_REVERTED: "Puntos revertidos",
  MATCH_POINTS_RESTORED: "Puntos restaurados",
};

/**
 * Color del distintivo por tipo. Cada tipo tiene su tono para poder escanear la
 * lista sin leer todas las frases: alta en neutro (es una anotación, no un
 * juicio), baja en el rojo de la casa, puntos revertidos en el oro de la liga y
 * puntos restaurados en el verde de lo que vuelve. Es la misma paleta del resto
 * del panel, no una taxonomía nueva.
 */
const ACTION_STYLES: Record<AdminActionType, string> = {
  PLAYER_CREATED: "border-line-strong text-foreground",
  PLAYER_REMOVED: "border-loss/40 text-loss",
  MATCH_POINTS_REVERTED: "border-accent/40 text-accent",
  MATCH_POINTS_RESTORED: "border-win/40 text-win",
};

export default async function AdminActionsPage({ searchParams }: PageProps<"/admin/acciones">) {
  await requireAdmin();

  const params = await searchParams;
  const actions = await getAdminActions(params);

  return (
    <div className="flex flex-col gap-6">
      <section>
        <h1 className="text-2xl font-semibold">Historial de acciones</h1>
        <p className="mt-1 max-w-[70ch] text-sm text-muted">
          Lo que hace la organización en el panel, de lo más reciente a lo más
          antiguo. El texto de cada línea lo redacta la propia acción.
        </p>
      </section>

      {actions.status === "degraded" ? (
        <EmptyState
          title="No se ha podido leer el historial"
          body="La base de datos no ha respondido. Vuelve a intentarlo en unos minutos."
        />
      ) : actions.data.rows.length === 0 ? (
        <EmptyState
          title="Todavía no hay acciones registradas"
          body="Aquí se anotarán las altas y bajas de jugadores y los cambios de puntos de una partida, con quién los hizo."
        />
      ) : (
        <>
          <div className="overflow-x-auto overscroll-x-contain rounded-lg border border-line">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">
                Acciones de la organización: fecha, resumen de lo hecho con su tipo y
                correo del admin que la ejecutó. Por debajo de la pantalla mediana la
                fecha y el admin se leen bajo el resumen.
              </caption>
              <thead className="bg-surface text-muted">
                <tr>
                  <th scope="col" className="hidden w-44 px-4 py-3 font-medium md:table-cell">
                    Fecha
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Acción
                  </th>
                  <th scope="col" className="hidden px-4 py-3 font-medium lg:table-cell">
                    Admin
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {actions.data.rows.map((action) => (
                  <tr key={action.id}>
                    <td className="hidden whitespace-nowrap px-4 py-3 align-top text-muted md:table-cell">
                      <time
                        dateTime={action.createdAt.toISOString()}
                        title={formatAbsoluteTime(action.createdAt)}
                        className="tabular-nums"
                      >
                        {formatAbsoluteTime(action.createdAt)}
                      </time>
                    </td>

                    <td className="px-4 py-3 align-top">
                      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
                        {/* El `summary` ya viene redactado en español y con los
                            nombres resueltos: se pinta tal cual, sin reinterpretarlo. */}
                        <p className="min-w-0 text-foreground">{action.summary}</p>
                        <span
                          className={`inline-block shrink-0 rounded-full border px-2 py-0.5 text-xs ${
                            ACTION_STYLES[action.type]
                          }`}
                        >
                          {ACTION_LABELS[action.type]}
                        </span>
                      </div>

                      <div className="mt-1 flex flex-col gap-0.5 text-xs text-muted md:hidden">
                        <time
                          dateTime={action.createdAt.toISOString()}
                          className="tabular-nums"
                        >
                          {formatAbsoluteTime(action.createdAt)}
                        </time>
                        <span className="break-all">{action.actorEmail}</span>
                      </div>
                    </td>

                    <td className="hidden px-4 py-3 align-top text-muted lg:table-cell">
                      <span className="break-all">{action.actorEmail}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <Pagination
            page={actions.data.page}
            pageCount={actions.data.pageCount}
            shown={actions.data.rows.length}
            total={actions.data.total}
            basePath="/admin/acciones"
            query={{}}
          />
        </>
      )}
    </div>
  );
}
