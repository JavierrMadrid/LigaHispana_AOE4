import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PLAYER_STATUS_LABELS, PLAYER_STATUS_STYLES } from "@/app/admin/participant-status";
import { EmptyState } from "@/components/empty-state";
import type { AdminActPlayerStatus } from "@/lib/admin-acts";
import { getAdminAct } from "@/lib/admin-acts-read";
import { getAdminAccess, requireAdmin } from "@/lib/auth";
import { aoe4WorldGameUrl, formatAbsoluteTime } from "@/lib/format";
import { AdminActKindBadge, AdminActStateBadge } from "../act-badges";

export const metadata: Metadata = {
  title: { absolute: "Actuación · Admin" },
};

function PlayerStatusBadge({ status }: { status: AdminActPlayerStatus }) {
  return (
    <span
      className={`inline-block whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium ${PLAYER_STATUS_STYLES[status]}`}
    >
      {PLAYER_STATUS_LABELS[status]}
    </span>
  );
}

/**
 * Detalle de una actuación.
 *
 * Es la única pantalla que lee la **información privada**. Por eso el bloque va
 * separado del resto y etiquetado: no se mezcla con la razón pública, que es la
 * que se anuncia. El listado no la selecciona siquiera.
 *
 * La pantalla separa los tres tipos porque cada uno tiene una consecuencia
 * distinta: una expulsión deja un estado antes y un estado ahora; una anulación
 * enseña las partidas que dejaron de sumar; una reversión enumera lo que deshizo
 * y recuerda que es final.
 */
