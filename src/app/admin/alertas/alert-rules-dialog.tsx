"use client";

import { useId, useState, type ReactNode } from "react";
import { Modal } from "@/components/modal";
import type { AlertsThresholds } from "@/lib/alerts/rules";

type AlertRulesDialogProps = {
  /** Umbrales efectivos, tal y como los publica `getAdminAlertRules()`. */
  thresholds: AlertsThresholds;
  /** La lectura de los umbrales ha degradado y se muestran los valores de respaldo. */
  fallback: boolean;
};

/**
 * Ventana con las reglas de las alertas de comportamiento, en claro.
 *
 * Es un botón **informativo**: no lanza ninguna acción, solo abre la explicación de
 * qué se vigila. Por eso el disparador es un control secundario del panel y la capa
 * reutiliza `Modal`, que ya resuelve `showModal()`, la trampa de foco, `Esc`, el clic
 * en el fondo y el scroll bloqueado.
 *
 * Los números **no están escritos aquí**: llegan de los umbrales vivos
 * (`Setting["alerts.ruleset"]`, que la organización retoca sin desplegar). Un texto
 * con las cifras a mano mentiría en cuanto se cambiara un umbral, que es el mismo
 * pendiente que el proyecto ya tiene anotado para `/puntuacion` y `/objetivos`. El
 * `fallback` solo afecta a la procedencia de los números: si la lectura de los
 * umbrales ha fallado, se usan los del código y la ventana lo dice.
 */
