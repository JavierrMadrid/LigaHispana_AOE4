"use client";

import { useState, type ReactNode } from "react";
import type { ObjectiveContender, ObjectiveOption } from "@/lib/public";
import {
  completedContenders,
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
} from "@/components/objective-card";
import { ObjectiveFlipDialog } from "@/components/objective-flip-dialog";
import { ObjectiveIcon } from "@/components/objective-icon";
import { PlayerAvatar } from "@/components/player-avatar";

/** Contendientes por página. La lista entera llega ya ordenada del servidor. */
const PAGE_SIZE = 10;

type ObjectiveRankingDialogProps = {
  option: ObjectiveOption;
  /**
   * Participante a resaltar en la lista, para las vistas que abren el diálogo
   * desde la ficha de un jugador concreto. Sin él (`null`/`undefined`), el
   * resaltado recae en el poseedor, que es el comportamiento de `/objetivos`.
   */
  highlightProfileId?: number | null;
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
 * y el tinte del jugador resaltado empiezan y acaban donde el texto (24px del canto
 * en móvil, 32px a partir de `sm`), sin moverse de donde ya estaban.
 */
export function ObjectiveRankingDialog({
  option,
  highlightProfileId = null,
  front,
  onClose,
}: ObjectiveRankingDialogProps) {
  const [page, setPage] = useState(0);

  const total = option.ranking.length;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const start = page * PAGE_SIZE;
  const rows = option.ranking.slice(start, start + PAGE_SIZE);

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

            <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
              <HolderSummary option={option} />
              <PrizePlate option={option} />
            </div>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto">
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

/** Una fila del listado: posición, avatar, nombre y el valor de la métrica. */
function RankingRow({
  option,
  contender,
  rank,
  highlightProfileId,
}: {
  option: ObjectiveOption;
  contender: ObjectiveContender;
  rank: number;
  highlightProfileId: number | null;
}) {
  // En una competición el distintivo es del poseedor; en un logro, de quien ha
  // **llegado a su umbral** —no de quien cobra algo: `imparable` paga desde el primer
  // día—. Un logro sin tope no tiene distintivo: todos los que salen en la lista ya
  // suman y ninguno lo completa.
  const completed =
    option.kind === "achievement"
      ? hasReachedTarget(option, contender.value)
      : contender.profileId === option.holder?.profileId;
  // Sin participante que resaltar (el caso de `/objetivos`) manda el cobrador;
  // con él, el resaltado se muda a su fila. La etiqueta no depende de esto.
  const highlighted =
    highlightProfileId === null ? completed : contender.profileId === highlightProfileId;

  return (
    <li className={`flex items-center gap-3 py-3 ${highlighted ? "bg-accent/5" : ""}`}>
      <span className="w-6 shrink-0 text-right text-sm tabular-nums text-muted">{rank}</span>
      <PlayerAvatar name={contender.name} avatarUrl={contender.avatarUrl} className="size-8 text-xs" />
      <span className="min-w-0 flex-1">
        <ContenderName
          contender={contender}
          className="w-fit max-w-full truncate text-sm text-foreground/90"
        />
        {highlighted ? (
          <span className="sr-only">(jugador de esta ficha)</span>
        ) : null}
        {!completed && option.kind === "competition" ? (
          <span className="mt-0.5 block text-xs text-muted">{ineligibleTag(option)}</span>
        ) : null}
      </span>

      {completed && !hasNoCap(option) ? (
        <span className="shrink-0 rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-xs font-semibold text-accent">
          {option.kind === "achievement" ? "Conseguido" : "Poseedor"}
        </span>
      ) : null}

      <span className="shrink-0 text-sm tabular-nums text-foreground/90">
        {contenderValue(option, contender)}
      </span>
    </li>
  );
}

/** La misma placa de premio de la tarjeta, en tamaño grande. */
function PrizePlate({ option }: { option: ObjectiveOption }) {
  return (
    <span className="justify-self-start rounded-md border border-accent/30 bg-accent/5 px-4 py-2 text-right sm:justify-self-end">
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
