"use client";

import { useActionState, useEffect, useState } from "react";
import type { AdminActionResult } from "@/app/admin/actions";
import type { ScoringRuleset } from "@/lib/scoring";
import { saveScoringRuleset } from "./actions";
import { StatusLine, TextField } from "./fields";
import { SwitchField } from "./switch-field";

const initialState: AdminActionResult = { status: "idle", message: null };

/**
 * Prefijo del campo que lleva los puntos de un objetivo: `objectivePoints.<id>`.
 *
 * Tiene que ser el mismo que lee `saveScoringRuleset` (`OBJECTIVE_POINTS_PREFIX`). El
 * literal se repite aquí porque un módulo `"use server"` solo exporta funciones async,
 * así que la constante de la acción no se puede importar desde este componente.
 */
const OBJECTIVE_POINTS_FIELD_PREFIX = "objectivePoints.";

/**
 * El objetivo que paga las victorias clasificatorias.
 *
 * Va como literal, y no importado de `@/lib/objectives`, por lo mismo que los ids de
 * familia de la ficha: este componente es de cliente y no puede tirar del catálogo
 * del servidor. Es contrato estable.
 *
 * No lleva campo de puntos propio: lo que vale una victoria lo dice «Puntos por
 * victoria», y el servidor descarta un `objectivePoints.victorias` (ver `actions.ts`).
 */
const VICTORIAS_ID = "victorias";

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
   * importar desde un componente de cliente. Llegan otra vez con cada render del
   * servidor, y el formulario los vuelve a adoptar: es lo que devuelve su valor a
   * los campos después de guardar.
   */
  windowFrom: string;
  windowTo: string;
  /**
   * ¿Ha empezado ya la edición? Con la ventana en marcha los puntos y las reglas
   * están congelados y solo queda fijar el fin (`editionStarted()` en el servidor).
   * La pantalla lo usa para no ofrecer lo que la acción va a rechazar.
   */
  locked: boolean;
  /**
   * La fecha de inicio de la ventana en hora de Madrid, ya formateada, o `null` si
   * el instante guardado no se puede leer. Solo se usa para explicar el bloqueo.
   */
  windowStartLabel: string | null;
};

/**
 * Los puntos de cada objetivo como texto, que es lo que se escribe en el campo.
 *
 * Sale de los grupos del catálogo, que es lo que manda el servidor. El mismo cálculo
 * sirve para el estado inicial y para volver a adoptarlo cuando el servidor
 * responde a un guardado, así que no puede haber dos versiones del mismo dato.
 */
function objectivePointTexts(groups: ObjectiveGroupBlock[]): Record<string, string> {
  return Object.fromEntries(
    groups.flatMap((group) =>
      group.objectives.map((objective) => [objective.id, String(objective.points)]),
    ),
  );
}

/**
 * Las reglas de puntuación, en el estado que toque.
 *
 * Son dos formularios distintos, no uno con campos deshabilitados: con la edición
 * en marcha la acción rechaza **cualquier** envío que traiga un campo congelado,
 * aunque lleve el valor que ya estaba, así que un campo deshabilitado no basta —
 * deshabilitado no viaja, pero un `readonly` sí—. Cada estado monta sus propios
 * hooks dentro de su componente, y este despachador no tiene ninguno: así no hay
 * forma de que cambie el orden en que se llaman.
 */
export function RulesetForm({ locked, ...props }: RulesetFormProps) {
  return locked ? <LockedRulesetForm {...props} /> : <EditableRulesetForm {...props} />;
}

/**
 * Lo que reciben los dos formularios: el documento y los campos de la ventana, ya
 * sin el estado —lo decidió el despachador—. Cada uno toma de aquí lo que le sirve
 * (`windowFrom` no lo usa el bloqueado, que ya no lo manda).
 */
type RulesetFormStateProps = Omit<RulesetFormProps, "locked">;

