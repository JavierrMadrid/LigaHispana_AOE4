import Link from "next/link";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";

export default async function AdminPage() {
  await requireAdmin();

  const [totalPlayers, approvedPlayers, pendingPlayers, totalMatches] =
    await Promise.all([
      db.player.count(),
      db.player.count({ where: { status: "APPROVED" } }),
      db.player.count({ where: { status: "PENDING" } }),
      db.match.count(),
    ]);

  const stats = [
    { label: "Jugadores", value: totalPlayers },
    { label: "Aprobados", value: approvedPlayers },
    { label: "Pendientes", value: pendingPlayers },
    { label: "Partidas", value: totalMatches },
  ];

  return (
    <div className="flex flex-col gap-8">
      <section>
        <h1 className="text-2xl font-semibold">Resumen</h1>
        <p className="mt-1 text-sm text-muted">
          Estado de la Liga Hispana de Age of Empires IV.
        </p>
      </section>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((stat) => (
          <div
            key={stat.label}
            className="rounded-lg border border-line bg-surface p-4"
          >
            <p className="text-sm text-muted">{stat.label}</p>
            <p className="mt-1 text-3xl font-semibold tabular-nums">
              {stat.value}
            </p>
          </div>
        ))}
      </section>

      {pendingPlayers > 0 ? (
        <section className="rounded-lg border border-accent/40 bg-accent/5 p-4">
          <p className="text-sm">
            Hay <strong>{pendingPlayers}</strong>{" "}
            {pendingPlayers === 1 ? "registro pendiente" : "registros pendientes"}{" "}
            de aprobación.
          </p>
          <Link
            href="/admin/jugadores"
            className="mt-3 inline-flex h-10 items-center rounded-md bg-accent px-4 text-sm font-medium text-accent-ink transition-colors hover:bg-accent-strong"
          >
            Revisar registros
          </Link>
        </section>
      ) : null}
    </div>
  );
}
