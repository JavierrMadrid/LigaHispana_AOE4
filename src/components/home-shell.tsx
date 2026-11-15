"use client";

import type { CSSProperties, ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowUpRight } from "@phosphor-icons/react/dist/csr/ArrowUpRight";
import { PUBLIC_NAVIGATION } from "@/lib/public-navigation";
import { HomeObjectiveHelpProvider } from "@/components/home-objective-help";
import "./home.css";
import "./matches.css";

export function HomeShell({
  legacy,
  children,
  modal,
  banner,
  fonts,
  accentStyle,
  editionName,
  editionEmblem,
  sponsorBanner,
  sponsorCredit,
}: {
  legacy: ReactNode;
  children: ReactNode;
  modal: ReactNode;
  banner: ReactNode;
  fonts: string;
  accentStyle?: CSSProperties;
  editionName: string | null;
  editionEmblem: string | null;
  sponsorBanner: ReactNode;
  sponsorCredit: ReactNode;
}) {
  const pathname = usePathname();
  if (pathname !== "/" && pathname !== "/partidas") return legacy;

  return (
    <div
      className={`league-home ${
        pathname === "/partidas" ? "league-matches" : ""
      } ${fonts}`}
      style={accentStyle}
    >
      <a href="#contenido" className="home-skip">
        Saltar al contenido
      </a>
      {banner}
      <header className="home-header">
        <div className="home-header-inner">
          <Link
            target="_blank"
            rel="noopener noreferrer"
            href="/"
            className="home-brand"
          >
            <Image
              src={editionEmblem ?? "/imagenes/marca/emblema-256.png"}
              width={48}
              height={48}
              alt=""
              priority
              unoptimized={editionEmblem !== null}
            />
            <span>{editionName ?? "La Liga Hispana"}</span>
          </Link>
          <nav aria-label="Navegación principal" className="home-nav">
            {PUBLIC_NAVIGATION.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                aria-current={item.href === pathname ? "page" : undefined}
              >
                {"homeLabel" in item ? item.homeLabel : item.label}
              </Link>
            ))}
          </nav>
          <div className="home-header-actions">
            <Link
              target="_blank"
              rel="noopener noreferrer"
              className="home-primary home-signup-gold"
              href="/participar"
            >
              Inscríbete
              <ArrowUpRight size={16} aria-hidden="true" />
            </Link>
          </div>
        </div>
        {sponsorBanner}
      </header>
      <main id="contenido" className="home-content">
        <HomeObjectiveHelpProvider>{children}</HomeObjectiveHelpProvider>
      </main>
      <footer className="home-footer">
        <div className="home-footer-inner">
          <div>
            <Link
              target="_blank"
              rel="noopener noreferrer"
              href="/"
              className="home-footer-brand"
            >
              {editionName ?? "Liga Hispana AoE IV"}
            </Link>
            <p>Una competición de la comunidad hispanohablante.</p>
            <p>Competición no oficial. Perfiles y resultados de AoE4World.</p>
          </div>
          {sponsorCredit}
          <nav aria-label="Enlaces del pie">
            <Link target="_blank" rel="noopener noreferrer" href="/reglas">
              Reglas del torneo
            </Link>
            <Link target="_blank" rel="noopener noreferrer" href="/puntuacion">
              Cómo se puntúa
            </Link>
            <Link target="_blank" rel="noopener noreferrer" href="/login">
              Acceso de la organización
              <ArrowUpRight size={14} aria-hidden="true" />
            </Link>
          </nav>
        </div>
      </footer>
      {modal}
    </div>
  );
}
