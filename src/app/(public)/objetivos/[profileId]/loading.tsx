/**
 * Esqueleto de carga de la ficha de objetivos.
 *
 * La página es `force-dynamic` y lee la base en cada petición, así que entre la
 * navegación y los datos hay un hueco. En lugar de una pantalla en blanco, se
 * reserva el sitio de cada bloque con cajas de `surface`/`line`, la misma forma
 * que luego ocupa el contenido: así no salta el diseño al llegar los datos.
 */
export default function Loading() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex animate-pulse flex-col gap-8 motion-reduce:animate-none"
    >
      <span className="sr-only">Cargando los objetivos del participante</span>

      <div aria-hidden="true" className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <span className="h-4 w-32 rounded bg-surface-raised" />
        <span className="h-4 w-28 rounded bg-surface-raised" />
      </div>

      <div
        aria-hidden="true"
        className="thread-top relative overflow-hidden rounded-lg border border-line bg-surface px-5 py-5"
      >
        <div className="flex flex-wrap items-center gap-x-6 gap-y-4">
          <span className="size-16 shrink-0 rounded-md border border-line bg-surface-raised" />
          <div className="flex flex-col gap-2">
            <span className="h-6 w-44 rounded bg-surface-raised" />
            <span className="h-3 w-32 rounded bg-surface-raised" />
          </div>
          <div className="ml-auto flex gap-8">
            <SkeletonStat />
            <SkeletonStat />
            <SkeletonStat />
          </div>
        </div>
        <span className="mt-4 block h-4 w-3/4 max-w-[48ch] rounded bg-surface-raised" />
      </div>

      <div
        aria-hidden="true"
        className="rounded-lg border border-line bg-surface p-4"
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="h-10 w-20 rounded-full bg-surface-raised" />
          <span className="h-10 w-24 rounded-full bg-surface-raised" />
          <span className="h-10 w-20 rounded-full bg-surface-raised" />
          <span className="h-10 w-28 rounded-full bg-surface-raised" />
        </div>
      </div>

      {[0, 1].map((section) => (
        <div key={section} aria-hidden="true" className="flex flex-col gap-3">
          <div className="flex items-center justify-between border-b border-line pb-2">
            <span className="h-5 w-36 rounded bg-surface-raised" />
            <span className="h-3 w-40 rounded bg-surface-raised" />
          </div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {[0, 1, 2].map((card) => (
              <span
                key={card}
                className="h-44 rounded-lg border border-line bg-surface"
              />
            ))}
          </div>
        </div>
      ))}

      <div aria-hidden="true" className="flex flex-col gap-3">
        <div className="flex items-center justify-between border-b border-line pb-2">
          <span className="h-5 w-44 rounded bg-surface-raised" />
          <span className="h-3 w-40 rounded bg-surface-raised" />
        </div>
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2, 3, 4, 5].map((chip) => (
            <span
              key={chip}
              className="h-12 rounded-md border border-line bg-surface"
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function SkeletonStat() {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="h-5 w-12 rounded bg-surface-raised" />
      <span className="h-3 w-20 rounded bg-surface-raised" />
    </div>
  );
}
