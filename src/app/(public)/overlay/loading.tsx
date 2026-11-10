/**
 * Esqueleto del configurador del overlay.
 *
 * Reserva las dos columnas reales —la lista de participantes y la vista previa
 * con su URL e instrucciones— con las mismas cajas de `surface`/`line`, para que
 * la pantalla no salte al llegar la clasificación.
 */
export default function Loading() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex animate-pulse flex-col gap-6 motion-reduce:animate-none"
    >
      <span className="sr-only">Cargando el configurador del overlay</span>

      <div
        aria-hidden="true"
        className="grid items-start gap-6 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]"
      >
        <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4">
          <span className="h-5 w-28 rounded bg-surface-raised" />
          <span className="h-10 rounded bg-surface-raised" />
          {[0, 1, 2, 3, 4].map((row) => (
            <span key={row} className="h-11 rounded bg-surface-raised" />
          ))}
        </div>

        <div className="flex flex-col gap-3">
          <span className="h-5 w-24 rounded bg-surface-raised" />
          <span className="h-[360px] rounded-lg border border-line bg-surface-raised sm:h-[400px]" />
          <span className="h-10 rounded bg-surface-raised" />
          <span className="h-40 rounded-lg border border-line bg-surface-raised" />
        </div>
      </div>
    </div>
  );
}
