import type { ComponentType, ReactNode } from "react";
import { civilizationFile, objectiveCivilization } from "@/lib/civs";
import type { ObjectiveOption } from "@/lib/public";
import { CivilizationIcon, CivilizationPlaceholderIcon } from "@/components/civilization-icon";

/**
 * Icono de un objetivo especial, al inicio de su tarjeta.
 *
 * Tres familias, por origen del objetivo:
 *  - Civilización (`masterizando-*`, `lider-*`, `acolito-*`): la imagen del juego
 *    de esa civilización, que resuelve `CivilizationIcon`.
 *  - Formato (`rey-1v1` a `rey-4v4`): `FormatIcon` dibuja tantos jugadores por
 *    bando como indique el tamaño.
 *  - Los quince objetivos sin asset oficial: un glifo propio cada uno, elegido
 *    por id en `OBJECTIVE_ICONS`. El reparto es **explícito** —ni por grupo ni
 *    por métrica— para que dos objetivos distintos no vuelvan a compartir glifo
 *    por descuido: cada id lleva el suyo, con la forma de lo que mide. Un id que
 *    no esté en el mapa cae a `CivilizationPlaceholderIcon`, que es la reserva
 *    común del proyecto.
 *
 * Los ids van como literales porque son contrato estable del catálogo
 * (`src/lib/objectives.ts`) y este módulo no puede importar valores de él —el
 * catálogo es `server-only`—.
 *
 * Aquí el icono es decorativo: el nombre del objetivo ya lo dice la etiqueta,
 * así que no se pide texto alternativo.
 */

/**
 * Forma mínima que necesita el icono. La comparten `ObjectiveOption` (tarjetas
 * de `/objetivos`) y `StandingObjective` (fila de la clasificación), así que el
 * mismo icono sirve en los dos sitios sin adaptar el dato ni castear. El glifo
 * se elige solo por `id`; los otros dos campos viajan con él porque los
 * consumidores comparten el mismo tipo.
 */
type ObjectiveIconInput = Pick<ObjectiveOption, "id" | "group" | "metric">;

type ObjectiveIconProps = {
  option: ObjectiveIconInput;
  /** Caja del icono. Por defecto 24x24 px, la altura de una línea de texto. */
  className?: string;
};

export function ObjectiveIcon({ option, className = "size-6 shrink-0" }: ObjectiveIconProps) {
  const civ = objectiveCivilization(option.id);
  const civFile = civ === null ? null : civilizationFile(civ);

  if (civFile !== null) {
    return <CivilizationIcon civ={civ} className={className} />;
  }

  const wrapper = `${className} inline-flex items-center justify-center text-muted`;

  if (option.id.startsWith("rey-")) {
    return (
      <span className={wrapper}>
        <FormatIcon size={formatPlayers(option.id)} className="size-full" />
      </span>
    );
  }

  const Icon = OBJECTIVE_ICONS[option.id] ?? CivilizationPlaceholderIcon;

  return (
    <span className={wrapper}>
      <Icon className="size-full" />
    </span>
  );
}

/** "rey-3v3" → 3. Un valor fuera de 1-4 se recorta para no salirse de la caja. */
function formatPlayers(id: string): number {
  const size = Number.parseInt(id.slice("rey-".length), 10);
  return Number.isInteger(size) ? Math.min(Math.max(size, 1), 4) : 1;
}

/**
 * Glifo propio de cada objetivo sin asset oficial, por id. Uno por objetivo:
 * el objeto literal que lo representa (un mapa, un calendario, unas marcas de
 * conteo) o la metáfora inmediata de lo que mide (el trébol de la suerte, el
 * velocímetro de las acciones por minuto, el rayo del avance relámpago).
 * Ninguno se comparte: si dos objetivos se leyeran igual de un vistazo, el
 * reparto habría vuelto a fallar.
 */
