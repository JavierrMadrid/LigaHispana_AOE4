import { CIVILIZATION_DIRECTORY, civilizationFile } from "@/lib/civs";

/**
 * Icono de una civilización de Age of Empires IV.
 *
 * Vivía dentro de `objective-icon.tsx`, donde solo servía a los objetivos de
 * civilización (`masterizando-*`, `lider-*`, `acolito-*`); la tarjeta de partidas
 * en juego necesita el mismo asset para cada jugador, así que el mapa de ficheros
 * y su `<img>` se extraen aquí y las dos pantallas usan el mismo componente. El
 * icono es solo la imagen: el nombre de la civilización no se pinta al lado, va
 * como texto para lectores de pantalla.
 *
 * Un `civ` desconocido (una civilización de un DLC reciente, o `null` porque la
 * partida no la publicó) cae a un recuadro neutro con el mismo tamaño, para que
 * la fila no se desalinee ni quede un hueco.
 *
 * El mapa `id → fichero` y `civilizationFile()` viven en `src/lib/civs.ts`: este
 * componente no es el único que necesita saber qué asset corresponde a una
 * civilización (la API del overlay publica la URL del icono de cada objetivo).
 */

type CivilizationIconProps = {
  /** Id de AoE4World (`english`, `holy_roman_empire`…). `null` si no se publicó. */
  civ: string | null;
  /** Caja del icono. Por defecto 24x24 px, la altura de una línea de texto. */
  className?: string;
  /** Nombre en español para lectores de pantalla. Sin él, el icono es decorativo. */
  label?: string;
};

export function CivilizationIcon({
  civ,
  className = "size-6 shrink-0",
  label,
}: CivilizationIconProps) {
  const file = civ === null ? null : civilizationFile(civ);

  if (file === null) {
    return (
      <span
        aria-hidden={label === undefined ? true : undefined}
        className={`${className} inline-flex items-center justify-center rounded-md border border-line bg-surface-raised text-muted`}
      >
        {label === undefined ? null : <span className="sr-only">{label}</span>}
        <CivilizationPlaceholderIcon className="size-1/2" />
      </span>
    );
  }

  return (
    <span className={`${className} inline-flex`}>
      {/* eslint-disable-next-line @next/next/no-img-element -- asset estático de `public`; el optimizador de next/image no aporta nada aquí. */}
      <img
        src={`${CIVILIZATION_DIRECTORY}/${file}`}
        alt=""
        loading="lazy"
        decoding="async"
        className="size-full rounded-md object-cover"
      />
      {label === undefined ? null : <span className="sr-only">{label}</span>}
    </span>
  );
}

/**
 * Reserva para una civilización sin asset reconocido: un estandarte, el mismo
 * glifo que usa `objective-icon.tsx` cuando un objetivo no tiene imagen. Antes
 * vivía allí como `BannerIcon` privado; ahora lo comparten los dos.
 */
export function CivilizationPlaceholderIcon({ className }: { className?: string }) {
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
      <path d="M6 3.5V20.5" />
      <path d="M6 4.5h11l-2.2 3.5L17 11.5H6" />
    </svg>
  );
}
