import type { ObjectiveContender, ObjectiveOption } from "@/lib/public";
import {
  completionSummary,
  contenderValue,
  orderByObjectiveRanking,
} from "@/lib/objective-format";
import { PlayerAvatar } from "@/components/player-avatar";

/**
 * Clasificación de un objetivo: el listado de participantes del torneo con su
 * avance y un check en quien lo ha completado (logro) o en su poseedor
 * (competición).
 *
 * El orden es el **ranking del objetivo** (`option.ranking`), de más a menos: el
 * que va primero es el más avanzado. Quien **no disputa** el objetivo ahora mismo
 * —no aparece en el ranking— queda al final, en el orden de la clasificación
 * general, y se queda sin valor ni posición, sin inventarle un cero. El número de
 * cada fila es esa posición dentro del objetivo (`1` es el líder); el avance sale
 * del ranking cruzado por `profileId`: en un logro es `value/target` (12/23
 * civilizaciones, 2/3 victorias) y en una competición el valor de su métrica
 * (victorias, partidas, racha), que es lo que le da su posición.
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
      <p className="px-4 py-8 text-center text-sm text-muted sm:px-6">
        No se ha podido cargar la clasificación. Vuelve a intentarlo en unos minutos.
      </p>
    );
  }

  const completed = completedProfileIds(option);
  const orderedPlayers = orderByObjectiveRanking(players, option.ranking);

  return (
    <>
      <div className="flex items-baseline justify-between gap-3 px-4 py-3 sm:px-6">
        <h3 className="font-display text-base font-semibold text-foreground">Clasificación</h3>
        <span className="text-xs tabular-nums text-muted">
          {players.length === 1 ? "1 participante" : `${players.length} participantes`}
        </span>
      </div>

      <p className="border-t border-line px-4 py-2.5 text-xs text-muted sm:px-6">
        {completionSummary(option, players.length)}
      </p>

      {players.length === 0 ? (
        <p className="border-t border-line px-4 py-8 text-center text-sm text-muted sm:px-6">
          Todavía no hay participantes en la clasificación.
        </p>
      ) : (
        <ol className="divide-y divide-line border-t border-line">
          {orderedPlayers.map(({ participant, contender, position }) => (
            <StandingRow
              key={participant.profileId}
              option={option}
              player={participant}
              contender={contender}
              position={position}
              achieved={completed.has(participant.profileId)}
              highlight={participant.profileId === highlightProfileId}
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
}: {
  option: ObjectiveOption;
  player: ObjectiveStandingPlayer;
  /** Entrada del jugador en el ranking del objetivo, o `null` si no lo disputa. */
  contender: ObjectiveContender | null;
  /** Puesto en el objetivo (`1` es el más avanzado), o `null` si no lo disputa. */
  position: number | null;
  achieved: boolean;
  highlight: boolean;
}) {
  return (
    <li
      className={`flex items-center gap-3 px-4 py-3 sm:px-6 ${highlight ? "bg-accent/5" : ""}`}
    >
      <span className="w-6 shrink-0 text-right text-sm tabular-nums text-muted">
        {position === null ? null : position}
      </span>
      <PlayerAvatar name={player.name} avatarUrl={player.avatarUrl} className="size-8 text-xs" />
      <a
        href={player.profileUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="min-w-0 flex-1 truncate text-sm text-foreground/90 underline-offset-4 transition-colors hover:text-accent hover:underline"
      >
        {player.name}
        <span className="sr-only"> en AoE4World (se abre en una pestaña nueva)</span>
      </a>

      {achieved ? (
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
