"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { PlayerStatus } from "@/generated/prisma/enums";
import { deletePlayer } from "@/app/admin/actions";
import type { AdminParticipant } from "@/lib/admin";
import { ActionFeedbackProvider } from "@/components/action-feedback";
import { ChannelLinks } from "@/components/channel-links";
import { ConfirmAction } from "@/components/confirm-action";
import { EmptyState } from "@/components/empty-state";
import {
  DEFAULT_PAGE_SIZE_VALUE,
  PAGE_SIZE_OPTIONS,
  readPageSize,
} from "@/components/page-size-select";
import {
  SortableHeaderButton,
  nextSortState,
  type ActiveSort,
} from "@/components/sortable-header";
import { aoe4WorldProfileUrl } from "@/lib/format";
import { PlayerEditDialog } from "./player-edit-dialog";
import { PlayerStatusActions } from "./player-status-actions";
import { VerificationBadge } from "./participant-verification";
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
  { id: "BANNED", label: "Expulsados" },
];

const CELL = "px-4 py-3 align-top";

/* -------------------------------------------------------------------------- */
/* Orden por columna                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Las columnas ordenables del listado. Quedan fuera Acciones (no es un dato) y
 * Canales (es un grupo de enlaces: ordenar por él sería ordenar por el primero de
 * tres canales distintos, que no significa nada).
 */
type SortKey = "name" | "aoe4WorldName" | "country" | "status" | "matchCount" | "points";

/**
 * Orden de los estados, calcado del que aplica el servidor (`status asc`): en
 * Postgres el enum se ordena por el orden de declaración (`PENDING`, `APPROVED`,
 * `REJECTED`, `BANNED`), que es el que deja la cola de solicitudes primero y a
 * los expulsados, que no piden nada, al final.
 */
const STATUS_ORDER: Record<PlayerStatus, number> = {
  PENDING: 0,
  APPROVED: 1,
  REJECTED: 2,
  BANNED: 3,
};

/**
 * Los nulos van al final en los dos sentidos: un jugador sin perfil oficial, sin
 * país o fuera de la clasificación —el que no está aprobado, el único que llega
 * con las cifras en blanco— no debe encabezar la tabla ni al ordenar ascendente ni
 * al descendente.
 */
function compareNullableText(a: string | null, b: string | null, dir: 1 | -1): number {
  if (a === null && b === null) {
    return 0;
  }

  if (a === null) {
    return 1;
  }

  if (b === null) {
    return -1;
  }

  return normalize(a).localeCompare(normalize(b), "es") * dir;
}

function compareNullableNumber(a: number | null, b: number | null, dir: 1 | -1): number {
  if (a === null && b === null) {
    return 0;
  }

  if (a === null) {
    return 1;
  }

  if (b === null) {
    return -1;
  }

  return (a - b) * dir;
}

function comparePlayers(
  a: AdminParticipant,
  b: AdminParticipant,
  sort: { key: SortKey; dir: "asc" | "desc" },
): number {
  const dir = sort.dir === "asc" ? 1 : -1;

  switch (sort.key) {
    case "name":
      return normalize(a.name).localeCompare(normalize(b.name), "es") * dir;
    case "aoe4WorldName":
      return compareNullableText(a.aoe4WorldName, b.aoe4WorldName, dir);
    case "country":
      return compareNullableText(a.country, b.country, dir);
    case "status":
      return (STATUS_ORDER[a.status] - STATUS_ORDER[b.status]) * dir;
    case "matchCount":
      return compareNullableNumber(a.matchCount, b.matchCount, dir);
    case "points":
      return compareNullableNumber(a.points, b.points, dir);
  }
}

