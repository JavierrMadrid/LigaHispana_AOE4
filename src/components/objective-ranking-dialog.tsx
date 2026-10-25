"use client";

import { useState, type ReactNode } from "react";
import type {
  ObjectiveContender,
  ObjectiveOption,
  ParticipantObjective,
} from "@/lib/public";
import {
  completedContenders,
  contenderShareOfObjective,
  contenderValue,
  hasNoCap,
  hasReachedTarget,
  prizeLabel,
  standingsCountLabel,
} from "@/lib/objective-format";
import {
  ContenderName,
  emptyMessage,
  ineligibleTag,
  MapGaps,
} from "@/components/objective-card";
import { FamilyCivDetail } from "@/components/objective-family-detail";
import { ObjectiveFlipDialog } from "@/components/objective-flip-dialog";
import { ObjectiveIcon } from "@/components/objective-icon";
import { PlayerAvatar } from "@/components/player-avatar";

/** Contendientes por página. La lista entera llega ya ordenada del servidor. */
const PAGE_SIZE = 10;

type ObjectiveRankingDialogProps = {
  option: ObjectiveOption;
  /**
   * Participante de la ficha que abrió la ventana: su fila lleva la etiqueta
   * «Tú» y su detalle de mapas encabeza la lista. Sin él (`null`/`undefined`)
   * no se marca a nadie; hoy la única pantalla que la monta es la ficha de un
   * participante, que siempre lo pasa.
   */
  highlightProfileId?: number | null;
  /**
   * Hijos de la familia si el objetivo abierto es su cabeza (`polifacetico`,
   * `jugon`): con ellos y con jugador resaltado, la cara de clasificación enseña
   * el avance por civilización de ese jugador. Sin ellos —la clasificación
   * general, que se abre sin ficha de jugador— no se pinta nada.
   */
  familyChildren?: readonly ParticipantObjective[];
  /** Cara frontal de la tarjeta: el resumen del avance del jugador. */
  front: ReactNode;
  onClose: () => void;
};

/**
 * Clasificación completa de un objetivo, en una tarjeta volteable.
 *
 * El `ranking` llega entero (puede tener decenas de filas), así que aquí solo
 * se pagina, 10 por página, con el rango "X–Y de N". La ventana se abre en la
 * cara de la clasificación y el giro descubre el resumen del jugador (`front`).
 * El `Modal` que la envuelve resuelve foco, `Esc`, cierre con clic en el fondo,
 * bloqueo del scroll y devolución del foco al disparador.
 *
 * La cara lleva el **marco** de la tarjeta a 10 y 16px del canto
 * (`ObjectiveFlipDialog`), así que nada pintado lo cruza: la cabecera, el pie del
 * paginador y la lista van con **márgenes** laterales y no con relleno, y el de las
 * filas vive en la lista. Así las líneas de cabecera y pie, los filetes de las filas
 * y la barra de avance empiezan y acaban donde el texto (24px del canto
 * en móvil, 32px a partir de `sm`), sin moverse de donde ya estaban.
 *
 * ## La barra de fondo de cada fila
 *
 * El mismo tratamiento que la clasificación de `/objetivos`
 * (`ObjectiveStandings`): fondo del tramo que va del canto del contenido a la
 * columna de la cifra, con el mismo aire a los dos lados (12px, el `gap` de la
 * fila), para no pasar por debajo del número. **Qué mide depende del objetivo**
 * (`contenderShareOfObjective`): en un logro con tope, el avance sobre su
 * umbral; en una competición o en un logro sin tope, la distancia al **líder de
 * la lista**, que es la primera entrada de `option.ranking`. Es decorativa: la
 * cifra real la escribe la fila.
 *
 * ## El detalle de mapas del jugador
 *
 * En `por-tierra-y-agua`, lo que le falta al jugador de la ficha encabeza el
 * scroll, **entre la cabecera y la lista**: es información suya, así que va
 * antes que la clasificación neutra, y en su sitio —y no dentro de su fila—
 * porque la paginación puede dejar al jugador fuera de la primera página.
 *
 * ## El detalle por civilización
 *
 * En `polifacetico` y `jugon` ocupa ese mismo sitio el avance del jugador en
 * cada civilización, con la lista más corta de las dos —las hechas o las que
 * quedan—. No puede salir del ranking, porque los `lider-<civ>`/`acolito-<civ>`
 * son objetivos aparte: la ficha los pasa por prop (`familyChildren`), y sin
 * ellos —una ventana abierta sin ficha de jugador— no se pinta.
 */
