/**
 * Punto de estado en directo: un núcleo sólido con una onda que se expande.
 * La animación va bajo `motion-safe`, así que con movimiento reducido queda
 * como un punto fijo.
 */
export function LiveDot({ className = "bg-accent" }: { className?: string }) {
  return (
    <span aria-hidden="true" className="relative flex size-2 shrink-0">
      <span
        className={`absolute inline-flex size-full rounded-full opacity-60 motion-safe:animate-ping ${className}`}
      />
      <span className={`relative inline-flex size-2 rounded-full ${className}`} />
    </span>
  );
}