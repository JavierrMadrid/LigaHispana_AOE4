"use client";

import type { ReactNode } from "react";
import type { ObjectiveOption } from "@/lib/public";
import { civilizationName } from "@/lib/civs";
import { unitPrizeLabel } from "@/lib/objective-format";
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
 * Cómo puntúa una familia **de civilización**: lo que da cada subobjetivo y lo
 * que suma completarlos todos con el logro global. Los números salen del contrato
 * (`head.points` y los `points` de los hijos); con hijos de puntos distintos no se
 * pinta, antes que inventar una cifra que el motor no aplica.
 *
 * Un hijo con `pointsPerUnit` (los `maestro-<civ>`) no reparte un premio cerrado:
 * cobra por unidad hasta su tope, y su `points` es ese **máximo**. La nota lo dice
 * con la cifra por victoria delante (`1 punto por victoria, hasta 5`), porque
 * anunciar los 5 como si se cobraran de una vez sería mentira. Si los hijos no
 * comparten el pago por unidad, tampoco se pinta.
 */
function familyScoringNote(
  head: ObjectiveOption,
  subobjectives: ObjectiveOption[],
): ReactNode {
  const [first] = subobjectives;

  if (
    first === undefined ||
    subobjectives.some(
      (child) =>
        child.points !== first.points || child.pointsPerUnit !== first.pointsPerUnit,
    )
  ) {
    return null;
  }

  const perUnit = first.pointsPerUnit;

  return (
    <>
      Cada civilización:{" "}
      <span className="font-medium tabular-nums text-foreground">
        {perUnit === undefined
          ? `${first.points} puntos`
          : `${unitPrizeLabel(perUnit, first.metric)}, hasta ${first.points}`}
      </span>{" "}
      ({subjectStem(first)}). Completar las{" "}
      <span className="tabular-nums">{subobjectives.length}</span>:{" "}
      <span className="font-medium tabular-nums text-accent">+{head.points} extra</span> (
      {head.label}).
    </>
  );
}

/**
 * Si la familia es de civilización: todos sus hijos llevan la civilización pegada
 * al id (`lider-<civ>`, `acolito-<civ>`, `maestro-<civ>`). Las familias que no
 * —`avance-relampago` agrupa hazañas— no llevan riel de banderas: una rejilla con
 * las tarjetas de los hijos se lee mejor y no promete un filtro que no existe.
 */
function isCivFamily(subobjectives: ObjectiveOption[]): boolean {
  return (
    subobjectives.length > 0 &&
    subobjectives.every((child) => familyCivId(child.id) !== null)
  );
}

/**
 * El nombre del subobjetivo de una familia de hazañas, sin la cabeza delante
 * ("Avance relámpago: Feudal" → "Feudal"), para poder enumerarlos en la nota.
 */
function subobjectiveStem(head: ObjectiveOption, child: ObjectiveOption): string {
  const stem = child.label
    .slice(child.label.startsWith(head.label) ? head.label.length : 0)
    .replace(/^[\s:·-]+/, "")
    .trim();

  return stem || child.label;
}

/**
 * La nota de una familia que **no** es de civilización: los hijos son hazañas que
 * se cobran por separado y la cabeza paga un extra al completarlos todos. Si los
 * hijos comparten puntos se dice cuánto da cada uno; si no (aquí son 3, 6 y 9), se
 * calla antes que inventar un reparto que el motor no aplica. Las cifras salen de
 * `head.points` y de los hijos.
 */
function familyExtraNote(
  head: ObjectiveOption,
  subobjectives: ObjectiveOption[],
): ReactNode {
  const [first] = subobjectives;
  const shared =
    first !== undefined &&
    first.pointsPerUnit === undefined &&
    subobjectives.every(
      (child) => child.points === first.points && child.pointsPerUnit === undefined,
    );

  return (
    <>
      {shared ? (
        <>
          Cada subobjetivo:{" "}
          <span className="font-medium tabular-nums text-foreground">
            {first.points} {first.points === 1 ? "punto" : "puntos"}
          </span>{" "}
          ({subobjectives.map((child) => subobjectiveStem(head, child)).join(", ")}).{" "}
        </>
      ) : null}
      Completar{" "}
      {subobjectives.length === 1 ? "el subobjetivo" : `los ${subobjectives.length}`}:{" "}
      <span className="font-medium tabular-nums text-accent">+{head.points} extra</span>{" "}
      ({head.label}).
    </>
  );
}

type ObjectiveFamilySectionProps = {
  /** El logro global, cabeza de la familia. */
  head: ObjectiveOption;
  /** Sus subobjetivos, en el orden del catálogo. */
  subobjectives: ObjectiveOption[];
  standings: ObjectiveStandingPlayer[] | null;
  /** El pool de mapas no afecta a las familias de civilización, pero se pasa para reutilizar la tarjeta. */
  mapPool?: readonly string[];
};

/**
 * Una familia de objetivos: el logro global arriba y sus subobjetivos debajo.
 *
 * En las familias **de civilización** los hijos van en un riel horizontal con el
 * filtro de banderas. El riel —el gesto de arrastre, el teclado y el salto por
 * civilización— vive en `ObjectiveFamilyRail`, que comparte con la ficha de un
 * participante: las dos pantallas montan el mismo recorrido sobre tarjetas
 * distintas. En las familias que **no** lo son (las hazañas de
 * `avance-relampago`) no hay civilización que filtrar: los hijos van en la misma
 * rejilla de tres columnas que los objetivos sueltos, para que el ritmo de la
 * página no cambie.
 */
export function ObjectiveFamilySection({
  head,
  subobjectives,
  standings,
  mapPool = [],
}: ObjectiveFamilySectionProps) {
  const civFamily = isCivFamily(subobjectives);

  return (
    <section className="flex flex-col gap-4">
      <ObjectiveDialogCard
        option={head}
        standings={standings}
        mapPool={mapPool}
        actionLabel="Ver completados"
        note={
          civFamily
            ? familyScoringNote(head, subobjectives)
            : familyExtraNote(head, subobjectives)
        }
      />

      {civFamily ? (
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
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {subobjectives.map((child) => (
            <ObjectiveDialogCard
              key={child.id}
              option={child}
              standings={standings}
              mapPool={mapPool}
              actionLabel="Ver clasificación"
            />
          ))}
        </div>
      )}
    </section>
  );
}

type ObjectiveMasterizandoSectionProps = {
  /** Las competiciones `masterizando-<civ>`, una por civilización, en orden. */
  subobjectives: ObjectiveOption[];
  standings: ObjectiveStandingPlayer[] | null;
};

/**
 * Las competiciones `Masterizando <civ>` de `/objetivos`.
 *
 * No son una familia —no tienen cabeza que las agrupe—, pero se leen como tal:
 * el mismo riel (`ObjectiveFamilyRail`) con su filtro de banderas, sus flechas y
 * el salto por civilización, bajo un titular propio, para no amontonarlas en la
 * rejilla de objetivos sueltos. La tarjeta abre la clasificación de esa
 * civilización, igual que las de las familias.
 */
export function ObjectiveMasterizandoSection({
  subobjectives,
  standings,
}: ObjectiveMasterizandoSectionProps) {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-1 border-b border-line pb-2">
        <h3 className="font-display text-base font-semibold text-foreground">
          Masterizando
        </h3>
        <p className="mt-0.5 text-xs text-muted">
          Una competición por civilización: la cobra quien más victorias suma con
          ella.
        </p>
      </div>

      <ObjectiveFamilyRail
        items={subobjectives}
        itemsLabel="competiciones"
        flagsLabel="Civilizaciones con competición"
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
