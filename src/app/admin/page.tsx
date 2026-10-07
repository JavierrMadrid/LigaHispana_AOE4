import type { Metadata } from "next";
import { approvePlayer, rejectPlayer } from "@/app/admin/actions";
import { ParticipantsBrowser } from "@/app/admin/participants-browser";
import { PlayerForm } from "@/app/admin/player-form";
import { RegistrationSwitch } from "@/app/admin/registration-switch";
import { SyncNowButton } from "@/app/admin/sync-now-button";
import { EmptyState } from "@/components/empty-state";
import { PendingButton } from "@/components/pending-button";
import { getAdminParticipants, getSyncHealth } from "@/lib/admin";
import { requireAdmin } from "@/lib/auth";
import { DEFAULT_COUNTRIES, readCountries } from "@/lib/countries";
import { db } from "@/lib/db";
import { DEFAULT_REGISTRATION_OPEN } from "@/lib/registration-open";
import { readRegistrationOpen } from "@/lib/settings";

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

  // La lista de países y el estado del plazo se leen de `Setting`, y las dos
  // lecturas degradan a su valor de respaldo en vez de tumbar el panel: la lista,
  // a la de por defecto; el plazo, a cerrado. El servidor vuelve a comprobar
  // ambas al guardar —el país en el alta y el plazo en el alta y en el envío
  // público—, así que una lectura degradada aquí no abre nada por accidente. Van
  // en paralelo porque son independientes.
  const [countries, registrationOpen] = await Promise.all([
    readCountries().catch(() => [...DEFAULT_COUNTRIES]),
    readRegistrationOpen().catch(() => DEFAULT_REGISTRATION_OPEN),
  ]);

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

  // El estado del sincronizador va en **su propia tarjeta, a la derecha del
  // resumen y del mismo ancho** (`lg:grid-cols-2`): son dos cosas distintas —cuántos
  // jugadores hay, y cómo va la última pasada— y el `headline` es texto que crece
  // con la longitud del motivo, así que en una sola línea compartida empujaba al
  // resumen. Por debajo de `lg` se apilan. El botón vive en esa tarjeta, arriba a
  // la derecha, porque es la acción de esa sección. El `headline` lo redacta el
  // servidor (`getSyncHealth()`); aquí no se reimplementa. Los motivos de cada
  // jugador que falló van en línea y no en un enlace, porque no hay ninguna otra
  // pantalla que los muestre: `/admin/alertas` está reservada para anomalías de
  // participantes. Sin el motivo literal de la API el aviso no serviría de nada,
  // ya que no dice si hay que corregir un `profileId` o solo esperar a que
  // AoE4World pare de limitar.
  return (
    <div className="flex flex-col gap-8">
      <section>
        <h1 className="text-2xl font-semibold">Participantes</h1>
        <p className="mt-1 max-w-[70ch] text-sm text-muted">
          Alta y aprobación de los jugadores del torneo. Solo los aprobados entran
          en la clasificación pública.
        </p>
      </section>

      {/* Resumen y sincronización, en dos tarjetas de la mitad de ancho cada una
          (`lg:grid-cols-2`): el resumen son cuatro cifras cortas y el estado es
          texto largo más un botón, así que a mitades los dos tienen su sitio sin
          que el segundo tenga que empujar al primero. Por debajo de `lg` se
          apilan, que es lo razonable cuando no hay ancho para dos columnas.
          El botón va en la derecha porque pertenece a lo que describe: forzar una
          pasada es actuar sobre el estado del sincronizador, no sobre el resumen
          de jugadores. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <section
          aria-label="Resumen del torneo"
          className="thread-top relative overflow-hidden rounded-lg border border-line bg-surface px-5 py-4"
        >
          {/* `flex h-full` y `content-center` en el `<dl>`: la rejilla estira las dos
              tarjetas a la misma altura y el resumen solo tiene una línea de
              cifras, así que sin esto se quedaba pegada arriba con el hueco
              debajo, mientras la de al lado crece con el `headline` y el botón. */}
          <dl className="flex h-full flex-wrap content-center items-baseline gap-x-6 gap-y-2">
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

        <section
          aria-label="Sincronización"
          className={`rounded-lg border bg-surface px-5 py-4 ${
            syncAlarm ? "border-loss/40" : "border-line"
          }`}
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <h2 className="text-sm text-muted">Sincronización</h2>
              <p
                className={`mt-1 text-sm leading-relaxed ${
                  syncAlarm ? "text-loss" : "text-muted"
                }`}
              >
                {syncState !== null
                  ? syncState.headline
                  : "No se ha podido leer el estado del sincronizador."}
              </p>
            </div>

            {/* El botón está arriba a la derecha de su propia tarjeta y no debajo
                del texto: es la acción de la sección y así se ve aunque el
                `headline` ocupe tres líneas. Con ancho de sobra se queda a la
                derecha; si no cabe, `flex-wrap` lo baja a una línea propia. */}
            <div className="shrink-0">
              <SyncNowButton />
            </div>
          </div>

          {/* El aviso va por debajo del `headline` y de la lista de fallos, con su
              propio tono neutro y no el rojo de `syncAlarm`: es información y no una
              alarma —la pasada salió bien y aun así una parte no pudo hacer su
              trabajo—, así que `role="status"` y no `alert`. El texto va literal
              porque lo escribe el servicio de fuera y lo que dice —qué servicio, qué
              estado, qué motivo— es justo lo que hay que mirar para arreglarlo;
              resumirlo aquí perdería lo único que vale. */}
          {syncState?.notice ? (
            <p
              role="status"
              className="mt-3 break-words rounded-md border border-line-strong bg-surface-raised px-3 py-2 text-xs leading-relaxed text-muted"
            >
              {syncState.notice}
            </p>
          ) : null}

          {syncState?.lastRun?.failures.length ? (
            <ul className="mt-3 flex flex-col gap-1 border-t border-line pt-3 text-xs text-muted">
              {syncState.lastRun.failures.map((fallo) => (
                <li key={fallo.profileId}>
                  <span className="text-foreground">{fallo.name}</span> (
                  {fallo.profileId}): {fallo.error}
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      </div>

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

      <section>
        <h2 className="text-lg font-medium">Inscripciones</h2>
        <p className="mt-1 max-w-[70ch] text-sm text-muted">
          Quién puede entrar al torneo. Con el plazo abierto se admiten solicitudes
          nuevas desde la web y altas desde este panel; con el plazo cerrado, solo se
          gestionan las solicitudes ya recibidas.
        </p>
        <div className="mt-4">
          <RegistrationSwitch open={registrationOpen} />
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-medium">Añadir jugador</h2>
        <PlayerForm countries={countries} disabled={!registrationOpen} />
      </section>

      <section>
        <h2 className="mb-3 text-lg font-medium">Todos los jugadores</h2>

        {participantsRead.status === "degraded" ? (
          <EmptyState
            title="No se ha podido leer la lista de jugadores"
            body="La base de datos no ha respondido. Vuelve a intentarlo en unos minutos para ver el listado."
          />
        ) : (
          <ParticipantsBrowser participants={participants} countries={countries} />
        )}
      </section>
    </div>
  );
}