export function AlertRulesDialog({ thresholds, fallback }: AlertRulesDialogProps) {
  const [open, setOpen] = useState(false);
  const titleId = useId();

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex h-10 items-center rounded-md border border-line-strong px-4 text-sm text-foreground transition-colors hover:border-accent/50 hover:text-accent"
      >
        Reglas
      </button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        labelledBy={titleId}
        closeLabel="Cerrar las reglas"
        className="m-auto w-[calc(100%-2rem)] max-w-2xl rounded-lg border border-line bg-surface p-0 text-foreground"
      >
        <div className="flex max-h-[85vh] flex-col">
          <header className="border-b border-line px-5 py-4 pr-14">
            {/* El foco inicial va al título, no a un botón del pie: con un diálogo
                largo y con scroll, enfocar el "Cerrar" del final desplazaría el
                contenido hasta abajo al abrirlo. `Modal` busca `[data-autofocus]`. */}
            <h2
              id={titleId}
              tabIndex={-1}
              data-autofocus
              className="text-lg font-semibold text-foreground"
            >
              Reglas de las alertas
            </h2>
            <p className="mt-1 text-sm text-muted">
              Qué vigila el motor de alertas sobre las partidas clasificatorias del
              torneo y sobre el estado de los perfiles.
            </p>
          </header>

          <div className="overflow-y-auto px-5 py-4">
            {fallback ? (
              <p className="mb-5 rounded-md border border-line-strong bg-surface-raised px-3 py-2 text-xs text-muted">
                No se han podido leer los umbrales vigentes. Se muestran los valores
                por defecto.
              </p>
            ) : null}

            <ol className="flex flex-col gap-5">
              <Rule index={1} title="Partidas cortas">
                Se vigilan las partidas de menos de{" "}
                {minutos(thresholds.shortMatchSeconds)}. Si un jugador encadena{" "}
                {thresholds.shortMatchStreak} o más, se avisa cuando la racha termina,
                indicando cuántas fueron. Además, cada vez que acumula{" "}
                {thresholds.shortMatchTotalStep} partidas cortas (y sus múltiplos:{" "}
                {multiplos(thresholds.shortMatchTotalStep)}), aunque no sean seguidas,
                se crea otra alerta.
              </Rule>

              <Rule index={2} title="Rival repetido" mode="Solo 1v1">
                Si un jugador juega {thresholds.repeatedOpponentStreak} o más partidas
                seguidas contra el mismo rival, se avisa al romperse la racha, con el
                número. Y cada vez que alcanza{" "}
                {thresholds.repeatedOpponentTotalStep} partidas contra el mismo rival en
                total (y sus múltiplos:{" "}
                {multiplos(thresholds.repeatedOpponentTotalStep)}), se crea otra.
              </Rule>

              <Rule index={3} title="Compañero repetido" mode="Solo equipos">
                Si un jugador juega {thresholds.repeatedTeammateStreak} o más partidas
                seguidas con el mismo compañero, se avisa al romperse la racha. Si llega
                a {thresholds.repeatedTeammateTotal} partidas en total con ese mismo
                compañero, se crea otra alerta, una sola vez.
              </Rule>

              <Rule index={4} title="Sin aldeanos al arrancar">
                Solo se miran las partidas que duraron al menos{" "}
                {minutos(thresholds.noVillagersFirstSeconds)}. Si en esa ventana no
                apareció ningún aldeano, se avisa; los aldeanos con los que se empieza
                no cuentan. La alerta es de esa partida, no una racha.
              </Rule>

              <Rule index={5} title="Sin crecimiento militar">
                La puntuación militar arranca en un valor bajo por el explorador inicial,
                y no hacer un máximo nuevo al principio es normal: los primeros{" "}
                {minutos(thresholds.noMilitaryGraceSeconds)} no se miran. Después, si pasa{" "}
                {minutos(thresholds.noMilitaryGapSeconds)} seguidos sin que haga un máximo
                nuevo, se avisa. Se mide la puntuación militar, no un número de unidades.
                Cada partida que lo cumpla tiene su propia alerta.
              </Rule>

              <Rule index={6} title="Sin obtener recursos">
                Se mira la suma de recursos recolectados, no las existencias que quedan
                en el banco. Si esa suma no sube durante{" "}
                {minutos(thresholds.noResourcesGapSeconds)} seguidos, se avisa. Una
                alerta por partida.
              </Rule>
            </ol>

            <p className="mt-6 border-l-2 border-accent/40 pl-4 text-sm leading-relaxed text-muted">
              Las alertas de racha se crean cuando la racha termina, con el número de
              partidas que duró; si el torneo acaba con una racha abierta, se emite al
              cierre con el conteo que tenga. Las de total se crean al alcanzar el
              umbral. Solo cuentan las partidas clasificatorias resueltas y no
              revertidas: las que no puntúan quedan fuera de la racha y no la rompen
              (por ejemplo, una de equipo con un compañero a dos escalones o más de
              división). Cada umbral avisa una sola vez. En cambio, las tres del
              resumen no son rachas: cada partida que cumple su criterio lleva su
              propia alerta, y si el hallazgo se repite en otra partida, hay otra. Un
              dato que no se pudo leer no cuenta como cero: si falta, la regla de esa
              partida no se evalúa.
            </p>

            <div className="mt-6 border-t border-line pt-5">
              <h3 className="text-sm font-semibold text-foreground">
                Estado que no sale de las partidas
              </h3>
              <p className="mt-1 text-sm leading-relaxed text-muted">
                Estas comprobaciones no miran las partidas que ya tenemos, sino el perfil
                del jugador en AoE4World y su cuenta de Discord. Avisan cuando:
              </p>
              <ul className="mt-3 flex flex-col gap-3 text-sm leading-relaxed text-muted">
                <li>
                  <strong className="font-medium text-foreground">
                    El historial de partidas no es público.
                  </strong>{" "}
                  Se sondean las partidas resueltas más recientes y solo se avisa si
                  ninguna tiene resumen, que es lo que ocurre con el historial cerrado.
                  Un fallo de red no cuenta como cerrado: en ese caso no se escribe
                  nada.
                </li>
                <li>
                  <strong className="font-medium text-foreground">
                    La ladder registra una partida que no nos llega.
                  </strong>{" "}
                  Se compara la ladder de AoE4World con nuestras partidas de 1v1 y se
                  avisa cuando va claramente por delante de lo que tenemos.
                </li>
                <li>
                  <strong className="font-medium text-foreground">
                    La cuenta de Discord no está en el servidor del torneo.
                  </strong>{" "}
                  Se comprueba cada doce horas si la cuenta de Discord enlazada sigue
                  en el servidor. Un fallo de red no cuenta como salida: en ese caso no
                  se escribe nada.
                </li>
              </ul>
              <p className="mt-3 text-sm leading-relaxed text-muted/85">
                Estas comprobaciones son un aviso para que la organización mire, no un
                veredicto.
              </p>
            </div>

            <div className="mt-6 border-t border-line pt-5">
              <h3 className="text-sm font-semibold text-foreground">
                Cuando el resumen no se puede revisar
              </h3>
              <p className="mt-1 text-sm leading-relaxed text-muted">
                Aunque el historial no esté cerrado, el resumen de una partida puede no
                dejar leer sus datos. Cuando hay partidas que se intentaron leer y pasó
                la ventana de revisión sin una respuesta concluyente, se escribe una
                alerta de estado por jugador, con el número de partidas afectadas.
              </p>
              <p className="mt-3 text-sm leading-relaxed text-muted/85">
                Es un aviso para revisar, no una sanción: dice que la organización
                todavía no sabe qué pasó en esas partidas, no que el jugador haya hecho
                nada. Una sola por jugador, no una por partida, y no se confunde con el
                perfil privado confirmado, que tiene su propia alerta.
              </p>
            </div>
          </div>
        </div>
      </Modal>
    </>
  );
}

/** Una regla numerada: número, título, etiqueta de modo y explicación. */
function Rule({
  index,
  title,
  mode,
  children,
}: {
  index: number;
  title: string;
  mode?: string;
  children: ReactNode;
}) {
  return (
    <li className="flex gap-3">
      <span
        aria-hidden="true"
        className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md border border-line-strong text-xs font-semibold tabular-nums text-accent"
      >
        {index}
      </span>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          {mode !== undefined ? (
            <span className="inline-block rounded-full border border-line-strong px-2 py-0.5 text-xs text-muted">
              {mode}
            </span>
          ) : null}
        </div>
        <p className="mt-1 text-sm leading-relaxed text-muted">{children}</p>
      </div>
    </li>
  );
}

/** Los segundos del umbral, en minutos; con un decimal solo si no es entero. */
function minutos(seconds: number): string {
  const m = seconds / 60;
  const value = Number.isInteger(m) ? String(m) : m.toFixed(1).replace(".", ",");

  return `${value} ${m === 1 ? "minuto" : "minutos"}`;
}

/** Los tres primeros múltiplos del paso, como se leen en el texto ("5, 10, 15…"). */
function multiplos(step: number): string {
  return `${step}, ${step * 2}, ${step * 3}…`;
}