export function ObjectiveRankingDialog({
  option,
  highlightProfileId = null,
  familyChildren,
  front,
  onClose,
}: ObjectiveRankingDialogProps) {
  const [page, setPage] = useState(0);

  const total = option.ranking.length;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const start = page * PAGE_SIZE;
  const rows = option.ranking.slice(start, start + PAGE_SIZE);
  // El primero de la lista ya ordenada es el más avanzado. Su valor es la escala de
  // la barra donde no hay umbral contra el que medir (competición y logro sin tope);
  // en un logro con tope la barra se mide contra su umbral y esto no se usa.
  const leader = option.ranking[0]?.value ?? 0;
  // Los mapas que le faltan al jugador de la ficha salen de su entrada en el propio
  // ranking, que es la misma que pinta la lista: `mapGaps` solo lo publica el
  // objetivo de mapas y solo para quien aparece en él.
  const yours =
    highlightProfileId === null
      ? null
      : (option.ranking.find((contender) => contender.profileId === highlightProfileId) ?? null);
  const yourGaps =
    option.metric === "mapas" ? (yours?.mapGaps ?? null) : null;

  return (
    <ObjectiveFlipDialog
      onClose={onClose}
      ariaLabel={`Clasificación de ${option.label}`}
      cardLabel={option.label}
      closeLabel="Cerrar la clasificación"
      front={front}
      back={
        <div className="flex h-full flex-col">
          {/* `pt-14`/`sm:pt-16` le dejan sitio a la X de la cara, que vive en la
              esquina superior derecha de la tarjeta, por encima del relleno. El
              relleno lateral va como margen para que la línea de debajo no cruce el
              marco de la tarjeta. */}
          <header className="mx-6 border-b border-line pt-14 pb-6 sm:mx-8 sm:pt-16 sm:pb-8">
            <div className="flex items-start gap-4">
              <span className="flex size-12 shrink-0 items-center justify-center rounded-md border border-line bg-surface-raised">
                <ObjectiveIcon option={option} className="size-7 shrink-0" />
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="font-display text-lg font-semibold leading-snug text-foreground sm:text-xl">
                  {option.label}
                </h2>
                <p className="mt-1 text-sm leading-relaxed text-muted">
                  {option.description}
                </p>
              </div>
            </div>

            {/* Las dos cajas se igualan en alto —la placa crece hasta la del
                aviso para que sus bordes superior e inferior concorden—; en
                móvil, apiladas, cada una sigue midiendo lo suyo. */}
            <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-stretch">
              <HolderSummary option={option} />
              <PrizePlate option={option} />
            </div>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {/* El detalle de mapas va con margen propio, pegado a la línea de la
                cabecera y cerrando con filete: lo que le falta al jugador se lee
                antes que la clasificación, esté o no su fila en esta página. */}
            {yourGaps !== null ? (
              <div className="mx-6 border-b border-line pb-4 sm:mx-8">
                <p className="text-xs font-medium uppercase tracking-wide text-muted">
                  Tus mapas
                </p>
                <MapGaps gaps={yourGaps} />
              </div>
            ) : null}

            {/* El avance por civilización de un logro de familia, en el mismo
                sitio que el de mapas: lo del jugador, antes que la clasificación
                neutra. Los hijos no los lleva el ranking, así que van por prop. */}
            {familyChildren !== undefined &&
            familyChildren.length > 0 &&
            highlightProfileId !== null ? (
              <div className="mx-6 border-b border-line pb-4 sm:mx-8">
                <p className="text-xs font-medium uppercase tracking-wide text-muted">
                  Tus civilizaciones
                </p>
                <FamilyCivDetail items={familyChildren} />
              </div>
            ) : null}

            <div className="mx-6 flex items-baseline justify-between gap-3 py-3 sm:mx-8">
              <h3 className="font-display text-base font-semibold text-foreground">
                Clasificación
              </h3>
              <span className="text-xs tabular-nums text-muted">
                {standingsCountLabel(option, total)}
              </span>
            </div>

            {total === 0 ? (
              <p className="mx-6 border-t border-line py-8 text-center text-sm text-muted sm:mx-8">
                {emptyMessage(option)}
              </p>
            ) : (
              <ol className="mx-6 divide-y divide-line border-t border-line sm:mx-8">
                {rows.map((contender, index) => (
                  <RankingRow
                    key={contender.profileId}
                    option={option}
                    contender={contender}
                    rank={start + index + 1}
                    highlightProfileId={highlightProfileId}
                    leader={leader}
                  />
                ))}
              </ol>
            )}
          </div>

          {total > PAGE_SIZE ? (
            <footer className="mx-6 flex items-center justify-between gap-3 border-t border-line py-3 sm:mx-8">
              <PagerButton
                label="Anterior"
                disabled={page === 0}
                onClick={() => setPage((current) => current - 1)}
              />
              <span className="text-xs tabular-nums text-muted">
                {`${start + 1}–${Math.min(start + PAGE_SIZE, total)} de ${total}`}
              </span>
              <PagerButton
                label="Siguiente"
                disabled={page >= pageCount - 1}
                onClick={() => setPage((current) => current + 1)}
              />
            </footer>
          ) : null}
        </div>
      }
    />
  );
}