export default async function AdminActPage({
  params,
}: PageProps<"/admin/actuaciones/[id]">) {
  await requireAdmin();

  const { id } = await params;
  const [read, access] = await Promise.all([getAdminAct(id), getAdminAccess()]);

  if (read.status === "degraded") {
    return (
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
        <Link
          href="/admin/actuaciones"
          className="text-sm text-muted underline-offset-4 transition-colors hover:text-accent hover:underline"
        >
          Volver a Actuaciones
        </Link>
        <h1 className="text-2xl font-semibold">Actuación</h1>
        <EmptyState
          title="No se ha podido leer la actuación"
          body="La base de datos no ha respondido. Vuelve a intentarlo en unos minutos; el detalle no se muestra vacío a propósito."
        />
      </div>
    );
  }

  if (read.data === null) {
    notFound();
  }

  const act = read.data;
  const isSuperadmin = access === "superadmin";
  const publicProfileUrl =
    act.playerId !== null && act.playerStatus === "APPROVED"
      ? `/detalle-jugador/${act.profileId}`
      : null;
  const matchesTitle =
    act.kind === "REVERSAL"
      ? "Partidas afectadas por lo revertido"
      : "Partidas anuladas";

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <Link
        href="/admin/actuaciones"
        className="text-sm text-muted underline-offset-4 transition-colors hover:text-accent hover:underline"
      >
        Volver a Actuaciones
      </Link>

      <header className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <AdminActKindBadge kind={act.kind} />
              <AdminActStateBadge state={act.state} />
            </div>
            <h1 className="mt-2 text-2xl font-semibold">{act.summary}</h1>
          </div>

          {isSuperadmin && act.state === "active" && act.playerId !== null ? (
            <Link
              href={`/admin/actuaciones/nueva?accion=REVERSAL&participante=${act.playerId}&actuacion=${act.id}`}
              className="inline-flex h-10 shrink-0 items-center rounded-md border border-accent/50 px-4 text-sm font-semibold text-accent transition-colors hover:bg-accent/10"
            >
              Revertir esta actuación
            </Link>
          ) : null}
        </div>

        <dl className="grid gap-4 rounded-lg border border-line bg-surface p-4 sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <dt className="text-xs text-muted">Participante</dt>
            <dd className="mt-1">
              <span className="block text-sm font-medium text-foreground">
                {act.playerName}
              </span>
              <span className="mt-0.5 block text-xs text-muted">
                AoE4World {act.profileId}
              </span>
              {act.playerStatus !== null ? (
                <span className="mt-1.5 inline-block">
                  <PlayerStatusBadge status={act.playerStatus} />
                </span>
              ) : null}
              {act.playerId === null ? (
                <span className="mt-1 block text-xs text-muted">
                  El jugador ya no está en el panel.
                </span>
              ) : null}
              {publicProfileUrl !== null ? (
                <Link
                  href={publicProfileUrl}
                  className="mt-1.5 inline-block text-xs text-accent underline-offset-4 transition-colors hover:text-accent-strong hover:underline"
                >
                  Ver ficha pública
                </Link>
              ) : null}
            </dd>
          </div>

          <div>
            <dt className="text-xs text-muted">Fecha de la actuación</dt>
            <dd className="mt-1 text-sm text-foreground">
              <time
                dateTime={act.createdAt}
                title={formatAbsoluteTime(new Date(act.createdAt))}
                className="tabular-nums"
              >
                {formatAbsoluteTime(new Date(act.createdAt))}
              </time>
            </dd>
          </div>

          <div>
            <dt className="text-xs text-muted">Autor</dt>
            <dd className="mt-1 break-all text-sm text-foreground">
              {act.actorEmail}
            </dd>
          </div>
        </dl>

        {act.reversedBy !== null ? (
          <p className="rounded-md border border-line bg-surface px-3 py-2 text-sm leading-relaxed text-muted">
            Esta actuación fue revertida por{" "}
            <Link
              href={`/admin/actuaciones/${act.reversedBy.actId}`}
              className="text-accent underline-offset-4 transition-colors hover:text-accent-strong hover:underline"
            >
              {act.reversedBy.actorEmail}
            </Link>{" "}
            el{" "}
            <time
              dateTime={act.reversedBy.createdAt}
              className="tabular-nums"
            >
              {formatAbsoluteTime(new Date(act.reversedBy.createdAt))}
            </time>
            .
          </p>
        ) : null}
      </header>

      <section className="rounded-lg border border-accent/30 bg-accent/[0.06] p-4 sm:p-5">
        <h2 className="text-sm font-medium text-accent">Razón pública</h2>
        <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-foreground">
          {act.publicReason}
        </p>
        <p className="mt-3 border-t border-accent/20 pt-2 text-xs text-muted">
          Es la razón que se anuncia en el canal de avisos y se envía por privado
          al participante.
        </p>
      </section>

      <section className="rounded-lg border border-line-strong bg-surface-raised p-4 sm:p-5">
        <h2 className="text-sm font-medium text-foreground">
          Información privada{" "}
          <span className="font-normal text-muted">· solo organización</span>
        </h2>
        {act.privateInfo === null ? (
          <p className="mt-2 text-sm text-muted">Sin información privada.</p>
        ) : (
          <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-foreground">
            {act.privateInfo}
          </p>
        )}
        <p className="mt-3 border-t border-line pt-2 text-xs text-muted">
          Nunca se publica ni se envía a Discord.
        </p>
      </section>

      {act.kind === "BAN" ? (
        <section className="rounded-lg border border-line bg-surface p-4 sm:p-5">
          <h2 className="text-sm font-medium text-foreground">
            Estado del participante
          </h2>
          <dl className="mt-3 grid gap-4 sm:grid-cols-2">
            <div>
              <dt className="text-xs text-muted">Antes de la expulsión</dt>
              <dd className="mt-1">
                {act.statusBefore !== null ? (
                  <PlayerStatusBadge status={act.statusBefore} />
                ) : (
                  <span className="text-sm text-muted">Sin dato</span>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Ahora</dt>
              <dd className="mt-1">
                {act.playerStatus !== null ? (
                  <PlayerStatusBadge status={act.playerStatus} />
                ) : (
                  <span className="text-sm text-muted">
                    El jugador ya no está en el panel
                  </span>
                )}
              </dd>
            </div>
          </dl>
        </section>
      ) : null}

      {act.kind !== "BAN" && act.matchCount > 0 ? (
        <section className="rounded-lg border border-line bg-surface p-4 sm:p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-medium text-foreground">{matchesTitle}</h2>
            <p className="text-xs text-muted">
              {act.matchCount === 1
                ? "1 partida afectada"
                : `${act.matchCount} partidas afectadas`}
            </p>
          </div>

          {act.matches.length < act.matchCount ? (
            <p className="mt-2 rounded-md border border-accent/40 bg-accent/5 px-3 py-2 text-sm leading-relaxed text-muted">
              Algunas de las partidas afectadas ya no están disponibles en el
              panel: se conservan {act.matches.length} de {act.matchCount}.
            </p>
          ) : null}

          {act.matches.length === 0 ? (
            <p className="mt-3 text-sm text-muted">
              No se han podido recuperar las partidas de esta actuación.
            </p>
          ) : (
            <div className="mt-3 overflow-x-auto overscroll-x-contain rounded-md border border-line bg-background">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">
                  Partidas afectadas: fecha, identificador en AoE4World, rival,
                  civilización, modo, mapa y puntos.
                </caption>
                <thead className="bg-surface text-muted">
                  <tr>
                    <th scope="col" className="whitespace-nowrap px-3 py-2 font-medium">
                      Fecha
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Partida
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Rival
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Civilización
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Modo
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Mapa
                    </th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">
                      Puntos
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {act.matches.map((match) => (
                    <tr key={match.id}>
                      <td className="whitespace-nowrap px-3 py-2 align-top text-muted">
                        <time
                          dateTime={match.startedAt}
                          title={formatAbsoluteTime(new Date(match.startedAt))}
                          className="tabular-nums"
                        >
                          {formatAbsoluteTime(new Date(match.startedAt))}
                        </time>
                      </td>
                      <td className="px-3 py-2 align-top">
                        <a
                          href={aoe4WorldGameUrl(act.profileId, match.gameId)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="break-all text-foreground underline-offset-4 transition-colors hover:text-accent hover:underline"
                        >
                          {match.gameId}
                        </a>
                      </td>
                      <td className="px-3 py-2 align-top">
                        {match.opponentName ?? "—"}
                      </td>
                      <td className="px-3 py-2 align-top">
                        {match.civLabel ?? match.civ ?? "—"}
                      </td>
                      <td className="px-3 py-2 align-top">
                        {match.modeLabel === "" ? "—" : match.modeLabel}
                      </td>
                      <td className="px-3 py-2 align-top">
                        {match.map ?? "—"}
                      </td>
                      <td className="px-3 py-2 text-right align-top font-medium tabular-nums text-accent">
                        +{match.points}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}

      {act.kind === "REVERSAL" ? (
        <section className="rounded-lg border border-line bg-surface p-4 sm:p-5">
          <h2 className="text-sm font-medium text-foreground">
            Actuaciones revertidas
          </h2>

          <div className="mt-3 rounded-md border border-accent/50 bg-accent/[0.07] px-3 py-2">
            <p className="text-sm font-medium text-foreground">
              Esta reversión es final: no se puede revertir.
            </p>
            <p className="mt-1 text-xs leading-relaxed text-muted">
              Si necesitas volver a aplicar la sanción, tendrás que crear otra
              actuación.
            </p>
          </div>

          {act.targets.length === 0 ? (
            <p className="mt-3 text-sm text-muted">
              No se han podido recuperar las actuaciones revertidas.
            </p>
          ) : (
            <ul className="mt-3 flex flex-col gap-2">
              {act.targets.map((target) => (
                <li
                  key={target.id}
                  className="rounded-md border border-line bg-background p-3"
                >
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <AdminActKindBadge kind={target.kind} />
                    <time
                      dateTime={target.createdAt}
                      className="text-xs text-muted tabular-nums"
                    >
                      {formatAbsoluteTime(new Date(target.createdAt))}
                    </time>
                  </div>
                  <Link
                    href={`/admin/actuaciones/${target.id}`}
                    className="mt-1.5 block text-sm font-medium text-foreground underline-offset-4 transition-colors hover:text-accent hover:underline"
                  >
                    {target.summary}
                  </Link>
                  <p className="mt-1 whitespace-pre-line text-sm leading-relaxed text-muted">
                    {target.publicReason}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </div>
  );
}
