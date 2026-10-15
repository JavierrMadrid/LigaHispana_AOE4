import type { ReactNode } from "react";
import type {
  ObjectiveContender,
  ObjectiveMapGap,
  ObjectiveOption,
} from "@/lib/public";
import { ObjectiveIcon } from "@/components/objective-icon";
import { PlayerAvatar } from "@/components/player-avatar";
import { formatMapPool, hasNoCap, prizeLabel } from "@/lib/objective-format";

/**
 * Tarjeta de un objetivo especial.
 *
 * Se lee como un cartel del premio: arriba el emblema, el nombre y la regla en
 * una frase, con los puntos en juego en una placa a la derecha; debajo, el
 * estado (poseedor único en una competición, cuántos lo han conseguido en un
 * logro, cuántos ya suman en uno sin tope) y la puerta a la clasificación. La
 * lista entera de participantes no vive aquí: se enseña en la ventana que abre la
 * tarjeta (`ObjectiveDialogCard`).
 *
 * Es presentacional: quien la coloca decide el alto —y el `BorderGlow` que le
 * pinta el cromo— y le pone encima el botón que abre la clasificación.
 */

/** Id estable de `por-tierra-y-agua`, que lista el pool de mapas. */
export const POR_TIERRA_ID = "por-tierra-y-agua";

type ObjectiveSummaryProps = {
  option: ObjectiveOption;
  /** Pool de mapas activo, solo para explicar `por-tierra-y-agua`. */
  mapPool?: readonly string[];
  /** Texto de la acción que abre la clasificación ("Ver clasificación", "Ver completados"). */
  actionLabel?: string;
  /**
   * Aclaración de cómo puntúa el conjunto, cuando la tarjeta es la cabeza de una
   * familia (ver `ObjectiveFamilySection`). Sin ella, la tarjeta solo lleva lo
   * del objetivo.
   */
  note?: ReactNode;
};

export function ObjectiveSummary({
  option,
  mapPool = [],
  actionLabel = "Ver clasificación",
  note,
}: ObjectiveSummaryProps) {
  return (
    <div className="flex h-full flex-col p-4">
      <div className="flex items-center gap-3">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-md border border-line bg-surface-raised">
          <ObjectiveIcon option={option} className="size-6 shrink-0" />
        </span>
        <h3 className="min-w-0 flex-1 font-display text-base font-semibold leading-snug text-foreground">
          {option.label}
        </h3>
        <PrizePlate option={option} />
      </div>

      <p className="mt-2 text-sm leading-relaxed text-muted">{option.description}</p>

      {note !== undefined ? (
        <p className="mt-2 text-xs leading-relaxed text-muted">{note}</p>
      ) : null}

      {option.metric === "mapas" && mapPool.length > 0 ? <MapPool maps={mapPool} /> : null}

      <div className="mt-auto flex items-end justify-between gap-4 border-t border-line pt-3">
        <ObjectiveStatus option={option} />
        {/* El icono y el texto acompañan al botón invisible que cubre la tarjeta
            (ver `ObjectiveDialogCard`); el `pointer-events-none` deja que el clic
            lo recoja ese botón. */}
        <span className="pointer-events-none inline-flex shrink-0 items-center gap-1 text-sm font-medium text-accent">
          {actionLabel}
          <Chevron />
        </span>
      </div>
    </div>
  );
}

/** El estado del objetivo: quién lo posee, o cuánta gente lo ha conseguido. */
export function ObjectiveStatus({ option }: { option: ObjectiveOption }) {
  // Un logro sin tope no se "consigue": se cobra con cada unidad de su métrica, y
  // lo que interesa saber es cuánta gente ya suma. Decir "N jugadores lo han
  // conseguido" sería falso (lo están cobrando todos, hoy y mañana).
  if (hasNoCap(option)) {
    return (
      <div className="min-w-0">
        <p className="text-xs font-medium uppercase tracking-wide text-muted">Sin tope</p>
        <p className="mt-1 truncate text-sm text-foreground">
          {option.beneficiaries.length === 0
            ? "Todavía nadie"
            : option.beneficiaries.length === 1
              ? "1 jugador ya cobra"
              : `${option.beneficiaries.length} jugadores ya cobran`}
        </p>
      </div>
    );
  }

  return (
    <div className="min-w-0">
      <p className="text-xs font-medium uppercase tracking-wide text-muted">
        {option.kind === "achievement" ? "Lo han conseguido" : "Poseedor"}
      </p>
      {option.kind === "achievement" ? (
        <p className="mt-1 truncate text-sm text-foreground">
          {option.beneficiaries.length === 0
            ? "Todavía nadie"
            : option.beneficiaries.length === 1
              ? "1 jugador"
              : `${option.beneficiaries.length} jugadores`}
        </p>
      ) : option.holder === null ? (
        <p className="mt-1 truncate text-sm text-muted">Sin poseedor todavía</p>
      ) : (
        <div className="mt-1 flex items-center gap-2">
          <PlayerAvatar
            name={option.holder.name}
            avatarUrl={option.holder.avatarUrl}
            className="size-6 shrink-0 text-xs"
          />
          {/* Sin enlace a propósito: la tarjeta cerrada entera es un botón que
              abre la clasificación, y un enlace por debajo quedaría tapado. El
              perfil se alcanza desde la lista que aparece al voltear. */}
          <span className="truncate text-sm font-medium text-foreground">
            {option.holder.name}
          </span>
        </div>
      )}
    </div>
  );
}

