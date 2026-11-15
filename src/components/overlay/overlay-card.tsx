import type { CSSProperties, ReactNode } from "react";

/**
 * El marco de la tarjeta del overlay.
 *
 * Doble filete —uno exterior y otro interior— sobre un fondo casi opaco, para
 * que la tarjeta se lea sobre el juego sin taparlo del todo. No hay sombra: en
 * este proyecto la elevación se declara con filete, nunca con sombra, y el
 * overlay tiene que verse como la misma casa que la web.
 *
 * `style` lo usa la vista del directo para escalar la tarjeta desde la esquina
 * en la que está anclada, sin cambiar su ancho base.
 */
export function OverlayCard({
  children,
  style,
}: {
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div
      style={style}
      className="relative w-full max-w-[22.5rem] overflow-hidden rounded-md border border-accent/45 bg-[#101d30]/95"
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-1 rounded-sm border border-accent/20"
      />
      <div className="relative">{children}</div>
    </div>
  );
}

/**
 * La cabecera de la tarjeta: emblema, nombre de la edición y el estado de la
 * vista. La comparten el ranking, la animación y las tarjetas de error, para que
 * la marca no cambie de sitio según lo que esté pasando.
 */
export function OverlayCardHeader({
  emblem,
  title,
  subtitle,
}: {
  emblem: string;
  title: string;
  subtitle: string;
}) {
  return (
    <header className="flex items-center gap-2.5 border-b border-accent/20 px-3 py-2.5">
      {/* El emblema puede ser el de la edición, con una URL que escribe la
          organización: no está declarada en `images.remotePatterns` y el overlay
          no debe arrastrar el optimizador. */}
      {/* eslint-disable-next-line @next/next/no-img-element -- emblema externo de la edición */}
      <img
        src={emblem}
        alt=""
        width={32}
        height={32}
        loading="eager"
        decoding="async"
        className="size-8 shrink-0"
      />
      <div className="min-w-0">
        <h1 className="truncate font-display text-[13px] font-semibold uppercase tracking-[0.14em] text-foreground">
          {title}
        </h1>
        <p className="text-[9px] font-medium uppercase tracking-[0.22em] text-accent">
          {subtitle}
        </p>
      </div>
    </header>
  );
}
