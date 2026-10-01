"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

/**
 * Los cuatro destinos del sitio público, en el orden en que se leen.
 *
 * `label` es el nombre completo y `tabLabel` el que cabe en la barra inferior de
 * móvil, donde no hay sitio para "Partidas en juego". El destino es el mismo, así
 * que el `href` y el orden son la única fuente de verdad para las dos formas.
 */
const items = [
  { href: "/", label: "Clasificación", tabLabel: "Clasificación", icon: PodiumIcon },
  { href: "/partidas", label: "Partidas en juego", tabLabel: "Partidas", icon: SwordsIcon },
  { href: "/objetivos", label: "Objetivos", tabLabel: "Objetivos", icon: TargetIcon },
  { href: "/reglas", label: "Reglas", tabLabel: "Reglas", icon: BookIcon },
] as const;

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
 * Por debajo de `sm` esta versión no se pinta: cuatro destinos no caben a lo
 * ancho de un móvil (463 px de contenido en 370 px de pantalla), y en lugar de
 * dejar "Reglas" fuera de vista tras un desplazamiento sin señal, la navegación
 * baja a `SiteTabBar`. A partir de `sm` la fila cabe entera y no hay desplazamiento.
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
      <ul className="flex items-center gap-1.5 px-1.5">
        {items.map((item) => {
          const active = isActive(item.href, pathname);

          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`relative block whitespace-nowrap rounded-md px-3.5 py-2.5 text-[15px] leading-5 transition-colors ${
                  active
                    ? "font-semibold text-accent"
                    : "text-muted hover:bg-surface hover:text-foreground"
                }`}
              >
                {item.label}
                {active ? (
                  <span
                    aria-hidden="true"
                    className="absolute inset-x-3.5 -bottom-px h-px bg-accent"
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
 * Es la misma navegación que `SiteNav`, resuelta como pestañas: cuatro destinos
 * en una fila, siempre a la vista y al alcance del pulgar. Existe porque en un
 * móvil los cuatro nombres no caben de una sola línea y la alternativa —una
 * barra que se desplaza— esconde un destino sin avisar de que hay más. Aquí no
 * hay nada que desplazar ni que adivinar.
 *
 * El coste de identidad es real: el sitio deja de tener toda su navegación
 * arriba. Se compensa manteniendo el dialecto de la cabecera (mismo fondo, mismo
 * filete `line`, mismo `bg/95` con desenfoque) y usando el acento solo en el
 * destino activo, marcado con `aria-current` y un filete en el borde superior
 * que es el espejo del que la cabecera pinta en el inferior.
 *
 * Desaparece a partir de `sm`, donde `SiteNav` ya cabe sin desplazarse.
 */
export function SiteTabBar() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Principal"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-background/95 backdrop-blur sm:hidden"
    >
      <ul className="flex items-stretch justify-around gap-1 px-1 pb-[env(safe-area-inset-bottom)]">
        {items.map((item) => {
          const active = isActive(item.href, pathname);
          const Icon = item.icon;

          return (
            <li key={item.href} className="min-w-0">
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`relative flex flex-col items-center gap-1 px-2 py-2 text-xs leading-none transition-colors ${
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
 * partidas, la diana para los objetivos y el libro abierto para las reglas.
 * Todos son decorativos: el nombre accesible lo da la etiqueta del enlace.
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

/** Reglas: el libro de reglas abierto. */
function BookIcon({ className }: { className?: string }) {
  return (
    <Glyph className={className}>
      <path d="M12 6.75C10.4 5.35 8.3 4.6 5.5 4.6v12.3c2.8 0 4.9.75 6.5 2.15 1.6-1.4 3.7-2.15 6.5-2.15V4.6c-2.8 0-4.9.75-6.5 2.15Z" />
      <path d="M12 6.75v12.3" />
    </Glyph>
  );
}
