/**
 * Esqueleto de carga del detalle de una actuación.
 *
 * Reserva la vuelta al expediente, la cabecera con sus datos y los bloques de
 * razón pública e información privada, para que el contenido no salte al llegar.
 */
export default function Loading() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="mx-auto flex w-full max-w-5xl animate-pulse flex-col gap-6 motion-reduce:animate-none"
    >
      <span className="sr-only">Cargando la actuación</span>

      <div aria-hidden="true" className="flex flex-col gap-2">
        <span className="h-4 w-36 rounded bg-surface-raised" />
        <span className="h-5 w-48 rounded-full bg-surface-raised" />
        <span className="h-8 w-2/3 rounded bg-surface-raised" />
      </div>

      <div aria-hidden="true" className="grid gap-4 rounded-lg border border-line bg-surface p-4 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2].map((block) => (
          <div key={block} className="flex flex-col gap-2">
            <span className="h-3 w-24 rounded bg-surface-raised" />
            <span className="h-4 w-full rounded bg-surface-raised" />
          </div>
        ))}
      </div>

      {[0, 1, 2].map((block) => (
        <div key={block} aria-hidden="true" className="rounded-lg border border-line bg-surface p-5">
          <span className="block h-4 w-40 rounded bg-surface-raised" />
          <span className="mt-3 block h-4 w-full rounded bg-surface-raised" />
          <span className="mt-2 block h-4 w-2/3 rounded bg-surface-raised" />
        </div>
      ))}
    </div>
  );
}
