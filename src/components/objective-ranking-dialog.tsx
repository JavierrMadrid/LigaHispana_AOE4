"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { ObjectiveContender, ObjectiveOption, ObjectiveView } from "@/lib/public";
import {
  ContenderName,
  contenderValue,
  emptyMessage,
  ineligibleTag,
} from "@/components/objective-card";
import { ObjectiveIcon } from "@/components/objective-icon";
import { PlayerAvatar } from "@/components/player-avatar";

/** Contendientes por página. La lista entera llega ya ordenada del servidor. */
const PAGE_SIZE = 10;

type ObjectiveRankingDialogProps = {
  option: ObjectiveOption;
  minimums: ObjectiveView["minimums"];
  masterizarTodosId: string;
  onClose: () => void;
};

/**
 * Clasificación completa de un objetivo, en una ventana emergente.
 *
 * El `ranking` llega entero (puede tener decenas de filas), así que aquí solo
 * se pagina, 10 por página, con el rango "X–Y de N". Se monta sobre la página
 * con un portal, a propósito, para escapar de cualquier recorte o contexto de
 * apilamiento de la rejilla de tarjetas. Es un `role="dialog"` + `aria-modal`,
 * cierre con Escape o clic en el fondo, foco
 * atrapado dentro del panel y devuelto al disparador al cerrar. En móvil ocupa
 * la pantalla completa; a partir de `sm` es una tarjeta centrada con el cuerpo
 * desplazable.
 */
export function ObjectiveRankingDialog({
  option,
  minimums,
  masterizarTodosId,
  onClose,
}: ObjectiveRankingDialogProps) {
  const [page, setPage] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const idPrefix = useId();
  const titleId = `${idPrefix}-title`;
  const descriptionId = `${idPrefix}-description`;

  const total = option.ranking.length;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const start = page * PAGE_SIZE;
  const rows = option.ranking.slice(start, start + PAGE_SIZE);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const { overflow, paddingRight } = document.body.style;
    // Compensa el ancho de la barra de desplazamiento para que el fondo no dé
    // un salto lateral al bloquearse el scroll.
    const scrollbar = window.innerWidth - document.documentElement.clientWidth;

    document.body.style.overflow = "hidden";

    if (scrollbar > 0) {
      document.body.style.paddingRight = `${scrollbar}px`;
    }

    panelRef.current?.focus();

    return () => {
      document.body.style.overflow = overflow;
      document.body.style.paddingRight = paddingRight;
      previouslyFocused?.focus();
    };
  }, []);

  // Escape cierra y Tab cicla dentro del panel: el foco no puede salir a la
  // página de debajo, que sigue tapada por el fondo.
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
      return;
    }

    if (event.key !== "Tab") {
      return;
    }

    const focusables = panelRef.current?.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );

    if (focusables === undefined || focusables.length === 0) {
      return;
    }

    const first = focusables[0];
    const last = focusables[focusables.length - 1];

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  const dialog = (
    <div
      className="animate-overlay-in fixed inset-0 z-50 flex items-stretch justify-center bg-background/85 motion-reduce:animate-none sm:items-center sm:p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        className="animate-dialog-in relative flex h-full w-full flex-col overflow-hidden bg-surface outline-none motion-reduce:animate-none sm:h-auto sm:max-h-[85vh] sm:max-w-2xl sm:rounded-lg sm:border sm:border-line"
      >
        <header className="relative border-b border-line p-4 pr-14 sm:p-6 sm:pr-16">
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar la clasificación"
            className="absolute right-3 top-3 inline-flex size-9 items-center justify-center rounded-md border border-line bg-surface text-muted transition-colors hover:bg-surface-raised hover:text-foreground sm:right-4 sm:top-4"
          >
            <CloseIcon className="size-4" />
          </button>

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
            <HolderSummary
              option={option}
              minimums={minimums}
              masterizarTodosId={masterizarTodosId}
            />
            <PrizePlate points={option.points} />
          </div>
        </header>

        <div className="flex-1 overflow-y-auto">
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
                  masterizarTodosId={masterizarTodosId}
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
      </div>
    </div>
  );

  return createPortal(dialog, document.body);
}

/** El poseedor actual en grande, o el motivo por el que el objetivo está libre. */
function HolderSummary({
  option,
  minimums,
  masterizarTodosId,
}: {
  option: ObjectiveOption;
  minimums: ObjectiveView["minimums"];
  masterizarTodosId: string;
}) {
  if (option.holder === null) {
    return (
      <div className="rounded-md border border-dashed border-line bg-surface-raised/40 p-3">
        <p className="text-sm font-medium text-foreground/90">Sin poseedor todavía</p>
        <p className="mt-1 text-xs leading-relaxed text-muted">
          {emptyMessage(option, minimums, masterizarTodosId)}
        </p>
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
          {contenderValue(option, option.holder, masterizarTodosId)}
        </p>
      </div>
      <span className="shrink-0 rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-[10px] font-semibold text-accent">
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
  masterizarTodosId,
}: {
  option: ObjectiveOption;
  contender: ObjectiveContender;
  rank: number;
  masterizarTodosId: string;
}) {
  const isHolder = contender.profileId === option.holder?.profileId;

  return (
    <li className={`flex items-center gap-3 px-4 py-3 sm:px-6 ${isHolder ? "bg-accent/5" : ""}`}>
      <span className="w-6 shrink-0 text-right text-sm tabular-nums text-muted">{rank}</span>
      <PlayerAvatar name={contender.name} avatarUrl={contender.avatarUrl} className="size-8 text-[11px]" />
      <span className="min-w-0 flex-1">
        <ContenderName contender={contender} className="truncate text-sm text-foreground/90" />
        {isHolder || contender.eligible ? null : (
          <span className="mt-0.5 block text-[11px] text-muted">{ineligibleTag(option)}</span>
        )}
      </span>

      {isHolder ? (
        <span className="shrink-0 rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-[10px] font-semibold text-accent">
          Poseedor
        </span>
      ) : null}

      <span className="shrink-0 text-sm tabular-nums text-foreground/90">
        {contenderValue(option, contender, masterizarTodosId)}
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
      <span className="mt-1 block text-[10px] font-medium uppercase tracking-wide text-muted">
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

function CloseIcon({ className }: { className?: string }) {
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
      <path d="M6 6 18 18" />
      <path d="M18 6 6 18" />
    </svg>
  );
}
