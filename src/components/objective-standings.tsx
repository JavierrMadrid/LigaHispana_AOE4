import type { ObjectiveContender, ObjectiveOption } from "@/lib/public";
import {
  completionSummary,
  contenderShareOfObjective,
  contenderValue,
  hasNoCap,
  hasReachedTarget,
  objectiveStandingsView,
  standingsCountLabel,
} from "@/lib/objective-format";
import { emptyMessage } from "@/components/objective-card";
import { PlayerAvatar } from "@/components/player-avatar";

/**
 * Clasificación de un objetivo: la lista de **quien lo disputa**, con su avance y un
 * check en quien ha **llegado al umbral** (logro) o en su poseedor (competición); en
 * un logro **sin tope** no hay check que poner, porque no se completa.
 *
 * «Completado» es el umbral, no cobrar algo (`hasReachedTarget`): un logro acumulativo
 * paga desde el primer punto, así que `imparable` con tres días de catorce no lleva
 * check —le quedan once— y el resumen tampoco lo cuenta.
 *
 * El orden es el **ranking del objetivo** (`option.ranking`), de más a menos: el
 * que va primero es el más avanzado. Quien no ha empezado su participación **no
 * aparece**: sale sin valor ni puesto, y el censo completo está en la página de
 * clasificación del torneo. La única excepción es `highlightProfileId`, que
 * conserva su fila —sin valor y sin puesto, no se le inventa un cero— para la ficha
 * de un jugador. El número de cada fila es su posición dentro del objetivo (`1` es
 * el líder); el avance sale del ranking cruzado por `profileId`: en un logro es
 * `value/target` (12/23 civilizaciones, 2/3 victorias) y en una competición el
 * valor de su métrica (victorias, partidas, racha), que es lo que le da su
 * posición.
 *
 * ## La barra de fondo
 *
 * Cada fila lleva una barra con su avance. **Qué mide depende del objetivo**
 * (`contenderShareOfObjective`): en un **logro con umbral** es el avance sobre el
 * umbral, para que corresponda con el `X/X` que la fila escribe —`imparable` con tres
 * días de catorce va por una quinta parte, no por el final—; en una **competición** y
 * en un logro **sin tope** (`victorias`) no hay umbral contra el que medir, así que se
 * compara con el **líder de la lista**, que es lo único que los ordena.
 *
 * Es fondo del tramo de la fila que va del canto del contenido a la columna de la
 * cifra —no pasa por debajo del número— y con el mismo aire a los dos lados (12px, el
 * `gap` de la fila): por eso se cuelga de un envoltorio con puesto, avatar, nombre y
 * distintivo, y la cifra queda fuera.
 *
 * ## Lo pintado a sangre se queda dentro del marco
 *
 * La tarjeta de la ventana lleva un marco a 10 y 16px del canto
 * (`ObjectiveFlipDialog`), así que nada pintado puede cruzarlo: los tres bloques de
 * esta cara —cabecera, resumen y lista— van con **márgenes** laterales y no con
 * relleno, y el de las filas vive en la lista. Así los filetes de separación, el
 * tinte de la fila resaltada y la barra empiezan y acaban donde empieza el texto
 * (24px del canto en móvil, 32px a partir de `sm`). El texto no se mueve: solo cambia
 * quién pone el relleno.
 */

/** Un participante del torneo, con lo mínimo para pintar la fila. */
export type ObjectiveStandingPlayer = {
  profileId: number;
  name: string;
  avatarUrl: string | null;
  profileUrl: string;
};

export function ObjectiveStandings({  option,
  players,
  highlightProfileId = null,
}: {
  option: ObjectiveOption;
  /** `null` cuando la clasificación no se ha podido leer. */
  players: ObjectiveStandingPlayer[] | null;
  /** Participante a resaltar, para la ficha de un jugador. */
  highlightProfileId?: number | null;
}) {
  if (players === null) {
    return (
      <p className="px-6 py-8 text-center text-sm text-muted sm:px-8">
        No se ha podido cargar la clasificación. Vuelve a intentarlo en unos minutos.
      </p>
    );
  }

  const { rows, contenders } = objectiveStandingsView(
    players,
    option.ranking,
    highlightProfileId,
  );
  // El primero de la lista ya ordenada es el más avanzado. Su valor es la escala de
  // la barra solo donde no hay umbral contra el que medir (competiciones y logros sin
  // tope); en un logro con umbral, la barra se mide contra el umbral y esto no se usa.
  const leader = rows[0]?.contender?.value ?? 0;

  return (
    <>
      <div className="mx-6 flex items-baseline justify-between gap-3 py-3 sm:mx-8">
        <h3 className="font-display text-base font-semibold text-foreground">Clasificación</h3>
        <span className="text-xs tabular-nums text-muted">
          {standingsCountLabel(option, contenders)}
        </span>
      </div>

      <p className="mx-6 border-t border-line py-2.5 text-xs text-muted sm:mx-8">
        {completionSummary(option, contenders)}
      </p>

      {rows.length === 0 ? (
        <p className="mx-6 border-t border-line py-8 text-center text-sm text-muted sm:mx-8">
          {emptyMessage(option)}
        </p>
      ) : (
        <ol className="mx-6 divide-y divide-line border-t border-line sm:mx-8">
          {rows.map(({ participant, contender, position }) => (
            <StandingRow
              key={participant.profileId}
              option={option}
              player={participant}
              contender={contender}
              position={position}
              highlight={participant.profileId === highlightProfileId}
              leader={leader}
            />
          ))}
        </ol>
      )}
    </>
  );
}

