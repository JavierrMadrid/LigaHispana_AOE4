/**
 * Esqueleto de carga del panel de participantes.
 *
 * La página lee la base en cada petición. Se reserva la forma real —titular, las
 * dos tarjetas de resumen y sincronización, la barra de filtros y el listado—
 * con las mismas cajas de `surface`/`line`, para que el contenido no salte al
 * llegar los datos.
 */
export default function Loading() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex animate-pulse flex-col gap-8 motion-reduce:animate-none"
    >
      <span className="sr-only">Cargando el panel de participantes</span>

      <div aria-hidden="true" className="flex flex-col gap-2">
        <span className="h-8 w-48 rounded bg-surface-raised" />
        <span className="h-4 w-full max-w-[70ch] rounded bg-surface-raised" />
      </div>

      <div aria-hidden="true" className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="thread-top relative overflow-hidden rounded-lg border border-line bg-surface px-5 py-4">
          <span className="h-4 w-3/4 rounded bg-surface-raised" />
        </div>
        <div className="rounded-lg border border-line bg-surface px-5 py-4">
          <span className="h-4 w-40 rounded bg-surface-raised" />
          <span className="mt-2 block h-4 w-full rounded bg-surface-raised" />
        </div>
      </div>

      <div aria-hidden="true" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="h-10 w-full rounded-md bg-surface-raised sm:w-[300px]" />
          <div className="flex flex-wrap items-center gap-1.5">
            {[0, 1, 2, 3].map((pill) => (
              <span key={pill} className="h-10 w-24 rounded-full bg-surface-raised" />
            ))}
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
