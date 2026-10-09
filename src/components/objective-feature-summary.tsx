import type { ReactNode } from "react";
import type { ObjectiveOption } from "@/lib/public";
import { ObjectiveIcon } from "@/components/objective-icon";
import { MapPool, ObjectiveStatus } from "@/components/objective-card";

/**
 * Cara frontal de la tarjeta grande volteable: el resumen de un objetivo en una
 * sola columna centrada alrededor de su emblema.
 *
 * La tarjeta pequeña (`ObjectiveSummary`, `ParticipantObjectiveSummary`) enseña
 * el resumen pegado al borde superior; en la tarjeta grande —con mucho más
 * alto— eso dejaba el centro muerto. Aquí la lectura es vertical: la cabecera
 * abre con el título centrado y su filete, el emblema preside la parte alta del
 * cuerpo con la descripción del objetivo debajo, y el pie cierra con el estado a
 * la izquierda, los puntos en línea a la derecha y, bajo el filete, la puerta a
 * la clasificación. Sin columnas laterales: todo se apila en el eje central, y el
 * cuerpo crece con `flex-1` para empujar el pie al fondo sin bloques flotando.
 *
 * Es solo la composición: cada pantalla monta su variante con sus datos
 * (`ObjectiveFeatureSummary` para `/objetivos`, `ParticipantObjectiveFeatureSummary`
 * para la ficha de un jugador), y `ObjectiveDialogCard` decide cuándo se enseña.
 */

/** Lo mínimo para elegir el emblema de un objetivo. */
export type FeatureTarget = Pick<ObjectiveOption, "id" | "group" | "metric">;

type ObjectiveFeatureFrameProps = {
  target: FeatureTarget;
  title: string;
  /** Línea de contexto bajo el título (grupo, detalle); sin ella no se pinta. */
  subtitle?: ReactNode;
  /** Distintivos en la línea bajo el título (conseguido, podio). */
  badges?: ReactNode;
  points: number;
  /** Puntos en oro (lo normal) o neutros (objetivo aún sin cobrar). */
  pointsTone?: "accent" | "neutral";
  /** Bajo el emblema: la regla del objetivo, con la tipografía mayor del frontal. */
  description: ReactNode;
  /** Bajo la descripción, en tamaño menor: la nota de familia y el pool de mapas. */
  detail?: ReactNode;
  /** En la fila sobre el filete, a la izquierda: el estado o el avance. */
  progress: ReactNode;
  actionLabel: string;
};

/**
 * El armazón de la cara frontal: una sola columna centrada. La cabecera abre con
 * el título centrado —más grande que en la tarjeta pequeña— y un filete corto
 * debajo, con el subtítulo y los distintivos en una línea propia. El cuerpo, que
 * crece con `flex-1`, deja el emblema en su parte alta y la descripción justo
 * debajo; el pie separa con un filete el estado (izquierda) y los puntos en línea
 * (derecha) de la acción, que cierra centrada. En móvil llena la pantalla y
 * desplaza sin recortar.
 *
 * El relleno reserva el aire del botón de cerrar del `Modal` arriba a la derecha
 * y deja respirar la tarjeta por los cuatro lados, sin que nada toque el borde
 * redondeado.
 */
