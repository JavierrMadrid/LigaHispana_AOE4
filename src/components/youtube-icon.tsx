/**
 * Glifo de YouTube dibujado a mano para este proyecto: una pantalla redondeada
 * con un triángulo de reproducción recortado. Se usa solo como enlace al canal
 * del jugador, igual que `TwitchIcon`.
 */
export function YoutubeIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className}>
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M2.5 6.5 A3 3 0 0 1 5.5 3.5 H18.5 A3 3 0 0 1 21.5 6.5 V17.5 A3 3 0 0 1 18.5 20.5 H5.5 A3 3 0 0 1 2.5 17.5 Z M10 8.25 L16 12 L10 15.75 Z"
      />
    </svg>
  );
}
