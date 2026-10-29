import type { Metadata } from "next";
import { ParticipantsBrowser } from "@/app/admin/participants-browser";
import { PlayerForm } from "@/app/admin/player-form";
import { PlayerStatusActions } from "@/app/admin/player-status-actions";
import { VerificationBadge } from "@/app/admin/participant-verification";
import { SyncNowButton } from "@/app/admin/sync-now-button";
import { ActionFeedbackProvider } from "@/components/action-feedback";
import { EmptyState } from "@/components/empty-state";
import { getAdminParticipants, getSyncHealth } from "@/lib/admin";
import { getAdminAccess, requireAdmin } from "@/lib/auth";
import { DEFAULT_COUNTRIES, readCountries } from "@/lib/countries";
import { db } from "@/lib/db";
import { missingDiscordVerificationEnv } from "@/lib/discord/env";
import { DEFAULT_REGISTRATION_OPEN } from "@/lib/registration-open";
import { RULESET_VERSION } from "@/lib/scoring";
import { readRegistrationOpen } from "@/lib/settings";

export const metadata: Metadata = {
  title: { absolute: "Participantes · Admin" },
};

/**
 * Detalle del relleno de la ventana, debajo del `headline`.
 *
 * El `headline` solo nombra el relleno cuando la pasada truncó; esta línea está
 * siempre que hay rastro, con el contador vivo de aprobados pendientes y el
 * veredicto de `backfillStalled`. Sin rastro no se pinta: el contador sale de la
 * base y no de la pasada, así que «completo» o «atascado» afirmarían un estado
 * que nadie ha medido.
 */
function backfillDetail(pending: number, stalled: boolean | null): string {
  if (stalled === null) {
    return "Relleno: sin medir.";
  }

  if (pending === 0) {
    return "Relleno completo.";
  }

  const estado = stalled ? "Relleno atascado" : "Relleno en curso";

  return `${estado}: ${pending} jugador(es) pendiente(s).`;
}

/**
 * Pestaña de participantes: resumen, cola de aprobación, estado del sincronizador,
 * alta y listado.
 *
 * Los contadores de jugadores salen de consultas directas a la base y no del DAL
 * porque son agregados que `getAdminParticipants()` no publica. El de partidas
 * tampoco sale del DAL: es la suma de `PlayerScore` de la versión activa del
 * ruleset, la misma que la columna «Partidas» de la tabla y que la clasificación
 * pública. El listado, en cambio, sí pasa por el DAL.
 */