export function ObjectiveFeatureFrame({
  target,
  title,
  subtitle,
  badges,
  points,
  pointsTone = "accent",
  description,
  detail,
  progress,
  actionLabel,
}: ObjectiveFeatureFrameProps) {
  return (
    <div className="flex min-h-full flex-col p-6 pt-14 sm:p-8 sm:pt-16">
      <header className="shrink-0 text-center">
        <h2 className="text-balance font-display text-2xl font-semibold leading-tight text-foreground sm:text-3xl">
          {title}
        </h2>
        {badges !== undefined || subtitle !== undefined ? (
          <div className="mt-2 flex flex-wrap items-center justify-center gap-x-2 gap-y-1">
            {badges}
            {subtitle !== undefined ? (
              <p className="text-xs text-muted">{subtitle}</p>
            ) : null}
          </div>
        ) : null}
        <span aria-hidden="true" className="mx-auto mt-3 block h-px w-16 bg-accent/40" />
      </header>

      <div className="flex flex-1 flex-col items-center pt-10 sm:pt-14">
        <Medallion target={target} />

        <div className="mt-10 w-full min-w-0 max-w-md text-center sm:mt-14">
          <p className="text-base leading-relaxed text-muted sm:text-lg">{description}</p>
          {detail !== undefined ? (
            <div className="mt-3 text-xs leading-relaxed text-muted">{detail}</div>
          ) : null}
        </div>
      </div>

      <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 pb-4">
        <div className="min-w-0 sm:flex-1">{progress}</div>
        <FeaturePoints points={points} tone={pointsTone} />
      </div>

      <footer className="flex shrink-0 items-center justify-center border-t border-line pt-4">
        {/* El clic lo recoge el `FlipCard`; el pie solo anuncia la acción. */}
        <span className="pointer-events-none inline-flex shrink-0 items-center gap-1 text-sm font-medium text-accent">
          {actionLabel}
          <Chevron />
        </span>
      </footer>
    </div>
  );
}

/**
 * El emblema del objetivo, en el centro de la cara frontal: un medallón redondo
 * del mismo tamaño y cromo para todos —relleno elevado y filete dorado, con un
 * aro interior— y el icono dentro.
 *
 * El icono va en una ventana cuadrada inscrita en el círculo: así el arte de
 * civilización —cuadrado y a color— entra entero, sin que el recorte circular le
 * corte las esquinas, y el glifo de línea de los demás objetivos queda centrado
 * en la misma caja. El medallón no elige el asset: lo resuelve `ObjectiveIcon`.
 */
function Medallion({ target }: { target: FeatureTarget }) {
  return (
    <div className="relative flex size-40 shrink-0 items-center justify-center rounded-full border border-accent/30 bg-surface-raised">
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-1.5 rounded-full border border-line"
      />
      <span className="relative flex size-24 items-center justify-center">
        <ObjectiveIcon option={target} className="size-full" />
      </span>
    </div>
  );
}

/**
 * La cara frontal de un objetivo de `/objetivos`: el emblema, el nombre, los
 * puntos, el poseedor o el recuento de completadores, la regla y la puerta a la
 * ventana. Es la misma información que la tarjeta pequeña, en columna centrada.
 */
export function ObjectiveFeatureSummary({
  option,
  mapPool = [],
  actionLabel = "Ver clasificación",
  note,
}: {
  option: ObjectiveOption;
  mapPool?: readonly string[];
  actionLabel?: string;
  note?: ReactNode;
}) {
  return (
    <ObjectiveFeatureFrame
      target={option}
      title={option.label}
      points={option.points}
      description={option.description}
      detail={
        note !== undefined || (option.metric === "mapas" && mapPool.length > 0) ? (
          <>
            {note !== undefined ? (
              <p className="text-xs leading-relaxed text-muted">{note}</p>
            ) : null}
            {option.metric === "mapas" && mapPool.length > 0 ? (
              <MapPool maps={mapPool} />
            ) : null}
          </>
        ) : undefined
      }
      progress={<ObjectiveStatus option={option} />}
      actionLabel={actionLabel}
    />
  );
}

/**
 * Los puntos del objetivo, en línea sobre el filete: la cifra con el peso de la
 * casa —oro, o neutra si el objetivo aún no se cobra— y la palabra «puntos» en
 * pequeño. Van en una sola línea, sin caja, a la derecha del estado.
 */
function FeaturePoints({ points, tone }: { points: number; tone: "accent" | "neutral" }) {
  const accent = tone === "accent";

  return (
    <span className="inline-flex shrink-0 items-center gap-1">
      <span
        className={`font-display text-xl font-semibold leading-none tabular-nums ${
          accent ? "text-accent" : "text-foreground"
        }`}
      >
        +{points}
      </span>
      <span className="text-xs font-medium text-muted">puntos</span>
    </span>
  );
}

/** Flecha del pie, con el mismo trazo que el resto de glifos de la casa. */
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
