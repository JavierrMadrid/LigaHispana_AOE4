import { ObjectiveIcon } from "@/components/objective-icon";
import { describeMode, formatAbsoluteTime, formatRelativeTime } from "@/lib/format";
import { objectiveTitle } from "@/lib/objective-format";
import {
  OBJECTIVE_GROUP_LABELS,
  type PointHistoryRow as PointHistoryEntry,
} from "@/lib/public";

/**
 * La frase de una fila de objetivo: `cumplió «2 x Imparable»`,
 * `ahora lidera «Rey del 1v1»` o `ya no lidera «Rey del 1v1»`.
 *
 * Un **logro** se cumple una vez, así que dice `cumplió`. Una **competición** no
 * se cumple: se gana y se pierde cuantas veces cambie de manos, así que su verbo
 * es el del instante de la fila —`ahora lidera` o `ya no lidera`, el mismo para
 * todas las competiciones—, y decirle "cumplió" a la fila de la pérdida afirmaría
 * lo contrario de lo que pasó.
 */
function describeObjectiveGain(
  objective: NonNullable<PointHistoryEntry["objective"]>,
): string {
  const titulo = `«${objectiveTitle(objective)}»`;

  if (objective.lead === "GAINED") {
    return `ahora lidera ${titulo}`;
  }

  if (objective.lead === "LOST") {
    return `ya no lidera ${titulo}`;
  }

  return `cumplió ${titulo}`;
}

/**
 * La frase de una ganancia, sin el nombre delante: `ganó a Chocola`, `ganó la
 * partida 2vs2` o la frase del objetivo de más abajo.
 *
 * En un **1v1** se nombra al rival, que es lo que la frase añade; en una partida
 * **por equipos** no, y es importante: `Match` guarda un solo rival —el primer
 * jugador del equipo contrario—, así que decir "ganó a X" en un 2v2 nombraría a uno
 * de los dos y haría creer que era un 1v1. Se dice el **formato** en su lugar, que
 * es el dato que sí es cierto y completo. `formato` sale de `teamSize` (el recuento
 * real del payload) y cae a `describeMode` cuando el payload no lo permite; un
 * formato vacío —una fila sin `mode` ni `leaderboard`— se queda en "ganó la
 * partida", que sigue siendo cierto.
 *
 * Un **objetivo** no tiene resultado de partida, así que se sale antes de las ramas
 * de victoria: sin esa salida, la frase lo describiría como una partida.
 */
function describeGain(row: PointHistoryEntry, formato: string): string {
  if (row.objective !== null) {
    return describeObjectiveGain(row.objective);
  }

  if (formato === "1vs1") {
    return row.opponentName === null ? "ganó la partida" : `ganó a ${row.opponentName}`;
  }

  return formato === "" ? "ganó la partida" : `ganó la partida ${formato}`;
}

/**
 * Los datos secundarios de la fila, tras la fecha: el grupo del objetivo de la
 * fila —logro cumplido o cambio de poseedor—, o el formato de la partida con su
 * mapa.
 *
 * Los dos ejes van en la misma línea y con el mismo registro porque son lo mismo:
 * el contexto que sitúa la ganancia. Un mapa sin formato o un formato sin mapa no
 * dejan un separador suelto.
 */
function describeContext(row: PointHistoryEntry, formato: string): string {
  if (row.objective !== null) {
    return OBJECTIVE_GROUP_LABELS[row.objective.group];
  }

  return [formato, row.map ?? ""].filter((part) => part !== "").join(" · ");
}

