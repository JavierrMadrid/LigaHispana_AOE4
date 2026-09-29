import type { Metadata } from "next";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { PlayerForm } from "./player-form";
import { approvePlayer, deletePlayer, rejectPlayer } from "./actions";

export const metadata: Metadata = {
  title: { absolute: "Jugadores · Admin" },
};

const statusStyles: Record<string, string> = {
  APPROVED: "border-emerald-500/40 text-emerald-300",
  PENDING: "border-accent/40 text-accent",
  REJECTED: "border-red-500/40 text-red-300",
};

const statusLabels: Record<string, string> = {
  APPROVED: "Aprobado",
  PENDING: "Pendiente",
  REJECTED: "Rechazado",
};

export default async function PlayersPage() {
  await requireAdmin();

  const players = await db.player.findMany({
    orderBy: [{ status: "asc" }, { name: "asc" }],
  });

  return (
    <div className="flex flex-col gap-8">
      <section>
        <h1 className="text-2xl font-semibold">Jugadores</h1>
        <p className="mt-1 text-sm text-muted">
          {players.length} {players.length === 1 ? "registro" : "registros"}
        </p>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-medium">Añadir jugador</h2>
        <PlayerForm />
      </section>

      <section>
        <h2 className="mb-3 text-lg font-medium">Lista</h2>

        {players.length === 0 ? (
          <p className="rounded-lg border border-line bg-surface p-4 text-sm text-muted">
            Todavía no hay jugadores registrados.
          </p>
        ) : (
          <div className="overflow-x-auto overscroll-x-contain rounded-lg border border-line">
            {/* En móvil la tabla se queda con el nombre y las acciones; Profile
                ID, Twitch, contacto y estado se leen bajo el nombre, en la misma
                fila, en vez de comprimir siete columnas. A partir de `lg`
                vuelven todas. */}
            <table className="w-full text-left text-sm">
              <thead className="bg-surface text-muted">
                <tr>
                  <th scope="col" className="hidden px-4 py-3 font-medium lg:table-cell">#</th>
                  <th scope="col" className="px-4 py-3 font-medium">Nombre</th>
                  <th scope="col" className="hidden px-4 py-3 font-medium lg:table-cell">Profile ID</th>
                  <th scope="col" className="hidden px-4 py-3 font-medium lg:table-cell">Twitch</th>
                  <th scope="col" className="hidden px-4 py-3 font-medium lg:table-cell">Contacto</th>
                  <th scope="col" className="hidden px-4 py-3 font-medium lg:table-cell">Estado</th>
                  <th scope="col" className="px-4 py-3 font-medium">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {players.map((player, index) => (
                  <tr key={player.id}>
                    <td className="hidden px-4 py-3 tabular-nums text-muted lg:table-cell">
                      {index + 1}
                    </td>
                    <td className="px-4 py-3">
                      <span className="block break-words font-medium text-foreground">
                        {player.name}
                      </span>
                      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted lg:hidden">
                        <span
                          className={`inline-block rounded-full border px-2 py-0.5 font-medium ${statusStyles[player.status]}`}
                        >
                          {statusLabels[player.status]}
                        </span>
                        <span className="tabular-nums">Profile ID {player.profileId}</span>
                        {player.twitchChannel !== null ? (
                          <span className="break-all">Twitch {player.twitchChannel}</span>
                        ) : null}
                        {player.contactEmail !== null ? (
                          <span className="break-all">{player.contactEmail}</span>
                        ) : null}
                      </div>
                    </td>
                    <td className="hidden px-4 py-3 tabular-nums text-muted lg:table-cell">
                      {player.profileId}
                    </td>
                    <td className="hidden px-4 py-3 text-muted lg:table-cell">
                      {player.twitchChannel === null ? (
                        "—"
                      ) : (
                        <span className="block max-w-[8rem] truncate" title={player.twitchChannel}>
                          {player.twitchChannel}
                        </span>
                      )}
                    </td>
                    <td className="hidden px-4 py-3 text-muted lg:table-cell">
                      {player.contactEmail === null ? (
                        "—"
                      ) : (
                        <span className="block max-w-[14rem] truncate" title={player.contactEmail}>
                          {player.contactEmail}
                        </span>
                      )}
                    </td>
                    <td className="hidden px-4 py-3 lg:table-cell">
                      <span
                        className={`inline-block rounded-full border px-2 py-0.5 text-xs ${statusStyles[player.status]}`}
                      >
                        {statusLabels[player.status]}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        {player.status !== "APPROVED" ? (
                          <form action={approvePlayer}>
                            <input
                              type="hidden"
                              name="playerId"
                              value={player.id}
                            />
                            <button
                              type="submit"
                              className="h-9 rounded-md border border-emerald-500/40 px-2.5 text-xs text-emerald-300 transition-colors hover:bg-emerald-500/10"
                            >
                              Aprobar
                            </button>
                          </form>
                        ) : null}

                        {player.status !== "REJECTED" ? (
                          <form action={rejectPlayer}>
                            <input
                              type="hidden"
                              name="playerId"
                              value={player.id}
                            />
                            <button
                              type="submit"
                              className="h-9 rounded-md border border-line-strong px-2.5 text-xs text-muted transition-colors hover:bg-surface-raised hover:text-foreground"
                            >
                              Rechazar
                            </button>
                          </form>
                        ) : null}

                        <form action={deletePlayer}>
                          <input type="hidden" name="playerId" value={player.id} />
                          <button
                            type="submit"
                            className="h-9 rounded-md border border-red-500/40 px-2.5 text-xs text-red-300 transition-colors hover:bg-red-500/10"
                          >
                            Eliminar
                          </button>
                        </form>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
