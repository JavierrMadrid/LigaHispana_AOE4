"use client";

import { useId, useState } from "react";
import type { ObjectiveContender, ObjectiveOption } from "@/lib/public";
import { contenderValue } from "@/lib/objective-format";
import {
  ContenderName,
  emptyMessage,
  ineligibleTag,
} from "@/components/objective-card";
import { ObjectiveIcon } from "@/components/objective-icon";
import { PlayerAvatar } from "@/components/player-avatar";
import { Modal } from "@/components/modal";

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
  onClose: () => void;
};

/**
 * Clasificación completa de un objetivo, en una ventana emergente.
 *
 * El `ranking` llega entero (puede tener decenas de filas), así que aquí solo
 * se pagina, 10 por página, con el rango "X–Y de N". Se monta sobre `Modal`,
 * que resuelve la mecánica común de la capa: trampa de foco, `Esc`, cierre con
 * clic en el fondo, bloqueo del scroll y devolución del foco al disparador. En
 * móvil ocupa la pantalla completa; a partir de `sm` es una tarjeta centrada
 * con el cuerpo desplazable.
 */
export function ObjectiveRankingDialog({
  option,
  highlightProfileId = null,
  onClose,
}: ObjectiveRankingDialogProps) {
  const [page, setPage] = useState(0);
  const idPrefix = useId();
  const titleId = `${idPrefix}-title`;
  const descriptionId = `${idPrefix}-description`;

  const total = option.ranking.length;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const start = page * PAGE_SIZE;
  const rows = option.ranking.slice(start, start + PAGE_SIZE);

  return (
    <Modal
      open
      onClose={onClose}
      labelledBy={titleId}
      describedBy={descriptionId}
      closeLabel="Cerrar la clasificación"
      className="animate-dialog-in m-0 flex h-dvh max-h-none w-full max-w-none flex-col overflow-hidden rounded-none border-0 bg-surface p-0 outline-none motion-reduce:animate-none sm:m-auto sm:h-auto sm:max-h-[85vh] sm:max-w-2xl sm:rounded-lg sm:border sm:border-line"
    >
      <header className="border-b border-line p-4 pr-14 sm:p-6 sm:pr-16">
        <div className="flex items-start gap-4">
          <span className="flex size-12 shrink-0 items-center justify-center rounded-md border border-line bg-surface-raised">
            <ObjectiveIcon option={option} className="size-7 shrink-0" />
          </span>
          <div className="min-w-0 flex-1">
            <h2
              id={titleId}
              className="font-display text-lg font-semibold leading-snug text-foreground sm:text-xl"
            >
              {option.label}
            </h2>
            <p id={descriptionId} className="mt-1 text-sm leading-relaxed text-muted">
              {option.description}
            </p>
          </div>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
          <HolderSummary option={option} />
          <PrizePlate points={option.points} />
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex items-baseline justify-between gap-3 px-4 py-3 sm:px-6">
          <h3 className="font-display text-base font-semibold text-foreground">
            Clasificación
          </h3>
          <span className="text-xs tabular-nums text-muted">
            {total === 1 ? "1 contendiente" : `${total} contendientes`}
          </span>
        </div>

        {total === 0 ? (
          <p className="border-t border-line px-4 py-8 text-center text-sm text-muted sm:px-6">
            Todavía no hay contendientes en este objetivo.
          </p>
        ) : (
          <ol className="divide-y divide-line border-t border-line">
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
        <footer className="flex items-center justify-between gap-3 border-t border-line px-4 py-3 sm:px-6">
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
    </Modal>
  );
}

/** El poseedor actual en grande, el recuento de un logro, o por qué está libre. */
function HolderSummary({ option }: { option: ObjectiveOption }) {
  if (option.kind === "achievement") {
    return (
      <div className="flex items-center gap-3 rounded-md border border-accent/25 bg-accent/5 p-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">
            {option.beneficiaries.length === 1
              ? "1 jugador lo ha conseguido"
              : `${option.beneficiaries.length} jugadores lo han conseguido`}
          </p>
          <p className="mt-0.5 text-xs leading-relaxed text-muted">{option.description}</p>
        </div>
        <span className="shrink-0 rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-xs font-semibold text-accent">
          Logro
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
  // En una competición el distintivo es del poseedor; en un logro, de quien ya lo
  // ha completado (`eligible`).
  const achieved =
    option.kind === "achievement"
      ? contender.eligible
      : contender.profileId === option.holder?.profileId;
  // Sin participante que resaltar (el caso de `/objetivos`) manda el cobrador;
  // con él, el resaltado se muda a su fila. La etiqueta no depende de esto.
  const highlighted =
    highlightProfileId === null ? achieved : contender.profileId === highlightProfileId;

  return (
    <li className={`flex items-center gap-3 px-4 py-3 sm:px-6 ${highlighted ? "bg-accent/5" : ""}`}>
      <span className="w-6 shrink-0 text-right text-sm tabular-nums text-muted">{rank}</span>
      <PlayerAvatar name={contender.name} avatarUrl={contender.avatarUrl} className="size-8 text-xs" />
      <span className="min-w-0 flex-1">
        <ContenderName contender={contender} className="truncate text-sm text-foreground/90" />
        {highlighted ? (
          <span className="sr-only">(jugador de esta ficha)</span>
        ) : null}
        {!achieved && option.kind === "competition" ? (
          <span className="mt-0.5 block text-xs text-muted">{ineligibleTag(option)}</span>
        ) : null}
      </span>

      {achieved ? (
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
function PrizePlate({ points }: { points: number }) {
  return (
    <span className="justify-self-start rounded-md border border-accent/30 bg-accent/5 px-4 py-2 text-right sm:justify-self-end">
      <span className="block font-display text-2xl font-semibold leading-none tabular-nums text-accent">
        +{points}
      </span>
      <span className="mt-1 block text-xs font-medium uppercase tracking-wide text-muted">
        puntos
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
