/**
 * Esqueleto de carga de la operación de objetos.
 *
 * Reserva la forma real —titular, el bloque de pendientes con sus tarjetas y el
 * historial— con las mismas cajas de `surface`/`line`, para que la pantalla no
 * salte al llegar las tres lecturas de la base.
 */
export default function Loading() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex animate-pulse flex-col gap-8 motion-reduce:animate-none"
    >
      <span className="sr-only">Cargando los objetos</span>

      <div aria-hidden="true" className="flex flex-col gap-2">
        <span className="h-8 w-36 rounded bg-surface-raised" />
        <span className="h-4 w-full max-w-[70ch] rounded bg-surface-raised" />
        <span className="h-4 w-2/3 max-w-[70ch] rounded bg-surface-raised" />
      </div>

      <div aria-hidden="true" className="flex flex-col gap-4">
        <div className="flex items-baseline justify-between gap-4">
          <span className="h-6 w-44 rounded bg-surface-raised" />
          <span className="h-4 w-32 rounded bg-surface-raised" />
        </div>
        <span className="h-4 w-full max-w-[70ch] rounded bg-surface-raised" />

        <div className="flex flex-col gap-4">
          {[0, 1].map((card) => (
            <div key={card} className="rounded-lg border border-line bg-surface">
              <div className="flex flex-col gap-3 px-5 py-4">
                <span className="h-5 w-48 rounded bg-surface-raised" />
                <span className="h-3 w-72 rounded bg-surface-raised" />
                <div className="mt-1 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
                  {[0, 1, 2, 3].map((cell) => (
                    <div key={cell} className="flex flex-col gap-1.5">
                      <span className="h-3 w-16 rounded bg-surface-raised" />
                      <span className="h-4 w-full rounded bg-surface-raised" />
                    </div>
                  ))}
                </div>
              </div>

              <div className="grid border-t border-line lg:grid-cols-2">
                <div className="flex flex-col gap-3 px-5 py-4 lg:border-r lg:border-line">
                  <span className="h-4 w-36 rounded bg-surface-raised" />
                  <span className="h-3 w-full rounded bg-surface-raised" />
                  <span className="h-10 w-full rounded-md bg-surface-raised" />
                  <span className="h-10 w-32 rounded-md bg-surface-raised" />
                </div>
                <div className="flex flex-col gap-3 border-t border-line px-5 py-4 lg:border-t-0">
                  <span className="h-4 w-52 rounded bg-surface-raised" />
                  <span className="h-3 w-full rounded bg-surface-raised" />
                  <span className="h-10 w-full rounded-md bg-surface-raised" />
                  <span className="h-10 w-36 rounded-md bg-surface-raised" />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div aria-hidden="true" className="flex flex-col gap-4">
        <div className="flex items-baseline justify-between gap-4">
          <span className="h-6 w-28 rounded bg-surface-raised" />
          <span className="h-4 w-32 rounded bg-surface-raised" />
        </div>
        <span className="h-4 w-full max-w-[70ch] rounded bg-surface-raised" />

        <div className="overflow-hidden rounded-lg border border-line">
          <div className="h-11 border-b border-line bg-surface" />
          <div className="divide-y divide-line">
            {[0, 1, 2].map((row) => (
              <div key={row} className="h-12" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