/** El poseedor actual en grande, el recuento de un logro, o por qué está libre. */
function HolderSummary({ option }: { option: ObjectiveOption }) {
  if (option.kind === "achievement") {
    // Un logro sin tope no se "consigue": se cobra con cada victoria, así que lo que
    // se cuenta es cuánta gente ya cobra. En los demás, el recuento es de quien ha
    // **llegado al umbral**, no de quien ha rascado puntos: `imparable` paga desde el
    // primer día y decir "9 jugadores lo han conseguido" con tres días de catorce
    // sería mentira. El distintivo de la derecha dice la regla en dos palabras.
    const noCap = hasNoCap(option);
    const count = noCap ? option.beneficiaries.length : completedContenders(option);

    return (
      <div className="flex items-center gap-3 rounded-md border border-accent/25 bg-accent/5 p-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">
            {noCap
              ? count === 1
                ? "1 jugador ya cobra"
                : `${count} jugadores ya cobran`
              : count === 0
                ? "Todavía nadie lo ha conseguido"
                : count === 1
                  ? "1 jugador lo ha conseguido"
                  : `${count} jugadores lo han conseguido`}
          </p>
          <p className="mt-0.5 text-xs leading-relaxed text-muted">{option.description}</p>
        </div>
        <span className="shrink-0 rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-xs font-semibold text-accent">
          {noCap ? "Sin tope" : "Logro"}
        </span>
      </div>
    );
  }

  if (option.holder === null) {
    return (
      <div className="rounded-md border border-dashed border-line bg-surface-raised/40 p-3">
        <p className="text-sm font-medium text-foreground/90">Sin poseedor todavía</p>
        <p className="mt-1 text-xs leading-relaxed text-muted">{emptyMessage(option)}</p>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 rounded-md border border-accent/25 bg-accent/5 p-3">
      <PlayerAvatar name={option.holder.name} avatarUrl={option.holder.avatarUrl} className="size-10 text-xs" />
      <div className="min-w-0 flex-1">
        <ContenderName
          contender={option.holder}
          className="truncate text-sm font-medium text-foreground"
        />
        <p className="mt-0.5 text-xs tabular-nums text-accent">
          {contenderValue(option, option.holder)}
        </p>
      </div>
      <span className="shrink-0 rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-xs font-semibold text-accent">
        Poseedor
      </span>
    </div>
  );
}

/**
 * Una fila del listado: posición, avatar, nombre, el valor de la métrica y la
 * barra de avance que hay detrás.
 *
 * La fila no se tiñe: al jugador de la ficha lo marca la etiqueta «Tú», que se
 * ve sin fondo y no compite con la barra. El tinte de `bg-accent/5` era del
 * catálogo —allí marca a quien ya ha completado el objetivo— y esta ventana solo
 * se abre desde la ficha, donde el sombreado esconde la barra.
 */
function RankingRow({
  option,
  contender,
  rank,
  highlightProfileId,
  leader,
}: {
  option: ObjectiveOption;
  contender: ObjectiveContender;
  rank: number;
  highlightProfileId: number | null;
  /**
   * Valor del primero de la lista: la escala de la barra donde no hay umbral
   * (competición o logro sin tope). Ver `contenderShareOfObjective`.
   */
  leader: number;
}) {
  // En una competición el distintivo es del poseedor; en un logro, de quien ha
  // **llegado a su umbral** —no de quien cobra algo: `imparable` paga desde el primer
  // día—. Un logro sin tope no tiene distintivo: todos los que salen en la lista ya
  // suman y ninguno lo completa.
  const completed =
    option.kind === "achievement"
      ? hasReachedTarget(option, contender.value)
      : contender.profileId === option.holder?.profileId;
  const you = highlightProfileId !== null && contender.profileId === highlightProfileId;
  const share = contenderShareOfObjective(option, contender, leader);

  return (
    <li className="flex items-center gap-3 py-3">
      {/* La barra es fondo del tramo que va del canto del contenido a la cifra, con
          el mismo aire a los dos lados (el `gap` de la fila, 12px): arranca un pelo
          dentro del contenido y el 100 % acaba antes de la columna del número. Va
          detrás de puesto, avatar, nombre, etiqueta y distintivo —por eso el
          envoltorio la aísla, y el `-z-10` la deja por debajo de todo lo suyo— y es
          decorativa. */}
      <div className="relative isolate flex min-w-0 flex-1 items-center gap-3">
        {share > 0 ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 left-3 right-0 -z-10"
          >
            <span
              className="absolute inset-y-0 left-0 bg-accent/10"
              style={{ width: `${share * 100}%` }}
            />
          </span>
        ) : null}

        <span className="w-6 shrink-0 text-right text-sm tabular-nums text-muted">{rank}</span>
        <PlayerAvatar name={contender.name} avatarUrl={contender.avatarUrl} className="size-8 text-xs" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <ContenderName
              contender={contender}
              className="w-fit min-w-0 max-w-full truncate text-sm text-foreground/90"
            />
            {you ? <YouBadge /> : null}
          </span>
          {!completed && option.kind === "competition" ? (
            <span className="mt-0.5 block text-xs text-muted">{ineligibleTag(option)}</span>
          ) : null}
        </span>

        {completed && !hasNoCap(option) ? (
          <span className="shrink-0 rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-xs font-semibold text-accent">
            {option.kind === "achievement" ? "Conseguido" : "Poseedor"}
          </span>
        ) : null}
      </div>

      <span className="shrink-0 text-sm tabular-nums text-foreground/90">
        {contenderValue(option, contender)}
      </span>
    </li>
  );
}

