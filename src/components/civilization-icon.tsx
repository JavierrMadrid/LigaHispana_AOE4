import type { CivilizationId } from "@/lib/civs";

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
 */

const CIVILIZATION_DIRECTORY = "/imagenes/civilizaciones";

/**
 * Fichero WebP de cada civilización en `public/imagenes/civilizaciones`.
 *
 * El nombre no se puede derivar del `id` de AoE4World (Sacro Imperio es `HRE`,
 * Juana de Arco es `Jeanne_d_Arc`, Legado de Zhu Xi es `Zhu_Xis_Legacy`), así
 * que el mapa es explícito. `satisfies` obliga a que esté completo: cuando
 * entre una civilización nueva, el compilador exige su icono.
 */
const CIVILIZATION_FILES = {
  abbasid_dynasty: "Abbasid_Dynasty_AoE4.webp",
  ayyubids: "Ayyubids_AoE4.webp",
  byzantines: "Byzantines_AoE4.webp",
  chinese: "Chinese_AoE4.webp",
  delhi_sultanate: "Delhi_Sultanate_AoE4.webp",
  english: "English_AoE4.webp",
  french: "French_AoE4.webp",
  golden_horde: "Golden_Horde_AoE4.webp",
  holy_roman_empire: "HRE_AoE4.webp",
  house_of_lancaster: "House_of_Lancaster_AoE4.webp",
  japanese: "Japanese_AoE4.webp",
  jeanne_darc: "Jeanne_d_Arc_AoE4.webp",
  jin_dynasty: "Jin_Dynasty_AoE4.webp",
  knights_templar: "Knights_Templar_AoE4.webp",
  macedonian_dynasty: "Macedonian_Dynasty_AoE4.webp",
  malians: "Malians_AoE4.webp",
  mongols: "Mongols_AoE4.webp",
  order_of_the_dragon: "Order_of_the_Dragon_AoE4.webp",
  ottomans: "Ottomans_AoE4.webp",
  rus: "Rus_AoE4.webp",
  sengoku_daimyo: "Sengoku_Daimyo_AoE4.webp",
  tughlaq_dynasty: "Tughlaq_Dynasty_AoE4.webp",
  zhu_xis_legacy: "Zhu_Xis_Legacy_AoE4.webp",
} as const satisfies Record<CivilizationId, string>;

/**
 * Fichero del icono de una civilización, o `null` si no hay asset.
 *
 * Lo usa quien necesita distinguir "hay imagen" de "no la hay" para elegir su
 * propio recuadro de reserva, en vez de montar el componente entero.
 */
export function civilizationFile(id: string): string | null {
  return id in CIVILIZATION_FILES ? CIVILIZATION_FILES[id as CivilizationId] : null;
}

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
