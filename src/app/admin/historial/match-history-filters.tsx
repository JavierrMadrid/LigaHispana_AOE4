"use client";

import { useRouter, useSearchParams } from "next/navigation";

type PlayerOption = {
  id: string;
  name: string;
};

type MatchHistoryFiltersProps = {
  players: PlayerOption[];
};

/**
 * Filtros del historial de partidas: jugador y rango de fechas.
 *
 * La fuente de verdad es la URL (el servidor pagina y filtra con
 * `searchParams`), así que cada control navega al cambiar en lugar de guardar
 * estado propio: si se recarga o se comparte el enlace, la vista es la misma. Al
 * tocar cualquier filtro se quita `page`, porque la página 5 de un filtro nuevo
 * no significa nada.
 */
export function MatchHistoryFilters({ players }: MatchHistoryFiltersProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const selectedPlayer = searchParams.get("playerId") ?? "";
  const from = searchParams.get("from") ?? "";
  const to = searchParams.get("to") ?? "";
  const hasFilters = selectedPlayer !== "" || from !== "" || to !== "";

  function navigate(next: Record<string, string>) {
    const params = new URLSearchParams(searchParams.toString());

    for (const [key, value] of Object.entries(next)) {
      if (value === "") {
        params.delete(key);
      } else {
        params.set(key, value);
      }
    }

    params.delete("page");

    const query = params.toString();
    router.push(query === "" ? "/admin/historial" : `/admin/historial?${query}`);
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4 lg:flex-row lg:items-end lg:justify-between">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex flex-col gap-1 text-sm sm:w-[240px]">
          <label htmlFor="filtro-jugador" className="text-muted">
            Jugador
          </label>
          <select
            id="filtro-jugador"
            value={selectedPlayer}
            onChange={(event) => navigate({ playerId: event.target.value })}
            className="h-10 rounded-md border border-line bg-background px-3 text-foreground"
          >
            <option value="">Todos los jugadores</option>
            {players.map((player) => (
              <option key={player.id} value={player.id}>
                {player.name}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1 text-sm">
          <label htmlFor="filtro-desde" className="text-muted">
            Desde
          </label>
          <input
            id="filtro-desde"
            type="date"
            value={from}
            onChange={(event) => navigate({ from: event.target.value })}
            className="h-10 rounded-md border border-line bg-background px-3 text-foreground"
          />
        </div>

        <div className="flex flex-col gap-1 text-sm">
          <label htmlFor="filtro-hasta" className="text-muted">
            Hasta
          </label>
          <input
            id="filtro-hasta"
            type="date"
            value={to}
            onChange={(event) => navigate({ to: event.target.value })}
            className="h-10 rounded-md border border-line bg-background px-3 text-foreground"
          />
        </div>
      </div>

      {hasFilters ? (
        <button
          type="button"
          onClick={() => navigate({ playerId: "", from: "", to: "" })}
          className="inline-flex h-10 items-center self-start rounded-md border border-line px-3 text-sm text-muted transition-colors hover:border-line-strong hover:text-foreground lg:self-auto"
        >
          Quitar filtros
        </button>
      ) : null}
    </div>
  );
}
