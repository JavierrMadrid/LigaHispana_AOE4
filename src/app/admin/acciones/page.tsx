import type { Metadata } from "next";
import type { AdminActionType } from "@/generated/prisma/enums";
import { ActionFeedbackProvider } from "@/components/action-feedback";
import { EmptyState } from "@/components/empty-state";
import { PageSizeSelect } from "@/components/page-size-select";
import { Pagination } from "@/components/pagination";
import { SortableHeaderLink } from "@/components/sortable-header";
import { getAdminActions } from "@/lib/admin";
import { isRevertibleActionType } from "@/lib/admin-revert";
import { getAdminAccess, requireAdmin } from "@/lib/auth";
import { formatAbsoluteTime } from "@/lib/format";
import { RevertButton } from "./revert-button";

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
  PLAYER_EDITED: "Edición de jugador",
  PLAYER_APPROVED: "Aprobación de jugador",
  PLAYER_REJECTED: "Rechazo de jugador",
  PLAYER_REMOVED: "Baja de jugador",
  MATCH_POINTS_REVERTED: "Puntos revertidos",
  MATCH_POINTS_RESTORED: "Puntos restaurados",
  ADMIN_ADDED: "Alta de admin",
  ADMIN_DEACTIVATED: "Baja de admin",
  ADMIN_REACTIVATED: "Reactivación de admin",
  ACTION_REVERTED: "Acción revertida",
  CONFIG_CHANGED: "Cambio de configuración",
};

/**
 * Color del distintivo por tipo. Cada tipo tiene su tono para poder escanear la
 * lista sin leer todas las frases: alta en neutro (es una anotación, no un
 * juicio), baja en el rojo de la casa, puntos revertidos en el oro de la liga y
 * puntos restaurados en el verde de lo que vuelve. Es la misma paleta del resto
 * del panel, no una taxonomía nueva.
 *
 * La edición comparte el tono neutro del alta: también es una anotación —el jugador
 * sigue en el torneo—, y darle un color propio haría que una fila de "corregir el
 * nombre" pesara más en la lista que un alta o una baja.
 *
 * Aprobar y rechazar sí deciden algo sobre un jugador, así que llevan el verde y el
 * rojo con los que `participant-status.ts` pinta el estado en el que lo dejan
 * ("Aprobado" / "Rechazado"): la misma decisión no puede verse de un color en el
 * listado de participantes y de otro aquí. Repiten, por tanto, el verde de los
 * puntos restaurados y el rojo de la baja —en los tres casos algo vuelve o se queda
 * fuera—, y quien separa un tipo de otro es la etiqueta; el color solo la refuerza.
 *
 * La gestión de admins sigue la misma lógica que la de jugadores: alta en neutro,
 * baja en el rojo y reactivación en el verde. Revertir una acción y cambiar la
 * configuración son anotaciones —no expulsan a nadie—, así que van en el mismo oro
 * de los puntos revertidos (la reversión) y en el neutro del alta (la configuración).
 */
const ACTION_STYLES: Record<AdminActionType, string> = {
  PLAYER_CREATED: "border-line-strong text-foreground",
  PLAYER_EDITED: "border-line-strong text-foreground",
  PLAYER_APPROVED: "border-win/40 text-win",
  PLAYER_REJECTED: "border-loss/40 text-loss",
  PLAYER_REMOVED: "border-loss/40 text-loss",
  MATCH_POINTS_REVERTED: "border-accent/40 text-accent",
  MATCH_POINTS_RESTORED: "border-win/40 text-win",
  ADMIN_ADDED: "border-line-strong text-foreground",
  ADMIN_DEACTIVATED: "border-loss/40 text-loss",
  ADMIN_REACTIVATED: "border-win/40 text-win",
  ACTION_REVERTED: "border-accent/40 text-accent",
  CONFIG_CHANGED: "border-line-strong text-foreground",
};

