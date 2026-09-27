"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const items = [
  { href: "/", label: "Clasificación" },
  { href: "/partidas", label: "En directo" },
  { href: "/reglas", label: "Reglas" },
] as const;

/**
 * Navegación principal del sitio público.
 *
 * Es la única pieza de cliente del layout: leer la ruta activa necesita
 * `usePathname`, y mantenerlo aislado permite que el resto del layout siga
 * siendo un Server Component. El estado activo se marca con el `aria-current`,
 * el color de acento y un filete inferior, que se lee igual envuelto a móvil.
 */
export function SiteNav() {
  const pathname = usePathname();

  return (
    <nav aria-label="Principal" className="-mx-1 overflow-x-auto py-1">
      <ul className="flex items-center gap-1 px-1">
        {items.map((item) => {
          const active =
            item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);

          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`relative block rounded-md px-2.5 py-1.5 text-sm transition-colors ${
                  active
                    ? "font-semibold text-accent"
                    : "text-muted hover:bg-surface hover:text-foreground"
                }`}
              >
                {item.label}
                {active ? (
                  <span
                    aria-hidden="true"
                    className="absolute inset-x-2.5 -bottom-px h-px bg-accent"
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