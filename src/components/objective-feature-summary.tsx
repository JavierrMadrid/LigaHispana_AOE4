import type { ReactNode } from "react";
import type { ObjectiveOption } from "@/lib/public";
import { ObjectiveIcon } from "@/components/objective-icon";
import { MapPool, ObjectiveStatus } from "@/components/objective-card";
import { prizeLabel } from "@/lib/objective-format";

/**
 * Cara frontal de la tarjeta grande volteable: el resumen de un objetivo en una
 * sola columna centrada alrededor de su emblema.
 *
 * La tarjeta pequeña (`ObjectiveSummary`, `ParticipantObjectiveSummary`) enseña
 * el resumen pegado al borde superior; en la tarjeta grande —con mucho más
 * alto— eso dejaba el centro muerto. Aquí la lectura es vertical, en el orden
 * lógico de la tarjeta: la cabecera abre con el título centrado y su filete, el
 * emblema preside la parte alta del cuerpo con la descripción del objetivo
 * debajo (**qué es**), el avance del jugador con sus puntos (**cómo va**) y, si
 * lo hay, el desglose que ese avance desgrana (**el detalle**); el pie cierra
 * con la puerta a la clasificación. Sin columnas laterales: todo se apila en el
 * eje central, y el cuerpo crece con `flex-1` para empujar el pie al fondo sin
 * bloques flotando.
 *
 * Es solo la composición: cada pantalla monta su variante con sus datos
 * (`ObjectiveFeatureSummary` para `/objetivos`, `ParticipantObjectiveFeatureSummary`
 * para la ficha de un jugador), y `ObjectiveDialogCard` decide cuándo se enseña.
 */

/** Lo mínimo para elegir el emblema de un objetivo y leer su premio. */
export type FeatureTarget = Pick<
  ObjectiveOption,
  "id" | "group" | "metric" | "kind" | "target" | "points"
>;

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
  /** Bajo la descripción, en tamaño menor: el contexto de la regla (la nota de familia y el pool de mapas). */
  detail?: ReactNode;
  /** En la fila sobre el filete, a la izquierda: el estado o el avance. */
  progress: ReactNode;
  /** Bajo el avance y sobre el filete del pie, a todo el ancho: el desglose que lo detalla (civilización a civilización, mapas que faltan). */
  breakdown?: ReactNode;
  actionLabel: string;
};