const OBJECTIVE_ICONS: Record<string, ComponentType<{ className?: string }>> = {
  "loco-por-ganar": TallyIcon,
  imparable: CalendarIcon,
  victorias: VictoryIcon,
  bienhadado: CloverIcon,
  imbatible: FlameIcon,
  ansioso: GaugeIcon,
  agresor: DaggerIcon,
  estratega: HourglassIcon,
  "por-tierra-y-agua": MapIcon,
  "avance-relampago-feudal": BoltKeepIcon,
  "avance-relampago-castillos": BoltCastleIcon,
  "avance-relampago-imperial": BoltCrownIcon,
  "defensor-del-pueblo": TownShieldIcon,
  polifacetico: AllCivsIcon,
  jugon: WorldIcon,
};

function Glyph({ className, children }: { className?: string; children: ReactNode }) {
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
      {children}
    </svg>
  );
}

/**
 * Loco por ganar: las marcas de conteo con las que se lleva la cuenta de las
 * partidas jugadas, que es lo que reparte este objetivo.
 */
function TallyIcon({ className }: { className?: string }) {
  return (
    <Glyph className={className}>
      <path d="M5.6 6.8v10.4" />
      <path d="M9.5 6.8v10.4" />
      <path d="M13.4 6.8v10.4" />
      <path d="M17.3 6.8v10.4" />
      <path d="M3.7 17.8 19.2 6.2" />
    </Glyph>
  );
}

/**
 * Imparable: el calendario con la marca del día cumplido, porque lo que cuenta
 * es encadenar un día natural tras otro.
 */
function CalendarIcon({ className }: { className?: string }) {
  return (
    <Glyph className={className}>
      <path d="M3.8 7.6a2 2 0 0 1 2-2h12.4a2 2 0 0 1 2 2v10.8a2 2 0 0 1-2 2H5.8a2 2 0 0 1-2-2Z" />
      <path d="M8.2 3.6v4" />
      <path d="M15.8 3.6v4" />
      <path d="M3.8 10.4h16.4" />
      <path d="m8.6 15.2 2.4 2.4 4.6-4.8" />
    </Glyph>
  );
}

/** Victorias: la copa que se levanta con cada victoria clasificatoria. */
function VictoryIcon({ className }: { className?: string }) {
  return (
    <Glyph className={className}>
      <path d="M7 4.5h10v3.2a5 5 0 0 1-10 0Z" />
      <path d="M7 5.5H4.5v1.2A3.3 3.3 0 0 0 7.8 10" />
      <path d="M17 5.5h2.5v1.2A3.3 3.3 0 0 1 16.2 10" />
      <path d="M12 12.8V15" />
      <path d="M9.2 15h5.6l1.2 4H8Z" />
    </Glyph>
  );
}

/**
 * Bienhadado: el trébol de cuatro hojas de quien tiene la suerte de la racha de
 * victorias más larga del torneo. Las hojas se separan con una muesca hacia el
 * tallo para que las cuatro se cuenten incluso a 16 px.
 */
function CloverIcon({ className }: { className?: string }) {
  const lobe =
    "M12 12C10.1 10.9 9.7 9 10 7.6 10.2 6.3 11.3 6.2 12 9.4c.7-3.2 1.8-3.1 2-1.8.3 1.4-.1 3.3-2 4.4Z";
  return (
    <Glyph className={className}>
      <g fill="currentColor" stroke="none">
        <path d={lobe} transform="rotate(45 12 12) translate(0 -1.1)" />
        <path d={lobe} transform="rotate(135 12 12) translate(0 -1.1)" />
        <path d={lobe} transform="rotate(225 12 12) translate(0 -1.1)" />
        <path d={lobe} transform="rotate(315 12 12) translate(0 -1.1)" />
      </g>
      <path d="M12 12.2v8.2" />
    </Glyph>
  );
}

/**
 * Imbatible: la llama de la racha que no se apaga, cinco victorias seguidas
 * encendidas.
 */
