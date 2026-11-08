import type { Metadata } from "next";
import {
  RulesetForm,
  type ObjectiveGroupBlock,
} from "@/app/admin/administracion/ruleset-form";
import { AdminPageHeader } from "@/components/admin/page-header";
import { EmptyState } from "@/components/empty-state";
import { formatMadridDateTime } from "@/lib/format";
import { OBJECTIVE_DEFINITIONS, OBJECTIVE_GROUP_LABELS } from "@/lib/objectives";
import { editionEnded, editionStarted } from "@/lib/ranked-match";
import { RANKED_MODES, readRuleset, type ScoringRuleset } from "@/lib/scoring";

export const metadata: Metadata = {
  title: { absolute: "Puntuación · Admin" },
};

/**
 * Rótulos de las familias de ladder para la pantalla. El valor crudo se usa como
 * respaldo, para que una familia nueva del ruleset se vea aunque no tenga rótulo
 * aquí en vez de desaparecer del formulario.
 */
const MODE_LABELS: Record<string, string> = {
  rm_solo: "Ranked 1vs1",
  rm_team: "Ranked por equipos",
};

/**
 * Subpestaña de puntuación: las reglas de las que sale toda la clasificación.
 *
 * Las fechas **no** se editan aquí: la ventana del torneo tiene su propia subpestaña
 * (`Fechas`) y su propia acción, y `saveScoringRuleset()` rechaza cualquier envío que
 * traiga `windowFrom` o `windowTo`. Lo que queda es lo que mueve puntos —familias,
 * puntos por victoria y objetivos—, que tiene dos modos y no los decide un campo del
 * formulario sino la **ventana guardada**: antes de `window.from` se edita todo; desde
 * ese instante (`editionStarted()`) queda bloqueado, y sigue bloqueado cuando la edición
 * ya ha terminado (`editionEnded()`), porque esas son las reglas de la edición cerrada.
 * El bloqueo cambia de motivo, no de forma. La pantalla solo explica el bloqueo y remite
 * a `Fechas`, que es donde se mueve el inicio para preparar la siguiente edición. La
 * acción lo vuelve a comprobar por su cuenta —una Server Action es un endpoint público—,
 * así que lo de aquí es la explicación del bloqueo, no su defensa.
 *
 * Si el ruleset no se puede leer no se pinta un formulario, ni entero ni a medias: sin
 * las reglas guardadas no se sabe si la edición ha empezado, y caer en el documento por
 * defecto diría "editable" sobre una edición que puede llevar meses en marcha.
 */
export default async function AdminScoringPage() {
  let ruleset: ScoringRuleset;

  try {
    ruleset = await readRuleset();
  } catch {
    return (
      <div className="flex flex-col gap-6">
        <AdminPageHeader
          level={2}
          title="Puntuación"
          description="Las ladders que puntúan, los puntos por victoria y los objetivos activos."
        />
        <EmptyState
          title="No se han podido leer las reglas de puntuación"
          body="La base de datos no ha respondido. Sin las reglas guardadas no se puede saber si la edición ya ha empezado ni qué está congelado, así que no se ofrece el formulario. Vuelve a intentarlo en unos minutos."
        />
      </div>
    );
  }

  // Un solo instante para los dos predicados: la pantalla está bloqueada mientras la
  // edición haya empezado, y sigue bloqueada cuando ya ha terminado porque esas reglas
  // son las de la edición cerrada. Se desbloquea al mover el inicio en `Fechas`.
  const now = new Date();
  const ended = editionEnded(ruleset.window, now);
  const locked = editionStarted(ruleset.window, now);
  const windowStartLabel = formatMadridDateTime(ruleset.window.from);

  const modeOptions = RANKED_MODES.map((mode) => ({
    value: mode,
    label: MODE_LABELS[mode] ?? mode,
  }));

  // El catálogo de objetivos agrupado por grupos, en el orden en que aparece en
  // `OBJECTIVE_DEFINITIONS`, para no llevar aquí una segunda copia del orden.
  const objectiveGroups: ObjectiveGroupBlock[] = [];

  for (const definition of OBJECTIVE_DEFINITIONS) {
    let block = objectiveGroups.find((candidate) => candidate.group === definition.group);

    if (block === undefined) {
      block = {
        group: definition.group,
        label: OBJECTIVE_GROUP_LABELS[definition.group],
        objectives: [],
      };
      objectiveGroups.push(block);
    }

    block.objectives.push({
      id: definition.id,
      label: definition.label,
      points: ruleset.objectives[definition.id] ?? definition.points,
      pointsPerUnit: definition.pointsPerUnit ?? null,
      target: definition.target,
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <AdminPageHeader
        level={2}
        title="Puntuación"
        description="Las ladders que puntúan, los puntos por victoria y los objetivos activos."
      />

      <RulesetForm
        ruleset={ruleset}
        modeOptions={modeOptions}
        groups={objectiveGroups}
        locked={locked}
        editionEnded={ended}
        windowStartLabel={windowStartLabel}
      />
    </div>
  );
}
