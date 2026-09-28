import type { ReactNode } from "react";
import type { DivisionId } from "@/lib/public";

/**
 * Divisiones de la ladder para la interfaz pública.
 *
 * `public.ts` es `server-only`, así que la lista que necesitan los filtros
 * (componente cliente) vive aquí, con sus etiquetas y colores.
 *
 * Estos escudos son SVG propios del proyecto y hoy son el reemplazo de los
 * iconos oficiales de liga: `league-icon.tsx` pinta el asset del juego cuando
 * existe y cae a `DivisionIcon` cuando falta.
 */
export type DivisionUi = {
  id: DivisionId;
  label: string;
  /** Color del emblema y del estado activo del filtro. */
  color: string;
  /** Clases del botón activo, escritas enteras para que Tailwind las genere. */
  activeClass: string;
};

export const DIVISION_UI: DivisionUi[] = [
  {
    id: "bronce",
    label: "Bronce",
    color: "#b07a45",
    activeClass: "border-[#b07a45]/60 bg-[#b07a45]/15 text-[#b07a45]",
  },
  {
    id: "plata",
    label: "Plata",
    color: "#aeb6bf",
    activeClass: "border-[#aeb6bf]/60 bg-[#aeb6bf]/15 text-[#aeb6bf]",
  },
  {
    id: "oro",
    label: "Oro",
    color: "#d4af37",
    activeClass: "border-[#d4af37]/60 bg-[#d4af37]/15 text-[#d4af37]",
  },
  {
    id: "platino",
    label: "Platino",
    color: "#6fc7c0",
    activeClass: "border-[#6fc7c0]/60 bg-[#6fc7c0]/15 text-[#6fc7c0]",
  },
  {
    id: "diamante",
    label: "Diamante",
    color: "#6ea8e8",
    activeClass: "border-[#6ea8e8]/60 bg-[#6ea8e8]/15 text-[#6ea8e8]",
  },
  {
    id: "conquistador",
    label: "Conquistador",
    color: "#d4665f",
    activeClass: "border-[#d4665f]/60 bg-[#d4665f]/15 text-[#d4665f]",
  },
];

const DIVISION_LABEL: Record<DivisionId, string> = {
  bronce: "Bronce",
  plata: "Plata",
  oro: "Oro",
  platino: "Platino",
  diamante: "Diamante",
  conquistador: "Conquistador",
};

export function divisionLabel(division: DivisionId): string {
  return DIVISION_LABEL[division];
}

export function divisionColor(division: DivisionId): string {
  return DIVISION_UI.find((item) => item.id === division)?.color ?? "currentColor";
}

/** Silueta de escudo común a los seis emblemas. */
const SHIELD =
  "M12 2.5 L19.5 5.2 V11.2 C19.5 16.2 16.4 19.9 12 21.5 C7.6 19.9 4.5 16.2 4.5 11.2 V5.2 Z";

/** Marca interior de cada división: una barra, dos barras, cheurón, estrella, rombo y corona. */
const MARKS: Record<DivisionId, ReactNode> = {
  bronce: <rect x="7.5" y="10" width="9" height="2.2" rx="1.1" fill="currentColor" />,
  plata: (
    <>
      <rect x="7.5" y="8.4" width="9" height="2" rx="1" fill="currentColor" />
      <rect x="7.5" y="12" width="9" height="2" rx="1" fill="currentColor" />
    </>
  ),
  oro: (
    <path
      d="M7.5 13.6 L12 9 L16.5 13.6"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  platino: (
    <path
      d="M12 7 L13.4 10.6 L17 12 L13.4 13.4 L12 17 L10.6 13.4 L7 12 L10.6 10.6 Z"
      fill="currentColor"
    />
  ),
  diamante: <path d="M12 7.5 L16 12 L12 16.5 L8 12 Z" fill="currentColor" />,
  conquistador: <path d="M7.5 15 V10 L10 12 L12 8.5 L14 12 L16.5 10 V15 Z" fill="currentColor" />,
};

export function DivisionIcon({
  division,
  className,
}: {
  division: DivisionId;
  className?: string;
}) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className}>
      <path
        d={SHIELD}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      {MARKS[division]}
    </svg>
  );
}