/**
 * La etiqueta visible de la fila del jugador de la ficha, junto a su nombre.
 *
 * Sustituye al `sr-only` de antes: el «Tú» es texto que se lee y además es lo
 * que hace findable la fila ahora que no lleva tinte. Mismo cromo que los
 * distintivos de la casa (`Poseedor`, `Conseguido`) para que se lea como una
 * marca de la lista y no como un texto suelto.
 */
function YouBadge() {
  return (
    <span className="inline-flex shrink-0 items-center rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-xs font-semibold text-accent">
      Tú
    </span>
  );
}

/**
 * La misma placa de premio de la tarjeta, en tamaño grande.
 *
 * La caja crece hasta el alto de la de al lado —el aviso o el poseedor— para que
 * los dos bordes concorden, y su contenido va centrado dentro: la cifra no se
 * quedaría colgada a media altura.
 */
function PrizePlate({ option }: { option: ObjectiveOption }) {
  return (
    <span className="flex flex-col justify-center justify-self-start rounded-md border border-accent/30 bg-accent/5 px-4 py-2 text-right sm:justify-self-end">
      <span className="block font-display text-2xl font-semibold leading-none tabular-nums text-accent">
        +{option.points}
      </span>
      <span className="mt-1 block text-xs font-medium uppercase leading-tight tracking-wide text-muted">
        {prizeLabel(option)}
      </span>
    </span>
  );
}

function PagerButton({
  label,
  disabled,
  onClick,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-9 items-center rounded-md border border-line px-3 text-sm font-medium text-foreground transition-colors enabled:hover:bg-surface-raised disabled:opacity-40"
    >
      {label}
    </button>
  );
}
