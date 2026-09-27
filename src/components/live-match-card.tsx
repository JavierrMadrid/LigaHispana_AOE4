import { describeMode, formatAbsoluteTime, formatRelativeTime } from "@/lib/format";
import type { LiveMatchRow } from "@/lib/public";

/**
 * Una partida en directo, con la lista de jugadores de la liga que están en ella.
 *
 * No es una tabla porque el contenido no es una rejilla de cifras: es un bloque
 * corto que se lee mejor apilado, y así no se rompe en móvil.
 */
export function LiveMatchCard({ rows, now }: { rows: LiveMatchRow[]; now: Date }) {
  const [first] = rows;
  const teammates = rows.length > 1;

  return (
    <li className="rounded-lg border border-line bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="font-semibold text-foreground">
          {describeMode(first.mode, first.leaderboard)}
        </span>
        {first.map !== null ? (
          <span className="text-sm text-muted">{first.map}</span>
        ) : null}
        {teammates ? (
          <span className="text-xs text-muted">
            {rows.length} jugadores de la liga en esta partida
          </span>
        ) : null}
        <time
          dateTime={first.startedAt.toISOString()}
          title={`Empezó a las ${formatAbsoluteTime(first.startedAt)}`}
          className="ml-auto text-xs tabular-nums text-muted"
        >
          {formatRelativeTime(first.startedAt, now)}
        </time>
      </div>

      <ul className="mt-4 flex flex-col gap-2 border-t border-line pt-4">
        {rows.map((row) => (
          <li key={row.id} className="flex flex-wrap items-baseline gap-x-2 text-sm">
            <span className="font-medium text-foreground">{row.playerName}</span>
            {row.civ !== null ? (
              <span className="text-xs text-muted">({row.civ})</span>
            ) : null}
            <span>
              <span className="text-muted">contra </span>
              <span
                className={
                  row.opponentName === null
                    ? "italic text-muted"
                    : "text-foreground/85"
                }
              >
                {row.opponentName ?? "rival por determinar"}
              </span>
            </span>
            {row.opponentCiv !== null ? (
              <span className="text-xs text-muted">({row.opponentCiv})</span>
            ) : null}
          </li>
        ))}
      </ul>
    </li>
  );
}