function StandingRow({
  option,
  player,
  contender,
  position,
  highlight,
  leader,
}: {
  option: ObjectiveOption;
  player: ObjectiveStandingPlayer;
  /** Entrada del jugador en el ranking del objetivo, o `null` si no lo disputa. */
  contender: ObjectiveContender | null;
  /** Puesto en el objetivo (`1` es el más avanzado), o `null` si no lo disputa. */
  position: number | null;
  highlight: boolean;
  /**
   * Valor del primero de la lista: la escala de la barra donde no hay umbral
   * (competición o logro sin tope). Ver `contenderShareOfObjective`.
   */
  leader: number;
}) {
  const share =
    contender === null ? 0 : contenderShareOfObjective(option, contender, leader);
  // Completado es **llegar al umbral**, no cobrar algo: `imparable` paga desde el
  // primer día. La competición la marca su poseedor, como siempre.
  const completed =
    contender !== null &&
    (option.kind === "competition"
      ? contender.profileId === option.holder?.profileId
      : hasReachedTarget(option, contender.value));

  return (
    <li className={`flex items-center gap-3 py-3 ${highlight ? "bg-accent/5" : ""}`}>
      {/* La barra es fondo del tramo que va del canto del contenido a la cifra, con
          el mismo aire a los dos lados (el `gap` de la fila, 12px): arranca un pelo
          dentro del contenido y el 100 % acaba antes de la columna del número. Va
          detrás de puesto, avatar, nombre y distintivo —por eso el envoltorio la
          aísla, y el `-z-10` la deja por debajo de todo lo suyo— y es decorativa. */}
      <div className="relative isolate flex min-w-0 flex-1 items-center gap-3">
        {share > 0 ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 left-3 right-0 -z-10"
          >
            <span
              className="absolute inset-y-0 left-0 bg-accent/10"
              style={{ width: `${share * 100}%` }}
            />
          </span>
        ) : null}

        <span className="w-6 shrink-0 text-right text-sm tabular-nums text-muted">
          {position === null ? null : position}
        </span>
        <PlayerAvatar name={player.name} avatarUrl={player.avatarUrl} className="size-8 text-xs" />
        <span className="min-w-0 flex-1 truncate text-sm text-foreground/90">
          {/* Solo el nombre es enlace: el hueco de la columna no debe navegar. */}
          <a
            href={player.profileUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="underline-offset-4 transition-colors hover:text-accent hover:underline"
          >
            {player.name}
            <span className="sr-only"> en AoE4World (se abre en una pestaña nueva)</span>
          </a>
          {highlight ? <span className="sr-only"> (jugador de esta ficha)</span> : null}
        </span>

        {/* El distintivo solo se pinta cuando tiene algo que decir: quien ha
            llegado al umbral (logro) o es el poseedor (competición). Quien no,
            no lleva nada: el hueco del distintivo era una redonda vacía que no
            informaba de nada. Y en un logro sin tope tampoco: todo el que sale en
            la lista ya está sumando, así que marcarlos a todos no diría nada. */}
        {!hasNoCap(option) && completed ? (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-xs font-semibold text-accent">
            <CheckIcon />
            {option.kind === "competition" ? "Poseedor" : "Conseguido"}
          </span>
        ) : null}
      </div>

      <span className="shrink-0 text-right text-xs tabular-nums text-foreground/90">
        {contender === null ? (
          <>
            <span aria-hidden="true" className="text-muted/60">
              —
            </span>
            <span className="sr-only">Sin disputar</span>
          </>
        ) : (
          contenderValue(option, contender)
        )}
      </span>
    </li>
  );
}

function CheckIcon() {
  return (
    <svg
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="size-3 shrink-0"
    >
      <path d="M2.5 6.5 5 9l4.5-5.5" />
    </svg>
  );
}
