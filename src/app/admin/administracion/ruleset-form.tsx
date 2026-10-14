"use client";

import { useActionState, useState } from "react";
import type { AdminActionResult } from "@/app/admin/actions";
import type { ScoringRuleset } from "@/lib/scoring";
import { saveScoringRuleset } from "./actions";
import { StatusLine, TextField } from "./fields";
import { SwitchField } from "./switch-field";

const initialState: AdminActionResult = { status: "idle", message: null };

/** Una familia de ladder que puede puntuar, con su nombre para la pantalla. */
export type ModeOption = { value: string; label: string };

/** Un objetivo del catálogo, con los puntos que tiene ahora mismo. */
export type ObjectiveOption = { id: string; label: string; points: number };

/** Los objetivos de un grupo del catálogo, en el orden en que se presentan. */
export type ObjectiveGroupBlock = {
  group: string;
  label: string;
  objectives: ObjectiveOption[];
};

type RulesetFormProps = {
  ruleset: ScoringRuleset;
  modeOptions: ModeOption[];
  groups: ObjectiveGroupBlock[];
  /**
   * Los límites de la ventana ya convertidos al `datetime-local` de Madrid
   * (`formatMadridLocalInstant`). Vienen del servidor y no se calculan aquí: la
   * conversión vive en `@/lib/ranked-match`, que es `server-only` y no se puede
   * importar desde un componente de cliente.
   */
  windowFrom: string;
  windowTo: string;
};

/**
 * Las reglas de puntuación: ventana, familias, puntos, civ aleatoria y objetivos.
 *
 * Es el documento del que sale **toda** la clasificación, así que la pantalla
 * enseña los cuatro ajustes que mueven puntos y, debajo, el catálogo de
 * objetivos agrupado por grupos. Cada grupo es un bloque plegable —cerrado por
 * defecto, con su recuento— porque el catálogo tiene 82 entradas y desplegarlo
 * entero convertiría el formulario en una lista interminable; los controles
 * siguen viajando con el formulario aunque el bloque esté cerrado.
 *
 * Un objetivo **marcado está activo**: se apaga desmarcándolo, que es como se lee
 * de forma natural. Los apagados viajan en campos ocultos, porque `FormData` solo
 * recoge las casillas marcadas y aquí lo que se guarda es la lista de apagados.
 *
 * Los puntos por objetivo son opcionales: cada fila trae el valor actual y
 * vaciarla deja el que ya tenía. La acción lo trata así a propósito, para que
 * este formulario no pueda borrar un ajuste por no mencionarlo.
 */