/**
 * Las reglas de puntuación: ventana, familias, puntos, civ aleatoria y objetivos.
 *
 * Es el documento del que sale **toda** la clasificación, así que la pantalla
 * enseña los cuatro ajustes que mueven puntos y, debajo, el catálogo de
 * objetivos agrupado por grupos. Cada grupo es un bloque plegable —cerrado por
 * defecto, con su recuento— porque el catálogo tiene 88 entradas y desplegarlo
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
 *
 * Todo lo que se edita aquí es estado del cliente que **nace** de lo que manda el
 * servidor: ventana, puntos, familias y objetivos activos. Cuando el servidor manda
 * algo nuevo —cada render suyo trae objetos nuevos— el formulario lo vuelve a
 * adoptar, porque React resetea los campos al terminar una Server Action.
 */
function EditableRulesetForm({
  ruleset,
  modeOptions,
  groups,
  windowFrom: serverWindowFrom,
  windowTo: serverWindowTo,
}: RulesetFormStateProps) {
  const [state, formAction, pending] = useActionState(saveScoringRuleset, initialState);

  const [windowFrom, setWindowFrom] = useState(serverWindowFrom);
  const [windowTo, setWindowTo] = useState(serverWindowTo);
  const [pointsPerWin, setPointsPerWin] = useState(String(ruleset.pointsPerWin));
  const [countRandomizedCivs, setCountRandomizedCivs] = useState(ruleset.countRandomizedCivs);
  const [modes, setModes] = useState<string[]>(ruleset.modes);
  const [disabled, setDisabled] = useState<string[]>(ruleset.disabledObjectives);
  const [points, setPoints] = useState<Record<string, string>>(() =>
    objectivePointTexts(groups),
  );

  // React resetea los campos cuando una Server Action termina: los controlados vuelven
  // al valor con el que se montaron y, como el estado del cliente no cambia, ningún
  // render los devuelve a su sitio —hasta recargar se ve lo anterior a lo que se acaba
  // de guardar—. Adoptar lo que manda el servidor es ese render: el estado no deriva de
  // otro estado, es el mismo dato del servidor, y por eso se silencia la regla.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reaplica al DOM las reglas que el servidor acaba de guardar
    setWindowFrom(serverWindowFrom);
    setWindowTo(serverWindowTo);
    setPointsPerWin(String(ruleset.pointsPerWin));
    setCountRandomizedCivs(ruleset.countRandomizedCivs);
    setModes(ruleset.modes);
    setDisabled(ruleset.disabledObjectives);
    setPoints(objectivePointTexts(groups));
  }, [groups, ruleset, serverWindowFrom, serverWindowTo]);

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
          hint="Lo que paga el objetivo Victorias: cada victoria clasificatoria suma esta cifra, sin tope. Los demás objetivos reparten aparte."
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
          tocarlo. El de Victorias no tiene precio propio: lo paga «Puntos por
          victoria».
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

                        {objective.id === VICTORIAS_ID ? (
                          <span className="text-xs text-muted">
                            Lo paga «Puntos por victoria»
                          </span>
                        ) : (
                          <span className="flex items-center gap-2 text-xs text-muted">
                            Puntos
                            <input
                              type="number"
                              name={`${OBJECTIVE_POINTS_FIELD_PREFIX}${objective.id}`}
                              min={1}
                              step={1}
                              value={points[objective.id] ?? ""}
                              onChange={(event) => setPoint(objective.id, event.target.value)}
                              aria-label={`Puntos de ${objective.label}`}
                              className="h-9 w-20 rounded-md border border-line bg-surface px-2 text-right text-sm tabular-nums text-foreground"
                            />
                          </span>
                        )}

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

type LockedRulesetFormProps = RulesetFormStateProps;

/**
 * Las reglas de puntuación con la edición ya empezada: lectura de lo congelado y un
 * solo ajuste vivo, el fin de la ventana.
 *
 * El formulario **no manda** ningún campo congelado —ni el inicio, ni los puntos por
 * victoria, ni las familias, ni la civ aleatoria, ni los objetivos, ni sus puntos—:
 * la acción rechaza el envío entero en cuanto ve uno, aunque venga con el valor que
 * ya estaba (ver `touchesLockedRulesetFields()`). Por eso no hay campos
 * deshabilitados ni ocultos: los congelados se enseñan como resumen de lectura y no
 * viajan.
 *
 * Lo único que hay que devolver al DOM después de guardar es el `to`, que es el mismo
 * patrón que en el formulario editable: React resetea los campos al terminar una
 * Server Action y el estado del cliente no cambia, así que el render del servidor es
 * el que devuelve el valor a su sitio.
 */
