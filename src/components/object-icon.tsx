import type { ReactNode } from "react";
import type { ObjectHistoryEvent } from "@/lib/object-history";

type ObjectKind = ObjectHistoryEvent["object"]["kind"];

type ObjectIconProps = {
  kind: ObjectKind;
  /** Caja del icono. Por defecto 20 px, la altura de una línea de texto. */
  className?: string;
};

/**
 * Glifo del objeto de una fila del historial.
 *
 * Tres formas propias —el cáliz de la reliquia, la moneda con la corona del Rey y
 * el obelisco del monumento—, dibujadas con el mismo trazo de 1,5 px y la misma
 * caja de 24×24 que los glifos de `ObjectiveIcon`, para que el feed hable el
 * idioma visual del resto del sitio. El icono es decorativo: el nombre del objeto
 * ya va en la frase, así que no pide texto alternativo.
 */
export function ObjectIcon({ kind, className = "size-5 shrink-0" }: ObjectIconProps) {
  return (
    <span className={`${className} inline-flex items-center justify-center text-muted`}>
      {kind === "RELIQUIA" ? <RelicIcon /> : null}
      {kind === "MONEDA" ? <CoinIcon /> : null}
      {kind === "MONUMENTO" ? <MonumentIcon /> : null}
    </span>
  );
}

function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="size-full"
    >
      {children}
    </svg>
  );
}

/** La reliquia pagana: el cáliz que se guarda en el monasterio. */
function RelicIcon() {
  return (
    <Glyph>
      <path d="M8 4h8" />
      <path d="M8.5 4v4a3.5 3.5 0 0 0 7 0V4" />
      <path d="M12 11.5v6" />
      <path d="M9.5 17.5h5l1 2.5h-7Z" />
    </Glyph>
  );
}

/** La moneda del Rey falsificada: la corona acuñada en el cospel. */
function CoinIcon() {
  return (
    <Glyph>
      <circle cx="12" cy="12" r="8" />
      <path d="M8.2 13.6 7.4 9.4l2.9 1.8L12 8.4l1.7 2.8 2.9-1.8-.8 4.2Z" />
      <path d="M8.2 13.6h7.6" />
    </Glyph>
  );
}

/** El monumento: el obelisco sobre su basamento escalonado. */
function MonumentIcon() {
  return (
    <Glyph>
      <path d="M10.3 5h3.4l.9 8.6h-5.2Z" />
      <path d="M9.6 5 12 2.8 14.4 5Z" />
      <path d="M9.8 13.6h4.4" />
      <path d="M7.5 16.2h9" />
      <path d="M6.5 19.5h11" />
    </Glyph>
  );
}
