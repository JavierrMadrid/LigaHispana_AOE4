import type { Metadata } from "next";
import { Cinzel, Geist, Geist_Mono } from "next/font/google";
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

export const metadata: Metadata = {
  title: {
    default: "Liga Hispana de Age of Empires IV",
    template: "%s · Liga Hispana AoE4",
  },
  description:
    "Clasificación, partidas en directo y reglas del torneo individual de Age of Empires IV de la comunidad hispanohablante.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="es"
      className={`${geistSans.variable} ${geistMono.variable} ${cinzel.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}