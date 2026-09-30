"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { PlayerStatus } from "@/generated/prisma/enums";
import { approvePlayer, deletePlayer, rejectPlayer } from "@/app/admin/actions";
import type { AdminParticipant } from "@/lib/admin";
import { ActionFeedbackProvider } from "@/components/action-feedback";
import { ConfirmAction } from "@/components/confirm-action";
import { EmptyState } from "@/components/empty-state";
import { PendingButton } from "@/components/pending-button";
import { aoe4WorldProfileUrl } from "@/lib/format";
import { PLAYER_STATUS_LABELS, PLAYER_STATUS_STYLES } from "./participant-status";

/** Búsqueda y estado no distinguen acentos ni mayúsculas: "josé" encuentra "Jose". */
function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word.charAt(0))
    .join("")
    .toUpperCase();
}

type StatusFilter = PlayerStatus | "ALL";

const STATUS_FILTERS: { id: StatusFilter; label: string }[] = [
  { id: "ALL", label: "Todos" },
  { id: "APPROVED", label: "Aprobados" },
  { id: "PENDING", label: "Pendientes" },
  { id: "REJECTED", label: "Rechazados" },
];

const CELL = "px-4 py-3 align-top";

/**
 * Listado completo de participantes con buscador y filtro por estado en cliente.
 *
 * El DAL manda la lista entera (son decenas de filas, no hay paginación) y aquí
 * solo se filtra y se pinta, así que buscar no recarga la página. Los estados no
 * aprobados no se esconden: se marcan, y cuando el jugador no tiene fila en la
 * clasificación los números salen como raya y no como cero, que afirmaría algo
 * falso.
 */