export function RulesetForm({
  ruleset,
  modeOptions,
  groups,
  windowFrom: initialWindowFrom,
  windowTo: initialWindowTo,
}: RulesetFormProps) {
  const [state, formAction, pending] = useActionState(saveScoringRuleset, initialState);

  const [windowFrom, setWindowFrom] = useState(initialWindowFrom);
  const [windowTo, setWindowTo] = useState(initialWindowTo);
  const [pointsPerWin, setPointsPerWin] = useState(String(ruleset.pointsPerWin));
  const [countRandomizedCivs, setCountRandomizedCivs] = useState(ruleset.countRandomizedCivs);
  const [modes, setModes] = useState<string[]>(ruleset.modes);
  const [disabled, setDisabled] = useState<string[]>(ruleset.disabledObjectives);
  const [points, setPoints] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      groups.flatMap((group) =>
        group.objectives.map((objective) => [objective.id, String(objective.points)]),
      ),
    ),
  );

  function toggleMode(mode: string) {
    setModes((current) =>
      current.includes(mode) ? current.filter((item) => item !== mode) : [...current, mode],
    );
  }

  function toggleObjective(id: string) {
    setDisabled((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  }

  function setPoint(id: string, value: string) {
    setPoints((current) => ({ ...current, [id]: value }));
  }

  return (
    <form action={formAction} className="rounded-lg border border-line bg-surface p-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          name="windowFrom"
          label="Inicio de la ventana"
          type="datetime-local"
          value={windowFrom}
          onChange={setWindowFrom}
          hint="Fecha y hora local de Madrid; se guarda en UTC. Cuenta la partida que empezó a partir de aquí."
          required
        />

        <TextField
          name="windowTo"
          label="Fin de la ventana (opcional)"
          type="datetime-local"
          value={windowTo}
          onChange={setWindowTo}
          hint="Fecha y hora local de Madrid, exclusiva; se guarda en UTC. Déjalo vacío para una ventana abierta: el fin se fija más tarde sin tocar nada más."
        />

        <TextField
          name="pointsPerWin"
          label="Puntos por victoria"
          type="number"
          min={1}
          step={1}
          value={pointsPerWin}
          onChange={setPointsPerWin}
          hint="Puntos que suma cada victoria clasificatoria, antes de los objetivos."
          required
        />
      </div>

      <fieldset className="mt-4">
        <legend className="text-sm font-medium text-foreground">
          Familias de ladder que puntúan
        </legend>
        <p className="mt-1 max-w-[70ch] text-xs leading-relaxed text-muted">
          Solo cuentan las partidas de estas ladders. Deja al menos una marcada: sin
          ninguna, no puntuaría nada.
        </p>
        <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
          {modeOptions.map((mode) => (
            <label key={mode.value} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="modes"
                value={mode.value}
                checked={modes.includes(mode.value)}
                onChange={() => toggleMode(mode.value)}
                className="size-4 rounded border-line bg-background accent-accent"
              />
              <span className="text-foreground">{mode.label}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="mt-4">
        <SwitchField
          name="countRandomizedCivs"
          label="Las partidas con civilización aleatoria cuentan para los objetivos de civilización"
          hint="Apagado, esas partidas no suman para los objetivos que dependen de la civilización."
          checked={countRandomizedCivs}
          onChange={setCountRandomizedCivs}
        />
      </div>

      <fieldset className="mt-4">
        <legend className="text-sm font-medium text-foreground">Objetivos</legend>
        <p className="mt-1 max-w-[70ch] text-xs leading-relaxed text-muted">
          Un objetivo apagado deja de repartir puntos y desaparece de la web. Los
          puntos de cada objetivo se pueden ajustar; deja el valor que trae para no
          tocarlo.
        </p>

        <div className="mt-3 flex flex-col gap-2">
          {groups.map((group) => {
            const activos = group.objectives.filter(
              (objective) => !disabled.includes(objective.id),
            ).length;

            return (
              <details key={group.group} className="rounded-md border border-line bg-background">
                <summary className="cursor-pointer px-3 py-2.5 text-sm text-foreground">
                  <span className="font-medium">{group.label}</span>
                  <span className="ml-2 text-xs text-muted">
                    {activos} de {group.objectives.length} activos
                  </span>
                </summary>

                <ul className="divide-y divide-line border-t border-line">
                  {group.objectives.map((objective) => {
                    const apagado = disabled.includes(objective.id);

                    return (
                      <li
                        key={objective.id}
                        className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-3 py-2"
                      >
                        <label className="flex min-w-0 items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={!apagado}
                            onChange={() => toggleObjective(objective.id)}
                            className="size-4 shrink-0 rounded border-line bg-surface accent-accent"
                          />
                          <span className={apagado ? "text-muted line-through" : "text-foreground"}>
                            {objective.label}
                          </span>
                        </label>

                        <span className="flex items-center gap-2 text-xs text-muted">
                          Puntos
                          <input
                            type="number"
                            min={1}
                            step={1}
                            value={points[objective.id] ?? ""}
                            onChange={(event) => setPoint(objective.id, event.target.value)}
                            aria-label={`Puntos de ${objective.label}`}
                            className="h-9 w-20 rounded-md border border-line bg-surface px-2 text-right text-sm tabular-nums text-foreground"
                          />
                        </span>

                        {apagado ? (
                          <input type="hidden" name="disabledObjectives" value={objective.id} />
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </details>
            );
          })}
        </div>
      </fieldset>

      <div className="mt-4 flex flex-wrap items-center gap-4">
        <button
          type="submit"
          disabled={pending}
          className="h-10 rounded-md bg-accent px-4 text-sm font-semibold text-accent-ink transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? "Guardando…" : "Guardar las reglas"}
        </button>
        <StatusLine state={state} pending={pending} />
      </div>
    </form>
  );
}
