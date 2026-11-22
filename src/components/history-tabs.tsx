"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

/**
 * El selector local de los dos historiales públicos.
 *
 * `/historial` y `/historial-objetos` son dos feeds hermanos —puntos y objetos—,
 * así que se cambia de uno a otro con esta barra y no con una sexta entrada en la
 * navegación principal. Se dibuja con el control segmentado de la casa (el mismo
 * carril de `surface` con radio completo de las pestañas del participante) para
 * que se lea como una vista del historial, no como una sección nueva del sitio.
 *
 * Cada opción es un enlace de ruta, no estado local: se puede recargar, compartir
 * y alcanzar con el teclado, y el navegador anuncia la activa con `aria-current`.
 * La coincidencia es exacta porque ninguna de las dos rutas tiene subrutas.
 *
 * Los filtros viajan con el cambio de pestaña: las dos rutas usan los mismos
 * parámetros (`jugador`, `from`, `to`, `pageSize`), así que cambiar de feed no
 * obliga a volver a escribirlos. `page` se queda fuera a propósito: la página 5 de
 * un feed no significa lo mismo en el otro.
 */
const TABS: readonly { href: string; label: string }[] = [
  { href: "/historial", label: "Puntos" },
  { href: "/historial-objetos", label: "Objetos" },
];

/** Los filtros que se conservan al cambiar de pestaña, en el orden de la barra. */
const CARRIED_PARAMS = ["jugador", "from", "to", "pageSize"] as const;

export function HistoryTabs() {
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

  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="text-sm text-muted">Historial</span>
      <nav aria-label="Vistas del historial">
        <ul className="flex items-center gap-1 rounded-full border border-line bg-surface p-1">
          {TABS.map((tab) => {
            const active = pathname === tab.href;

            return (
              <li key={tab.href}>
                <Link
                  href={carriedQuery === "" ? tab.href : `${tab.href}?${carriedQuery}`}
                  aria-current={active ? "page" : undefined}
                  className={`block whitespace-nowrap rounded-full px-4 py-2 text-sm font-medium transition-colors ${
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
    </div>
  );
}
