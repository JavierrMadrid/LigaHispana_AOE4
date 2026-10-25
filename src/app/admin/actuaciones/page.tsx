import type { Metadata } from "next";
import Link from "next/link";
import { EmptyState } from "@/components/empty-state";
import { PageSizeSelect } from "@/components/page-size-select";
import { Pagination } from "@/components/pagination";
import { getAdminParticipants } from "@/lib/admin";
import { getAdminActs } from "@/lib/admin-acts-read";
import { requireAdmin } from "@/lib/auth";
import { formatAbsoluteTime } from "@/lib/format";
import { ActFilters } from "./act-filters";
import { AdminActKindBadge, AdminActStateBadge } from "./act-badges";

export const metadata: Metadata = {
  title: { absolute: "Actuaciones · Admin" },
};

/** Un valor de `searchParams` reducido a texto, para los enlaces de paginación. */
function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Expediente de actuaciones de la organización.
 *
 * Una actuación es una expulsión, una anulación de partidas o una reversión. Se
 * listan de la más reciente a la más antigua, paginadas en servidor, con filtros
 * por participante, tipo y estado. La **información privada no viaja en esta
 * pantalla**: `getAdminActs()` no la selecciona y solo se lee en el detalle.
 *
 * Un fallo de lectura se pinta como «no se ha podido leer», nunca como «no hay
 * actuaciones»: un corte de la base dejaría el expediente limpio y parecería que
 * la organización no ha tomado ninguna decisión.
 */