/**
 * Una fila del feed: una victoria clasificatoria, un objetivo cumplido o un cambio
 * de poseedor de una competición.
 *
 * La fila lleva la fecha (relativa, con el instante exacto en el `title` y en el
 * `datetime` del `<time>`), la frase de la ganancia y, a la derecha, lo que sumó.
 * Los objetivos —logros y liderazgos— van teñidos del oro de la liga —el mismo
 * tono con el que la clasificación y el panel marcan un hito—, y además llevan su
 * glifo, para que el color no sea la única señal de que esa fila no es una
 * partida.
 *
 * ## La fila de un liderazgo
 *
 * Cuando una competición cambia de manos, el historial lo cuenta dos veces: quien
 * la gana (`ahora lidera`, puntos en positivo) y quien la pierde (`ya no lidera`,
 * puntos en negativo). Es la misma clase de hecho que un logro —algo que le pasa
 * a un jugador con un objetivo del catálogo— y por eso comparte su oro; lo que
 * las separa es el verbo y el signo, no el fondo.
 *
 * Los puntos de un liderazgo son **informativos**: una pérdida no resta nada de la
 * clasificación, y el precio que enseña la fila es el del ruleset. El signo lo
 * pinta la interfaz, y por eso la cifra negativa no se confunde con la ganancia
 * revertida de más abajo: la revertida se apaga, se tacha y se queda sin cifra
 * porque su importe ya no es fiable, mientras que la pérdida de un liderazgo va
 * entera —frase y cifra— porque lo que cambió es el poseedor, no el precio.
 *
 * ## La ganancia revertida
 *
 * Una victoria revertida por la organización **no cuenta**, y la fila lo dice: la
 * frase va tachada y debajo hay una marca con texto —"Revertida por la
 * organización" y el día del revert—, porque un tachado solo no comunica nada a
 * quien usa un lector de pantalla. La columna de puntos se deja **vacía**: el
 * importe de una revertida puede venir a cero o con el valor de antes (el motor
 * pone `Match.points` a cero al recalcular), así que publicar la cifra afirmaría
 * algo que la fila no puede sostener. Lo que no se calla es la marca.
 *
 * El tratamiento es el mismo en el historial global y en el de un participante:
 * las dos pantallas montan esta pieza, así que no pueden divergir.
 */
export function PointHistoryRow({ row }: { row: PointHistoryEntry }) {
  const reverted = row.revertedAt !== null;
  // `teamSize` manda sobre `describeMode` cuando existe: es el recuento real de
  // `rawJson`, no una etiqueta deducida.
  const formato = row.teamSize ?? describeMode(row.mode, row.leaderboard);

  return (
    <li
      className={`grid gap-x-4 gap-y-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start ${
        row.objective === null ? "" : "bg-accent/[0.06]"
      }`}
    >
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted">
          <time
            dateTime={row.startedAt.toISOString()}
            title={formatAbsoluteTime(row.startedAt)}
            className="tabular-nums"
          >
            {formatRelativeTime(row.startedAt)}
          </time>
          <span aria-hidden="true">·</span>
          <span>{describeContext(row, formato)}</span>
        </p>

        <p
          className={`mt-0.5 flex items-start gap-2 text-sm ${
            reverted ? "text-muted" : "text-foreground"
          }`}
        >
          {row.objective !== null ? (
            <ObjectiveIcon option={row.objective} className="mt-0.5 size-5 shrink-0" />
          ) : null}
          <span
            className={`min-w-0 ${reverted ? "line-through decoration-line-strong" : ""}`}
          >
            <strong className="font-medium">{row.playerName}</strong>{" "}
            {describeGain(row, formato)}
          </span>
        </p>

        {row.revertedAt !== null ? (
          <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
            <span className="inline-block rounded-full border border-line-strong px-2 py-0.5 font-medium">
              Revertida por la organización
            </span>
            <span>
              el{" "}
              <time dateTime={row.revertedAt.toISOString()} className="tabular-nums">
                {formatAbsoluteTime(row.revertedAt)}
              </time>
            </span>
          </p>
        ) : null}
      </div>

      {reverted ? null : (
        <p className="shrink-0 font-display text-lg font-semibold leading-none tabular-nums text-accent sm:text-right">
          {/* El signo lo decide la interfaz: `+` en lo que suma y `−` en la
              pérdida de un liderazgo, que es informativa. El signo menos
              tipográfico —no el guion— se alinea con las cifras tabulares y se
              lee como una resta. */}
          {row.objective?.lead === "LOST" ? "−" : "+"}
          {row.points}
          <span className="sr-only"> puntos</span>
        </p>
      )}
    </li>
  );
}

/**
 * El feed de ganancias, ya paginado por quien lo lee: una lista de filas sobre el
 * mismo bloque de `surface`, separadas por filete.
 *
 * La monta el historial global y la pestaña de historial de un participante, así
 * que el cromo de la lista —y no solo el de la fila— vive aquí: dos copias del
 * mismo `<ul>` se separarían en cuanto una cambiara de bordes.
 */
export function PointHistoryList({ rows }: { rows: readonly PointHistoryEntry[] }) {
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
      {rows.map((row) => (
        <PointHistoryRow key={row.id} row={row} />
      ))}
    </ul>
  );
}
