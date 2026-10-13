/**
 * Esqueleto de carga de la pestaña de administración.
 *
 * Se reserva la forma real —titular y los bloques de formulario— con las mismas
 * cajas de `surface`/`line`, para que el contenido no salte al llegar los datos.
 */
export default function Loading() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex animate-pulse flex-col gap-8 motion-reduce:animate-none"
    >
      <span className="sr-only">Cargando la administración</span>

      <div aria-hidden="true" className="flex flex-col gap-2">
        <span className="h-8 w-56 rounded bg-surface-raised" />
        <span className="h-4 w-full max-w-[70ch] rounded bg-surface-raised" />
      </div>

      {[0, 1, 2].map((block) => (
        <div key={block} aria-hidden="true" className="flex flex-col gap-3">
          <span className="h-6 w-48 rounded bg-surface-raised" />
          <span className="h-4 w-full max-w-[70ch] rounded bg-surface-raised" />
          <div className="mt-1 h-40 rounded-lg border border-line bg-surface" />
        </div>
      ))}
    </div>
  );
}