function LockedRulesetForm({
  ruleset,
  modeOptions,
  groups,
  windowTo: serverWindowTo,
  windowStartLabel,
}: LockedRulesetFormProps) {
  const [state, formAction, pending] = useActionState(saveScoringRuleset, initialState);
  const [windowTo, setWindowTo] = useState(serverWindowTo);

  // El `to` vuelve al campo después de guardar, igual que en el formulario editable:
  // React resetea los controlados al terminar la acción y este render los devuelve.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reaplica al DOM el fin que el servidor acaba de guardar
    setWindowTo(serverWindowTo);
  }, [serverWindowTo]);

  const disabled = new Set(ruleset.disabledObjectives);
  const totalObjectives = groups.reduce((total, group) => total + group.objectives.length, 0);
  const activeObjectives = groups.reduce(
    (total, group) =>
      total + group.objectives.filter((objective) => !disabled.has(objective.id)).length,
    0,
  );

  // El rótulo sale de `modeOptions` —la misma lista que pinta las casillas—, y una
  // familia que no tenga rótulo se enseña con su valor crudo en vez de desaparecer.
  const scoringModes = ruleset.modes
    .map((mode) => modeOptions.find((option) => option.value === mode)?.label ?? mode)
    .join(", ");

  return (
    <div className="flex flex-col gap-4">
      <p className="max-w-[70ch] rounded-md border border-accent/30 bg-accent/5 px-4 py-3 text-sm leading-relaxed text-muted">
        <strong className="font-semibold text-foreground">
          Las reglas de puntuación están cerradas
        </strong>
        .{" "}
        {windowStartLabel !== null
          ? `La edición empezó el ${windowStartLabel}`
          : "La edición ya ha empezado"}{" "}
        y, desde ese momento, cambiar los puntos o los objetivos movería una
        clasificación ya publicada. Solo se puede fijar o cambiar la fecha de fin de
        la ventana.
      </p>

      <div className="rounded-lg border border-line bg-surface p-4">
        <h3 className="text-base font-medium">Reglas congeladas</h3>
        <dl className="mt-3 grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs text-muted">Puntos por victoria</dt>
            <dd className="mt-0.5 tabular-nums text-foreground">{ruleset.pointsPerWin}</dd>
          </div>

          <div>
            <dt className="text-xs text-muted">Familias de ladder que puntúan</dt>
            <dd className="mt-0.5 text-foreground">
              {scoringModes === "" ? "Ninguna" : scoringModes}
            </dd>
          </div>

          <div>
            <dt className="text-xs text-muted">Objetivos activos</dt>
            <dd className="mt-0.5 tabular-nums text-foreground">
              {activeObjectives} de {totalObjectives}
            </dd>
          </div>

          <div>
            <dt className="text-xs text-muted">Civilizaciones aleatorias</dt>
            <dd className="mt-0.5 text-foreground">
              {ruleset.countRandomizedCivs
                ? "Cuentan para los objetivos de civilización"
                : "No cuentan para los objetivos de civilización"}
            </dd>
          </div>
        </dl>
      </div>

      <form action={formAction} className="rounded-lg border border-line bg-surface p-4">
        <div className="max-w-md">
          <TextField
            name="windowTo"
            label="Fin de la ventana (opcional)"
            type="datetime-local"
            value={windowTo}
            onChange={setWindowTo}
            hint="Fecha y hora local de Madrid, exclusiva; se guarda en UTC. Déjalo vacío para una ventana abierta: el fin se fija más tarde sin tocar nada más."
          />
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-4">
          <button
            type="submit"
            disabled={pending}
            className="h-10 rounded-md bg-accent px-4 text-sm font-semibold text-accent-ink transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-60"
          >
            {pending ? "Guardando…" : "Guardar el fin de la ventana"}
          </button>
          <StatusLine state={state} pending={pending} />
        </div>
      </form>
    </div>
  );
}