/**
 * Listado completo de participantes con buscador, filtro por estado y orden por
 * columna en cliente.
 *
 * El DAL manda la lista entera (son decenas de filas) y aquí solo se filtra, se
 * ordena, se pagina y se pinta, así que buscar no recarga la página. **La
 * paginación es de cliente a propósito**: con la búsqueda filtrando sobre lo que ya
 * hay, paginar en servidor haría que buscar solo encontrara lo de la página visible,
 * que es el fallo clásico de combinar las dos cosas. Los estados no aprobados no se
 * esconden: se marcan, y sus cifras salen como raya y no como cero, porque fuera de
 * la clasificación un cero afirmaría algo falso. Un aprobado, en cambio, siempre
 * tiene fila: si no ha jugado nada todavía, sus cifras son 0.
 *
 * El orden sigue el ciclo de tres estados de la tabla pública (ascendente →
 * descendente → orden original del servidor, que aquí es `status` y después `name`),
 * con `aria-sort` y chevron. "Quitar filtros" **no** toca el orden; cambiar filtros,
 * búsqueda u orden vuelve a la primera página.
 */
export function ParticipantsBrowser({
  participants,
  countries,
  canReverse,
}: {
  participants: AdminParticipant[];
  countries: string[];
  canReverse: boolean;
}) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("ALL");
  const [sort, setSort] = useState<ActiveSort<SortKey>>(null);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE_VALUE);
  const [page, setPage] = useState(1);

  const counts = useMemo(() => {
    const map: Record<StatusFilter, number> = {
      ALL: participants.length,
      APPROVED: 0,
      PENDING: 0,
      REJECTED: 0,
      BANNED: 0,
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
          `${player.name} ${player.aoe4WorldName ?? ""} ${player.country ?? ""} ${
            player.discordUsername ?? ""
          } ${player.twitchChannel ?? ""} ${player.youtubeChannel ?? ""} ${
            player.kickChannel ?? ""
          }`,
        );

        if (!haystack.includes(needle)) {
          return false;
        }
      }

      return true;
    });
  }, [participants, query, status]);

  // El orden se aplica sobre el resultado ya filtrado: primero se decide quién
  // entra y después en qué orden se muestra.
  const sorted = useMemo(() => {
    if (sort === null) {
      return filtered;
    }

    return [...filtered].sort((a, b) => comparePlayers(a, b, sort));
  }, [filtered, sort]);

  const hasFilters = query.trim() !== "" || status !== "ALL";

  /**
   * La página que se pinta, acotada a las que existen.
   *
   * Se acota aquí y no con un `useEffect` que reinicie al cambiar los filtros: si la
   * página 3 deja de existir porque el filtro reduce la lista, esto cae solo en la
   * última válida, sin un renderizado de más ni un estado intermedio incoherente.
   */
  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
  const currentPage = Math.min(page, pageCount);

  const paged = useMemo(
    () => sorted.slice((currentPage - 1) * pageSize, currentPage * pageSize),
    [sorted, currentPage, pageSize],
  );

  function clearFilters() {
    setQuery("");
    setStatus("ALL");
    setPage(1);
  }

  function changePageSize(next: number) {
    setPageSize(next);
    setPage(1);
  }

  // Un clic ordena ascendente, el segundo descendente y el tercero vuelve al orden
  // original del servidor (`status` y después `name`). Cada cambio vuelve a la
  // primera página, porque la página 3 de un orden nuevo no significa nada.
  function toggleSort(column: string) {
    setSort((current) => nextSortState(current, column as SortKey));
    setPage(1);
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
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(1);
              }}
              placeholder="Buscar por nombre, perfil, país, canal o Discord"
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
                  onClick={() => {
                    setStatus(active && item.id !== "ALL" ? "ALL" : item.id);
                    setPage(1);
                  }}
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
          <>
            <div className="overflow-x-auto overscroll-x-contain rounded-lg border border-line lg:max-h-[70vh] lg:overflow-y-auto">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">
                  Jugadores del torneo: nombre, perfil de AoE4World, canales de directo,
                  cuenta de Discord y su pertenencia al servidor, país, estado, partidas
                  clasificatorias y puntos. Una raya en partidas o puntos significa que el
                  jugador no está aprobado y por tanto no está en la clasificación; un
                  participante aprobado sin partidas clasificatorias muestra 0. Un jugador
                  sin cuenta de Discord aparece como Sin Discord, y su pertenencia se marca
                  como En el servidor, Fuera del servidor o Sin comprobar. Las columnas de
                  jugador, perfil, país, estado, partidas y puntos se pueden ordenar. Junto
                  al estado se indica el de la verificación del alta por privado de
                  Discord: Esperando confirmación, Verificación sin enviar, Verificado,
                  Rechazó la participación o Aprobado sin verificar.
                </caption>
                <thead className="bg-surface text-muted">
                  <tr>
                    <SortableHeaderButton
                      column="name"
                      label="Jugador"
                      sort={sort}
                      onSort={toggleSort}
                      className="px-4 py-3 font-medium"
                    />
                    <SortableHeaderButton
                      column="aoe4WorldName"
                      label="AoE4World"
                      sort={sort}
                      onSort={toggleSort}
                      className="hidden px-4 py-3 font-medium lg:table-cell"
                    />
                    {/* Los canales son enlaces: no se ordenan, no hay un criterio único. */}
                    <th
                      scope="col"
                      className="hidden bg-surface px-4 py-3 font-medium lg:sticky lg:top-0 lg:z-10 lg:table-cell"
                    >
                      Canales
                    </th>
                    {/* El Discord es de solo lectura y no se ordena: no hay un criterio
                        de orden que signifique algo para quien administra. La columna
                        muestra el @usuario y su estado de pertenencia al servidor. */}
                    <th
                      scope="col"
                      className="hidden bg-surface px-4 py-3 font-medium lg:sticky lg:top-0 lg:z-10 lg:table-cell"
                    >
                      Discord
                    </th>
                    <SortableHeaderButton
                      column="country"
                      label="País"
                      sort={sort}
                      onSort={toggleSort}
                      className="hidden px-4 py-3 font-medium lg:table-cell"
                    />
                    <SortableHeaderButton
                      column="status"
                      label="Estado"
                      sort={sort}
                      onSort={toggleSort}
                      className="hidden px-4 py-3 font-medium lg:table-cell"
                    />
                    <SortableHeaderButton
                      column="matchCount"
                      label="Partidas"
                      sort={sort}
                      onSort={toggleSort}
                      align="right"
                      className="hidden px-4 py-3 font-medium lg:table-cell"
                    />
                    <SortableHeaderButton
                      column="points"
                      label="Puntos"
                      sort={sort}
                      onSort={toggleSort}
                      align="right"
                      className="hidden px-4 py-3 font-medium lg:table-cell"
                    />
                    <th
                      scope="col"
                      className="bg-surface px-4 py-3 text-right font-medium lg:sticky lg:top-0 lg:z-10"
                    >
                      Acciones
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {paged.map((player) => (
                    <ParticipantRow
                      key={player.id}
                      player={player}
                      countries={countries}
                      canReverse={canReverse}
                    />
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-2 text-xs text-muted">
                <label htmlFor="participantes-page-size">Filas por página</label>
                <select
                  id="participantes-page-size"
                  value={String(pageSize)}
                  onChange={(event) => changePageSize(readPageSize(event.target.value))}
                  className="h-10 rounded-md border border-line bg-background px-2 text-foreground"
                >
                  {PAGE_SIZE_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </div>

              <nav aria-label="Paginación" className="flex flex-wrap items-center gap-3">
                <p className="text-xs text-muted">
                  Mostrando {paged.length} de {sorted.length}
                  {pageCount > 1 ? ` · página ${currentPage} de ${pageCount}` : ""}
                </p>

                {pageCount > 1 ? (
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setPage(currentPage - 1)}
                      disabled={currentPage <= 1}
                      className="inline-flex h-10 items-center rounded-md border border-line bg-surface px-3 text-sm text-foreground transition-colors hover:border-accent/50 hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Anterior
                    </button>
                    <button
                      type="button"
                      onClick={() => setPage(currentPage + 1)}
                      disabled={currentPage >= pageCount}
                      className="inline-flex h-10 items-center rounded-md border border-line bg-surface px-3 text-sm text-foreground transition-colors hover:border-accent/50 hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Siguiente
                    </button>
                  </div>
                ) : null}
              </nav>
            </div>
          </>
        )}
      </div>
    </ActionFeedbackProvider>
  );
}

