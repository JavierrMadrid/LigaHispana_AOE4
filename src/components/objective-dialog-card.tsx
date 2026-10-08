"use client";

import { useState, type ReactNode } from "react";
import type { ObjectiveOption } from "@/lib/public";
import { BorderGlow } from "@/components/border-glow";
import { ObjectiveFlipDialog } from "@/components/objective-flip-dialog";
import { ObjectiveIcon } from "@/components/objective-icon";
import { ObjectiveSummary, PrizePlate } from "@/components/objective-card";
import { ObjectiveFeatureSummary } from "@/components/objective-feature-summary";
import {
  ObjectiveStandings,
  type ObjectiveStandingPlayer,
} from "@/components/objective-standings";

type ObjectiveDialogCardProps = {
  option: ObjectiveOption;
  /** Clasificación del torneo para el check; `null` si no se ha podido leer. */
  standings: ObjectiveStandingPlayer[] | null;
  /** Pool de mapas activo, solo para `por-tierra-y-agua`. */
  mapPool?: readonly string[];
  /** Texto de la acción ("Ver clasificación" / "Ver completados"). */
  actionLabel?: string;
  /**
   * Alto de la tarjeta cerrada, en clases de Tailwind. Por defecto ocupa el alto
   * de su fila (`h-full`): en la rejilla, la fila la fija la tarjeta más alta y
   * las demás se estiran a su altura; en el riel, la fija la más alta del carril.
   * Así no queda hueco muerto bajo el pie de las tarjetas cortas.
   */
  heightClass?: string;
  /** Participante a resaltar al abrir la clasificación (ficha de jugador). */
  highlightProfileId?: number | null;
  /** Aclaración extra de la tarjeta cerrada (cómo puntúa una familia). */
  note?: ReactNode;
};

/**
 * Tarjeta de objetivo que abre su clasificación en una tarjeta volteable.
 *
 * Cerrada es un resumen del objetivo; al pulsarla se abre la ventana con la
 * clasificación —la cara posterior, igual que la ventana anterior— y un giro
 * (clic, teclado o arrastre) descubre el resumen front. El `Modal` de dentro
 * sigue resolviendo foco, `Esc`, clic en el fondo y bloqueo del scroll. La
 * tarjeta cerrada es un botón invisible que cubre el resumen: así se puede pulsar
 * en cualquier punto y el orden de tabulación tiene un único destino.
 */
export function ObjectiveDialogCard({
  option,
  standings,
  mapPool = [],
  actionLabel = "Ver clasificación",
  heightClass = "h-full",
  highlightProfileId = null,
  note,
}: ObjectiveDialogCardProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <BorderGlow className={heightClass}>
        <ObjectiveSummary
          option={option}
          mapPool={mapPool}
          actionLabel={actionLabel}
          note={note}
        />
        {/* El botón cubre la tarjeta entera; va dentro del `BorderGlow` para que
            el halo siga recibiendo el puntero. */}
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={`${actionLabel}: ${option.label}`}
          className="absolute inset-0 z-10 rounded-lg"
        />
      </BorderGlow>

      {open ? (
        <ObjectiveFlipDialog
          onClose={() => setOpen(false)}
          ariaLabel={`Clasificación de ${option.label}`}
          cardLabel={option.label}
          closeLabel="Cerrar la clasificación"
          front={
            // El componente reserva arriba el aire del botón de cerrar del
            // `Modal`, que flota sobre la esquina superior derecha de la tarjeta.
            <div className="h-full overflow-y-auto">
              <ObjectiveFeatureSummary
                option={option}
                mapPool={mapPool}
                actionLabel={actionLabel}
                note={note}
              />
            </div>
          }
          back={
            <div className="flex h-full flex-col">
              <header className="flex items-start gap-4 border-b border-line p-6 pt-14 sm:p-8 sm:pt-16">
                <span className="flex size-12 shrink-0 items-center justify-center rounded-md border border-line bg-surface-raised">
                  <ObjectiveIcon option={option} className="size-7 shrink-0" />
                </span>
                <div className="min-w-0 flex-1">
                  <h2 className="font-display text-lg font-semibold leading-snug text-foreground sm:text-xl">
                    {option.label}
                  </h2>
                  <p className="mt-1 text-sm leading-relaxed text-muted">{option.description}</p>
                </div>
                <PrizePlate points={option.points} />
              </header>

              <div className="min-h-0 flex-1 overflow-y-auto">
                <ObjectiveStandings
                  option={option}
                  players={standings}
                  highlightProfileId={highlightProfileId}
                />
              </div>
            </div>
          }
        />
      ) : null}
    </>
  );
}
