/**
 * Glifo de Twitch dibujado a mano para este proyecto: burbuja con muesca y dos
 * barras recortadas. Se usa solo como enlace al canal del jugador.
 */
export function TwitchIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className}>
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M4.3 2 L2.5 6.2 V19.5 H6.5 V22.5 L9.5 19.5 H13.5 L21.5 11.5 V2 Z M11 6.5 H13 V12.5 H11 Z M16 6.5 H18 V12.5 H16 Z"
      />
    </svg>
  );
}