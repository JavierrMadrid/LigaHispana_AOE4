"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { PUBLIC_NAVIGATION } from "@/lib/public-navigation";

/**
 * Los siete destinos del sitio público, en el orden en que se leen.
 *
 * `label` es el rótulo de la navegación y el título de la página de destino —lo
 * que la pestaña anuncia es lo que su `h1` dice, que es lo que pidió la issue
 * #97—; `tabLabel` es la forma que cabe en la barra inferior de móvil, donde no
 * hay sitio para "Partidas en juego" ni para "Puntuación". El destino es el
 * mismo, así que el `href` y el orden son la única fuente de verdad para las dos
 * formas.
 */
const icons = {
  standings: PodiumIcon,
  matches: SwordsIcon,
  objectives: TargetIcon,
  scoring: MedalIcon,
  rules: BookIcon,
  objects: ChaliceIcon,
  news: NewspaperIcon,
};

function isActive(href: string, pathname: string): boolean {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

/**
 * Navegación principal del sitio público, en la cabecera.
 *
 * Es la única pieza de cliente del layout por partida doble: leer la ruta activa
 * necesita `usePathname` y este componente se reparte entre la cabecera y la
 * barra inferior de móvil. El estado activo se marca con el `aria-current`, el
 * color de acento y un filete, aquí inferior porque la barra cuelga de arriba.
 *
 * Por debajo de `md` esta versión no se pinta: la lista mide 616 px con los siete
 * rótulos y en un móvil la fila da 343 px (375 de ventana menos los 32 de
 * relleno), así que en lugar de dejar "Noticias" fuera de vista tras un
 * desplazamiento sin señal, la navegación baja a `SiteTabBar`. A partir de `md` la
 * fila cabe entera y no hay desplazamiento: los 616 px —623 con el destino activo
 * en negrita— entran en la celda de 710 px que la cabecera les da a 768. El
 * estandarte del patrocinador no entra en la cuenta porque solo cuelga desde
 * `lg`, donde la fila ya tiene ancho de sobra.
 *
 * Cuando comparte fila con la marca y las acciones —de `min-[1376px]` en
 * adelante, el ancho máximo del contenedor de la cabecera— los siete rótulos
 * bajan además a 13 px de cuerpo y la lista pasa de 616 a 549 px (554 con el
 * activo en negrita). Es lo que hace posible la fila única: con 1328 px de
 * contenido, su celda de 573 px deja 362 a cada lateral y las acciones de la
 * derecha piden 338; con el cuerpo de 15 px la lista ocuparía 640, los laterales
 * bajarían a 328 y las acciones ya no cabrían.
 *
 * El centrado lo da la rejilla, que reparte el mismo ancho a los dos laterales, y
 * aquí el `mx-auto` no tiene nada que repartir. Cuando la nav tiene su propia
 * fila, a ancho completo, es el `mx-auto` quien la centra. En los dos casos se
 * centra con ancho por contenido y no con `justify-center`: si la fila llegara a
 * no caber, `justify-center` dejaría lo desbordado por la izquierda fuera del
 * alcance del desplazamiento horizontal, mientras que con el ancho por contenido
 * la lista se apoya en el principio y el desplazamiento llega a todo.
 */
export function SiteNav() {
  const pathname = usePathname();

  // `overscroll-x-contain` corta el encadenado del desplazamiento: llegar al
  // final de la barra no arrastra a la página.
  return (
    <nav
      aria-label="Principal"
      className="-mx-1.5 overflow-x-auto overscroll-x-contain py-1"
    >
      <ul className="mx-auto flex w-fit items-center gap-1 px-1.5">
        {PUBLIC_NAVIGATION.map((item) => {
          const active = isActive(item.href, pathname);

          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`relative block whitespace-nowrap rounded-md px-2 py-2.5 text-[15px] leading-5 transition-colors min-[1376px]:text-[13px] ${
                  active
                    ? "font-semibold text-accent"
                    : "text-muted hover:bg-surface hover:text-foreground"
                }`}
              >
                {item.label}
                {active ? (
                  <span
                    aria-hidden="true"
                    className="absolute inset-x-2 -bottom-px h-px bg-accent"
                  />
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/**
 * Barra de destinos para móvil, fija al pie de la ventana.
 *
 * Es la misma navegación que `SiteNav`, resuelta como pestañas: los siete
 * destinos siempre a la vista y al alcance del pulgar. Existe porque en un móvil
 * los siete nombres no caben de una sola línea y la alternativa —una barra que se
 * desplaza— esconde un destino sin avisar de que hay más. Aquí no hay nada que
 * desplazar ni que adivinar: cada enlace mide lo que mide su rótulo compacto, con
 * el relleno lateral mínimo; «Clasificación» se lee «Puestos» en este tramo (ver
 * `PUBLIC_NAVIGATION`).
 *
 * Siete rótulos de 12 px piden 305 px de texto; con los 4 px de relleno de cada
 * enlace, los 4 px de hueco entre ellos y los 4 px de la barra, la fila necesita
 * 365 px. A 366 todavía recorta dos etiquetas y a 372 ya no recorta ninguna, así
 * que por debajo de 380 se reparten en dos filas —cuatro y tres— en lugar de
 * apretarse: las celdas miden 73 px a 320, los rótulos entran enteros y el
 * objetivo táctil queda por encima de los 44 px que pide un dedo. La barra pasa de
 * 53 a 109 px de alto en ese tramo, y quien reserva su franja lo sabe: el relleno
 * inferior del layout sube a 7rem y `BackToTop` a 7.5rem. `min-w-0` y el
 * `truncate` de la etiqueta quedan como red de seguridad si el texto crece.
 *
 * El coste de identidad es real: el sitio deja de tener toda su navegación
 * arriba. Se compensa manteniendo el dialecto de la cabecera (mismo fondo, mismo
 * filete `line`, mismo `bg/95` con desenfoque) y usando el acento solo en el
 * destino activo, marcado con `aria-current` y un filete en el borde superior
 * que es el espejo del que la cabecera pinta en el inferior.
 *
 * Desaparece a partir de `md`, donde `SiteNav` ya cabe sin desplazarse.
 */
export function SiteTabBar() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Principal"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-background/95 backdrop-blur md:hidden"
    >
      <ul className="flex flex-wrap items-stretch justify-around gap-1 px-1 pb-[env(safe-area-inset-bottom)] max-[379px]:[&>li]:min-w-[calc((100%-0.75rem)/4)] max-[379px]:[&>li]:flex-1">
        {PUBLIC_NAVIGATION.map((item) => {
          const active = isActive(item.href, pathname);
          const Icon = icons[item.id];

          return (
            <li key={item.href} className="min-w-0">
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`relative flex flex-col items-center gap-1 px-0.5 py-2 text-xs leading-none transition-colors ${
                  active ? "text-accent" : "text-muted hover:text-foreground"
                }`}
              >
                {active ? (
                  <span
                    aria-hidden="true"
                    className="absolute inset-x-3 top-0 h-0.5 rounded-full bg-accent"
                  />
                ) : null}
                <Icon className="size-5 shrink-0" />
                <span className="max-w-full truncate">{item.tabLabel}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/**
 * Glifos de la barra inferior.
 *
 * Mismo lenguaje que los iconos de `objective-icon.tsx` (caja de 24, `currentColor`,
 * 1.5 de grosor y extremos redondeados), para que la navegación no estrene un
 * dialecto propio: el podio para la clasificación, las espadas cruzadas para las
 * partidas, la diana para los objetivos, la medalla para la puntuación, el libro
 * abierto para las reglas, el cáliz de la reliquia para los objetos y la gaceta
 * para las noticias. Todos son decorativos: el nombre accesible lo da la
 * etiqueta del enlace.
 */
function Glyph({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {children}
    </svg>
  );
}

/** Clasificación: el podio de tres alturas. */
function PodiumIcon({ className }: { className?: string }) {
  return (
    <Glyph className={className}>
      <path d="M4 20h16" />
      <path d="M5.5 20v-5h3.5v5" />
      <path d="M10.25 20V9.5h3.5V20" />
      <path d="M15 20v-3h3.5v3" />
    </Glyph>
  );
}

/** Partidas: dos espadas cruzadas, el signo del enfrentamiento. */
function SwordsIcon({ className }: { className?: string }) {
  return (
    <Glyph className={className}>
      <path d="M4.5 4.5 13.5 13.5" />
      <path d="M19.5 4.5 10.5 13.5" />
      <path d="M11.9 15.1 15.1 11.9" />
      <path d="M8.9 11.9 12.1 15.1" />
      <path d="M13.5 13.5 15.6 15.6" />
      <path d="M10.5 13.5 8.4 15.6" />
    </Glyph>
  );
}

/** Objetivos: la diana. */
function TargetIcon({ className }: { className?: string }) {
  return (
    <Glyph className={className}>
      <circle cx="12" cy="12" r="7.5" />
      <circle cx="12" cy="12" r="3.25" />
      <circle cx="12" cy="12" r="0.75" fill="currentColor" stroke="none" />
    </Glyph>
  );
}

/** Puntuación: la medalla que premia la victoria. */
function MedalIcon({ className }: { className?: string }) {
  return (
    <Glyph className={className}>
      <path d="M8.75 3.5 10.75 8.25" />
      <path d="M15.25 3.5 13.25 8.25" />
      <circle cx="12" cy="14.25" r="6.25" />
      <path d="M12 10.9l1 2 2.2.3-1.6 1.55.4 2.2-2-1.05-2 1.05.4-2.2-1.6-1.55 2.2-.3z" />
    </Glyph>
  );
}

/** Reglas: el libro de reglas abierto. */
function BookIcon({ className }: { className?: string }) {
  return (
    <Glyph className={className}>
      <path d="M12 6.75C10.4 5.35 8.3 4.6 5.5 4.6v12.3c2.8 0 4.9.75 6.5 2.15 1.6-1.4 3.7-2.15 6.5-2.15V4.6c-2.8 0-4.9.75-6.5 2.15Z" />
      <path d="M12 6.75v12.3" />
    </Glyph>
  );
}

/** Objetos: el cáliz de la reliquia, el mismo glifo del feed de objetos. */
function ChaliceIcon({ className }: { className?: string }) {
  return (
    <Glyph className={className}>
      <path d="M8 4h8" />
      <path d="M8.5 4v4a3.5 3.5 0 0 0 7 0V4" />
      <path d="M12 11.5v6" />
      <path d="M9.5 17.5h5l1 2.5h-7Z" />
    </Glyph>
  );
}

/** Noticias: la gaceta, con su pliego doblado y sus líneas de texto. */
function NewspaperIcon({ className }: { className?: string }) {
  return (
    <Glyph className={className}>
      <path d="M4.5 6.5h11v10a2 2 0 0 0 2 2h-11a2 2 0 0 1-2-2Z" />
      <path d="M15.5 9.5H18a1.5 1.5 0 0 1 1.5 1.5v4.5a2.5 2.5 0 0 0 2.5 2.5" />
      <path d="M7.5 9.5h5" />
      <path d="M7.5 12.5h5" />
      <path d="M7.5 15.5h3" />
    </Glyph>
  );
}
