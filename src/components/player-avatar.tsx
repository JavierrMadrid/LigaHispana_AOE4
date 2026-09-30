type PlayerAvatarProps = {
  /** Nombre de display; de aquí salen las iniciales del recuadro de reserva. */
  name: string;
  /** Avatar de AoE4World; `null` pinta las iniciales. */
  avatarUrl: string | null;
  /** Caja del avatar: tamaño y tamaño de letra de las iniciales. */
  className: string;
};

/**
 * Avatar de un jugador.
 *
 * Es el mismo recuadro en toda la web: la clasificación y las tarjetas/modal de
 * objetivos comparten forma (cuadrado redondeado con filete) y solo cambian de
 * tamaño, que entra por `className`. Sin `avatarUrl` (AoE4World no lo publicó, o
 * el jugador todavía no se ha sincronizado) se pintan las iniciales, para que la
 * fila no quede con un hueco.
 */
export function PlayerAvatar({ name, avatarUrl, className }: PlayerAvatarProps) {
  if (avatarUrl === null) {
    return (
      <span
        aria-hidden="true"
        className={`${className} flex shrink-0 items-center justify-center rounded-md border border-line bg-surface-raised font-semibold text-muted`}
      >
        {initials(name)}
      </span>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- los avatares vienen de AoE4World (o como data: en el mock); next/image exigiría declarar el host remoto.
    <img
      src={avatarUrl}
      alt=""
      loading="lazy"
      decoding="async"
      className={`${className} shrink-0 rounded-md border border-line bg-surface-raised object-cover`}
    />
  );
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word.charAt(0))
    .join("")
    .toUpperCase();
}
