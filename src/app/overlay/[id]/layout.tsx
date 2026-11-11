import type { CSSProperties, ReactNode } from "react";
import { Inter } from "next/font/google";
import "./overlay.css";

/**
 * La misma familia de lectura que la portada nueva. El layout raíz carga Geist
 * para el resto del sitio; el overlay vive fuera de `(public)`, así que trae
 * Inter aquí y la aplica solo a su árbol.
 */
const inter = Inter({
  subsets: ["latin"],
  variable: "--font-overlay-inter",
  display: "swap",
});

/**
 * El overlay va fuera de `(public)` a propósito: no lleva cabecera ni pie, y
 * hereda del layout raíz las fuentes y los tokens. Este layout añade la familia
 * de la portada y el CSS que deja el documento transparente para OBS.
 */
export default function OverlayLayout({ children }: { children: ReactNode }) {
  return (
    <div
      className={`${inter.variable} font-sans`}
      style={{ "--font-sans": "var(--font-overlay-inter)" } as CSSProperties}
    >
      {children}
    </div>
  );
}