/** Los mapas del pool activo, en el objetivo que exige jugar en cada uno. */
export function MapPool({ maps }: { maps: readonly string[] }) {
  return (
    <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-muted">
      <span className="font-medium text-foreground/90">
        {maps.length === 1 ? "1 mapa" : `${maps.length} mapas`}
      </span>
      {" · "}
      {formatMapPool(maps)}
    </p>
  );
}

/**
 * Lo que le falta a un jugador en `por-tierra-y-agua`: los mapas del pool que no
 * tiene y cuántas partidas le faltan en cada uno, de menos a más.
 *
 * Es la cara **personal** del pool (la de la ficha del jugador): la tarjeta de
 * `/objetivos` lista el pool entero, y aquí lo que se lee es la distancia que le
 * queda. Los mapas ya completados no salen —no hay nada que decir de ellos— y el
 * número de cada uno es lo que le falta, no lo que lleva.
 */
export function MapGaps({ gaps }: { gaps: readonly ObjectiveMapGap[] }) {
  if (gaps.length === 0) {
    return (
      <p className="mt-2 line-clamp-2 text-xs leading-relaxed">
        <span className="font-medium text-foreground/90">Pool completo</span>
        <span className="text-muted"> · los tienes todos</span>
      </p>
    );
  }

  return (
    <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-muted">
      <span className="font-medium text-foreground/90">
        {gaps.length === 1 ? "Falta 1 mapa" : `Faltan ${gaps.length} mapas`}
      </span>
      {" · "}
      {gapList(gaps)}
    </p>
  );
}

/** La lista de huecos, en el mismo registro que `formatMapPool`: coma y un espacio. */
function gapList(gaps: readonly ObjectiveMapGap[]): string {
  return gaps.map((gap) => `${gap.missing} × ${gap.map}`).join(", ");
}

/** La placa del premio: los puntos que reparte el objetivo, a la derecha. */
export function PrizePlate({ option }: { option: ObjectiveOption }) {
  return (
    <span className="shrink-0 rounded-md border border-accent/30 bg-accent/5 px-3 py-1.5 text-right">
      <span className="block font-display text-xl font-semibold leading-none tabular-nums text-accent">
        +{option.points}
      </span>
      {/* En un objetivo sin tope la cifra es por unidad y el pie lo dice; el
          `max-w` mantiene la placa estrecha también con el pie de dos renglones,
          para que no se coma el ancho del título en la tarjeta. */}
      <span className="mt-1 block max-w-[7rem] text-xs font-medium uppercase leading-tight tracking-wide text-muted">
        {prizeLabel(option)}
      </span>
    </span>
  );
}

/**
 * Nombre de un contendiente, enlazado a su perfil de AoE4World cuando la API
 * publicó un id. Sin él se queda en texto, que es más honesto que un enlace
 * roto.
 */
export function ContenderName({
  contender,
  className,
}: {
  contender: ObjectiveContender;
  className: string;
}) {
  if (contender.profileUrl === null) {
    return <span className={`block ${className}`}>{contender.name}</span>;
  }

  return (
    <a
      href={contender.profileUrl}
      target="_blank"
      rel="noopener noreferrer"
      className={`block underline-offset-4 transition-colors hover:text-accent hover:underline ${className}`}
    >
      {contender.name}
      <span className="sr-only"> en AoE4World (se abre en una pestaña nueva)</span>
    </a>
  );
}

/** Por qué el objetivo todavía no lo cobra nadie, con el matiz de cada familia. */
export function emptyMessage(option: ObjectiveOption): string {
  if (hasNoCap(option)) {
    return "Todavía nadie ha ganado una partida clasificatoria.";
  }

  if (option.kind === "achievement") {
    return "Todavía nadie ha completado este logro.";
  }

  switch (option.group) {
    case "civilizacion":
      return "Nadie ha ganado todavía con una civilización fija.";
    case "formato":
      return "Nadie ha ganado todavía en este formato.";
    case "racha":
      return "Nadie ha encadenado todavía una victoria clasificatoria.";
    default:
      return "Todavía no hay partidas clasificatorias jugadas.";
  }
}

/** Por qué un aspirante no cobra todavía el objetivo. */
export function ineligibleTag(option: ObjectiveOption): string {
  return option.kind === "achievement" ? "en camino" : "no disputa";
}

function Chevron() {
  return (
    <svg
      viewBox="0 0 12 12"
      aria-hidden="true"
      className="size-3 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4.5 2.5 8 6l-3.5 3.5" />
    </svg>
  );
}
