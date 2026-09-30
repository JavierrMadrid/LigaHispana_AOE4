"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { PlayerCombobox, type ComboboxOption } from "./player-combobox";

type MatchHistoryFiltersProps = {
  players: ComboboxOption[];
};

/**
 * Filtros del historial de partidas: jugador, resultado y rango de fechas.
 *
 * La fuente de verdad es la URL (el servidor pagina y filtra con `searchParams`), así
 * que cada control navega al cambiar en lugar de guardar estado propio: si se recarga
 * o se comparte el enlace, la vista es la misma. Al tocar cualquier filtro se quita
 * `page`, porque la página 5 de un filtro nuevo no significa nada.
 *
 * El buscador del desplegable de jugador no vive en la URL, y a propósito: es una
 * ayuda para encontrar una opción dentro de la lista, no un filtro del historial. Lo
 * que sí va en la URL es el `playerId` elegido, que es el filtro de verdad.
 *
 * Los tres filtros se combinan solos porque el servidor los conjuga en un único
 * `where`. Aquí no hay ninguna lógica de prioridad entre ellos, y es lo que evita que
 * «jugador + resultado» se pisen: en cuanto uno cambia, solo se reescribe su parámetro
 * y el resto se conserva.
 */
export function MatchHistoryFilters({ players }: MatchHistoryFiltersProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const selectedPlayer = searchParams.get("playerId") ?? "";
  const resultado = searchParams.get("resultado") ?? "";
  const from = searchParams.get("from") ?? "";
  const to = searchParams.get("to") ?? "";
  const hasFilters = selectedPlayer !== "" || resultado !== "" || from !== "" || to !== "";

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
          <PlayerCombobox
            inputId="filtro-jugador"
            options={players}
            value={selectedPlayer}
            onChange={(id) => navigate({ playerId: id })}
            allLabel="Todos los jugadores"
          />
        </div>

        <div className="flex flex-col gap-1 text-sm">
          <label htmlFor="filtro-resultado" className="text-muted">
            Resultado
          </label>
          <select
            id="filtro-resultado"
            value={resultado}
            onChange={(event) => navigate({ resultado: event.target.value })}
            className="h-10 rounded-md border border-line bg-background px-3 text-foreground"
          >
            <option value="">Todos</option>
            <option value="WIN">Victorias</option>
            <option value="LOSS">Derrotas</option>
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
          onClick={() => navigate({ playerId: "", resultado: "", from: "", to: "" })}
          className="inline-flex h-10 items-center self-start rounded-md border border-line px-3 text-sm text-muted transition-colors hover:border-line-strong hover:text-foreground lg:self-auto"
        >
          Quitar filtros
        </button>
      ) : null}
    </div>
  );
}
