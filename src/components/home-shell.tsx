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
import "./objectives.css";
import "./rules.css";
import "./participate.css";
import "./objects.css";
import "./news.css";

/**
 * Las rutas que se leen con el armazón de la portada y el modificador que tiñe
 * cada una. Una ruta que no esté aquí usa el cromo heredado (`legacy`): la
 * cabecera y el pie de las páginas que no son secciones de la casa.
 *
 * La portada no lleva modificador —es la casa misma— y por eso su valor es
 * vacío; las demás se anuncian con su clase para que su hoja de estilos pueda
 * pintar solo lo suyo.
 */
const HOME_SHELL_CLASS: Record<string, string> = {
  "/": "",
  "/partidas": "league-matches",
  "/objetivos": "league-objectives",
  "/puntuacion": "league-scoring",
  "/reglas": "league-rules",
  "/participar": "league-participate",
  "/objetos": "league-objects",
  "/noticias": "league-news",
};

/**
 * Si el destino está activo en esa ruta o en las que cuelgan de ella.
 *
 * La comparación exacta no bastaba en cuanto una sección tiene página propia por
 * elemento: al leer `/noticias/<slug>`, la cabecera sigue estando en Noticias, y
 * con `===` no marcaba nada. La portada solo lo está en sí misma.
 */
function isSection(href: string, pathname: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * La sección de la casa a la que pertenece una ruta, o `undefined` si usa el
 * cromo heredado. Las páginas propias de una sección —hoy, las noticias sueltas—
 * heredan la clase de su sección.
 */
function homeShellClass(pathname: string): string | undefined {
  const direct = HOME_SHELL_CLASS[pathname];

  if (direct !== undefined) {
    return direct;
  }

  return pathname.startsWith("/noticias/") ? HOME_SHELL_CLASS["/noticias"] : undefined;
}

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
  const isScoring = pathname === "/puntuacion";
  const shellClass = homeShellClass(pathname);

  if (shellClass === undefined) return legacy;

  return (
    <div
      className={`league-home ${shellClass} ${fonts}`}
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
                aria-current={isSection(item.href, pathname) ? "page" : undefined}
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
            {isScoring ? (
              <>
                <Link target="_blank" rel="noopener noreferrer" href="/noticias">
                  Noticias
                </Link>
                <Link target="_blank" rel="noopener noreferrer" href="/overlay">
                  Overlay para streamers
                </Link>
              </>
            ) : null}
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
