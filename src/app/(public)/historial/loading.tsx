/**
 * Esqueleto de carga del historial de puntos.
 *
 * La página es `force-dynamic` y relee la base en cada petición, así que entre la
 * navegación y los datos hay un hueco. Se reserva la forma real —entradilla, barra de
 * filtros, lista de ganancias y paginación— con las mismas cajas de
 * `surface`/`line`, para que el feed no salte al llegar los datos.
 */
export default function Loading() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="mx-auto flex w-full max-w-6xl animate-pulse flex-col gap-8 motion-reduce:animate-none"
    >
      <span className="sr-only">Cargando el historial de puntos</span>

      <div aria-hidden="true" className="flex flex-col gap-2">
        <span className="h-4 w-full max-w-[68ch] rounded bg-surface-raised" />
        <span className="h-4 w-3/4 max-w-[68ch] rounded bg-surface-raised" />
      </div>

      <div aria-hidden="true" className="flex flex-col gap-4">
        <div className="grid gap-3 rounded-lg border border-line bg-surface p-4 sm:grid-cols-[240px_auto_auto]">
          <span className="h-10 rounded-md bg-surface-raised" />
          <span className="h-10 rounded-md bg-surface-raised" />
          <span className="h-10 rounded-md bg-surface-raised" />
        </div>

        <div className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
          {[0, 1, 2, 3, 4, 5, 6, 7].map((row) => (
            <div key={row} className="h-[4.5rem]" />
          ))}
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <span className="h-10 w-44 rounded-md bg-surface-raised" />
          <span className="h-4 w-52 rounded bg-surface-raised" />
        </div>
      </div>
    </div>
  );
}
