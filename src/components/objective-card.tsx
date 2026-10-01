import { CIVILIZATION_IDS } from "@/lib/civs";
import type {
  ObjectiveContender,
  ObjectiveMetric,
  ObjectiveOption,
  ObjectiveView,
} from "@/lib/public";
import { ObjectiveIcon } from "@/components/objective-icon";
import { PlayerAvatar } from "@/components/player-avatar";

/**
 * Tarjeta de un objetivo especial.
 *
 * Se lee como un cartel del premio: arriba el emblema, el nombre y la regla en
 * una frase, con los puntos en juego en una placa a la derecha; debajo, quién
 * lo posee (o por qué está vacante). El top de contendientes ya no vive aquí:
 * la lista entera se enseña en el diálogo de `ObjectiveRankingDialog`, así que
 * la tarjeta se escanea de un vistazo. El pie es la puerta a esa clasificación.
 */
type ObjectiveCardProps = {
  option: ObjectiveOption;
  /** Abre la clasificación completa del objetivo. */
  onOpen: () => void;
};

export function ObjectiveCard({
  option,
  onOpen,
}: ObjectiveCardProps) {
  const held = option.holder !== null;

  return (
    // `min-w-0`: como ítem de la rejilla, el ancho mínimo por defecto es
    // `auto`, o sea su min-content, y ese lo fija el pie (poseedor + botón
    // "Ver clasificación"). Con nombres largos la tarjeta mide más que la
    // columna y desborda la página en móvil estrecho; con `min-w-0` el pie
    // cede y su nombre se recorta donde ya lo hace.
    <article
      className={`flex h-full min-w-0 flex-col rounded-lg border bg-surface p-5 ${
        held ? "border-accent/35" : "border-line"
      }`}
    >
      <div className="flex items-center gap-4">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-md border border-line bg-surface-raised">
          <ObjectiveIcon option={option} className="size-6 shrink-0" />
        </span>
        <h3 className="min-w-0 flex-1 font-display text-base font-semibold leading-snug text-foreground">
          {option.label}
        </h3>
        <PrizePlate points={option.points} />
      </div>

      <p className="mt-3 pb-6 text-sm leading-relaxed text-muted">{option.description}</p>

      {/*
        Pie en una sola línea bajo un filete fino: a la izquierda el poseedor
        (rótulo pequeño y debajo el nombre), a la derecha el enlace a la
        clasificación. El valor de la métrica y el motivo de vacante viven en
        el diálogo, no aquí.
      */}
      <div className="mt-auto flex items-end justify-between gap-4 border-t border-line pt-4">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">Poseedor</p>
          {option.holder === null ? (
            <p className="mt-1 truncate text-sm text-muted">Sin poseedor todavía</p>
          ) : (
            <div className="mt-1 flex items-center gap-2">
              <PlayerAvatar
                name={option.holder.name}
                avatarUrl={option.holder.avatarUrl}
                className="size-6 shrink-0 text-xs"
              />
              <ContenderName
                contender={option.holder}
                className="truncate text-sm font-medium text-foreground"
              />
            </div>
          )}
        </div>
        {/* El relleno vertical amplía el área de pulsación hasta los 44 px del
            mínimo táctil sin engordar el texto: los márgenes negativos lo
            compensan para que la fila del pie no crezca. */}
        <button
          type="button"
          onClick={onOpen}
          className="-my-3 shrink-0 py-3 text-sm font-medium text-accent underline-offset-4 transition-colors hover:underline focus-visible:underline"
        >
          Ver clasificación
        </button>
      </div>
    </article>
  );
}

/** La placa del premio: los puntos que reparte el objetivo, a la derecha. */
function PrizePlate({ points }: { points: number }) {
  return (
    <span className="shrink-0 rounded-md border border-accent/30 bg-accent/5 px-3 py-1.5 text-right">
      <span className="block font-display text-xl font-semibold leading-none tabular-nums text-accent">
        +{points}
      </span>
      <span className="mt-1 block text-xs font-medium uppercase tracking-wide text-muted">
        puntos
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

/**
 * Valor de la métrica de un contendiente, en la unidad que se lee de un vistazo.
 *
 * En `masterizarlos-a-todos` el valor no son victorias sino **civilizaciones
 * dominadas** del catálogo, así que se ramifica por id y no por métrica: añadir
 * un miembro a `ObjectiveMetric` rompería el `switch` exhaustivo de
 * `formatValue`.
 */
export function contenderValue(
  option: ObjectiveOption,
  contender: ObjectiveContender,
  masterizarTodosId: string,
): string {
  if (option.id === masterizarTodosId) {
    return `${contender.value}/${CIVILIZATION_IDS.length} civilizaciones`;
  }

  return formatValue(option.metric, contender);
}

/**
 * Valor de la métrica del objetivo, en la unidad que se lee de un vistazo.
 * En `winrate` el valor son victorias de `matches` partidas, así que se pinta
 * el récord completo con su porcentaje.
 */
export function formatValue(metric: ObjectiveMetric, contender: ObjectiveContender): string {
  const { value, matches } = contender;

  switch (metric) {
    case "partidas":
      return value === 1 ? "1 partida" : `${value} partidas`;
    case "racha":
      return value === 1 ? "1 victoria seguida" : `${value} victorias seguidas`;
    case "victorias":
      return value === 1 ? "1 victoria" : `${value} victorias`;
    case "winrate": {
      if (matches <= 0) {
        return "-";
      }

      const losses = matches - value;
      const percentage = Math.round((value / matches) * 100);

      // Espacio duro antes del signo: en español el «%» no se separa de su cifra.
      return `${value}-${losses} (${percentage}\u00A0%)`;
    }
  }
}

/** Por qué el objetivo está vacante, con el matiz de cada familia. */
export function emptyMessage(
  option: ObjectiveOption,
  minimums: ObjectiveView["minimums"],
  masterizarTodosId: string,
): string {
  if (option.id === masterizarTodosId) {
    return "Carrera abierta: nadie ha ganado todavía con las 23 civilizaciones.";
  }

  if (option.group === "civilizacion") {
    return `Carrera abierta: nadie ha llegado a ${minimums.masterizar} victorias con esta civilización todavía.`;
  }

  if (option.metric === "winrate" || option.metric === "racha") {
    const minimo = option.metric === "winrate" ? minimums.winrate : minimums.streak;

    return option.ranking.length === 0
      ? "Sin candidatos todavía: nadie ha jugado una partida clasificatoria."
      : `Nadie cumple el mínimo de ${minimo} partidas clasificatorias.`;
  }

  switch (option.group) {
    case "division":
      return "Nadie de esta división ha ganado una partida todavía.";
    case "formato":
      return "Nadie ha ganado todavía en este formato.";
    default:
      return option.metric === "victorias"
        ? "Nadie ha ganado todavía con una civilización fija."
        : "Todavía no hay partidas clasificatorias jugadas.";
  }
}

/** Por qué un aspirante no puede cobrar todavía el objetivo. */
export function ineligibleTag(option: ObjectiveOption): string {
  return option.group === "civilizacion" ? "en camino" : "no llega al mínimo";
}
