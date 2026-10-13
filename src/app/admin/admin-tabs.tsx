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
];

/**
 * Pestaña de administración, reservada al superadministrador.
 *
 * Va aparte de `TABS` porque su visibilidad no es fija: un admin regular no la
 * ve —no puede entrar— y el servidor decide eso, no la ruta activa.
 */
const ADMINISTRATION_TAB: AdminTab = {
  href: "/admin/administracion",
  label: "Administración",
};

/**
 * Navegación de las pestañas del panel.
 *
 * Es cliente porque leer la ruta activa necesita `usePathname`; el resto del
 * layout sigue en servidor. `/admin` es una pestaña más (Participantes), así que
 * su coincidencia es exacta: si no, cualquier subruta la marcaría como activa.
 *
 * `showAdministration` la fija el layout a partir del acceso real: es lo que hace
 * que la pestaña no se pinte para quien no puede usarla, en vez de ofrecer una
 * puerta que devuelve a `/admin`.
 */
export function AdminTabs({ showAdministration }: { showAdministration: boolean }) {
  const pathname = usePathname();
  const tabs = showAdministration ? [...TABS, ADMINISTRATION_TAB] : TABS;

  return (
    <nav aria-label="Secciones del panel" className="-mb-px overflow-x-auto overscroll-x-contain">
      <ul className="flex items-center gap-1">
        {tabs.map((tab) => {
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
