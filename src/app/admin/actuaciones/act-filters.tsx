"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { ADMIN_ACT_KINDS, ADMIN_ACT_KIND_LABELS } from "@/lib/admin-acts";
import { PlayerCombobox, type ComboboxOption } from "@/components/player-combobox";

const STATE_OPTIONS = [
  { value: "active", label: "Vigentes" },
  { value: "reverted", label: "Revertidas" },
  { value: "final", label: "Finales (reversiones)" },
] as const;

type ActFiltersProps = {
  players: ComboboxOption[];
};

/**
 * Filtros del listado de actuaciones: jugador, tipo y estado.
 *
 * La fuente de verdad es la URL, igual que en el historial de puntos y en las
 * alertas: el servidor pagina y filtra con `searchParams`. Cada control navega al
 * cambiar y quita `page`, porque la página 5 de un filtro nuevo no significa nada.
 * El buscador dentro del desplegable de jugador no viaja en la URL: es una ayuda
 * para encontrar una opción, no un filtro.
 */
export function ActFilters({ players }: ActFiltersProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const selectedPlayer = searchParams.get("playerId") ?? "";
  const kind = searchParams.get("kind") ?? "";
  const rawState = searchParams.get("state") ?? "";
  const state = rawState === "all" ? "" : rawState;
  const hasFilters = selectedPlayer !== "" || kind !== "" || state !== "";

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
    router.push(query === "" ? "/admin/actuaciones" : `/admin/actuaciones?${query}`);
  }

  const selectClass = "h-10 rounded-md border border-line bg-background px-3 text-foreground";

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4 lg:flex-row lg:items-end lg:justify-between">
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
        <div className="flex flex-col gap-1 text-sm sm:w-[240px]">
          <label htmlFor="filtro-actuacion-jugador" className="text-muted">
            Participante
          </label>
          <PlayerCombobox
            inputId="filtro-actuacion-jugador"
            options={players}
            value={selectedPlayer}
            onChange={(id) => navigate({ playerId: id })}
            allLabel="Todos los participantes"
          />
        </div>

        <div className="flex flex-col gap-1 text-sm">
          <label htmlFor="filtro-actuacion-tipo" className="text-muted">
            Tipo
          </label>
          <select
            id="filtro-actuacion-tipo"
            value={kind}
            onChange={(event) => navigate({ kind: event.target.value })}
            className={selectClass}
          >
            <option value="">Todos los tipos</option>
            {ADMIN_ACT_KINDS.map((option) => (
              <option key={option} value={option}>
                {ADMIN_ACT_KIND_LABELS[option]}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1 text-sm">
          <label htmlFor="filtro-actuacion-estado" className="text-muted">
            Estado
          </label>
          <select
            id="filtro-actuacion-estado"
            value={state}
            onChange={(event) => navigate({ state: event.target.value })}
            className={selectClass}
          >
            <option value="">Todos los estados</option>
            {STATE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {hasFilters ? (
        <button
          type="button"
          onClick={() => navigate({ playerId: "", kind: "", state: "" })}
          className="inline-flex h-10 items-center self-start rounded-md border border-line px-3 text-sm text-muted transition-colors hover:border-line-strong hover:text-foreground lg:self-auto"
        >
          Quitar filtros
        </button>
      ) : null}
    </div>
  );
}