/**
 * El armazón de la cara frontal: una sola columna centrada. La cabecera abre con
 * el título centrado —más grande que en la tarjeta pequeña— y un filete corto
 * debajo, con el subtítulo y los distintivos en una línea propia. El cuerpo, que
 * crece con `flex-1`, deja el emblema y la descripción **centrados en el aire
 * que sobra**; después va el avance con los puntos en línea a su derecha, el
 * desglose (si lo hay) y el pie, que separa con un filete la puerta a la
 * clasificación. En móvil llena la pantalla y, por debajo del umbral que se
 * cuenta abajo, desplaza sin recortar.
 *
 * ## Una cara que cabe entera y reparte su aire por igual
 *
 * La ventana mide `100dvh` con tope de `44rem` (`ObjectiveFlipDialog`) y esta
 * cara **no debe desplazar**: toda la información se enseña de una vez. El caso
 * que manda es la cabeza de familia en su peor rango —23 civilizaciones por
 * detallar, que son dos filas de chips en `sm` y cuatro en móvil—: esa cara
 * ocupa 595,5px de contenido en `sm` y 617,5px en móvil, y la ventana le deja
 * 684px con el tope (cualquier viewport de 704px o más) y 647px en móvil, así
 * que sobran 88,5px en escritorio y 29,5px en móvil. Con la ventana al mínimo
 * en que la cara sigue cabiendo —616px de alto útil en `sm`, 638px en móvil—
 * no sobra nada.
 *
 * Ese sobrante **no cae entero en un hueco**: el cuerpo centra el bloque
 * «emblema + descripción» con `justify-center`, de modo que el aire que queda
 * entre el filete de la cabecera y el emblema es idéntico al que queda entre la
 * descripción y la primera sección (el avance). Así se leen homogéneas las
 * tarjetas ligeras —en `/objetivos` el sobrante llega a 246px—, que antes se
 * quedaban con el vacío entero de un solo lado. Las dos mitades miden 44,25px
 * en escritorio (con el tope) y 14,75px en móvil; en un 1366×768 con barra del
 * navegador —650px de alto útil, 630px de ventana— quedan 17,25px por lado y
 * la cara sigue sin desplazar. Por debajo de ese umbral ya no cabe y la cara
 * vuelve a desplazar: preferible a recortar el pie.
 *
 * Lo que es aire **entre secciones** no se mueve con el sobrante: es constante
 * —16px del avance al desglose, 24px con la cabecera interna de ese desglose,
 * y 24px del desglose al filete y del filete al pie—, y la X de cerrar reserva
 * los 56px superiores (`pt-14`). Tampoco se tocó ningún tamaño para que quepa:
 * el medallón sigue con sus 72px en móvil y 88px en `sm` (el original de 160px
 * no cabía) y la descripción con la tipografía mayor de la cara.
 *
 * La fila del avance va además **más adentro** que el resto en horizontal (24px
 * del canto en móvil, 48px a partir de `sm`, frente a los 20/32px del armazón):
 * sus dos textos son los extremos de la tarjeta —el estado a la izquierda y los
 * puntos a la derecha— y así no se pegan a la línea. El desglose, en cambio, va
 * al ancho de la cabecera y del cuerpo, que es donde ya viven los chips en el
 * resto de caras. Los demás bloques no se mueven, y el pie, que va centrado,
 * tampoco.
 *
 * El relleno reserva el aire de la X de cerrar, que va dentro de la propia cara
 * (arriba a la derecha) y deja respirar la tarjeta por los cuatro lados, sin que
 * nada toque el borde redondeado.
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
  breakdown,
  actionLabel,
}: ObjectiveFeatureFrameProps) {
  return (
    <div className="flex min-h-full flex-col px-5 pt-14 pb-6 sm:px-8 sm:pb-8">
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
        <span aria-hidden="true" className="mx-auto mt-2 block h-px w-16 bg-accent/40" />
      </header>

      {/* El cuerpo crece hasta llenar el alto de la cara y centra el bloque
          «emblema + descripción» en el aire que le queda: así el hueco de
          arriba —del filete al emblema— y el de abajo —de la descripción a esta
          fila— miden lo mismo, sea cual sea el sobrante. */}
      <div className="flex flex-1 flex-col items-center justify-center">
        <Medallion target={target} />

        <div className="mt-4 w-full min-w-0 max-w-md text-center sm:mt-5">
          <p className="text-base leading-relaxed text-muted sm:text-lg">{description}</p>
          {detail !== undefined ? (
            <div className="mt-4 text-xs leading-relaxed text-muted">{detail}</div>
          ) : null}
        </div>
      </div>

      {/* La fila del estado y los puntos va más adentro que el resto: sus textos son
          los extremos de la tarjeta, así que se separan del filete del marco más que el
          cuerpo (24px del canto en móvil, 48px a partir de `sm`), y el `ml-auto` de los
          puntos mantiene su borde derecho cuando la fila envuelve. Los `gap` y el
          relleno lateral se estrechan en móvil para que los dos extremos quepan en una
          sola línea en una pantalla de 375px: si envuelven, los puntos bajan y la cara
          deja de caber. Sus 16px de pie más los 8px de la cabecera del desglose dejan
          24px fijos sobre los chips; el sobrante del cuerpo, en cambio, no es suyo:
          se reparte por igual entre el filete de la cabecera y esta fila, que es
          donde empieza su sección. El tinte del marco no se mueve. */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 px-1 pb-4 sm:gap-x-4 sm:px-4">
        <div className="min-w-0 sm:flex-1">{progress}</div>
        <div className="ml-auto">
          <FeaturePoints target={target} points={points} tone={pointsTone} />
        </div>
      </div>

      {/* El desglose va al ancho de la cabecera y del cuerpo —donde ya se leen las
          banderas— y con 24px de pie: cierra el avance por abajo y deja el filete del
          pie a su distancia, sea cual sea el alto de la ventana. */}
      {breakdown !== undefined ? (
        <div className="shrink-0 pb-6 text-center">{breakdown}</div>
      ) : null}

      <footer className="flex shrink-0 items-center justify-center border-t border-line pt-6">
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
 * Su diámetro es el de la ficha a pantalla completa: 72px en móvil y 88px a
 * partir de `sm`, con el icono inscrito en la misma proporción de dos tercios
 * del medallón que tenía el de 160px. Es el tamaño que cabe sin desplazar la
 * cara (ver `ObjectiveFeatureFrame`), no una elección estética suelta.
 *
 * El icono va en una ventana cuadrada inscrita en el círculo: así el arte de
 * civilización —cuadrado y a color— entra entero, sin que el recorte circular le
 * corte las esquinas, y el glifo de línea de los demás objetivos queda centrado
 * en la misma caja. El medallón no elige el asset: lo resuelve `ObjectiveIcon`.
 */
function Medallion({ target }: { target: FeatureTarget }) {
  return (
    <div className="relative flex size-18 shrink-0 items-center justify-center rounded-full border border-accent/30 bg-surface-raised sm:size-22">
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-1.5 rounded-full border border-line"
      />
      <span className="relative flex size-11 items-center justify-center sm:size-13">
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
 * casa —oro, o neutra si el objetivo aún no se cobra— y su unidad en pequeño. Van
 * en una sola línea, sin caja, a la derecha del estado. En un objetivo sin tope la
 * cifra es por unidad y la unidad lo dice (`puntos por victoria`), para que no se lea
 * como un premio que el objetivo reparte una vez.
 */
function FeaturePoints({
  target,
  points,
  tone,
}: {
  target: FeatureTarget;
  points: number;
  tone: "accent" | "neutral";
}) {
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
      <span className="text-xs font-medium text-muted">{prizeLabel(target)}</span>
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
