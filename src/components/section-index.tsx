"use client";

import { useEffect, useState } from "react";

/**
 * Mobiliario compartido de las páginas de reglamento (`/reglas` y
 * `/puntuacion`): el índice de secciones y el titular que abre cada bloque.
 *
 * Las dos pantallas se leen como un mismo documento partido en dos, así que
 * reparten la misma estructura y no deben divergir. El índice tiene dos formas
 * del mismo dato: a partir de `lg` vive en una columna fija a la derecha; por
 * debajo, donde esa columna no cabe, baja a un desplegable sobre el contenido, y
 * en una sola columna horizontal (`SectionIndexBar`) en la ficha del jugador.
 *
 * El módulo es cliente para poder marcar la sección que se está leyendo: el
 * índice queda lejos del texto y, sin eso, no habría forma de saber dónde se
 * está. El estado del activo arranca en `null` —nada marcado— en el render de
 * servidor y en el primero de cliente; se rellena ya en el cliente para no romper
 * la hidratación.
 */

export type DocSection = { id: string; label: string };

/**
 * Sección que se está leyendo.
 *
 * La referencia es una línea de lectura al 35 % de la ventana: manda la última
 * sección cuyo borde superior ya la ha cruzado. Los dos extremos de la página
 * necesitan trato propio: al principio ninguna sección ha cruzado la línea (la
 * primera es la activa por defecto) y al final la última puede no cruzarla
 * nunca, porque la página se acaba antes; por eso también se observa el pie
 * —el último bloque— y, en cuanto asoma casi entero, la última sección pasa a
 * ser la activa. Sin esos dos casos, el primer y el último índice jamás se
 * marcarían.
 */
function useActiveSection(sections: readonly DocSection[]): string | null {
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    const elements = sections
      .map((section) => document.getElementById(section.id))
      .filter((element): element is HTMLElement => element !== null);

    if (elements.length === 0) {
      return;
    }

    // Cuánto del pie se ve. A partir de tres cuartos se considera que la página
    // está en su final; el dato llega del observador del pie.
    let footerRatio = 0;

    function update() {
      const line = window.innerHeight * 0.35;
      let current = elements[0].id;

      for (const element of elements) {
        if (element.getBoundingClientRect().top <= line) {
          current = element.id;
        }
      }

      // En el final de la página la última sección puede no haber cruzado la
      // línea: manda ella.
      setActive(footerRatio >= 0.75 ? elements[elements.length - 1].id : current);
    }

    // Las secciones se observan contra la banda superior de la ventana (la
    // línea de lectura cae dentro), así cada cruce dispara el recálculo.
    const sectionsObserver = new IntersectionObserver(update, {
      rootMargin: "0px 0px -65% 0px",
    });
    const footer = document.querySelector("footer");
    let footerObserver: IntersectionObserver | null = null;

    if (footer !== null) {
      // El pie va aparte, por umbrales: al asomar tres cuartos, la página está
      // en su final y la última sección pasa a ser la activa.
      footerObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            footerRatio = entry.intersectionRatio;
          }

          update();
        },
        { threshold: [0, 0.75, 1] },
      );
      footerObserver.observe(footer);
    }

    for (const element of elements) {
      sectionsObserver.observe(element);
    }

    window.addEventListener("resize", update);

    return () => {
      sectionsObserver.disconnect();
      footerObserver?.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [sections]);

  return active;
}

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
  const active = useActiveSection(sections);

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
          {sections.map((section) => {
            const isActive = section.id === active;

            return (
              <li key={section.id}>
                <a
                  href={`#${section.id}`}
                  aria-current={isActive ? "location" : undefined}
                  className={`block px-4 py-2.5 text-sm transition-colors ${
                    isActive
                      ? "font-medium text-foreground"
                      : "text-muted hover:text-foreground"
                  }`}
                >
                  {section.label}
                </a>
              </li>
            );
          })}
        </ul>
      </details>
    </nav>
  );
}

/**
 * Índice lateral fijo. Solo existe a partir de `lg`; por debajo navega
 * `MobileSectionIndex`. La sección activa hereda el filete de acento del hover y
 * lo deja fijo, para que la columna diga dónde se está.
 */
export function SectionIndexAside({
  sections,
  ariaLabel,
}: {
  sections: readonly DocSection[];
  ariaLabel: string;
}) {
  const active = useActiveSection(sections);

  return (
    <nav aria-label={ariaLabel} className="hidden lg:block">
      <div className="sticky top-24">
        <p className="text-xs text-muted">En esta página</p>
        <ul className="mt-3 flex flex-col gap-2 border-l border-line">
          {sections.map((section) => {
            const isActive = section.id === active;

            return (
              <li key={section.id}>
                <a
                  href={`#${section.id}`}
                  aria-current={isActive ? "location" : undefined}
                  className={`-ml-px block border-l pl-3 text-sm transition-colors ${
                    isActive
                      ? "border-accent text-foreground"
                      : "border-transparent text-muted hover:border-accent hover:text-foreground"
                  }`}
                >
                  {section.label}
                </a>
              </li>
            );
          })}
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
 * líneas. Es el mismo dato que `SectionIndexAside`, en otro eje: la sección
 * activa se marca con el relleno que ya usa el hover.
 */
export function SectionIndexBar({
  sections,
  ariaLabel,
}: {
  sections: readonly DocSection[];
  ariaLabel: string;
}) {
  const active = useActiveSection(sections);

  return (
    <nav
      aria-label={ariaLabel}
      className="flex items-center gap-1 overflow-x-auto border-b border-line pb-2 text-sm"
    >
      <span className="shrink-0 pr-2 text-xs font-medium text-muted">
        En esta página
      </span>
      {sections.map((section) => {
        const isActive = section.id === active;

        return (
          <a
            key={section.id}
            href={`#${section.id}`}
            aria-current={isActive ? "location" : undefined}
            className={`shrink-0 whitespace-nowrap rounded-md px-2.5 py-1.5 transition-colors ${
              isActive
                ? "bg-surface-raised font-medium text-foreground"
                : "text-muted hover:bg-surface-raised hover:text-foreground"
            }`}
          >
            {section.label}
          </a>
        );
      })}
    </nav>
  );
}
