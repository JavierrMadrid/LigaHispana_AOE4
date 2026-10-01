/**
 * Glifo de Kick dibujado a mano para este proyecto: una barra vertical y una
 * cuña que forma la K. Se usa solo como enlace al canal del jugador, igual que
 * `TwitchIcon`.
 */
export function KickIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className}>
      <path
        fill="currentColor"
        d="M4 3 H8 V21 H4 Z M9 12 L16.5 3 H21.5 L13.5 12 L21.5 21 H16.5 Z"
      />
    </svg>
  );
}
