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
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full text-left text-sm">
              <thead className="bg-surface text-muted">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">#</th>
                  <th scope="col" className="px-4 py-3 font-medium">Nombre</th>
                  <th scope="col" className="px-4 py-3 font-medium">Profile ID</th>
                  <th scope="col" className="px-4 py-3 font-medium">Twitch</th>
                  <th scope="col" className="px-4 py-3 font-medium">Contacto</th>
                  <th scope="col" className="px-4 py-3 font-medium">Estado</th>
                  <th scope="col" className="px-4 py-3 font-medium">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {players.map((player, index) => (
                  <tr key={player.id}>
                    <td className="px-4 py-3 tabular-nums text-muted">
                      {index + 1}
                    </td>
                    <td className="px-4 py-3">{player.name}</td>
                    <td className="px-4 py-3 tabular-nums text-muted">
                      {player.profileId}
                    </td>
                    <td className="px-4 py-3 text-muted">
                      {player.twitchChannel ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-muted">
                      {player.contactEmail ?? "—"}
                    </td>
                    <td className="px-4 py-3">
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
                              className="h-8 rounded-md border border-emerald-500/40 px-2.5 text-xs text-emerald-300 transition-colors hover:bg-emerald-500/10"
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
                              className="h-8 rounded-md border border-line-strong px-2.5 text-xs text-muted transition-colors hover:bg-surface-raised hover:text-foreground"
                            >
                              Rechazar
                            </button>
                          </form>
                        ) : null}

                        <form action={deletePlayer}>
                          <input type="hidden" name="playerId" value={player.id} />
                          <button
                            type="submit"
                            className="h-8 rounded-md border border-red-500/40 px-2.5 text-xs text-red-300 transition-colors hover:bg-red-500/10"
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