/** Un valor de `searchParams` reducido a texto, para los enlaces de paginación. */
function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function AdminActionsPage({ searchParams }: PageProps<"/admin/acciones">) {
  await requireAdmin();

  // El acceso ya está resuelto por `requireAdmin()`; se lee para decidir si esta
  // pantalla ofrece el botón de deshacer, que es solo del superadministrador.
  const isSuperadmin = (await getAdminAccess()) === "superadmin";

  const params = await searchParams;
  const actions = await getAdminActions(params);

  // El historial de acciones no tiene filtros, pero sí tamaño de página y orden: viajan
  // en la URL y hay que devolvérselos a la paginación, o al pasar de página se perderían.
  const query = {
    pageSize: single(params.pageSize),
    sort: single(params.sort),
    dir: single(params.dir),
  };

  // La página como dato, o `null` si la lectura degradó: tenerla aparte deja el
  // listado escrito una sola vez y con los tipos ya estrechados.
  const page = actions.status === "ok" ? actions.data : null;

  const listado =
    page === null ? null : (
      <>
        <div className="overflow-x-auto overscroll-x-contain rounded-lg border border-line lg:max-h-[70vh] lg:overflow-y-auto">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">
              Acciones de la organización: fecha, resumen de lo hecho con su tipo y
              correo del admin que la ejecutó. Por debajo de la pantalla mediana la
              fecha y el admin se leen bajo el resumen.
              {isSuperadmin
                ? " Hay además una columna con la acción de deshacer o la marca de que la fila ya está deshecha."
                : null}
            </caption>
            <thead className="bg-surface text-muted">
              <tr>
                <SortableHeaderLink
                  column="fecha"
                  label="Fecha"
                  sort={page.sort}
                  basePath="/admin/acciones"
                  query={query}
                  className="hidden w-44 px-4 py-3 font-medium md:table-cell"
                />
                <SortableHeaderLink
                  column="tipo"
                  label="Acción"
                  sort={page.sort}
                  basePath="/admin/acciones"
                  query={query}
                  className="px-4 py-3 font-medium"
                />
                <SortableHeaderLink
                  column="admin"
                  label="Admin"
                  sort={page.sort}
                  basePath="/admin/acciones"
                  query={query}
                  className="hidden px-4 py-3 font-medium lg:table-cell"
                />
                {isSuperadmin ? (
                  <th scope="col" className="px-4 py-3 text-right font-medium">
                    Deshacer
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {page.rows.map((action) => (
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

                  {isSuperadmin ? (
                    <td className="px-4 py-3 text-right align-top">
                      {action.revertedAt !== null ? (
                        <div className="flex flex-col items-end gap-1">
                          <span className="inline-block rounded-full border border-line-strong px-2 py-0.5 text-xs font-medium text-muted">
                            Deshecha
                          </span>
                          <span className="text-xs text-muted">
                            {action.revertedByEmail !== null ? (
                              <>
                                por <span className="break-all">{action.revertedByEmail}</span>
                                {" · "}
                              </>
                            ) : null}
                            el{" "}
                            <time
                              dateTime={action.revertedAt.toISOString()}
                              title={formatAbsoluteTime(action.revertedAt)}
                              className="tabular-nums"
                            >
                              {formatAbsoluteTime(action.revertedAt)}
                            </time>
                          </span>
                        </div>
                      ) : isRevertibleActionType(action.type) ? (
                        <RevertButton actionId={action.id} type={action.type} />
                      ) : (
                        <span className="text-xs text-muted">—</span>
                      )}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <PageSizeSelect />
          <Pagination
            page={page.page}
            pageCount={page.pageCount}
            shown={page.rows.length}
            total={page.total}
            basePath="/admin/acciones"
            query={query}
          />
        </div>
      </>
    );

  return (
    <div className="flex flex-col gap-6">
      <section>
        <h1 className="text-2xl font-semibold">Historial de acciones</h1>
        <p className="mt-1 max-w-[70ch] text-sm text-muted">
          Lo que la organización decide y hace en el panel, de lo más reciente a lo
          más antiguo. El texto de cada línea lo redacta la propia acción.
        </p>
      </section>

      {page === null ? (
        <EmptyState
          title="No se ha podido leer el historial"
          body="La base de datos no ha respondido. Vuelve a intentarlo en unos minutos."
        />
      ) : page.rows.length === 0 ? (
        <EmptyState
          title="Todavía no hay acciones registradas"
          body="Aquí se anotarán las altas, bajas y ediciones de jugadores, sus aprobaciones y rechazos, y los cambios de puntos de una partida, con quién los hizo."
        />
      ) : isSuperadmin ? (
        // La banda de avisos conserva el mensaje de la reversión aunque la fila
        // cambie de estado al re-renderizarse.
        <ActionFeedbackProvider>{listado}</ActionFeedbackProvider>
      ) : (
        listado
      )}
    </div>
  );
}
