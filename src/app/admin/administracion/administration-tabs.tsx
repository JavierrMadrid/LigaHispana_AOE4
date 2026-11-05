"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

type AdministrationTab = {
  href: string;
  label: string;
  /** `/admin/administracion` es la subpestaña raíz: solo coincide por igualdad exacta. */
  exact?: boolean;
};

type AdministrationGroup = {
  label: string;
  tabs: readonly AdministrationTab[];
};

/**
 * Las subpestañas, agrupadas por lo que se configura en cada una.
 *
 * El orden de los grupos va de lo que se toca antes a lo que se toca después:
 * la edición y sus plazos, quién participa, lo que se publica y, al final, quién
 * entra al panel. Antes eran ocho píldoras en fila, sin más orden que el de
 * llegada, y no decían a qué grupo pertenecía cada pantalla.
 */
const GROUPS: readonly AdministrationGroup[] = [
  {
    label: "Edición",
    tabs: [
      { href: "/admin/administracion/edicion", label: "Edición" },
      { href: "/admin/administracion/fechas", label: "Fechas" },
      { href: "/admin/administracion/puntuacion", label: "Puntuación" },
      { href: "/admin/administracion/eventos", label: "Eventos" },
    ],
  },
  {
    label: "Participación",
    tabs: [{ href: "/admin/administracion/inscripciones", label: "Inscripciones" }],
  },
  {
    label: "Comunicación",
    tabs: [
      { href: "/admin/administracion/donaciones", label: "Donaciones" },
      { href: "/admin/administracion/avisos", label: "Avisos" },
    ],
  },
  {
    label: "Acceso",
    tabs: [{ href: "/admin/administracion", label: "Administradores", exact: true }],
  },
];

const TABS = GROUPS.flatMap((group) => group.tabs);

function isActive(tab: AdministrationTab, pathname: string): boolean {
  return tab.exact === true ? pathname === tab.href : pathname.startsWith(tab.href);
}

/**
 * Navegación de las subpestañas de Administración.
 *
 * Es **subordinada** a la barra de pestañas del panel: donde esa usa un
 * subrayado pegado al filete de la cabecera, esta es una columna con el grupo
 * rotulado encima de sus opciones. La activa se marca con el oro de la casa, el
 * mismo con el que la barra dice en qué pestaña estás.
 *
 * A partir de `lg` es una columna fija. En móvil no cabe —ocho opciones a 320 px
 * partirían el layout o pedirían desplazamiento horizontal—, así que se pliega en
 * un desplegable que enseña el grupo y la pantalla actual: saber dónde estás no
 * debería depender de abrir el menú. Se cierra al elegir, con el clic del enlace,
 * sin efectos que observen la ruta.
 */
export function AdministrationTabs() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  const active = TABS.find((tab) => isActive(tab, pathname));
  const activeGroup = GROUPS.find((group) => group.tabs.some((tab) => tab === active));

  return (
    <nav
      aria-label="Subsecciones de administración"
      className="lg:sticky lg:top-6 lg:self-start"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls="subsecciones-administracion"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between gap-3 rounded-md border border-line bg-surface px-3 py-2 text-left transition-colors hover:border-line-strong lg:hidden"
      >
        <span className="flex min-w-0 flex-col">
          <span className="text-xs text-muted">{activeGroup?.label ?? "Secciones"}</span>
          <span className="truncate text-sm font-medium text-foreground">
            {active?.label ?? "Administración"}
          </span>
        </span>
        <svg
          viewBox="0 0 12 12"
          aria-hidden="true"
          className={`size-3 shrink-0 text-muted transition-transform motion-reduce:transition-none ${
            open ? "rotate-180" : ""
          }`}
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
      </button>

      <div
        id="subsecciones-administracion"
        className={open ? "mt-2 lg:mt-0" : "hidden lg:block"}
      >
        <ul className="flex flex-col gap-5 rounded-lg border border-line bg-surface p-2 lg:gap-6 lg:border-0 lg:bg-transparent lg:p-0">
          {GROUPS.map((group) => (
            <li key={group.label}>
              <p className="px-2 text-xs text-muted">{group.label}</p>

              <ul className="mt-1.5 flex flex-col gap-0.5">
                {group.tabs.map((tab) => {
                  const current = isActive(tab, pathname);

                  return (
                    <li key={tab.href}>
                      <Link
                        href={tab.href}
                        aria-current={current ? "page" : undefined}
                        onClick={() => setOpen(false)}
                        className={`block rounded-md px-2 py-1.5 text-sm transition-colors ${
                          current
                            ? "bg-accent/10 font-medium text-accent"
                            : "text-muted hover:bg-surface-raised hover:text-foreground"
                        }`}
                      >
                        {tab.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}
