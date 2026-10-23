/**
 * Esqueleto de carga del alta de una actuación.
 *
 * Reserva la cabecera y los bloques del asistente —participante, acción,
 * selección de partidas o actuaciones y razones— para que el formulario no se
 * monte de golpe cuando lleguen los datos.
 */
export default function Loading() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="mx-auto flex w-full max-w-5xl animate-pulse flex-col gap-6 motion-reduce:animate-none"
    >
      <span className="sr-only">Cargando el formulario de la nueva actuación</span>

      <div aria-hidden="true" className="flex flex-col gap-3">
        <span className="h-4 w-36 rounded bg-surface-raised" />
        <span className="h-8 w-56 rounded bg-surface-raised" />
        <span className="h-4 w-full max-w-[70ch] rounded bg-surface-raised" />
      </div>

      <div aria-hidden="true" className="flex flex-col gap-4">
        {[0, 1, 2].map((block) => (
          <div key={block} className="rounded-lg border border-line bg-surface p-5">
            <span className="block h-4 w-40 rounded bg-surface-raised" />
            <span className="mt-3 block h-10 w-full rounded-md bg-surface-raised" />
            <span className="mt-2 block h-4 w-2/3 rounded bg-surface-raised" />
          </div>
        ))}
      </div>
    </div>
  );
}
