"use client";

import type { ReactNode } from "react";
import type { ObjectiveOption } from "@/lib/public";
import { civilizationName } from "@/lib/civs";
import { ObjectiveDialogCard } from "@/components/objective-dialog-card";
import { familyCivId, ObjectiveFamilyRail } from "@/components/objective-family-rail";
import type { ObjectiveStandingPlayer } from "@/components/objective-standings";

/**
 * El nombre del subobjetivo sin la civilización pegada ("Líder Français" →
 * "Líder"), para poder decir "cada civilización" sin nombrar una en concreto.
 */
function subjectStem(child: ObjectiveOption): string {
  const civ = familyCivId(child.id);

  if (civ === null) {
    return child.label;
  }

  const name = civilizationName(civ);

  return child.label.replace(name, "").replace(/\s+/g, " ").trim() || child.label;
}

/**
 * Cómo puntúa una familia: lo que da cada subobjetivo y lo que suma completarlos
 * todos con el logro global. Los números salen del contrato (`head.points` y los
 * `points` de los hijos); con hijos de puntos distintos no se pinta, antes que
 * inventar una cifra que el motor no aplica.
 */
function familyScoringNote(
  head: ObjectiveOption,
  subobjectives: ObjectiveOption[],
): ReactNode {
  const [first] = subobjectives;

  if (first === undefined || subobjectives.some((child) => child.points !== first.points)) {
    return null;
  }

  return (
    <>
      Cada civilización: <span className="font-medium tabular-nums text-foreground">{first.points} puntos</span>{" "}
      ({subjectStem(first)}). Completar las{" "}
      <span className="tabular-nums">{subobjectives.length}</span>:{" "}
      <span className="font-medium tabular-nums text-accent">+{head.points} extra</span> (
      {head.label}).
    </>
  );
}

type ObjectiveFamilySectionProps = {
  /** El logro global, cabeza de la familia. */
  head: ObjectiveOption;
  /** Sus subobjetivos, uno por civilización, en el orden del catálogo. */
  subobjectives: ObjectiveOption[];
  standings: ObjectiveStandingPlayer[] | null;
  /** El pool de mapas no afecta a las familias, pero se pasa para reutilizar la tarjeta. */
  mapPool?: readonly string[];
};

/**
 * Una familia de objetivos: el logro global arriba, el filtro de banderas debajo
 * y un riel horizontal con una tarjeta por subobjetivo.
 *
 * El riel —el gesto de arrastre, el teclado y el salto por civilización— vive en
 * `ObjectiveFamilyRail`, que comparte con la ficha de un participante: las dos
 * pantallas montan el mismo recorrido sobre tarjetas distintas.
 */
export function ObjectiveFamilySection({
  head,
  subobjectives,
  standings,
  mapPool = [],
}: ObjectiveFamilySectionProps) {
  return (
    <section className="flex flex-col gap-4">
      <ObjectiveDialogCard
        option={head}
        standings={standings}
        mapPool={mapPool}
        actionLabel="Ver completados"
        note={familyScoringNote(head, subobjectives)}
      />

      <ObjectiveFamilyRail
        items={subobjectives}
        renderCard={(child) => (
          <ObjectiveDialogCard
            option={child}
            standings={standings}
            actionLabel="Ver clasificación"
          />
        )}
      />
    </section>
  );
}