export function ParticipantsBrowser({ participants }: { participants: AdminParticipant[] }) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("ALL");

  const counts = useMemo(() => {
    const map: Record<StatusFilter, number> = {
      ALL: participants.length,
      APPROVED: 0,
      PENDING: 0,
      REJECTED: 0,
    };

    for (const player of participants) {
      map[player.status] += 1;
    }

    return map;
  }, [participants]);

  const filtered = useMemo(() => {
    const needle = normalize(query.trim());

    return participants.filter((player) => {
      if (status !== "ALL" && player.status !== status) {
        return false;
      }

      if (needle !== "") {
        const haystack = normalize(
          `${player.name} ${player.aoe4WorldName ?? ""} ${player.twitchChannel ?? ""}`,
        );

        if (!haystack.includes(needle)) {
          return false;
        }
      }

      return true;
    });
  }, [participants, query, status]);

  const hasFilters = query.trim() !== "" || status !== "ALL";

  function clearFilters() {
    setQuery("");
    setStatus("ALL");
  }

  return (
    <ActionFeedbackProvider>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="sm:w-[300px]">
            <label htmlFor="buscar-participante" className="sr-only">
              Buscar participante
            </label>
            <input
              id="buscar-participante"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Buscar por nombre, perfil o canal"
              autoComplete="off"
              className="h-10 w-full rounded-md border border-line bg-surface px-3 text-sm text-foreground transition-colors placeholder:text-muted"
            />
          </div>

          <div
            role="group"
            aria-label="Filtrar por estado"
            className="flex flex-wrap items-center gap-1.5"
          >
            {STATUS_FILTERS.map((item) => {
              const active = status === item.id;

              return (
                <button
                  key={item.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setStatus(active && item.id !== "ALL" ? "ALL" : item.id)}
                  className={`inline-flex h-10 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold transition-colors ${
                    active
                      ? "border-accent bg-accent text-accent-ink"
                      : "border-line bg-surface text-muted hover:bg-surface-raised hover:text-foreground"
                  }`}
                >
                  {item.label}
                  <span className="tabular-nums opacity-70">{counts[item.id]}</span>
                </button>
              );
            })}
          </div>
        </div>

        {hasFilters ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p
              role="status"
              className={filtered.length === 0 ? "sr-only" : "text-xs text-muted"}
            >
              {filtered.length === 1
                ? "1 jugador coincide con los filtros"
                : `${filtered.length} jugadores coinciden con los filtros`}
            </p>
            {filtered.length > 0 ? (
              <button
                type="button"
                onClick={clearFilters}
                className="text-xs font-medium text-muted underline-offset-4 transition-colors hover:text-accent hover:underline"
              >
                Quitar filtros
              </button>
            ) : null}
          </div>
        ) : null}

        {participants.length === 0 ? (
          <EmptyState
            title="Todavía no hay nadie registrado"
            body="El alta manual está justo encima y las solicitudes de la web llegan aquí en estado pendiente."
            action={
              <Link
                href="/participar"
                className="inline-block text-sm text-accent underline underline-offset-4 hover:text-accent-strong"
              >
                Ver el formulario de inscripción
              </Link>
            }
          />
        ) : filtered.length === 0 ? (
          <div className="rounded-lg border border-line bg-surface px-6 py-12 text-center">
            <p className="text-lg font-semibold text-foreground">
              Ningún jugador coincide con los filtros
            </p>
            <p className="mt-2 text-sm text-muted">
              Prueba con otro nombre o cambia el estado.
            </p>
            <button
              type="button"
              onClick={clearFilters}
              className="mt-5 inline-flex h-10 items-center rounded-md bg-accent px-4 text-sm font-semibold text-accent-ink transition-colors hover:bg-accent-strong"
            >
              Quitar filtros
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto overscroll-x-contain rounded-lg border border-line">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">
                Jugadores del torneo: nombre, perfil de AoE4World, canal de Twitch,
                estado, partidas clasificatorias y puntos. Una raya significa que el
                jugador no tiene fila en la clasificación.
              </caption>
              <thead className="bg-surface text-muted">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Jugador
                  </th>
                  <th scope="col" className="hidden px-4 py-3 font-medium lg:table-cell">
                    AoE4World
                  </th>
                  <th scope="col" className="hidden px-4 py-3 font-medium lg:table-cell">
                    Twitch
                  </th>
                  <th scope="col" className="hidden px-4 py-3 font-medium lg:table-cell">
                    Estado
                  </th>
                  <th scope="col" className="hidden px-4 py-3 text-right font-medium lg:table-cell">
                    Partidas
                  </th>
                  <th scope="col" className="hidden px-4 py-3 text-right font-medium lg:table-cell">
                    Puntos
                  </th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">
                    Acciones
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {filtered.map((player) => (
                  <ParticipantRow key={player.id} player={player} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </ActionFeedbackProvider>
  );
}

function ParticipantRow({ player }: { player: AdminParticipant }) {
  return (
    <tr>
      <td className={CELL}>
        <div className="flex items-start gap-3">
          <PlayerAvatar name={player.name} avatarUrl={player.avatarUrl} />
          <div className="min-w-0">
            <span className="block break-words font-medium text-foreground">
              {player.name}
            </span>
            {/* Por debajo de `lg` las columnas secundarias se leen aquí, bajo el
                nombre, en vez de comprimir siete columnas en un móvil. */}
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted lg:hidden">
              <StatusBadge status={player.status} />
              <ProfileLink player={player} />
              {player.twitchChannel !== null ? (
                <span className="break-all">Twitch {player.twitchChannel}</span>
              ) : null}
              <span className="tabular-nums">
                {player.matchCount === null
                  ? "Sin partidas clasificatorias"
                  : `${player.matchCount} ${player.matchCount === 1 ? "partida" : "partidas"}`}
              </span>
              <span className="tabular-nums">
                {player.points === null ? "Sin clasificar" : `${player.points} puntos`}
              </span>
            </div>
          </div>
        </div>
      </td>

      <td className={`${CELL} hidden lg:table-cell`}>
        <ProfileLink player={player} />
      </td>

      <td className={`${CELL} hidden text-muted lg:table-cell`}>
        {player.twitchChannel === null ? (
          "—"
        ) : (
          <a
            href={`https://twitch.tv/${player.twitchChannel}`}
            target="_blank"
            rel="noopener noreferrer"
            className="block max-w-[8rem] truncate text-foreground underline-offset-4 hover:text-accent hover:underline"
          >
            {player.twitchChannel}
          </a>
        )}
      </td>

      <td className={`${CELL} hidden lg:table-cell`}>
        <StatusBadge status={player.status} />
        {player.status !== "APPROVED" ? (
          <span className="mt-1 block text-xs text-muted">Fuera de la clasificación</span>
        ) : null}
      </td>

      <td className={`${CELL} hidden text-right tabular-nums lg:table-cell`}>
        {player.matchCount === null ? (
          <span className="text-muted" title="No tiene partidas clasificatorias">
            —
          </span>
        ) : (
          player.matchCount
        )}
      </td>

      <td className={`${CELL} hidden text-right tabular-nums lg:table-cell`}>
        {player.points === null ? (
          <span className="text-muted" title="No tiene fila en la clasificación">
            —
          </span>
        ) : (
          player.points
        )}
      </td>

      <td className={`${CELL} text-right`}>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {player.status !== "APPROVED" ? (
            <StatusForm action={approvePlayer} playerId={player.id} label="Aprobar" tone="approve" />
          ) : null}

          {player.status !== "REJECTED" ? (
            <StatusForm action={rejectPlayer} playerId={player.id} label="Rechazar" tone="neutral" />
          ) : null}

          <ConfirmAction
            action={deletePlayer}
            fields={{ playerId: player.id }}
            title="Eliminar jugador"
            body={
              <>
                Se eliminará a {player.name} (AoE4World {player.profileId}) y todas sus
                partidas. Esta acción no se puede deshacer.
              </>
            }
            triggerLabel="Eliminar"
            triggerClassName="h-10 rounded-md border border-loss/40 px-3 text-xs text-loss transition-colors hover:bg-loss/10"
            confirmLabel="Eliminar jugador"
            confirmPendingLabel="Eliminando…"
            confirmClassName="bg-loss text-accent-ink hover:brightness-110"
          />
        </div>
      </td>
    </tr>
  );
}

function ProfileLink({ player }: { player: AdminParticipant }) {
  const url = aoe4WorldProfileUrl(player.profileId);

  if (player.aoe4WorldName === null) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-muted underline-offset-4 transition-colors hover:text-accent hover:underline"
      >
        Perfil {player.profileId}
      </a>
    );
  }

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title={`Perfil de ${player.aoe4WorldName} en AoE4World`}
      className="block max-w-[12rem] truncate text-foreground underline-offset-4 transition-colors hover:text-accent hover:underline"
    >
      {player.aoe4WorldName}
    </a>
  );
}

