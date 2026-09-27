import Link from "next/link";

export function SiteFooter() {
  return (
    <footer className="border-t border-line bg-surface/40">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-10 px-4 py-10 sm:px-6 md:flex-row md:items-start md:justify-between">
        <div className="max-w-sm">
          <p className="font-display text-lg font-semibold text-foreground">
            Liga Hispana de Age of Empires IV
          </p>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            Torneo individual. Cada jugador compite por su cuenta y suma un punto
            por cada victoria en partida clasificatoria.
          </p>
        </div>

        <nav aria-label="Enlaces del pie" className="shrink-0">
          <ul className="flex flex-col items-start gap-2 text-sm">
            <li>
              <Link href="/reglas" className="text-muted transition-colors hover:text-accent">
                Reglas del torneo
              </Link>
            </li>
            <li>
              <Link
                href="/login"
                className="text-muted transition-colors hover:text-foreground"
              >
                Acceso de la organización
              </Link>
            </li>
          </ul>
        </nav>
      </div>

      <div className="mx-auto w-full max-w-6xl px-4 pb-10 sm:px-6">
        <p className="border-t border-line pt-6 text-xs leading-relaxed text-muted">
          Perfiles y resultados de partidas obtenidos de AoE4World. La
          clasificación se recalcula cada pocos minutos a medida que la API publica
          los resultados.
        </p>
      </div>
    </footer>
  );
}