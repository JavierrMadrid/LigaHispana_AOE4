import type { Metadata } from "next";
import { Cinzel, Geist } from "next/font/google";
import { BackToTop } from "@/components/back-to-top";
import { readSiteUrl } from "@/lib/site-url";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

// Cinzel es una capital romana inscripcional, la familia que más se acerca a la
// rotulación de Age of Empires IV. Se reserva para titulares y wordmark: el
// texto corrido y las cifras van en Geist, que tiene cifras tabulares.
const cinzel = Cinzel({
  variable: "--font-cinzel",
  subsets: ["latin"],
  display: "swap",
});

// Dominio público del sitio, del que cuelgan las rutas absolutas de las
// imágenes para compartir (`opengraph-image`, iconos) y los canónicos. Se
// resuelve en `src/lib/site-url.ts`, que es la misma fuente que usa el informe
// diario del bot para el enlace a la web: dos dominios se verían en cuanto uno
// de los dos se tocara.
const siteUrl = readSiteUrl();

export const metadata: Metadata = {
  metadataBase: siteUrl,
  title: {
    default: "Liga Hispana de Age of Empires IV",
    template: "%s · Liga Hispana AoE4",
  },
  description:
    "Clasificación, partidas en juego y reglas del torneo individual de Age of Empires IV de la comunidad hispanohablante.",
  openGraph: {
    type: "website",
    locale: "es_ES",
    siteName: "Liga Hispana de Age of Empires IV",
    title: "Liga Hispana de Age of Empires IV",
    description:
      "Clasificación, partidas en juego y reglas del torneo individual de Age of Empires IV de la comunidad hispanohablante.",
  },
  // La tarjeta usa la imagen generada por `opengraph-image.jpg`; las redes que
  // no leen `og:image` caen a ella igualmente.
  twitter: {
    card: "summary_large_image",
  },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="es"
      className={`${geistSans.variable} ${cinzel.variable} h-full antialiased`}
    >
      {/* `relative` ancla el centinela de `BackToTop` al inicio del documento. */}
      <body className="relative min-h-full flex flex-col">
        {children}
        <BackToTop />
      </body>
    </html>
  );
}