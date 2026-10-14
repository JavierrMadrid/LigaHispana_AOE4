"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type AdministrationTab = {
  href: string;
  label: string;
  /** `/admin/administracion` es la subpestaña raíz: solo coincide por igualdad exacta. */
  exact?: boolean;
};

const TABS: readonly AdministrationTab[] = [
  { href: "/admin/administracion", label: "Administradores", exact: true },
  { href: "/admin/administracion/edicion", label: "Edición" },
  { href: "/admin/administracion/puntuacion", label: "Puntuación" },
  { href: "/admin/administracion/inscripciones", label: "Inscripciones" },
  { href: "/admin/administracion/donaciones", label: "Donaciones" },
  { href: "/admin/administracion/avisos", label: "Avisos" },
];

/**
 * Navegación de las subpestañas de Administración.
 *
 * Es **subordinada** a la barra de pestañas del panel, así que no repite su
 * registro: donde esa usa un subrayado `border-b-2` pegado al filete de la
 * cabecera, esta usa un control segmentado —las opciones dentro de un carril de
 * `surface` con radio completo—. Las dos marcan lo activo con el mismo oro, que
 * es el acento de la casa para la navegación, pero la forma las sitúa: el
 * subrayado dice en qué pestaña del panel estás, la píldora dice en qué punto de
 * esa pestaña.
 *
 * Es cliente porque leer la ruta activa necesita `usePathname`; el layout que la
 * monta sigue en servidor. `/admin/administracion` es una subpestaña más
 * (Administradores), así que su coincidencia es exacta: si no, cualquier
 * subruta la marcaría como activa.
 *
 * En móvil el carril se desplaza en horizontal en lugar de partirse: a 320 px
 * las seis opciones no caben y es preferible que corran a que se apilen en tres
 * filas.
 */
export function AdministrationTabs() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Subsecciones de administración"
      className="overflow-x-auto overscroll-x-contain"
    >
      <ul className="flex w-max items-center gap-1 rounded-full border border-line bg-surface p-1">
        {TABS.map((tab) => {
          const active = tab.exact ? pathname === tab.href : pathname.startsWith(tab.href);

          return (
            <li key={tab.href}>
              <Link
                href={tab.href}
                aria-current={active ? "page" : undefined}
                className={`block whitespace-nowrap rounded-full px-3 py-1.5 text-sm transition-colors ${
                  active
                    ? "bg-accent/15 text-accent"
                    : "text-muted hover:bg-surface-raised hover:text-foreground"
                }`}
              >
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