function FlameIcon({ className }: { className?: string }) {
  return (
    <Glyph className={className}>
      <path d="M12 3.5c.5 2.6 2.4 3.8 3.5 5.4a5.3 5.3 0 1 1-8.8 3.2c0-1.8.9-3.2 1.9-4.4.3 1 .8 1.7 1.6 2.1-.4-2.4.2-4.6 1.8-6.3Z" />
    </Glyph>
  );
}

/**
 * Ansioso: el velocímetro de las acciones por minuto, con la aguja disparada
 * por encima del umbral de APM. La esfera queda abierta por abajo para que no
 * se confunda con el globo de `jugon`.
 */
function GaugeIcon({ className }: { className?: string }) {
  return (
    <Glyph className={className}>
      <path d="M6.86 18.73A8 8 0 1 1 17.14 18.73" />
      <path d="M12 12.6 16.6 8" />
      <circle cx="12" cy="12.6" r="1.25" fill="currentColor" stroke="none" />
    </Glyph>
  );
}

/**
 * Agresor: la daga del golpe rápido, con las rayas de velocidad del ataque que
 * gana la partida antes de los diez minutos. La hoja va maciza para que la
 * daga se sostenga al reducirse a 16 px.
 */
function DaggerIcon({ className }: { className?: string }) {
  return (
    <Glyph className={className}>
      <g fill="currentColor" stroke="none">
        <path d="M12 2.2 14.3 7.4v5.2H9.7V7.4Z" />
        <rect x="8" y="12.6" width="8" height="1.7" rx="0.85" />
        <rect x="10.85" y="14.3" width="2.3" height="4.1" />
        <circle cx="12" cy="19.4" r="1.5" />
      </g>
      <path d="M3.2 5.6h3.8" />
      <path d="M4.4 9h2.6" />
    </Glyph>
  );
}

/**
 * Estratega: el reloj de arena de la partida larga, la que se gana después de
 * veinte minutos de estrategia.
 */
function HourglassIcon({ className }: { className?: string }) {
  return (
    <Glyph className={className}>
      <path d="M6.8 3.8h10.4" />
      <path d="M6.8 20.2h10.4" />
      <path d="M8.8 3.8 12 11.8l3.2-8" />
      <path d="M8.8 20.2 12 11.8l3.2 8.4" />
    </Glyph>
  );
}

/**
 * Por tierra y agua: el mapa doblado del pool activo, que hay que recorrer
 * entero mapa por mapa.
 */
function MapIcon({ className }: { className?: string }) {
  return (
    <Glyph className={className}>
      <path d="M3 6.6 9 3.8l6 2.8 6-2.8v13.2l-6 2.8-6-2.8-6 2.8Z" />
      <path d="M9 3.8v13.2" />
      <path d="M15 6.6v13.2" />
    </Glyph>
  );
}

/**
 * El rayo que comparten los tres `avance-relampago-*`: la edad alcanzada en un
 * destello. Va macizo y ocupa el tercio superior derecho, con la punta baja
 * hacia el símbolo de la edad, que se dibuja abajo a la izquierda: un rayo de
 * trazo se fundiría con el edificio al reducirse, y el macizo sigue leyéndose
 * a 16 px.
 */
function FlashBolt() {
  return <path d="M18.2 1 13.2 7h4.5l-.5 4 5-6h-4.5Z" fill="currentColor" stroke="none" />;
}

/**
 * Avance relámpago: Feudal. El torreón almenado con su puerta en arco, la
 * primera fortaleza de la edad, alcanzado bajo el rayo.
 */
function BoltKeepIcon({ className }: { className?: string }) {
  return (
    <Glyph className={className}>
      <FlashBolt />
      <path d="M3.8 20.6V6.4h1.5v1.15h1.15V6.4h1.5v1.15h1.15V6.4h1.5v14.2Z" />
      <path d="M5.9 20.6v-3.2a1.3 1.3 0 0 1 2.6 0v3.2" />
    </Glyph>
  );
}

/**
 * Avance relámpago: Castillos. La muralla almenada con su gran puerta en arco,
 * la edad de las fortalezas, alcanzada bajo el rayo.
 */
