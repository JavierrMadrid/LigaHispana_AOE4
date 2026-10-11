type PlayerAvatarProps = {
  /** Nombre de display; de aquí salen las iniciales del recuadro de reserva. */
  name: string;
  /** Avatar de AoE4World; `null` pinta las iniciales. */
  avatarUrl: string | null;
  /** Caja del avatar: tamaño y tamaño de letra de las iniciales. */
  className: string;
  /**
   * Forma del marco: cuadrado redondeado por defecto, o círculo. La clasificación
   * pinta redondo; las tarjetas y el modal de objetivos, cuadrado. El tamaño
   * sigue entrando por `className`.
   */
  shape?: "square" | "circle";
};

/**
 * Avatar de un jugador.
 *
 * Comparte tratamiento en toda la web —filete y relleno de reserva, con las
 * iniciales cuando `avatarUrl` es `null` (AoE4World no lo publicó, o el jugador
 * todavía no se ha sincronizado)— y solo cambian la forma, por `shape`, y el
 * tamaño, por `className`. Nunca queda un hueco: sin avatar se pintan iniciales.
 */
export function PlayerAvatar({
  name,
  avatarUrl,
  className,
  shape = "square",
}: PlayerAvatarProps) {
  const frame = shape === "circle" ? "rounded-full" : "rounded-md";

  if (avatarUrl === null) {
    return (
      <span
        aria-hidden="true"
        className={`${className} flex shrink-0 items-center justify-center ${frame} border border-line bg-surface-raised font-semibold text-muted`}
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
      className={`${className} shrink-0 ${frame} border border-line bg-surface-raised object-cover`}
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
