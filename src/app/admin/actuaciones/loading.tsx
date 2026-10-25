/**
 * Esqueleto de carga del expediente de actuaciones.
 *
 * Reserva la forma real —titular, botón de alta, barra de filtros y tabla— con
 * las mismas cajas de `surface`/`line`, para que el listado no salte al llegar
 * los datos.
 */
export default function Loading() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex animate-pulse flex-col gap-6 motion-reduce:animate-none"
    >
      <span className="sr-only">Cargando las actuaciones</span>

      <div aria-hidden="true" className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-col gap-2">
          <span className="h-8 w-48 rounded bg-surface-raised" />
          <span className="h-4 w-full max-w-[70ch] rounded bg-surface-raised" />
          <span className="h-4 w-2/3 max-w-[70ch] rounded bg-surface-raised" />
        </div>
        <span className="h-10 w-40 shrink-0 rounded-md bg-surface-raised" />
      </div>

      <div aria-hidden="true" className="flex flex-col gap-4">
        <div className="rounded-lg border border-line bg-surface p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <span className="h-10 w-full rounded-md bg-surface-raised sm:w-[240px]" />
            <span className="h-10 w-44 rounded-md bg-surface-raised" />
            <span className="h-10 w-44 rounded-md bg-surface-raised" />
          </div>
        </div>

        <div className="overflow-hidden rounded-lg border border-line">
          <div className="h-11 border-b border-line bg-surface" />
          <div className="divide-y divide-line">
            {[0, 1, 2, 3, 4, 5, 6, 7].map((row) => (
              <div key={row} className="h-12" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
