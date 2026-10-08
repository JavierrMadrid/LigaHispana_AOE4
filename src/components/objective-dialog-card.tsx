"use client";

import { useState, type ReactNode } from "react";
import type { ObjectiveOption } from "@/lib/public";
import { BorderGlow } from "@/components/border-glow";
import { Modal } from "@/components/modal";
import { ObjectiveIcon } from "@/components/objective-icon";
import { ObjectiveSummary, PrizePlate } from "@/components/objective-card";
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
  /** Alto de la tarjeta cerrada, en clases de Tailwind. */
  heightClass?: string;
  /** Participante a resaltar al abrir la clasificación (ficha de jugador). */
  highlightProfileId?: number | null;
  /** Aclaración extra de la tarjeta cerrada (cómo puntúa una familia). */
  note?: ReactNode;
};

/**
 * Tarjeta de objetivo que abre su clasificación a tamaño ventana.
 *
 * Cerrada es un resumen del objetivo; al pulsarla se abre el `Modal` nativo —que
 * ya resuelve foco, `Esc` y bloqueo del scroll— con la clasificación y el avance
 * de cada participante. No hay giro 3D: la ventana aparece con una entrada
 * discreta (la misma del diálogo de clasificación del sitio), que basta para
 * leerla como una capa nueva sin simular el volteo de una tarjeta. La tarjeta
 * cerrada es un botón invisible que cubre el resumen: así se puede pulsar en
 * cualquier punto y el orden de tabulación tiene un único destino.
 */
export function ObjectiveDialogCard({
  option,
  standings,
  mapPool = [],
  actionLabel = "Ver clasificación",
  heightClass = "h-72",
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
        <Modal
          open
          onClose={() => setOpen(false)}
          ariaLabel={`Clasificación de ${option.label}`}
          closeLabel="Cerrar la clasificación"
          className="m-auto h-[100dvh] max-h-[100dvh] w-full max-w-none overflow-hidden border-0 bg-transparent p-0 sm:h-[85vh] sm:max-h-[44rem] sm:max-w-4xl"
        >
          <div className="animate-dialog-in flex h-full flex-col rounded-lg border border-line bg-surface motion-reduce:animate-none">
            <header className="flex items-start gap-4 border-b border-line p-4 pr-14 sm:p-6 sm:pr-16">
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

            <div className="flex-1 overflow-y-auto">
              <ObjectiveStandings
                option={option}
                players={standings}
                highlightProfileId={highlightProfileId}
              />
            </div>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
