/**
 * Esqueleto de carga de la configuración.
 *
 * Se reserva la forma real —titular y las dos secciones con su control— con las
 * mismas cajas de `surface`/`line`, para que el contenido no salte al llegar los
 * datos. No hereda el esqueleto de `/admin`, cuya forma es la de Participantes.
 */
export default function Loading() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex animate-pulse flex-col gap-8 motion-reduce:animate-none"
    >
      <span className="sr-only">Cargando la configuración</span>

      <div aria-hidden="true" className="flex flex-col gap-2">
        <span className="h-8 w-48 rounded bg-surface-raised" />
        <span className="h-4 w-full max-w-[70ch] rounded bg-surface-raised" />
      </div>

      {[0, 1].map((section) => (
        <div key={section} aria-hidden="true" className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <span className="h-6 w-32 rounded bg-surface-raised" />
            <span className="h-4 w-full max-w-[70ch] rounded bg-surface-raised" />
          </div>
          <span className="h-16 rounded-lg border border-line bg-surface" />
        </div>
      ))}
    </div>
  );
}
