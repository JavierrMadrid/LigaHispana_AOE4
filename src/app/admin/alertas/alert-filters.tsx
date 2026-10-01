"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { PlayerCombobox, type ComboboxOption } from "@/components/player-combobox";

type SelectOption = { value: string; label: string };

type AlertFiltersProps = {
  players: ComboboxOption[];
  ruleOptions: SelectOption[];
  kindOptions: SelectOption[];
};

/**
 * Filtros de la tabla de alertas: jugador, regla, tipo y rango de fechas.
 *
 * Es la misma pieza que la barra del historial de partidas y con el mismo
 * comportamiento, porque es el mismo problema: la fuente de verdad es la URL (el
 * servidor pagina y filtra con `searchParams`), así que cada control navega al
 * cambiar en lugar de guardar estado propio, y al tocar cualquier filtro se quita
 * `page`, porque la página 5 de un filtro nuevo no significa nada.
 *
 * Las opciones de regla y de tipo llegan resueltas desde el servidor: las
 * etiquetas viven en `ALERT_RULE_LABELS` / `ALERT_KIND_LABELS` y el valor que
 * viaja a la URL es el literal del enum (se comparan literales, no etiquetas).
 * El buscador interno del desplegable de jugador **no** va en la URL: es una
 * ayuda para encontrar una opción, no un filtro.
 */
export function AlertFilters({ players, ruleOptions, kindOptions }: AlertFiltersProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const selectedPlayer = searchParams.get("playerId") ?? "";
  const regla = searchParams.get("regla") ?? "";
  const tipo = searchParams.get("tipo") ?? "";
  const from = searchParams.get("from") ?? "";
  const to = searchParams.get("to") ?? "";
  const hasFilters =
    selectedPlayer !== "" || regla !== "" || tipo !== "" || from !== "" || to !== "";

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
    router.push(query === "" ? "/admin/alertas" : `/admin/alertas?${query}`);
  }

  const selectClass = "h-10 rounded-md border border-line bg-background px-3 text-foreground";

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4 lg:flex-row lg:items-end lg:justify-between">
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
        <div className="flex flex-col gap-1 text-sm sm:w-[240px]">
          <label htmlFor="filtro-alerta-jugador" className="text-muted">
            Jugador
          </label>
          <PlayerCombobox
            inputId="filtro-alerta-jugador"
            options={players}
            value={selectedPlayer}
            onChange={(id) => navigate({ playerId: id })}
            allLabel="Todos los jugadores"
          />
        </div>

        <div className="flex flex-col gap-1 text-sm">
          <label htmlFor="filtro-alerta-regla" className="text-muted">
            Regla
          </label>
          <select
            id="filtro-alerta-regla"
            value={regla}
            onChange={(event) => navigate({ regla: event.target.value })}
            className={selectClass}
          >
            <option value="">Todas</option>
            {ruleOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1 text-sm">
          <label htmlFor="filtro-alerta-tipo" className="text-muted">
            Tipo
          </label>
          <select
            id="filtro-alerta-tipo"
            value={tipo}
            onChange={(event) => navigate({ tipo: event.target.value })}
            className={selectClass}
          >
            <option value="">Todos</option>
            {kindOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1 text-sm">
          <label htmlFor="filtro-alerta-desde" className="text-muted">
            Desde
          </label>
          <input
            id="filtro-alerta-desde"
            type="date"
            value={from}
            onChange={(event) => navigate({ from: event.target.value })}
            className={selectClass}
          />
        </div>

        <div className="flex flex-col gap-1 text-sm">
          <label htmlFor="filtro-alerta-hasta" className="text-muted">
            Hasta
          </label>
          <input
            id="filtro-alerta-hasta"
            type="date"
            value={to}
            onChange={(event) => navigate({ to: event.target.value })}
            className={selectClass}
          />
        </div>
      </div>

      {hasFilters ? (
        <button
          type="button"
          onClick={() => navigate({ playerId: "", regla: "", tipo: "", from: "", to: "" })}
          className="inline-flex h-10 items-center self-start rounded-md border border-line px-3 text-sm text-muted transition-colors hover:border-line-strong hover:text-foreground lg:self-auto"
        >
          Quitar filtros
        </button>
      ) : null}
    </div>
  );
}
