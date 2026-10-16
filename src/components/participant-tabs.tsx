"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * La barra de pestañas de la ficha de un participante.
 *
 * Son dos vistas del mismo jugador —sus objetivos y su historial de puntos— y se
 * navega cambiando de ruta, no de estado: cada pestaña es un enlace, así que se
 * puede recargar, compartir y alcanzar con el teclado, y el navegador la anuncia
 * con `aria-current`. Es cliente solo por `usePathname`; el layout que la monta
 * sigue en servidor.
 *
 * ## Por qué una píldora y no un filete
 *
 * La pestaña de objetivos lleva dentro su propio índice de secciones
 * (`SectionIndexBar`), que ya es una fila de enlaces bajo un filete. Si las
 * pestañas se pintaran igual, dos renglones idénticos dirían cosas distintas —en
 * qué vista estás y en qué punto de ella—, así que esta barra usa la forma de
 * control segmentado de la casa (el mismo carril de `surface` con radio completo
 * que los filtros de la cara pública): el carril dice qué vista, el filete del
 * índice dice por dónde vas.
 *
 * Las dos pestañas son rutas hermanas y ninguna tiene subrutas, así que la
 * coincidencia es exacta: con `startsWith`, la raíz marcaría activa también la
 * pestaña de historial.
 */
const TABS: readonly { segment: string; label: string }[] = [
  { segment: "", label: "Objetivos" },
  { segment: "/historial", label: "Historial de puntos" },
];

export function ParticipantTabs({ profileId }: { profileId: number }) {
  const pathname = usePathname();
  const base = `/detalle-jugador/${profileId}`;

  return (
    <nav
      aria-label="Vistas del participante"
      className="overflow-x-auto overscroll-x-contain"
    >
      <ul className="flex w-max items-center gap-1 rounded-full border border-line bg-surface p-1">
        {TABS.map((tab) => {
          const href = `${base}${tab.segment}`;
          const active = pathname === href;

          return (
            <li key={tab.segment}>
              <Link
                href={href}
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
  );
}
