import type { MatcherinoDonations } from "@/lib/public";

/**
 * Banner de la campaña de donaciones del torneo, en lo alto de la web pública.
 *
 * Es cromo promocional, no contenido: vive por encima de la cabecera y fuera de su
 * `sticky`, en el flujo normal del layout. Al desplazar, la cabecera (`sticky
 * top-0`) se pega al borde superior y el banner ya ha subido con la página, así
 * que no la tapa ni se queda debajo de ella. Va a ancho de cabecera
 * (`max-w-[86rem]`) para que sus bordes alineen con el emblema y las acciones.
 *
 * El layout ya ha descartado la lectura degradada (`status !== "ok"`); aquí solo
 * queda la última condición, que la organización lo haya activado. Sin campaña
 * publicada devuelve `null`: un banner vacío dejaría un filete suelto y una franja
 * de tinte sin contenido.
 *
 * El enlace abre en pestaña nueva porque lleva fuera del sitio, y `rel="noopener
 * noreferrer"` corta el acceso del destino a `window.opener` y el referrer. La URL
 * llega ya validada (`http`/`https`) por `parseMatcherinoDonations()`, así que no se
 * vuelve a comprobar aquí.
 *
 * El filete dorado y el tinte de acento son el mismo dialecto que la cabecera
 * (`thread-bottom` + filete) y que la inscripción (`accent/10`, etiqueta en oro):
 * el banner se lee como parte del mismo cromo. El texto va en `muted` para no
 * competir con el contenido —es una invitación, no la clasificación— y el oro se
 * queda en el nombre de la plataforma y en el filete.
 */
export function DonationBanner({ donations }: { donations: MatcherinoDonations }) {
  if (!donations.enabled) {
    return null;
  }

  return (
    <div className="thread-bottom relative border-b border-accent/25 bg-accent/5">
      <a
        href={donations.url}
        target="_blank"
        rel="noopener noreferrer"
        className="group mx-auto flex w-full max-w-[86rem] flex-wrap items-center justify-center gap-x-2 gap-y-0.5 px-4 py-2 text-center text-sm transition-colors hover:bg-accent/5 sm:px-6"
      >
        <span className="text-muted">Apoya el torneo con una donación en</span>
        <span className="font-medium text-accent underline decoration-accent/40 underline-offset-4 transition-colors group-hover:text-accent-strong group-hover:decoration-accent">
          Matcherino
        </span>
        {/* Dice que el enlace sale del sitio; es decorativo, el nombre accesible lo
            da el texto. Mismo trazo que el resto de glifos de la casa. */}
        <ExternalLinkIcon className="size-4 shrink-0 text-accent" />
      </a>
    </div>
  );
}

/**
 * Flecha que sale de una ventana: el signo universal de "abre en otra pestaña".
 *
 * Caja de 24, `currentColor`, 1.5 de grosor y extremos redondeados, como los
 * glifos de `site-nav.tsx` y `objective-icon.tsx`.
 */
function ExternalLinkIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="M14 4h6v6" />
      <path d="M20 4 10.5 13.5" />
      <path d="M18 13.5v5A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6h5" />
    </svg>
  );
}
