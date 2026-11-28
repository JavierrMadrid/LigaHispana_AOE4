"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

/**
 * El selector local de los dos historiales públicos.
 *
 * `/historial` (puntos) y `/objetos` (objetos) son los dos feeds hermanos del
 * torneo. Se cambia de uno a otro con esta barra, que se conserva como atajo
 * dentro de cualquiera de las dos páginas aunque el historial de objetos ya tenga
 * además su propia entrada —la sexta— en la navegación principal.
 *
 * Cada opción es un enlace de ruta, no estado local: se puede recargar, compartir
 * y alcanzar con el teclado, y el navegador anuncia la activa con `aria-current`.
 * La coincidencia es exacta porque ninguna de las dos rutas tiene subrutas.
 *
 * Los filtros viajan con el cambio de pestaña: las dos rutas usan los mismos
 * parámetros (`jugador`, `from`, `to`, `pageSize`), así que cambiar de feed no
 * obliga a volver a escribirlos. `page` se queda fuera a propósito: la página 5 de
 * un feed no significa lo mismo en el otro.
 *
 * `variant` elige el cromo: `default` es el control segmentado de las páginas
 * heredadas (`/historial`), y `home` el carril de la casa que usa `/objetos` en su
 * columna lateral, con el rótulo encima y el relleno de las pestañas de la
 * portada. El comportamiento es idéntico: solo cambian las clases.
 */
const TABS: readonly { href: string; label: string }[] = [
  { href: "/historial", label: "Puntos" },
  { href: "/objetos", label: "Objetos" },
];

/** Los filtros que se conservan al cambiar de pestaña, en el orden de la barra. */
const CARRIED_PARAMS = ["jugador", "from", "to", "pageSize"] as const;

type HistoryTabsProps = {
  variant?: "default" | "home";
};

export function HistoryTabs({ variant = "default" }: HistoryTabsProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const carried = new URLSearchParams();

  for (const key of CARRIED_PARAMS) {
    const value = searchParams.get(key);

    if (value !== null && value !== "") {
      carried.set(key, value);
    }
  }

  const carriedQuery = carried.toString();
  const tabs = TABS.map((tab) => ({
    ...tab,
    active: pathname === tab.href,
    href: carriedQuery === "" ? tab.href : `${tab.href}?${carriedQuery}`,
  }));

  if (variant === "home") {
    return (
      <div className="objects-tabs">
        <span className="objects-tabs-label">Historial</span>
        <nav aria-label="Vistas del historial">
          <ul>
            {tabs.map((tab) => (
              <li key={tab.href}>
                <Link
                  href={tab.href}
                  aria-current={tab.active ? "page" : undefined}
                >
                  {tab.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="text-sm text-muted">Historial</span>
      <nav aria-label="Vistas del historial">
        <ul className="flex items-center gap-1 rounded-full border border-line bg-surface p-1">
          {tabs.map((tab) => (
            <li key={tab.href}>
              <Link
                href={tab.href}
                aria-current={tab.active ? "page" : undefined}
                className={`block whitespace-nowrap rounded-full px-4 py-2 text-sm font-medium transition-colors ${
                  tab.active
                    ? "bg-accent/15 text-accent"
                    : "text-muted hover:bg-surface-raised hover:text-foreground"
                }`}
              >
                {tab.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}
