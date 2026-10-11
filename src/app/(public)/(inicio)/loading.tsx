/**
 * Esqueleto de carga de la clasificación.
 *
 * La portada es `force-dynamic` y lee la base en cada petición, así que entre la
 * navegación y los datos hay un hueco. En lugar de una pantalla en blanco se
 * reserva la forma de lo que va a llegar —banda del torneo, barra de filtros y
 * filas de clasificación— con las mismas cajas de `surface`/`line`, para que el
 * diseño no salte cuando lleguen los datos.
 */
export default function Loading() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex animate-pulse flex-col gap-6 motion-reduce:animate-none"
    >
      <span className="sr-only">Cargando la clasificación</span>

      <div
        aria-hidden="true"
        className="thread-top relative overflow-hidden rounded-lg border border-line bg-surface px-5 py-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
          <span className="h-4 w-40 rounded bg-surface-raised" />
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <span className="h-4 w-24 rounded bg-surface-raised" />
            <span className="h-4 w-28 rounded bg-surface-raised" />
            <span className="h-4 w-24 rounded bg-surface-raised" />
          </div>
        </div>
      </div>

      <div aria-hidden="true" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="h-10 w-full rounded-md bg-surface-raised sm:w-[300px]" />
            <span className="h-10 w-24 rounded-full bg-surface-raised" />
            <span className="h-10 w-24 rounded-full bg-surface-raised" />
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {[0, 1, 2, 3, 4, 5, 6].map((chip) => (
              <span key={chip} className="size-10 rounded-md bg-surface-raised" />
            ))}
          </div>
        </div>
      </div>

      <div aria-hidden="true" className="flex flex-col gap-1.5">
        {[0, 1, 2, 3, 4, 5, 6, 7].map((row) => (
          <span key={row} className="h-12 rounded-md bg-surface" />
        ))}
      </div>
    </div>
  );
}
