import type { Metadata } from "next";
import {
  RulesetForm,
  type ObjectiveGroupBlock,
} from "@/app/admin/administracion/ruleset-form";
import { OBJECTIVE_DEFINITIONS, OBJECTIVE_GROUP_LABELS } from "@/lib/objectives";
import { formatMadridLocalInstant } from "@/lib/ranked-match";
import { DEFAULT_RULESET, RANKED_MODES, readRuleset } from "@/lib/scoring";

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
 * Subpestaña de puntuación: el ruleset del que sale toda la clasificación.
 *
 * La lectura degrada al documento por defecto si la base no responde, porque el
 * formulario vuelve a validar en el servidor al guardar.
 */
export default async function AdminScoringPage() {
  const ruleset = await readRuleset().catch(() => DEFAULT_RULESET);

  const modeOptions = RANKED_MODES.map((mode) => ({
    value: mode,
    label: MODE_LABELS[mode] ?? mode,
  }));

  // La ventana se prefila en el `datetime-local` de Madrid. Se convierte aquí, en
  // el servidor, porque `formatMadridLocalInstant()` es `server-only`; el formulario
  // solo recibe los dos textos. Un límite que no se pueda leer deja el campo vacío
  // en vez de con un valor inventado.
  const windowFrom = formatMadridLocalInstant(ruleset.window.from) ?? "";
  const windowTo =
    ruleset.window.to === null ? "" : (formatMadridLocalInstant(ruleset.window.to) ?? "");

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
    });
  }

  return (
    <section>
      <h2 className="text-lg font-medium">Puntuación</h2>
      <p className="mt-1 max-w-[70ch] text-sm text-muted">
        Las fechas que delimitan qué partidas puntúan, las ladders que cuentan, los
        puntos por victoria y los objetivos activos. Mover la ventana o apagar un
        objetivo cambia quién cobra qué, así que al guardar se recalcula la
        clasificación.
      </p>
      <div className="mt-4">
        <RulesetForm
          ruleset={ruleset}
          modeOptions={modeOptions}
          groups={objectiveGroups}
          windowFrom={windowFrom}
          windowTo={windowTo}
        />
      </div>
    </section>
  );
}
