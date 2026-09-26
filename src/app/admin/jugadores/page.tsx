import type { Metadata } from "next";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { PlayerForm } from "./player-form";
import { approvePlayer, deletePlayer, rejectPlayer } from "./actions";

export const metadata: Metadata = {
  title: "Jugadores — Admin",
};

const statusStyles: Record<string, string> = {
  APPROVED: "border-emerald-500/40 text-emerald-300",
  PENDING: "border-amber-500/40 text-amber-300",
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
        <p className="mt-1 text-sm text-neutral-400">
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
          <p className="rounded-lg border border-neutral-800 bg-neutral-950 p-4 text-sm text-neutral-400">
            Todavía no hay jugadores registrados.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-neutral-800">
            <table className="w-full text-left text-sm">
              <thead className="bg-neutral-900 text-neutral-400">
                <tr>
                  <th className="px-4 py-3 font-medium">#</th>
                  <th className="px-4 py-3 font-medium">Nombre</th>
                  <th className="px-4 py-3 font-medium">Profile ID</th>
                  <th className="px-4 py-3 font-medium">Twitch</th>
                  <th className="px-4 py-3 font-medium">Estado</th>
                  <th className="px-4 py-3 font-medium">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-800">
                {players.map((player, index) => (
                  <tr key={player.id} className="bg-neutral-950">
                    <td className="px-4 py-3 tabular-nums text-neutral-500">
                      {index + 1}
                    </td>
                    <td className="px-4 py-3">{player.name}</td>
                    <td className="px-4 py-3 tabular-nums text-neutral-400">
                      {player.profileId}
                    </td>
                    <td className="px-4 py-3 text-neutral-400">
                      {player.twitchChannel ?? "—"}
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
                              className="rounded-md border border-emerald-500/40 px-2 py-1 text-xs text-emerald-300 hover:bg-emerald-500/10"
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
                              className="rounded-md border border-amber-500/40 px-2 py-1 text-xs text-amber-300 hover:bg-amber-500/10"
                            >
                              Rechazar
                            </button>
                          </form>
                        ) : null}

                        <form action={deletePlayer}>
                          <input type="hidden" name="playerId" value={player.id} />
                          <button
                            type="submit"
                            className="rounded-md border border-red-500/40 px-2 py-1 text-xs text-red-300 hover:bg-red-500/10"
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
