import type { ObjectiveContender, ObjectiveOption } from "@/lib/public";
import {
  completionSummary,
  contenderShare,
  contenderValue,
  hasNoCap,
  objectiveStandingsView,
  standingsCountLabel,
} from "@/lib/objective-format";
import { emptyMessage } from "@/components/objective-card";
import { PlayerAvatar } from "@/components/player-avatar";

/**
 * Clasificación de un objetivo: la lista de **quien lo disputa**, con su avance y
 * un check en quien lo ha completado (logro) o en su poseedor (competición); en un
 * logro **sin tope** no hay check que poner, porque lo cobra todo el que suma.
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
 * posición. Cada fila lleva además una barra de fondo con su parte del valor del
 * líder, para comparar la distancia de un vistazo.
 */

/** Un participante del torneo, con lo mínimo para pintar la fila. */
export type ObjectiveStandingPlayer = {
  profileId: number;
  name: string;
  avatarUrl: string | null;
  profileUrl: string;
};

/**
 * Los `profileId` que han cumplido un objetivo, sean beneficiarios de un logro
 * o el poseedor de una competición. Es puro: solo depende del objetivo.
 */
export function completedProfileIds(option: ObjectiveOption): Set<number> {
  if (option.kind === "achievement") {
    return new Set(option.beneficiaries.map((beneficiary) => beneficiary.profileId));
  }

  return option.holder === null ? new Set() : new Set([option.holder.profileId]);
}

export function ObjectiveStandings({
  option,
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

  const completed = completedProfileIds(option);
  const { rows, contenders } = objectiveStandingsView(
    players,
    option.ranking,
    highlightProfileId,
  );
  // El primero de la lista ya ordenada es el más avanzado: su valor es la escala
  // de la barra de fondo del resto.
  const leader = rows[0]?.contender?.value ?? 0;

  return (
    <>
      <div className="flex items-baseline justify-between gap-3 px-6 py-3 sm:px-8">
        <h3 className="font-display text-base font-semibold text-foreground">Clasificación</h3>
        <span className="text-xs tabular-nums text-muted">
          {standingsCountLabel(option, contenders)}
        </span>
      </div>

      <p className="border-t border-line px-6 py-2.5 text-xs text-muted sm:px-8">
        {completionSummary(option, contenders)}
      </p>

      {rows.length === 0 ? (
        <p className="border-t border-line px-6 py-8 text-center text-sm text-muted sm:px-8">
          {emptyMessage(option)}
        </p>
      ) : (
        <ol className="divide-y divide-line border-t border-line">
          {rows.map(({ participant, contender, position }) => (
            <StandingRow
              key={participant.profileId}
              option={option}
              player={participant}
              contender={contender}
              position={position}
              achieved={completed.has(participant.profileId)}
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
  achieved,
  highlight,
  leader,
}: {
  option: ObjectiveOption;
  player: ObjectiveStandingPlayer;
  /** Entrada del jugador en el ranking del objetivo, o `null` si no lo disputa. */
  contender: ObjectiveContender | null;
  /** Puesto en el objetivo (`1` es el más avanzado), o `null` si no lo disputa. */
  position: number | null;
  achieved: boolean;
  highlight: boolean;
  /** Valor del primero de la lista, para escalar la barra de fondo. */
  leader: number;
}) {
  const share = contender === null ? 0 : contenderShare(contender.value, leader);

  return (
    <li
      className={`relative isolate flex items-center gap-3 px-6 py-3 sm:px-8 ${highlight ? "bg-accent/5" : ""}`}
    >
      {/* Barra de fondo: la parte del líder que vale esta fila. Es decorativa —la
          cifra ya está a la derecha— y va por detrás del texto (`-z-10` dentro del
          contexto que abre `isolate`), así que no compite con él ni con el check. */}
      {share > 0 ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 left-0 -z-10 bg-accent/10"
          style={{ width: `${share * 100}%` }}
        />
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

      {/* En un logro sin tope no hay distintivo: todo el que sale en la lista ya
          está sumando, así que marcarlos a todos con el check no diría nada. */}
      {hasNoCap(option) ? null : achieved ? (
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-xs font-semibold text-accent">
          <CheckIcon />
          {option.kind === "competition" ? "Poseedor" : "Conseguido"}
        </span>
      ) : (
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-line text-muted/50">
          <span className="sr-only">Sin completar</span>
        </span>
      )}

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