function StatusBadge({ status }: { status: PlayerStatus }) {
  return (
    <span
      className={`inline-block rounded-full border px-2 py-0.5 text-xs ${PLAYER_STATUS_STYLES[status]}`}
    >
      {PLAYER_STATUS_LABELS[status]}
    </span>
  );
}

/**
 * Fórmula de aprobar o rechazar. Es un `<form>` de una Server Action, con el
 * `playerId` en un campo oculto; el botón se deshabilita mientras la acción
 * viaja para que dos clics seguidos no la envíen dos veces.
 */
function StatusForm({
  action,
  playerId,
  label,
  tone,
}: {
  action: (formData: FormData) => Promise<void>;
  playerId: string;
  label: string;
  tone: "approve" | "neutral";
}) {
  const style =
    tone === "approve"
      ? "border-win/40 text-win hover:bg-win/10"
      : "border-line-strong text-muted hover:bg-surface-raised hover:text-foreground";

  return (
    <form action={action}>
      <input type="hidden" name="playerId" value={playerId} />
      <PendingButton
        className={`h-10 rounded-md border px-3 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${style}`}
      >
        {label}
      </PendingButton>
    </form>
  );
}

function PlayerAvatar({ name, avatarUrl }: { name: string; avatarUrl: string | null }) {
  if (avatarUrl === null) {
    return (
      <span
        aria-hidden="true"
        className="flex size-9 shrink-0 items-center justify-center rounded-md border border-line bg-surface-raised text-xs font-semibold text-muted"
      >
        {initials(name)}
      </span>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- los avatares vienen de AoE4World; next/image exigiría declarar el host remoto.
    <img
      src={avatarUrl}
      alt=""
      width={36}
      height={36}
      loading="lazy"
      decoding="async"
      className="size-9 shrink-0 rounded-md border border-line bg-surface-raised object-cover"
    />
  );
}