function BoltCastleIcon({ className }: { className?: string }) {
  return (
    <Glyph className={className}>
      <FlashBolt />
      <path d="M2 20.6V8.4h1.75v1.53h1.53V8.4h1.75v1.53h1.53V8.4h1.75v1.53h1.53V8.4h1.75V20.6Z" />
      <path d="M5.9 20.6v-3.6a1.9 1.9 0 0 1 3.8 0v3.6" />
    </Glyph>
  );
}

/**
 * Avance relámpago: Imperial. La corona de tres picos que remata la última
 * edad, alcanzada bajo el rayo.
 */
function BoltCrownIcon({ className }: { className?: string }) {
  return (
    <Glyph className={className}>
      <FlashBolt />
      <path d="M2 20.6v-11l2.65 4.2 2.65-5 2.65 5 2.65-4.2v11Z" />
      <path d="M2 17.8h10.6" />
    </Glyph>
  );
}

/**
 * Defensor del pueblo: el escudo de tapa plana que cubre a los aldeanos del
 * poblado, la gente que no se pierde en la partida larga.
 */
function TownShieldIcon({ className }: { className?: string }) {
  return (
    <Glyph className={className}>
      <path d="M5.4 4.8h13.2v5.9c0 3.9-2.9 6.9-6.6 9-3.7-2.1-6.6-5.1-6.6-9Z" />
      <circle cx="9.6" cy="11.6" r="1" fill="currentColor" stroke="none" />
      <circle cx="14.4" cy="11.6" r="1" fill="currentColor" stroke="none" />
      <path d="M7.9 16c.1-2 .75-3 1.7-3s1.6 1 1.7 3" />
      <path d="M12.7 16c.1-2 .75-3 1.7-3s1.6 1 1.7 3" />
    </Glyph>
  );
}

/**
 * Polifacético: el blasón con la estrella de haber ganado con todas las banderas
 * de las civilizaciones. La estrella maciza es el distintivo de la gesta
 * completa; el escudo de punta superior, el blasón de la liga.
 */
function AllCivsIcon({ className }: { className?: string }) {
  return (
    <Glyph className={className}>
      <path d="M12 3.5 18.5 5.7V10c0 3.9-2.6 6.8-6.5 9.5C8.1 16.8 5.5 13.9 5.5 10V5.7Z" />
      <path
        d="M12 6.75 12.91 9.24 15.56 9.34 13.49 10.99 14.2 13.54 12 12.06 9.8 13.54 10.51 10.99 8.44 9.34 11.09 9.24Z"
        fill="currentColor"
        stroke="none"
      />
    </Glyph>
  );
}

/**
 * Jugón: el mundo de las civilizaciones con las que juega, las veintitrés
 * recorridas una por una.
 */
function WorldIcon({ className }: { className?: string }) {
  return (
    <Glyph className={className}>
      <circle cx="12" cy="12" r="8.2" />
      <ellipse cx="12" cy="12" rx="3.7" ry="8.2" />
      <path d="M3.8 12h16.4" />
    </Glyph>
  );
}

/**
 * Formato de partida: dos bandos encarados, con tantos jugadores por lado como
 * indique el tamaño. La raya central separa los dos equipos.
 */
function FormatIcon({ size, className }: { size: number; className?: string }) {
  const spacing = 20 / size;
  const radius = size >= 4 ? 1.5 : size === 3 ? 1.7 : size === 2 ? 1.9 : 2.2;
  const rows = Array.from(
    { length: size },
    (_, index) => 12 + (index - (size - 1) / 2) * spacing,
  );

  return (
    <Glyph className={className}>
      <path d="M12 4.5V19.5" strokeOpacity={0.35} />
      {rows.map((y) => (
        <g key={y}>
          <circle cx="7.4" cy={y} r={radius} fill="currentColor" stroke="none" />
          <circle cx="16.6" cy={y} r={radius} fill="currentColor" stroke="none" />
        </g>
      ))}
    </Glyph>
  );
}
