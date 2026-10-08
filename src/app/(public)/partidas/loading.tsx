/**
 * Esqueleto de carga de las partidas en juego.
 *
 * La página es `force-dynamic` y relee la base en cada petición, así que entre la
 * navegación y los datos hay un hueco. Se reserva la forma de la rejilla real
 * —tarjetas con la banda del mapa a 16/7 y los dos bandos— con las mismas cajas
 * de `surface`/`line`, para que no salte el diseño al llegar las partidas.
 */
export default function Loading() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex animate-pulse flex-col gap-6 motion-reduce:animate-none"
    >
      <span className="sr-only">Cargando las partidas en juego</span>

      <div
        aria-hidden="true"
        className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3"
      >
        <span className="h-4 w-40 rounded bg-surface-raised" />
        <span className="h-4 w-20 rounded bg-surface-raised" />
      </div>

      <ul
        aria-hidden="true"
        className="grid items-start gap-4 lg:grid-cols-2"
      >
        {[0, 1, 2, 3].map((card) => (
          <li
            key={card}
            className="overflow-hidden rounded-lg border border-line bg-surface"
          >
            <div className="aspect-[16/7] w-full bg-surface-raised" />

            <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:gap-4">
              <div className="flex flex-1 flex-col gap-2">
                <span className="h-4 w-3/4 rounded bg-surface-raised" />
                <span className="h-4 w-1/2 rounded bg-surface-raised" />
              </div>
              <span className="hidden h-4 w-6 shrink-0 rounded bg-surface-raised sm:block" />
              <div className="flex flex-1 flex-col gap-2 sm:items-end">
                <span className="h-4 w-3/4 rounded bg-surface-raised" />
                <span className="h-4 w-1/2 rounded bg-surface-raised" />
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
