import type { Metadata } from "next";
import {
  RulesetForm,
  type ObjectiveGroupBlock,
} from "@/app/admin/administracion/ruleset-form";
import { EmptyState } from "@/components/empty-state";
import { formatMadridDateTime } from "@/lib/format";
import { OBJECTIVE_DEFINITIONS, OBJECTIVE_GROUP_LABELS } from "@/lib/objectives";
import { editionStarted, formatMadridLocalInstant } from "@/lib/ranked-match";
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
 * Subpestaña de puntuación: el ruleset del que sale toda la clasificación.
 *
 * La pantalla tiene dos estados, y cuál toca no lo decide un campo del formulario
 * sino la **ventana guardada**: antes de `window.from` se editan los puntos y las
 * reglas; desde ese instante (`editionStarted()`) quedan congelados y lo único que
 * se puede fijar es el fin de la ventana. La acción lo vuelve a comprobar por su
 * cuenta —una Server Action es un endpoint público—, así que lo de aquí es la
 * explicación del bloqueo, no su defensa.
 *
 * Si el ruleset no se puede leer no se pinta un formulario, ni entero ni a medias:
 * sin las reglas guardadas no se sabe si la edición ha empezado, y caer en el
 * documento por defecto diría "editable" sobre una edición que puede llevar meses
 * en marcha.
 */
export default async function AdminScoringPage() {
  let ruleset: ScoringRuleset;

  try {
    ruleset = await readRuleset();
  } catch {
    return (
      <section className="flex flex-col gap-6">
        <div>
          <h2 className="text-lg font-medium">Puntuación</h2>
          <p className="mt-1 max-w-[70ch] text-sm text-muted">
            Las fechas que delimitan qué partidas puntúan, las ladders que cuentan, los
            puntos por victoria y los objetivos activos.
          </p>
        </div>
        <EmptyState
          title="No se han podido leer las reglas de puntuación"
          body="La base de datos no ha respondido. Sin las reglas guardadas no se puede saber si la edición ya ha empezado ni qué está congelado, así que no se ofrece el formulario: vuelve a intentarlo en unos minutos."
        />
      </section>
    );
  }

  const locked = editionStarted(ruleset.window, new Date());
  const windowStartLabel = formatMadridDateTime(ruleset.window.from);

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
        puntos por victoria y los objetivos activos.{" "}
        {locked
          ? "Con la edición ya empezada, todo esto está congelado: solo se puede fijar el fin de la ventana."
          : "Mover la ventana o apagar un objetivo cambia quién cobra qué, así que al guardar se recalcula la clasificación."}
      </p>
      <div className="mt-4">
        <RulesetForm
          ruleset={ruleset}
          modeOptions={modeOptions}
          groups={objectiveGroups}
          windowFrom={windowFrom}
          windowTo={windowTo}
          locked={locked}
          windowStartLabel={windowStartLabel}
        />
      </div>
    </section>
  );
}
