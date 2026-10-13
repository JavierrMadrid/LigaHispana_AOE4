/**
 * Esqueleto de carga de la sección de administración.
 *
 * Es uno solo para las seis subpestañas: la cabecera y la navegación ya las pinta
 * el layout —que no se suspende—, así que aquí solo se reserva el cuerpo: titular,
 * frase y bloques de formulario, con las mismas cajas de `surface`/`line`, para que
 * el contenido no salte al llegar los datos.
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
        <span className="h-6 w-40 rounded bg-surface-raised" />
        <span className="h-4 w-full max-w-[70ch] rounded bg-surface-raised" />
      </div>

      {[0, 1].map((block) => (
        <div key={block} aria-hidden="true" className="flex flex-col gap-3">
          <span className="h-16 rounded-lg border border-line bg-surface" />
          <span className="h-16 rounded-lg border border-line bg-surface" />
        </div>
      ))}
    </div>
  );
}
