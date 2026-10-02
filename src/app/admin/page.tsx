import type { Metadata } from "next";
import { approvePlayer, rejectPlayer } from "@/app/admin/actions";
import { ParticipantsBrowser } from "@/app/admin/participants-browser";
import { PlayerForm } from "@/app/admin/player-form";
import { SyncNowButton } from "@/app/admin/sync-now-button";
import { EmptyState } from "@/components/empty-state";
import { PendingButton } from "@/components/pending-button";
import { getAdminParticipants, getSyncHealth } from "@/lib/admin";
import { requireAdmin } from "@/lib/auth";
import { DEFAULT_COUNTRIES, readCountries } from "@/lib/countries";
import { db } from "@/lib/db";

export const metadata: Metadata = {
  title: { absolute: "Participantes · Admin" },
};

/**
 * Pestaña de participantes: resumen, cola de aprobación, estado del sincronizador,
 * alta y listado.
 *
 * Los cuatro contadores salen de consultas directas a la base y no del DAL
 * porque son agregados que `getAdminParticipants()` no publica (el total de
 * partidas del torneo no se deduce de ninguna fila). El listado, en cambio, sí
 * pasa por el DAL.
 */
export default async function AdminPage() {
  await requireAdmin();

  const [totalPlayers, approvedPlayers, pendingPlayers, totalMatches, syncHealth] =
    await Promise.all([
      db.player.count(),
      db.player.count({ where: { status: "APPROVED" } }),
      db.player.count({ where: { status: "PENDING" } }),
      db.match.count(),
      getSyncHealth(),
    ]);

  const participantsRead = await getAdminParticipants();
  const participants = participantsRead.status === "ok" ? participantsRead.data : [];
  const pending = participants.filter((player) => player.status === "PENDING");

  // El país del alta se elige de la lista viva (`Setting["registration.countries"]`).
  // Si la lectura falla, el desplegable cae a la lista por defecto y el formulario
  // sigue siendo usable; la acción vuelve a leer la lista viva al guardar.
  let countries: string[];

  try {
    countries = await readCountries();
  } catch {
    countries = [...DEFAULT_COUNTRIES];
  }

  // `syncHealth` es un `PublicRead`: `status` distingue "no se ha podido leer" de
  // "leído", y `data.degraded`/`data.stale` son el estado del sincronizador. Son
  // dos cosas distintas y por eso no comparten nombre.
  const syncState = syncHealth.status === "ok" ? syncHealth.data : null;
  const syncAlarm = syncState !== null && (syncState.degraded || syncState.stale);

  // El resumen se lee como una línea de registro ("Jugadores 24 · Aprobados 18
  // …"), no como cuatro tarjetas iguales con el número en grande: la única cifra
  // que se destaca es la de pendientes, que es la que pide una acción.
  const stats = [
    { label: "Jugadores", value: totalPlayers, highlight: false },
    { label: "Aprobados", value: approvedPlayers, highlight: false },
    { label: "Pendientes", value: pendingPlayers, highlight: pendingPlayers > 0 },
    { label: "Partidas", value: totalMatches, highlight: false },
  ];

  // El estado y el botón del sincronizador van en una sección propia, siempre
  // visible, porque el botón es el "por si falla el cron" y no puede depender de
  // que el aviso esté de mal humor. El `headline` lo redacta el servidor
  // (`getSyncHealth()`); aquí no se reimplementa. La sección va **después** de la
  // cola de pendientes: aprobar una solicitud es la acción del día, y el estado del
  // sincronizador es salud del sistema, secundaria frente a ella. Los motivos de
  // cada jugador que falló van en línea y no en un enlace, porque no hay ninguna
  // otra pantalla que los muestre: `/admin/alertas` está reservada para anomalías
  // de participantes y sigue sin hacerse. Sin el motivo literal de la API el aviso
  // no serviría de nada, ya que no dice si hay que corregir un `profileId` o solo
  // esperar a que AoE4World pare de limitar.
  return (
    <div className="flex flex-col gap-8">
      <section>
        <h1 className="text-2xl font-semibold">Participantes</h1>
        <p className="mt-1 max-w-[70ch] text-sm text-muted">
          Alta y aprobación de los jugadores del torneo. Solo los aprobados entran
          en la clasificación pública.
        </p>
      </section>

      <section
        aria-label="Resumen del torneo"
        className="thread-top relative overflow-hidden rounded-lg border border-line bg-surface px-5 py-4"
      >
        <dl className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
          {stats.map((stat, index) => (
            <div
              key={stat.label}
              className={`flex items-baseline gap-2 ${
                index > 0 ? "sm:border-l sm:border-line sm:pl-6" : ""
              }`}
            >
              <dt className="text-sm text-muted">{stat.label}</dt>
              <dd
                className={`text-base font-semibold tabular-nums ${
                  stat.highlight ? "text-accent" : "text-foreground"
                }`}
              >
                {stat.value.toLocaleString("es-ES")}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      {pendingPlayers > 0 ? (
        <section
          id="solicitudes-pendientes"
          className="rounded-lg border border-accent/40 bg-accent/5 p-4"
        >
          <h2 className="font-display text-lg font-semibold text-accent">
            {pendingPlayers === 1 ? "1 solicitud pendiente" : `${pendingPlayers} solicitudes pendientes`}
          </h2>
          <p className="mt-1 text-sm text-muted">
            Aprueba o rechaza para que la clasificación refleje el estado real.
          </p>

          <ul className="mt-4 flex flex-col gap-2">
            {pending.map((player) => (
              <li
                key={player.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line bg-surface px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="break-words font-medium text-foreground">{player.name}</p>
                  <p className="mt-0.5 break-all text-xs text-muted">
                    AoE4World {player.profileId}
                    {player.contactEmail !== null ? ` · ${player.contactEmail}` : ""}
                    {player.twitchChannel !== null ? ` · Twitch ${player.twitchChannel}` : ""}
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <form action={approvePlayer}>
                    <input type="hidden" name="playerId" value={player.id} />
                    <PendingButton className="h-10 rounded-md border border-win/40 px-3 text-xs text-win transition-colors hover:bg-win/10 disabled:cursor-not-allowed disabled:opacity-50">
                      Aprobar
                    </PendingButton>
                  </form>
                  <form action={rejectPlayer}>
                    <input type="hidden" name="playerId" value={player.id} />
                    <PendingButton className="h-10 rounded-md border border-line-strong px-3 text-xs text-muted transition-colors hover:bg-surface-raised hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50">
                      Rechazar
                    </PendingButton>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section
        aria-label="Sincronización"
        className={`rounded-lg border bg-surface px-4 py-4 ${
          syncAlarm ? "border-loss/40" : "border-line"
        }`}
      >
        <h2 className="text-lg font-medium">Sincronización</h2>
        <p
          className={`mt-1 max-w-[70ch] text-sm ${
            syncAlarm ? "text-loss" : "text-muted"
          }`}
        >
          {syncState !== null
            ? syncState.headline
            : "No se ha podido leer el estado del sincronizador. El botón sigue disponible para forzar una pasada."}
        </p>
        {syncState?.lastRun?.failures.length ? (
          <ul className="mt-2 flex flex-col gap-1 text-sm text-muted">
            {syncState.lastRun.failures.map((fallo) => (
              <li key={fallo.profileId}>
                <span className="text-foreground">{fallo.name}</span> ({fallo.profileId}):{" "}
                {fallo.error}
              </li>
            ))}
          </ul>
        ) : null}
        <div className="mt-4">
          <SyncNowButton />
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-medium">Añadir jugador</h2>
        <PlayerForm countries={countries} />
      </section>

      <section>
        <h2 className="mb-3 text-lg font-medium">Todos los jugadores</h2>

        {participantsRead.status === "degraded" ? (
          <EmptyState
            title="No se ha podido leer la lista de jugadores"
            body="La base de datos no ha respondido. El alta sigue disponible; vuelve a intentarlo en unos minutos para ver el listado."
          />
        ) : (
          <ParticipantsBrowser participants={participants} countries={countries} />
        )}
      </section>
    </div>
  );
}
