import type { ObjectiveContender, ObjectiveMetric, ObjectiveOption } from "@/lib/public";
import { ObjectiveIcon } from "@/components/objective-icon";

/**
 * Tarjeta de un objetivo especial.
 *
 * El objetivo no es un premio: es un puesto de la clasificación que se cobra al
 * instante, así que la tarjeta se lee de arriba abajo como un marcador: qué se
 * juega y cuánto vale, quién lo tiene (o por qué está vacante) y quién va
 * detrás. A la izquierda del título va el icono que identifica el objetivo
 * (emblema de liga, civilización o glifo de grupo).
 */
export function ObjectiveCard({ option }: { option: ObjectiveOption }) {
  const chasers = option.ranking.filter(
    (contender) => contender.profileId !== option.holder?.profileId,
  );

  return (
    <article
      className={`flex h-full flex-col rounded-lg border bg-surface p-4 ${
        option.holder === null ? "border-line" : "border-accent/30"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <h3 className="flex min-w-0 items-center gap-2 font-semibold text-foreground">
          <ObjectiveIcon option={option} />
          <span className="min-w-0">{option.label}</span>
        </h3>
        <span className="shrink-0 rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-xs font-semibold tabular-nums text-accent">
          +{option.points}
          <span className="sr-only"> puntos</span>
        </span>
      </div>

      {option.holder === null ? (
        <p className="mt-3 rounded-md border border-dashed border-line bg-surface-raised/40 p-3 text-sm leading-relaxed text-muted">
          {emptyMessage(option)}
        </p>
      ) : (
        <div className="mt-3 flex items-center gap-3 rounded-md border border-accent/25 bg-accent/5 p-3">
          <ContenderAvatar contender={option.holder} className="size-9 text-xs" />
          <div className="min-w-0 flex-1">
            <a
              href={`https://aoe4world.com/players/${option.holder.profileId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="block truncate font-medium text-foreground underline-offset-4 hover:text-accent hover:underline"
            >
              {option.holder.name}
              <span className="sr-only"> en AoE4World (se abre en una pestaña nueva)</span>
            </a>
            <p className="mt-0.5 text-xs tabular-nums text-accent">
              {formatValue(option.metric, option.holder)}
            </p>
          </div>
          <span className="shrink-0 rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-semibold text-accent">
            Poseedor
          </span>
        </div>
      )}

      {chasers.length === 0 ? null : (
        <div className="mt-4 border-t border-line pt-3">
          <p className="text-xs text-muted">{chasersHeading(option)}</p>
          <ol className="mt-2 flex flex-col gap-2">
            {chasers.map((contender) => (
              <li key={contender.profileId} className="flex items-center gap-2 text-sm">
                <span
                  aria-hidden="true"
                  className="w-4 shrink-0 text-center text-xs tabular-nums text-muted"
                >
                  {option.ranking.indexOf(contender) + 1}
                </span>
                <ContenderAvatar contender={contender} className="size-6 text-[10px]" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-foreground/90">{contender.name}</span>
                  {contender.eligible ? null : (
                    <span className="block text-[11px] text-muted">
                      {ineligibleTag(option)}
                    </span>
                  )}
                </span>
                <span className="shrink-0 text-xs tabular-nums text-muted">
                  {formatValue(option.metric, contender)}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </article>
  );
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
function emptyMessage(option: ObjectiveOption): string {
  if (option.group === "civilizacion") {
    return "Carrera abierta: nadie ha llegado a 10 victorias con esta civilización todavía.";
  }

  if (option.metric === "winrate" || option.metric === "racha") {
    return option.ranking.length === 0
      ? "Sin candidatos todavía: nadie ha jugado una partida clasificatoria."
      : "Nadie cumple el mínimo de 10 partidas clasificatorias.";
  }

  switch (option.group) {
    case "division":
      return "Aún sin poseedor: nadie de esta división ha ganado una partida todavía.";
    case "formato":
      return "Aún sin poseedor: nadie ha ganado todavía en este formato.";
    default:
      return option.metric === "victorias"
        ? "Aún sin poseedor: nadie ha ganado todavía con una civilización fija."
        : "Aún sin poseedor: todavía no hay partidas clasificatorias jugadas.";
  }
}

/** Rótulo de la lista de aspirantes, según haya poseedor o no. */
function chasersHeading(option: ObjectiveOption): string {
  if (option.holder !== null) {
    return "Persiguen el objetivo";
  }

  return option.group === "civilizacion" ? "En carrera" : "Mejores aspirantes";
}

/** Por qué un aspirante no puede cobrar todavía el objetivo. */
function ineligibleTag(option: ObjectiveOption): string {
  return option.group === "civilizacion" ? "en camino" : "no llega al mínimo";
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word.charAt(0))
    .join("")
    .toUpperCase();
}

function ContenderAvatar({
  contender,
  className,
}: {
  contender: ObjectiveContender;
  className: string;
}) {
  if (contender.avatarUrl === null) {
    return (
      <span
        aria-hidden="true"
        className={`${className} flex shrink-0 items-center justify-center rounded-md border border-line bg-surface-raised font-semibold text-muted`}
      >
        {initials(contender.name)}
      </span>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- los avatares vienen de AoE4World (o como data: en el mock); next/image exigiría declarar el host remoto.
    <img
      src={contender.avatarUrl}
      alt=""
      loading="lazy"
      decoding="async"
      className={`${className} shrink-0 rounded-md border border-line bg-surface-raised object-cover`}
    />
  );
}