function ParticipantRow({
  player,
  countries,
  canReverse,
}: {
  player: AdminParticipant;
  countries: string[];
  canReverse: boolean;
}) {
  const hasChannels =
    player.twitchChannel !== null ||
    player.youtubeChannel !== null ||
    player.kickChannel !== null;

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
                nombre, en vez de comprimir nueve columnas en un móvil. */}
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted lg:hidden">
              <StatusBadge status={player.status} />
              <VerificationBadge player={player} />
              <ProfileLink player={player} />
              {player.country !== null ? <span>{player.country}</span> : null}
              {player.discordUsername !== null ? (
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="break-all">Discord @{player.discordUsername}</span>
                  <DiscordGuildBadge inGuild={player.discordInGuild} />
                </span>
              ) : (
                <span>Sin Discord</span>
              )}
              {player.twitchChannel !== null ? (
                <span className="break-all">Twitch {player.twitchChannel}</span>
              ) : null}
              {player.youtubeChannel !== null ? (
                <span className="break-all">YouTube {player.youtubeChannel}</span>
              ) : null}
              {player.kickChannel !== null ? (
                <span className="break-all">Kick {player.kickChannel}</span>
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

      <td className={`${CELL} hidden lg:table-cell`}>
        {hasChannels ? (
          <ChannelLinks
            name={player.name}
            twitch={
              player.twitchChannel === null
                ? null
                : { channel: player.twitchChannel, isLive: false }
            }
            youtube={
              player.youtubeChannel === null
                ? null
                : { channel: player.youtubeChannel, isLive: false }
            }
            kick={
              player.kickChannel === null
                ? null
                : { channel: player.kickChannel, isLive: false }
            }
          />
        ) : (
          <span className="text-muted">—</span>
        )}
      </td>

      <td className={`${CELL} hidden lg:table-cell`}>
        {player.discordUsername === null ? (
          <span className="text-muted">Sin Discord</span>
        ) : (
          <div className="flex flex-col items-start gap-1.5">
            <span className="block max-w-[12rem] break-words text-foreground">
              @{player.discordUsername}
            </span>
            {/* El usuario puede partirse (`break-words`, nombres largos o con
                puntos), pero el distintivo de al lado no: se queda en su línea
                aunque la columna quede justa. */}
            <div className="flex flex-wrap items-center gap-2">
              <DiscordGuildBadge inGuild={player.discordInGuild} />
            </div>
          </div>
        )}
      </td>

      <td className={`${CELL} hidden lg:table-cell`}>
        {player.country === null ? <span className="text-muted">—</span> : player.country}
      </td>

      <td className={`${CELL} hidden lg:table-cell`}>
        <div className="flex flex-col items-start gap-1">
          <StatusBadge status={player.status} />
          <VerificationBadge player={player} />
          {player.status !== "APPROVED" ? (
            <span className="text-xs text-muted">Fuera de la clasificación</span>
          ) : null}
        </div>
      </td>

      <td className={`${CELL} hidden text-right tabular-nums lg:table-cell`}>
        {player.matchCount === null ? (
          <span className="text-muted" title="No está aprobado, así que no está en la clasificación">
            —
          </span>
        ) : (
          player.matchCount
        )}
      </td>

      <td className={`${CELL} hidden text-right tabular-nums lg:table-cell`}>
        {player.points === null ? (
          <span className="text-muted" title="No está aprobado, así que no está en la clasificación">
            —
          </span>
        ) : (
          player.points
        )}
      </td>

      <td className={`${CELL} text-right`}>
        {player.status === "BANNED" ? (
          <div className="flex flex-col items-end gap-2">
            <div className="flex flex-wrap items-center justify-end gap-2">
              <PlayerEditDialog player={player} countries={countries} canReverse={canReverse} />

              <Link
                href={`/admin/actuaciones?playerId=${player.id}&state=active`}
                className="inline-flex h-10 items-center rounded-md border border-line px-3 text-xs text-muted transition-colors hover:bg-surface-raised hover:text-foreground"
              >
                Ver actuaciones
              </Link>

              {canReverse ? (
                <Link
                  href={`/admin/actuaciones/nueva?accion=REVERSAL&participante=${player.id}`}
                  className="inline-flex h-10 items-center rounded-md border border-accent/40 px-3 text-xs text-accent transition-colors hover:bg-accent/10"
                >
                  Revertir expulsión
                </Link>
              ) : null}
            </div>

            <p className="max-w-[24rem] text-right text-xs leading-relaxed text-muted">
              Expulsado: se levanta con una actuación de reversión.
              {canReverse ? null : " Solo el superadministrador puede revertirla."} No
              se puede aprobar, rechazar ni eliminar mientras la expulsión siga
              vigente.
            </p>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-end gap-2">
            {/* Editar va primero y en tono neutro: es la acción que se usa a
                diario, y el filete tenue la deja cerca del nombre sin competir con
                aprobar, rechazar o eliminar, que sí cambian el estado o borran.
                Los botones de estado (aprobar, rechazar, reenviar la verificación)
                van juntos en `PlayerStatusActions`, que es el mismo componente que
                usa la cola de pendientes: un alta sujeta a verificación no puede
                ofrecer «Aprobar» aquí y «Reenviar» allí. */}
            <PlayerEditDialog player={player} countries={countries} canReverse={canReverse} />

            <PlayerStatusActions player={player} canReverse={canReverse} />

            <ConfirmAction
              action={deletePlayer}
              fields={{ playerId: player.id }}
              title="Eliminar jugador"
              body={
                <>
                  Se eliminará a {player.name} (AoE4World {player.profileId}) y todas sus
                  partidas. Esta acción no se puede deshacer.
                  <span className="mt-2 block text-xs text-muted">
                    Si tiene actuaciones vigentes, la baja se rechazará hasta que se
                    reviertan desde Actuaciones.
                  </span>
                </>
              }
              triggerLabel="Eliminar"
              triggerClassName="h-10 rounded-md border border-loss/40 px-3 text-xs text-loss transition-colors hover:bg-loss/10"
              confirmLabel="Eliminar jugador"
              confirmPendingLabel="Eliminando…"
              confirmClassName="bg-loss text-accent-ink hover:brightness-110"
            />
          </div>
        )}
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
 * Pertenencia de la cuenta de Discord al servidor del torneo.
 *
 * `discordInGuild` es `boolean | null` y los **tres** valores tienen que leerse
 * distintos: `true` es "comprobado y está", `false` es "comprobado y no está" y
 * `null` es **sin comprobar**, que es el caso por defecto mientras el worker no ha
 * mirado la lista de miembros. Por eso el desconocido va en neutro y con la
 * palabra "Sin comprobar": pintarlo como "no está" sería afirmar algo que nadie ha
 * comprobado. El color refuerza el rótulo, nunca lo sustituye, igual que en
 * `StatusBadge`.
 */
function DiscordGuildBadge({ inGuild }: { inGuild: boolean | null }) {
  const state =
    inGuild === true
      ? { label: "En el servidor", style: "border-win/40 text-win" }
      : inGuild === false
        ? { label: "Fuera del servidor", style: "border-loss/40 text-loss" }
        : { label: "Sin comprobar", style: "border-line text-muted" };

  return (
    <span
      // `whitespace-nowrap` porque el rótulo no puede partirse: "En el
      // servidor" en dos líneas dentro de una píldora redonda se lee como dos
      // cosas, y "Fuera del servidor" no cabe en la columna junto al usuario.
      // Si la columna no da de sí, se desplaza la tabla, que ya lo hace.
      className={`inline-block whitespace-nowrap rounded-full border px-2 py-0.5 text-xs ${state.style}`}
    >
      {state.label}
    </span>
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
