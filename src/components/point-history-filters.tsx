"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { PlayerCombobox, type ComboboxOption } from "@/components/player-combobox";

type PointHistoryFiltersProps = {
  /** Ruta a la que vuelven los filtros: el historial global o el de un jugador. */
  basePath: string;
  /**
   * Los participantes del desplegable. Sin lista no hay selector de participante:
   * la pestaña de historial de un jugador ya **es** su feed —el id lo fija la
   * ruta—, así que ahí solo se filtra por fechas.
   */
  players?: ComboboxOption[];
};

/**
 * Filtros del historial público de puntos: participante y rango de fechas.
 *
 * La fuente de verdad es la URL (el servidor filtra y pagina con `searchParams`),
 * así que cada control navega al cambiar en lugar de guardar estado propio: la
 * página se puede recargar y compartir y enseña lo mismo. Al tocar cualquier filtro
 * se quita `page`, porque la página 5 de un filtro nuevo no significa nada.
 *
 * Son **dos** ejes y no tres: aquí solo entran las ganancias, así que lo que se
 * elige es de quién y de cuándo, no qué pasó (el filtro de resultado es del panel,
 * que lista el recorrido entero). Los dos se combinan solos porque el servidor los
 * conjuga en un único `where`: en cuanto uno cambia, solo se reescribe su parámetro
 * y el resto se conserva.
 *
 * El buscador del desplegable de participante no vive en la URL, y a propósito: es
 * una ayuda para encontrar una opción dentro de la lista, no un filtro del
 * historial. Lo que sí va en la URL es el `profileId` elegido, que es el filtro de
 * verdad —el mismo id público del detalle del participante, no el id interno del
 * panel—.
 *
 * La barra la montan dos pantallas con el mismo eje: el historial global
 * (`/historial`, con su selector) y la pestaña de historial de un participante
 * (solo fechas, porque allí el jugador es la ruta). Por eso vive en
 * `src/components/` y la ruta entra por `basePath`.
 */
export function PointHistoryFilters({ basePath, players }: PointHistoryFiltersProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const jugador = searchParams.get("jugador") ?? "";
  const from = searchParams.get("from") ?? "";
  const to = searchParams.get("to") ?? "";
  const withPlayers = players !== undefined;
  const hasFilters = (withPlayers && jugador !== "") || from !== "" || to !== "";

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
    router.push(query === "" ? basePath : `${basePath}?${query}`);
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4 lg:flex-row lg:items-end lg:justify-between">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        {withPlayers ? (
          <div className="flex flex-col gap-1 text-sm sm:w-[240px]">
            <label htmlFor="filtro-participante" className="text-muted">
              Participante
            </label>
            <PlayerCombobox
              inputId="filtro-participante"
              options={players}
              value={jugador}
              onChange={(id) => navigate({ jugador: id })}
              allLabel="Todos los participantes"
            />
          </div>
        ) : null}

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
          onClick={() =>
            navigate(withPlayers ? { jugador: "", from: "", to: "" } : { from: "", to: "" })
          }
          className="inline-flex h-10 items-center self-start rounded-md border border-line px-3 text-sm text-muted transition-colors hover:border-line-strong hover:text-foreground lg:self-auto"
        >
          Quitar filtros
        </button>
      ) : null}
    </div>
  );
}
