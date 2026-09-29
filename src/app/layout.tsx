import type { Metadata } from "next";
import { Cinzel, Geist, Geist_Mono } from "next/font/google";
import { BackToTop } from "@/components/back-to-top";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
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
// resuelve por capas para que funcione sin configurar nada y aun así admita
// dominio propio, y para que el build no se rompa en desarrollo local.
//   1. `NEXT_PUBLIC_SITE_URL`: dominio personalizado, con protocolo.
//   2. `VERCEL_PROJECT_PRODUCTION_URL`: dominio de producción que Vercel inyecta
//      en tiempo de build, sin protocolo; se usa también en los despliegues de
//      rama para que las tarjetas sociales apunten siempre a producción.
//   3. `http://localhost:3000`: fallback de desarrollo local.
//
// Se evalúa al importar el módulo, o sea en `next build`: son variables de build
// (`NEXT_PUBLIC_*` las sustituye Next por un literal), no de runtime, así que aquí
// no tiene sentido mirar los bindings del Worker.
function getSiteUrl(): URL {
  const configured = process.env.NEXT_PUBLIC_SITE_URL;
  if (configured) return new URL(configured);

  const vercelProduction = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (vercelProduction) return new URL(`https://${vercelProduction}`);

  return new URL("http://localhost:3000");
}

const siteUrl = getSiteUrl();

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
      className={`${geistSans.variable} ${geistMono.variable} ${cinzel.variable} h-full antialiased`}
    >
      {/* `relative` ancla el centinela de `BackToTop` al inicio del documento. */}
      <body className="relative min-h-full flex flex-col">
        {children}
        <BackToTop />
      </body>
    </html>
  );
}