export default async function AdminPage() {
  await requireAdmin();

  // El acceso ya está resuelto y memoizado por `requireAdmin()`; se lee para
  // ofrecer la reversión de una expulsión solo a quien puede crearla.
  const access = await getAdminAccess();

  const [totalPlayers, approvedPlayers, pendingPlayers, scoreTotals, syncHealth] =
    await Promise.all([
      db.player.count(),
      db.player.count({ where: { status: "APPROVED" } }),
      db.player.count({ where: { status: "PENDING" } }),
      // Las partidas del torneo no son las filas de `Match`: ahí entra todo lo
      // que importa el sincronizador —cualquier ladder, el histórico anterior a
      // la ventana y lo previo a la inscripción de cada jugador—. La cifra que
      // vale es la que ya suma el motor de puntos por participante aprobado, así
      // que se agrega `PlayerScore` de la versión activa en vez de recontar
      // partidas aquí.
      db.playerScore.aggregate({
        where: { ruleSetVersion: RULESET_VERSION },
        _sum: { matches: true },
      }),
      getSyncHealth(),
    ]);

  // `_sum` llega `null` cuando no hay ninguna fila de la versión activa: el
  // resumen enseña 0, no un hueco.
  const totalMatches = scoreTotals._sum.matches ?? 0;

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

  // La verificación del alta por privado se apaga sola si falta cualquiera de sus
  // cuatro credenciales, y sin aviso eso solo se nota por lo que **no** pasa: el
  // alta queda aprobada y la persona no recibe nada. Se lee una vez y alimenta las
  // dos caras del mismo hecho: el aviso de arriba y la pista del campo de estado.
  const missingVerificationEnv = missingDiscordVerificationEnv();
  const discordVerificationEnabled = missingVerificationEnv.length === 0;

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

      {/* El aviso va aquí, entre el titular y el resumen, porque es lo primero que
          hay que leer antes de dar un alta y así entra en la primera pantalla sin
          desplazarse. Es un estado persistente, no un suceso: no lleva `role` ni se
          anuncia solo, y el icono acompaña al texto en vez de sustituirlo, porque
          quien no distinga el rojo tiene que enterarse igual. Se dice la
          consecuencia concreta —aprobar aprueba— porque el fallo real no es que
          falte una variable, es que el alta se da por buena sin que nadie lo sepa. */}
      {discordVerificationEnabled ? null : (
        <section className="rounded-lg border border-danger/40 bg-danger/5 px-5 py-4">
          <div className="flex gap-3">
            <svg
              viewBox="0 0 16 16"
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 text-danger"
            >
              <path
                d="M8 2.25 1.5 13.5h13L8 2.25Z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinejoin="round"
              />
              <path
                d="M8 6.25v3"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
              <circle cx="8" cy="11.25" r="0.8" fill="currentColor" />
            </svg>

            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-danger-soft">
                Verificación del alta por privado desactivada
              </h2>
              <p className="mt-1 max-w-[70ch] text-sm leading-relaxed text-muted">
                Mientras falte, dar de alta como «Aprobado» aprueba directamente: no
                se pide confirmación a la persona ni se envía el privado de Discord.
              </p>
              <p className="mt-2 text-xs leading-relaxed text-muted">
                {missingVerificationEnv.length === 1
                  ? "Falta esta variable:"
                  : "Faltan estas variables:"}{" "}
                {missingVerificationEnv.map((name) => (
                  <code
                    key={name}
                    className="mr-1.5 inline-block rounded-sm border border-line bg-background px-1.5 py-0.5 font-mono text-xs text-foreground"
                  >
                    {name}
                  </code>
                ))}
              </p>
              <p className="mt-1 text-xs leading-relaxed text-muted">
                Se configuran en las variables del Worker de producción:
                DISCORD_PUBLIC_KEY es la Public Key de la aplicación de Discord. En
                cuanto estén puestas, este aviso desaparece.
              </p>
            </div>
          </div>
        </section>
      )}

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
              {syncState?.lastRun ? (
                /* Un paso por debajo del `headline` (`text-xs` frente a `text-sm`):
                   es su detalle, no otro titular. Se tiñe de `loss` solo cuando el
                   relleno está atascado, que es el único caso que no siempre levanta
                   el aviso de la tarjeta y sí pide una intervención. */
                <p
                  className={`mt-1 text-xs ${
                    syncState.backfillStalled === true ? "text-loss" : "text-muted"
                  }`}
                >
                  {backfillDetail(syncState.backfillPending, syncState.backfillStalled)}
                </p>
              ) : null}
            </div>

            {/* El botón está arriba a la derecha de su propia tarjeta y no debajo
                del texto: es la acción de la sección y así se ve aunque el
                `headline` ocupe tres líneas. Con ancho de sobra se queda a la
                derecha; si no cabe, `flex-wrap` lo baja a una línea propia. */}
            <div className="shrink-0">
              <SyncNowButton />
            </div>
          </div>

          {/* Los lotes van por encima de los fallos por jugador porque un solo lote
              caído explica hasta 50 de esos fallos: leerlos al revés haría buscar la
              causa jugador a jugador. El aviso de la API cierra la tarjeta como nota
              al pie, que es lo que es: contexto de AoE4World, no un fallo nuestro. */}
          {syncState?.gamesBatchErrors.length ? (
            <ul
              aria-label="Errores de lote del masivo"
              className="mt-3 flex flex-col gap-1 border-t border-line pt-3 text-xs text-muted"
            >
              {syncState.gamesBatchErrors.map((lote) => (
                <li key={lote.batch} className="break-words">
                  <span className="text-foreground">Lote {lote.batch}</span> (ids{" "}
                  {lote.firstProfileId}–{lote.lastProfileId}): {lote.error}
                </li>
              ))}
            </ul>
          ) : null}

          {syncState?.lastRun?.failures.length ? (
            <ul className="mt-3 flex flex-col gap-1 border-t border-line pt-3 text-xs text-muted">
              {syncState.lastRun.failures.map((fallo) => (
                <li key={fallo.profileId} className="break-words">
                  <span className="text-foreground">{fallo.name}</span> (
                  {fallo.profileId}): {fallo.error}
                </li>
              ))}
            </ul>
          ) : null}

          {syncState?.apiNotice ? (
            <p className="mt-3 break-words text-xs text-muted">
              Aviso de AoE4World: {syncState.apiNotice}
            </p>
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
          {/* La primera frase es la corrección de la issue 119: aprobar un alta
              sujeta a verificación **no** la aprueba, manda el privado y la deja
              pendiente. El resto sigue siendo verdad para las dos clases de alta:
              aprobar no trae partidas ni recalcula en el momento. */}
          <p className="mt-2 border-t border-line pt-2 text-xs text-muted">
            Aprobar no siempre aprueba: si el alta está sujeta a verificación por Discord,
            el bot manda un privado a la persona y el alta sigue pendiente hasta que
            confirme. Solo entonces entra en la clasificación, en la próxima pasada del
            sincronizador (hasta 10 minutos) o al pulsar «Sincronizar ahora», con 0 puntos
            y 0 partidas hasta que tenga partidas clasificatorias.
          </p>

          {/* La banda de avisos va una sola vez por cola y por encima de las filas:
              aquí viven los botones de estado (`PlayerStatusActions`), que ya solo
              usa esta cola, y su éxito se pinta ahí porque la fila afectada deja
              de estar pendiente y desaparece de esta lista. */}
          <div className="mt-4">
            <ActionFeedbackProvider>
              <ul className="flex flex-col gap-2">
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
                      <VerificationBadge player={player} className="mt-1" />
                    </div>

                    <PlayerStatusActions
                      player={player}
                      canReverse={access === "superadmin"}
                      align="start"
                    />
                  </li>
                ))}
              </ul>
            </ActionFeedbackProvider>
          </div>
        </section>
      ) : null}

      <section>
        <details open className="group">
          {/* El titular es el propio `<summary>`: conserva la jerarquía de la
              página (sigue siendo un `<h2>` dentro del resumen) y a la vez es el
              control que pliega la sección. Sin el `<h2>` el encabezado se
              perdería del esquema; sin el `<summary>` no habría forma de
              plegarla. El chevron gira al abrir y respeta `motion-reduce`. */}
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-foreground transition-colors hover:text-accent [&::-webkit-details-marker]:hidden">
            <h2 className="text-lg font-medium">Añadir jugador</h2>
            <svg
              viewBox="0 0 12 12"
              aria-hidden="true"
              className="size-3 shrink-0 text-muted transition-transform motion-reduce:transition-none group-open:rotate-180"
            >
              <path
                d="M2.5 4.5 6 8l3.5-3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </summary>
          <div className="mt-3">
            <PlayerForm
              countries={countries}
              disabled={!registrationOpen}
              discordVerificationEnabled={discordVerificationEnabled}
            />
          </div>
        </details>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-medium">Todos los jugadores</h2>

        {participantsRead.status === "degraded" ? (
          <EmptyState
            title="No se ha podido leer la lista de jugadores"
            body="La base de datos no ha respondido. Vuelve a intentarlo en unos minutos para ver el listado."
          />
        ) : (
          <ParticipantsBrowser
            participants={participants}
            countries={countries}
            canReverse={access === "superadmin"}
          />
        )}
      </section>
    </div>
  );
}
