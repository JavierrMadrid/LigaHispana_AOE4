"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type AdminTab = {
  href: string;
  label: string;
  /** `/admin` es la pestaña raíz: solo coincide por igualdad exacta. */
  exact?: boolean;
};

const TABS: readonly AdminTab[] = [
  { href: "/admin", label: "Participantes", exact: true },
  { href: "/admin/historial", label: "Historial de partidas" },
  { href: "/admin/alertas", label: "Alertas" },
  { href: "/admin/acciones", label: "Historial de acciones" },
  { href: "/admin/configuracion", label: "Configuración" },
];

/**
 * Navegación de las cinco pestañas del panel.
 *
 * Es cliente porque leer la ruta activa necesita `usePathname`; el resto del
 * layout sigue en servidor. `/admin` es una pestaña más (Participantes), así que
 * su coincidencia es exacta: si no, cualquier subruta la marcaría como activa.
 */
export function AdminTabs() {
  const pathname = usePathname();

  return (
    <nav aria-label="Secciones del panel" className="-mb-px overflow-x-auto overscroll-x-contain">
      <ul className="flex items-center gap-1">
        {TABS.map((tab) => {
          const active = tab.exact ? pathname === tab.href : pathname.startsWith(tab.href);

          return (
            <li key={tab.href}>
              <Link
                href={tab.href}
                aria-current={active ? "page" : undefined}
                className={`block whitespace-nowrap border-b-2 px-3 py-2.5 text-sm transition-colors ${
                  active
                    ? "border-accent font-semibold text-accent"
                    : "border-transparent text-muted hover:border-line-strong hover:text-foreground"
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
