import Image from "next/image";
import Link from "next/link";

export function SiteFooter() {
  return (
    <footer className="thread-top relative border-t border-line bg-surface/40">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-10 px-4 py-10 sm:px-6 md:flex-row md:items-start md:justify-between">
        <div className="max-w-sm">
          <div className="flex items-center gap-3">
            {/* Decorativo: el nombre completo va justo al lado como texto. El
                emblema del pie se queda un escalón por debajo del de la
                cabecera; la caja intrínseca coincide con el tamaño pintado
                para que el candidato 2x del `srcset` no se amplíe. */}
            <Image
              src="/imagenes/marca/emblema-128.png"
              alt=""
              width={44}
              height={44}
              className="size-11 shrink-0"
            />
            <p className="font-display text-lg font-semibold text-foreground">
              Liga Hispana de Age of Empires IV
            </p>
          </div>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            Competición no oficial organizada por y para la comunidad Hispanohablante del Age of Empires 4. 
            Consulte las reglas del mismo en la seccion de reglas.
          </p>
        </div>

        <nav aria-label="Enlaces del pie" className="shrink-0">
          <ul className="flex flex-col items-start gap-2 text-sm">
            <li>
              <Link href="/objetivos" className="text-muted transition-colors hover:text-accent">
                Objetivos especiales
              </Link>
            </li>
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

      {/* El relleno inferior deja libre la esquina que ocupa `BackToTop`. */}
      <div className="mx-auto w-full max-w-6xl px-4 pb-20 sm:px-6">
        <p className="border-t border-line pt-6 text-xs leading-relaxed text-muted">
          Perfiles y resultados de partidas obtenidos de AoE4World. La
          clasificación se recalcula cada pocos minutos a medida que la API publica
          los resultados.
        </p>
      </div>
    </footer>
  );
}