export default async function AdminActsPage({
  searchParams,
}: PageProps<"/admin/actuaciones">) {
  await requireAdmin();

  const params = await searchParams;

  const [acts, participantsRead] = await Promise.all([
    getAdminActs(params),
    getAdminParticipants(),
  ]);

  const players =
    participantsRead.status === "ok"
      ? participantsRead.data.map((player) => ({ id: player.id, name: player.name }))
      : [];

  const query = {
    kind: single(params.kind),
    state: single(params.state),
    playerId: single(params.playerId),
    pageSize: single(params.pageSize),
  };
  const hasFilters =
    query.kind !== undefined ||
    query.playerId !== undefined ||
    (query.state !== undefined && query.state !== "all");

  const page = acts.status === "ok" ? acts.data : null;

  const listado =
    page === null ? null : (
      <>
        <div className="overflow-x-auto overscroll-x-contain rounded-lg border border-line lg:max-h-[70vh] lg:overflow-y-auto">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">
              Actuaciones administrativas: fecha, participante, tipo, resumen con
              su razón pública, estado y correo de quien la creó. Por debajo de la
              pantalla grande la fecha, el participante, el tipo y el autor se leen
              bajo el resumen.
            </caption>
            <thead className="bg-surface text-muted">
              <tr>
                <th
                  scope="col"
                  className="hidden w-44 bg-surface px-4 py-3 font-medium md:table-cell lg:sticky lg:top-0 lg:z-10"
                >
                  Fecha
                </th>
                <th
                  scope="col"
                  className="hidden bg-surface px-4 py-3 font-medium lg:sticky lg:top-0 lg:z-10 lg:table-cell"
                >
                  Participante
                </th>
                <th
                  scope="col"
                  className="hidden bg-surface px-4 py-3 font-medium lg:sticky lg:top-0 lg:z-10 lg:table-cell"
                >
                  Tipo
                </th>
                <th
                  scope="col"
                  className="bg-surface px-4 py-3 font-medium lg:sticky lg:top-0 lg:z-10"
                >
                  Resumen
                </th>
                <th
                  scope="col"
                  className="bg-surface px-4 py-3 font-medium lg:sticky lg:top-0 lg:z-10"
                >
                  Estado
                </th>
                <th
                  scope="col"
                  className="hidden bg-surface px-4 py-3 font-medium lg:sticky lg:top-0 lg:z-10 xl:table-cell"
                >
                  Autor
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {page.rows.map((act) => (
                <tr key={act.id}>
                  <td className="hidden whitespace-nowrap px-4 py-3 align-top text-muted md:table-cell">
                    <time
                      dateTime={act.createdAt}
                      title={formatAbsoluteTime(new Date(act.createdAt))}
                      className="tabular-nums"
                    >
                      {formatAbsoluteTime(new Date(act.createdAt))}
                    </time>
                  </td>

                  <td className="hidden px-4 py-3 align-top lg:table-cell">
                    <div className="max-w-[14rem]">
                      {act.playerId === null ? (
                        <span className="block font-medium text-foreground">
                          {act.playerName}
                        </span>
                      ) : (
                        <Link
                          href={`/admin/actuaciones?playerId=${act.playerId}`}
                          className="block truncate font-medium text-foreground underline-offset-4 transition-colors hover:text-accent hover:underline"
                        >
                          {act.playerName}
                        </Link>
                      )}
                      <span className="mt-0.5 block text-xs text-muted">
                        AoE4World {act.profileId}
                      </span>
                      {act.playerId === null ? (
                        <span className="mt-1 block text-xs text-muted">
                          Ya no está en el panel
                        </span>
                      ) : null}
                    </div>
                  </td>

                  <td className="hidden px-4 py-3 align-top lg:table-cell">
                    <AdminActKindBadge kind={act.kind} />
                  </td>

                  <td className="px-4 py-3 align-top">
                    <div className="mb-1 text-xs text-muted md:hidden">
                      <time
                        dateTime={act.createdAt}
                        className="tabular-nums"
                      >
                        {formatAbsoluteTime(new Date(act.createdAt))}
                      </time>
                    </div>

                    <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted lg:hidden">
                      {act.playerId === null ? (
                        <span>{act.playerName}</span>
                      ) : (
                        <Link
                          href={`/admin/actuaciones?playerId=${act.playerId}`}
                          className="text-foreground underline-offset-4 transition-colors hover:text-accent hover:underline"
                        >
                          {act.playerName}
                        </Link>
                      )}
                      <span aria-hidden="true">·</span>
                      <span>AoE4World {act.profileId}</span>
                    </div>

                    <div className="mb-1 lg:hidden">
                      <AdminActKindBadge kind={act.kind} />
                    </div>

                    <Link
                      href={`/admin/actuaciones/${act.id}`}
                      className="line-clamp-2 max-w-[70ch] text-foreground underline-offset-4 transition-colors hover:text-accent hover:underline"
                    >
                      {act.summary}
                    </Link>
                    <p className="mt-1 line-clamp-1 max-w-[70ch] text-xs text-muted">
                      {act.publicReason}
                    </p>
                    <p className="mt-1 break-all text-xs text-muted xl:hidden">
                      {act.actorEmail}
                    </p>
                  </td>

                  <td className="px-4 py-3 align-top">
                    <AdminActStateBadge state={act.state} />
                  </td>

                  <td className="hidden px-4 py-3 align-top text-muted xl:table-cell">
                    <span className="break-all">{act.actorEmail}</span>
                  </td>
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
            basePath="/admin/actuaciones"
            query={query}
          />
        </div>
      </>
    );

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold">Actuaciones</h1>
          <p className="mt-1 max-w-[70ch] text-sm text-muted">
            El expediente de la organización: expulsiones, anulaciones de partidas
            y reversiones, con su razón pública, la información privada y quién las
            creó. Una actuación se aplica al guardarla y se anuncia en el canal de
            avisos y por privado al participante.
          </p>
        </div>

        <Link
          href="/admin/actuaciones/nueva"
          className="inline-flex h-10 shrink-0 items-center rounded-md bg-accent px-4 text-sm font-semibold text-accent-ink transition-colors hover:bg-accent-strong"
        >
          Nueva actuación
        </Link>
      </section>

      {page === null ? (
        <EmptyState
          title="No se ha podido leer el expediente"
          body="La base de datos no ha respondido. Vuelve a intentarlo en unos minutos; el listado no se muestra vacío a propósito, porque eso haría creer que no hay actuaciones."
        />
      ) : (
        <div className="flex flex-col gap-4">
          <ActFilters players={players} />

          {page.rows.length === 0 ? (
            <EmptyState
              title={
                hasFilters
                  ? "Ninguna actuación coincide con los filtros"
                  : "Todavía no hay actuaciones"
              }
              body={
                hasFilters
                  ? "Prueba con otro participante, otro tipo o quita los filtros. El expediente conserva también las actuaciones ya revertidas."
                  : "Aquí se anotarán las expulsiones, las anulaciones de partidas ganadas y las reversiones, con su razón pública y quién las creó."
              }
              action={
                <Link
                  href="/admin/actuaciones/nueva"
                  className="inline-flex h-10 items-center rounded-md bg-accent px-4 text-sm font-semibold text-accent-ink transition-colors hover:bg-accent-strong"
                >
                  {hasFilters ? "Crear una actuación" : "Crear la primera actuación"}
                </Link>
              }
            />
          ) : (
            listado
          )}
        </div>
      )}
    </div>
  );
}
