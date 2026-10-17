"use client";

import type { ParticipantIdentity } from "@/lib/public";
import { divisionColor } from "@/components/division-icon";
import { LeagueIcon, leagueFilterRank, rankLevelToLeague } from "@/components/league-icon";
import { PlayerAvatar } from "@/components/player-avatar";
import { StatFigure } from "@/components/stat-figure";

/**
 * Las cifras de la cabecera del participante, ya contadas.
 *
 * Las cuenta el layout —que es quien tiene la ficha leída— y llegan resueltas
 * para que esta cabecera no arrastre el avance entero al navegador: recibe tres
 * números, no las 83 opciones del catálogo con sus rankings.
 */
export type ParticipantFigures = {
  /** Objetivos que ya cobra. Cuenta el catálogo entero: los carruseles también. */
  owned: number;
  /** Objetivos activos, que es el denominador de "en posesión". */
  total: number;
  /** Puntos que reparten los objetivos que ya cobra. */
  points: number;
  /** Objetivos en los que cuenta sin haberlos cobrado todavía. */
  contending: number;
};

/**
 * Cabecera del participante: quién es, su liga y sus tres cifras.
 *
 * Es la parte de la ficha que no cambia al pasar de una pestaña a otra, así que
 * vive en el layout; la entradilla del mejor objetivo, que es de la pestaña de
 * objetivos, va dentro de esa pestaña.
 *
 * La identidad entera es un solo enlace a AoE4World (avatar, nombre y emblema).
 *
 * El componente es de cliente por el **emblema**: el rango exacto del escudo lo
 * resuelve `league-icon` (`rankLevelToLeague` traduce `"gold_2"` al escalón que
 * dibuja el SVG), y ese módulo es de cliente, así que el servidor no puede llamar
 * a sus funciones. Por eso la cabecera recibe del layout la identidad y las tres
 * cifras ya contadas —no el avance entero— y por eso el layout cuenta. Se pinta
 * igualmente en el HTML (un componente de cliente se renderiza en el servidor),
 * así que verse, se ve sin JavaScript.
 */
export function ParticipantHeader({
  player,
  figures,
}: {
  player: ParticipantIdentity;
  figures: ParticipantFigures;
}) {
  // El emblema sale del `rankLevel` en crudo, como en la clasificación; si no
  // está, cae al emblema de la división ya resuelta. Un jugador sin clasificar
  // no pinta escudo.
  const league =
    rankLevelToLeague(player.rankLevel) ??
    (player.division === null ? null : leagueFilterRank(player.division));

  return (
    <header className="thread-top relative overflow-hidden rounded-lg border border-line bg-surface px-5 py-5">
      <div className="flex flex-wrap items-start gap-x-6 gap-y-4">
        <a
          href={player.profileUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="group flex min-w-0 items-center gap-4 rounded-sm"
        >
          <PlayerAvatar
            name={player.name}
            avatarUrl={player.avatarUrl}
            className="size-16 text-lg"
          />
          <span className="min-w-0">
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate font-display text-2xl font-semibold text-foreground underline-offset-4 transition-colors group-hover:text-accent group-hover:underline">
                {player.name}
              </span>
              {league !== null ? (
                <span
                  className="inline-flex shrink-0"
                  style={{ color: divisionColor(league.division) }}
                >
                  <LeagueIcon rank={league} label={league.label} className="h-7 w-5" />
                </span>
              ) : null}
            </span>
            <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted">
              {league === null ? (
                <span>Sin clasificar</span>
              ) : (
                <span style={{ color: divisionColor(league.division) }}>{league.label}</span>
              )}
              <span className="underline-offset-4 transition-colors group-hover:text-accent">
                Perfil en AoE4World
              </span>
            </span>
          </span>
          <span className="sr-only">(se abre en una pestaña nueva)</span>
        </a>

        <dl className="ml-auto flex flex-wrap items-start gap-x-8 gap-y-3">
          <StatFigure
            label="Objetivos en posesión"
            value={`${figures.owned} de ${figures.total}`}
          />
          <StatFigure label="Puntos de objetivos" value={String(figures.points)} accent />
          <StatFigure label="Al alcance" value={String(figures.contending)} />
        </dl>
      </div>
    </header>
  );
}
