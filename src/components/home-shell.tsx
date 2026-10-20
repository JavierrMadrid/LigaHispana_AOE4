"use client";

import type { ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowUpRight } from "@phosphor-icons/react/dist/csr/ArrowUpRight";
import "./home.css";

const navigation = [
  { href: "/", label: "Clasificación" },
  { href: "/partidas", label: "Partidas" },
  { href: "/objetivos", label: "Objetivos" },
  { href: "/puntuacion", label: "Puntuación" },
  { href: "/reglas", label: "Reglas" },
];

export function HomeShell({
  legacy,
  children,
  modal,
  banner,
  fonts,
}: {
  legacy: ReactNode;
  children: ReactNode;
  modal: ReactNode;
  banner: ReactNode;
  fonts: string;
}) {
  const pathname = usePathname();
  if (pathname !== "/") return legacy;

  return (
    <div className={`league-home ${fonts}`}>
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
              src="/imagenes/marca/emblema-256.png"
              width={48}
              height={48}
              alt=""
              priority
            />
            <span>Liga Hispana</span>
          </Link>
          <nav aria-label="Navegación principal" className="home-nav">
            {navigation.map(({ href, label }) => (
              <Link
                target="_blank"
                rel="noopener noreferrer"
                key={href}
                href={href}
                aria-current={href === "/" ? "page" : undefined}
              >
                {label}
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
      </header>
      <main id="contenido" className="home-content">
        {children}
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
              Liga Hispana AoE IV
            </Link>
            <p>Una competición de la comunidad hispanohablante.</p>
            <p>Competición no oficial. Perfiles y resultados de AoE4World.</p>
          </div>
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
