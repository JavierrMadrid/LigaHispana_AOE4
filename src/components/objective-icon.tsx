import type { ReactNode } from "react";
import type { ObjectiveOption } from "@/lib/public";
import {
  CivilizationIcon,
  CivilizationPlaceholderIcon,
  civilizationFile,
} from "@/components/civilization-icon";

/**
 * Icono de un objetivo especial, al inicio de su tarjeta.
 *
 * Dos familias, una por origen del objetivo:
 *  - Civilización (`masterizando-*`, `lider-*`, `acolito-*`): la imagen del juego
 *    de esa civilización, que resuelve `CivilizationIcon`.
 *  - Actividad, racha, hazañas, formato y los logros globales: glifos propios del
 *    proyecto, porque no hay asset oficial para ellos. Se eligen por grupo y
 *    métrica, y los formatos dibujan tantos jugadores por bando como indique el
 *    tamaño (1v1 a 4v4).
 *
 * Aquí el icono es decorativo: el nombre de la civilización ya lo dice la
 * etiqueta del objetivo, así que no se pide texto alternativo.
 */

/** Prefijos de id que llevan la civilización pegada (`lider-japanese` → `japanese`). */
const CIV_PREFIXES = ["masterizando-", "lider-", "acolito-"] as const;

/**
 * Forma mínima que necesita el icono para elegir el glifo. La comparten
 * `ObjectiveOption` (tarjetas de `/objetivos`) y `StandingObjective` (fila de la
 * clasificación), así que el mismo icono sirve en los dos sitios sin adaptar el
 * dato ni castear.
 */
type ObjectiveIconInput = Pick<ObjectiveOption, "id" | "group" | "metric">;

type ObjectiveIconProps = {
  option: ObjectiveIconInput;
  /** Caja del icono. Por defecto 24x24 px, la altura de una línea de texto. */
  className?: string;
};

/** La civilización de un id de objetivo, o `null` si el id no es de civilización. */
function objectiveCiv(id: string): string | null {
  for (const prefix of CIV_PREFIXES) {
    if (id.startsWith(prefix)) {
      return id.slice(prefix.length);
    }
  }

  return null;
}

export function ObjectiveIcon({ option, className = "size-6 shrink-0" }: ObjectiveIconProps) {
  const civ = objectiveCiv(option.id);
  const civFile = civ === null ? null : civilizationFile(civ);

  if (civFile !== null) {
    return <CivilizationIcon civ={civ} className={className} />;
  }

  return (
    <span className={`${className} inline-flex items-center justify-center text-muted`}>
      <GenericIcon option={option} className="size-full" />
    </span>
  );
}

/** Glifo de los grupos sin asset oficial, elegido por grupo y métrica. */
function GenericIcon({ option, className }: { option: ObjectiveIconInput; className?: string }) {
  if (option.group === "formato") {
    return <FormatIcon size={formatPlayers(option.id)} className={className} />;
  }

  if (option.group === "actividad") {
    return option.metric === "dias" ? (
      <StreakIcon className={className} />
    ) : (
      <MatchesIcon className={className} />
    );
  }

  if (option.group === "racha" || option.group === "hazanas") {
    return <VictoryIcon className={className} />;
  }

  // `polifacetico` y `jugon` son los logros globales del grupo de civilización:
  // se pintan con el escudo estrellado que evoca "todas las civilizaciones".
  if (option.group === "civilizacion") {
    return <AllCivsIcon className={className} />;
  }

  return <CivilizationPlaceholderIcon className={className} />;
}

/** "rey-3v3" → 3. Un valor fuera de 1-4 se recorta para no salirse de la caja. */
function formatPlayers(id: string): number {
  const size = Number.parseInt(id.slice("rey-".length), 10);
  return Number.isInteger(size) ? Math.min(Math.max(size, 1), 4) : 1;
}

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

/** Partidas jugadas: dos espadas cruzadas, el signo universal del enfrentamiento. */
function MatchesIcon({ className }: { className?: string }) {
  return (
    <Glyph className={className}>
      <path d="M4.5 4.5 13.5 13.5" />
      <path d="M19.5 4.5 10.5 13.5" />
      <path d="M11.9 15.1 15.1 11.9" />
      <path d="M8.9 11.9 12.1 15.1" />
      <path d="M13.5 13.5 15.6 15.6" />
      <path d="M10.5 13.5 8.4 15.6" />
    </Glyph>
  );
}

/** Victorias: la copa que se levanta al ganar. */
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

/** Racha: la llama que crece con cada victoria seguida. */
function StreakIcon({ className }: { className?: string }) {
  return (
    <Glyph className={className}>
      <path d="M12 3.5c.5 2.6 2.4 3.8 3.5 5.4a5.3 5.3 0 1 1-8.8 3.2c0-1.8.9-3.2 1.9-4.4.3 1 .8 1.7 1.6 2.1-.4-2.4.2-4.6 1.8-6.3Z" />
    </Glyph>
  );
}

/**
 * Los logros globales de civilización: un escudo con estrella, emblema de haber
 * jugado o ganado con todas ellas. El escudo es el blasón de la liga; la estrella
 * que carga dentro es el distintivo de la gesta completa.
 */
function AllCivsIcon({ className }: { className?: string }) {
  return (
    <Glyph className={className}>
      <path d="M12 3.5 18.5 5.7V10c0 3.9-2.6 6.8-6.5 9.5C8.1 16.8 5.5 13.9 5.5 10V5.7Z" />
      <path
        d="M12 7.5 12.73 9.49 14.85 9.57 13.19 10.89 13.76 12.93 12 11.75 10.24 12.93 10.81 10.89 9.15 9.57 11.27 9.49Z"
        fill="currentColor"
        stroke="none"
      />
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
