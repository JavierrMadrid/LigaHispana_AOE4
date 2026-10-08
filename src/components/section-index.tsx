/**
 * Mobiliario compartido de las páginas de reglamento (`/reglas` y
 * `/puntuacion`): el índice de secciones y el titular que abre cada bloque.
 *
 * Las dos pantallas se leen como un mismo documento partido en dos, así que
 * reparten la misma estructura y no deben divergir. El índice tiene dos formas
 * del mismo dato: a partir de `lg` vive en una columna fija a la derecha; por
 * debajo, donde esa columna no cabe, baja a un desplegable sobre el contenido.
 */

export type DocSection = { id: string; label: string };

/**
 * Titular de una sección normativa: el nombre en Cinzel sobre el filete que
 * abre el bloque.
 */
export function SectionHeading({ title }: { title: string }) {
  return (
    <h2 className="border-b border-line pb-3 font-display text-xl font-semibold text-foreground">
      {title}
    </h2>
  );
}

/**
 * Índice plegable para pantallas estrechas. Se pinta por encima del contenido y
 * desaparece a partir de `lg`, donde ya está la columna lateral.
 */
export function MobileSectionIndex({
  sections,
  ariaLabel,
}: {
  sections: readonly DocSection[];
  ariaLabel: string;
}) {
  return (
    <nav aria-label={ariaLabel} className="lg:hidden">
      <details className="group rounded-lg border border-line bg-surface">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-3 text-sm font-medium text-foreground sm:px-4 [&::-webkit-details-marker]:hidden">
          En esta página
          <svg
            viewBox="0 0 12 12"
            aria-hidden="true"
            className="size-3 shrink-0 text-muted transition-transform motion-reduce:transition-none group-open:rotate-180"
          >
            <path
              d="M2.5 4.5 6 8l3.5-3.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </summary>
        <ul className="flex flex-col border-t border-line py-1">
          {sections.map((section) => (
            <li key={section.id}>
              <a
                href={`#${section.id}`}
                className="block px-4 py-2.5 text-sm text-muted transition-colors hover:text-foreground"
              >
                {section.label}
              </a>
            </li>
          ))}
        </ul>
      </details>
    </nav>
  );
}

/**
 * Índice lateral fijo. Solo existe a partir de `lg`; por debajo navega
 * `MobileSectionIndex`.
 */
export function SectionIndexAside({
  sections,
  ariaLabel,
}: {
  sections: readonly DocSection[];
  ariaLabel: string;
}) {
  return (
    <nav aria-label={ariaLabel} className="hidden lg:block">
      <div className="sticky top-24">
        <p className="text-xs text-muted">En esta página</p>
        <ul className="mt-3 flex flex-col gap-2 border-l border-line">
          {sections.map((section) => (
            <li key={section.id}>
              <a
                href={`#${section.id}`}
                className="-ml-px block border-l border-transparent pl-3 text-sm text-muted transition-colors hover:border-accent hover:text-foreground"
              >
                {section.label}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}

/**
 * Índice de sección en horizontal.
 *
 * Para páginas que van a una sola columna y no tienen ancho para la columna
 * fija: una fila discreta de enlaces bajo un filete, que se desplaza en
 * horizontal cuando no cabe (móvil estrecho) en vez de partirse en varias
 * líneas. Es el mismo dato que `SectionIndexAside`, en otro eje.
 */
export function SectionIndexBar({
  sections,
  ariaLabel,
}: {
  sections: readonly DocSection[];
  ariaLabel: string;
}) {
  return (
    <nav
      aria-label={ariaLabel}
      className="flex items-center gap-1 overflow-x-auto border-b border-line pb-2 text-sm"
    >
      <span className="shrink-0 pr-2 text-xs font-medium text-muted">
        En esta página
      </span>
      {sections.map((section) => (
        <a
          key={section.id}
          href={`#${section.id}`}
          className="shrink-0 whitespace-nowrap rounded-md px-2.5 py-1.5 text-muted transition-colors hover:bg-surface-raised hover:text-foreground"
        >
          {section.label}
        </a>
      ))}
    </nav>
  );
}
