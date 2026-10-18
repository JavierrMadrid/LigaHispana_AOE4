import Image from "next/image";

/**
 * Crédito del patrocinador del torneo.
 *
 * Hoy hay uno solo —Real Team corre con el dominio y la infraestructura donde
 * se despliega la web—, y el nombre se escribe una vez, aquí, para que la
 * insignia y su firma no puedan divergir. Hoy solo lo consume el pie; el día que
 * entren más, esta pieza es el sitio por donde empieza a ser una lista.
 */
export const SPONSOR_NAME = "RealTeam";

const SPONSOR_LOGO = "/imagenes/patrocinadores/Escudo_Real_Team_4_Gif.png";

/**
 * Escudo de la marca.
 *
 * Es decorativo siempre: el `alt` va vacío y quien nombra la mención es el texto
 * real que lo acompaña donde lo haya —debajo, en el pie—; las menciones que no
 * llevan texto, como el estandarte de la cabecera, se quedan en decoración y el
 * crédito con palabras vive entero en el pie, así que nunca hay dos versiones del
 * nombre que puedan divergir.
 *
 * `size` es el lado del recuadro que se pinta; el escudo visible es bastante más
 * pequeño, porque el PNG que dejó la organización trae su propio margen
 * transparente: lo visible ocupa en torno a la mitad del ancho y el 63 % del
 * alto, centrado. De ahí que la caja se pida más grande que el tamaño que se
 * quiere ver. Se pide el recuadro entero y no se recorta el fichero: el activo
 * es el suyo.
 */
export function SponsorLogo({ size, className }: { size: number; className?: string }) {
  return (
    <Image
      src={SPONSOR_LOGO}
      alt=""
      width={size}
      height={size}
      className={`shrink-0 ${className ?? ""}`}
    />
  );
}
