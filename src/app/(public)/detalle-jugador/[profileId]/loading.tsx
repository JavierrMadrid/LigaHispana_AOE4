/**
 * Esqueleto de carga de la pestaña de objetivos.
 *
 * La pestaña es dinámica y lee la base en cada petición, así que entre la
 * navegación y los datos hay un hueco. El marco —migas, cabecera y pestañas— no
 * se repite aquí: lo reserva su propio esqueleto (ver `layout.tsx`), y esto solo
 * cubre lo que va debajo, con las mismas cajas de `surface`/`line` que luego
 * ocupa el contenido: la entradilla del mejor objetivo, el índice de secciones y
 * los bloques. Así no salta el diseño al llegar los datos.
 */
export default function Loading() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex animate-pulse flex-col gap-8 motion-reduce:animate-none"
    >
      <span className="sr-only">Cargando los objetivos del participante</span>

      <div
        aria-hidden="true"
        className="flex flex-col gap-2 rounded-lg border border-line bg-surface px-5 py-4"
      >
        <span className="h-4 w-full max-w-[68ch] rounded bg-surface-raised" />
        <span className="h-4 w-2/3 max-w-[68ch] rounded bg-surface-raised" />
      </div>

      <div
        aria-hidden="true"
        className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-line pb-2"
      >
        <span className="h-4 w-24 rounded bg-surface-raised" />
        <span className="h-7 w-20 rounded-md bg-surface-raised" />
        <span className="h-7 w-24 rounded-md bg-surface-raised" />
        <span className="h-7 w-24 rounded-md bg-surface-raised" />
      </div>

      {[0, 1].map((section) => (
        <div key={section} aria-hidden="true" className="flex flex-col gap-3">
          <div className="flex items-center justify-between border-b border-line pb-2">
            <span className="h-5 w-36 rounded bg-surface-raised" />
            <span className="h-3 w-40 rounded bg-surface-raised" />
          </div>
          <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
            {[0, 1, 2].map((card) => (
              <span
                key={card}
                className="h-48 rounded-lg border border-line bg-surface"
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
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2, 3, 4, 5].map((chip) => (
            <span key={chip} className="h-12 rounded-md border border-line bg-surface" />
          ))}
        </div>
      </div>
    </div>
  );
}
