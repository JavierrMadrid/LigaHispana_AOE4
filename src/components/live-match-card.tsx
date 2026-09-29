import Image from "next/image";
import type { DivisionId, LiveMatch, LiveMatchParticipant } from "@/lib/public";
import { civilizationName } from "@/lib/civs";
import { CivilizationIcon } from "@/components/civilization-icon";
import { divisionColor, divisionLabel } from "@/components/division-icon";
import { LeagueIcon, leagueFilterRank } from "@/components/league-icon";
import { LiveDot } from "@/components/live-dot";
import { formatAbsoluteTime } from "@/lib/format";
import { mapImage } from "@/lib/maps";

/**
 * Una partida en juego, con la alineación completa que resuelve `getLiveMatches()`.
 *
 * La tarjeta se lee como la ficha de un enfrentamiento que está pasando ahora:
 * el mapa ocupa la banda superior, porque es el único asset del juego que el
 * lector reconoce de un vistazo, y debajo van los dos bandos. En un 1vs1 cada
 * lado lleva un jugador, así que la misma rejilla se lee "A contra B"; en 2v2 y
 * superiores cada lado es una columna con sus jugadores. Nunca se repite un
 * nombre ni se pintan dos tarjetas de la misma partida: la alineación ya llega
 * resuelta y sin duplicados.
 *
 * Los participantes de la liga se distinguen por peso de nombre y por el emblema
 * de su división; los rivales de ladder que no están en el torneo se pintan sin
 * emblema, en un tono un punto por debajo. No se pinta avatar: cada jugador lleva
 * su icono de civilización, que es lo que el ojo busca en una partida, y así la
 * fila queda alineada también para los rivales, que no tienen foto.
 */
export function LiveMatchCard({ match }: { match: LiveMatch }) {
  const teams = groupTeams(match.participants);
  const image = mapImage(match.map);
  const mapName = match.map !== null && match.map.trim() !== "" ? match.map : null;

  return (
    <li className="overflow-hidden rounded-lg border border-line bg-surface">
      <h2 className="sr-only">
        {match.format}
        {mapName === null ? "" : ` en ${mapName}`}
        {match.leaguePlayerCount > 1
          ? `, ${match.leaguePlayerCount} jugadores de la liga`
          : match.leaguePlayerCount === 1
            ? ", 1 jugador de la liga"
            : ""}
      </h2>

      <div className="relative aspect-[16/7] w-full overflow-hidden bg-surface-raised">
        {image !== null ? (
          <Image
            src={image}
            alt=""
            fill
            sizes="(min-width: 1024px) 34rem, 100vw"
            className="object-cover"
          />
        ) : (
          // Sin asset no se deja un hueco: la retícula recuerda a un plano y el
          // nombre del mapa, abajo, sigue diciendo qué se está jugando.
          <div
            aria-hidden="true"
            className="absolute inset-0 bg-[repeating-linear-gradient(135deg,var(--line)_0_1px,transparent_1px_10px)]"
          />
        )}

        {/* Velo inferior: da contraste al nombre del mapa sobre la imagen. */}
        <div
          aria-hidden="true"
          className="absolute inset-x-0 bottom-0 h-3/4 bg-gradient-to-t from-background via-background/70 to-transparent"
        />

        <div className="absolute inset-x-0 top-0 flex items-start justify-between gap-2 p-3">
          <span className="inline-flex min-w-0 items-center gap-2 rounded-full border border-line bg-background/80 px-2.5 py-1 text-xs font-semibold text-foreground backdrop-blur">
            <LiveDot />
            {/* El tipo de partida es lo único que puede estirarse: en un móvil
                estrecho se recorta antes que empujar el tiempo fuera de la banda. */}
            <span className="truncate">{match.format}</span>
            <span className="sr-only">en juego</span>
          </span>

          <span
            title={`Empezó a las ${formatAbsoluteTime(match.startedAt)}`}
            className="shrink-0 rounded-full border border-line bg-background/80 px-2.5 py-1 text-xs tabular-nums text-muted backdrop-blur"
          >
            {formatElapsed(match.elapsedSeconds)}
          </span>
        </div>

        <p className="absolute inset-x-0 bottom-0 flex min-w-0 p-3">
          <span
            title={mapName ?? undefined}
            className={`truncate font-display text-sm font-semibold ${
              mapName === null ? "italic text-muted" : "text-foreground"
            }`}
          >
            {mapName ?? "Mapa por determinar"}
          </span>
        </p>
      </div>

      <div className="p-4">
        {teams.length === 2 ? (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-stretch sm:gap-4">
            <TeamBlock participants={teams[0]} label="Equipo 1" />
            <Versus />
            <TeamBlock participants={teams[1]} label="Equipo 2" alignRight />
          </div>
        ) : (
          <ul aria-label="Jugadores de la partida" className="flex flex-col gap-2">
            {match.participants.map((participant, index) => (
              <ParticipantRow
                key={`${participant.profileId ?? "sin-perfil"}-${index}`}
                participant={participant}
              />
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}

/**
 * Un bando. Cuando los dos lados tienen un solo jugador la fila se lee como un
 * duelo; con más jugadores, como una alineación por equipos.
 */
function TeamBlock({
  participants,
  label,
  alignRight = false,
}: {
  participants: LiveMatchParticipant[];
  label: string;
  alignRight?: boolean;
}) {
  return (
    <ul aria-label={label} className="flex min-w-0 flex-1 flex-col gap-2">
      {participants.map((participant, index) => (
        <ParticipantRow
          key={`${participant.profileId ?? "sin-perfil"}-${index}`}
          participant={participant}
          alignRight={alignRight}
        />
      ))}
    </ul>
  );
}

/**
 * Separador de bandos: una raya con "vs" en medio. Horizontal en móvil (donde
 * los equipos se apilan) y vertical a partir de `sm`.
 */
function Versus() {
  return (
    <div
      aria-hidden="true"
      className="flex items-center gap-3 sm:w-10 sm:flex-col sm:gap-2"
    >
      <span className="h-px flex-1 bg-line sm:h-auto sm:w-px sm:flex-1" />
      <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted/80">
        vs
      </span>
      <span className="h-px flex-1 bg-line sm:h-auto sm:w-px sm:flex-1" />
    </div>
  );
}

function ParticipantRow({
  participant,
  alignRight = false,
}: {
  participant: LiveMatchParticipant;
  alignRight?: boolean;
}) {
  const name = participant.name.trim();
  const unknown = name === "";
  const label = unknown ? "Jugador sin identificar" : name;

  return (
    <li className={`flex min-w-0 items-center gap-2.5${alignRight ? " justify-end" : ""}`}>
      <CivilizationIcon
        civ={participant.civ}
        className="size-6 shrink-0"
        label={participant.civ === null ? undefined : civilizationName(participant.civ)}
      />

      {participant.isLeaguePlayer && participant.profileUrl !== null ? (
        <a
          href={participant.profileUrl}
          target="_blank"
          rel="noopener noreferrer"
          title={label}
          className="min-w-0 truncate font-semibold text-foreground underline-offset-4 transition-colors hover:text-accent hover:underline"
        >
          {label}
          <span className="sr-only">
            , perfil en AoE4World (se abre en una pestaña nueva)
          </span>
        </a>
      ) : (
        <span
          title={label}
          className={`min-w-0 truncate ${
            participant.isLeaguePlayer
              ? "font-semibold text-foreground"
              : unknown
                ? "italic text-muted"
                : "text-foreground/80"
          }`}
        >
          {label}
        </span>
      )}

      {participant.division !== null ? (
        <DivisionBadge division={participant.division} />
      ) : null}
    </li>
  );
}

/**
 * Emblema de la división del jugador de la liga. El color y la forma ya dicen
 * cuál es; el `title` y el texto oculto lo dicen también sin depender del color.
 */
function DivisionBadge({ division }: { division: DivisionId }) {
  const label = divisionLabel(division);

  return (
    <span
      title={label}
      style={{ color: divisionColor(division) }}
      className="inline-flex shrink-0 items-center"
    >
      <LeagueIcon rank={leagueFilterRank(division)} className="h-5 w-3.5" />
      <span className="sr-only">{label}, jugador de la liga</span>
    </span>
  );
}

/**
 * Agrupa la alineación por equipo conservando el orden de la API.
 *
 * Devuelve una lista vacía si algún jugador no tiene equipo: en el degradado sin
 * `rawJson` los bandos son desconocidos y suponerlos sería pintar un dato falso,
 * así que quien llama cae a la lista plana.
 */
function groupTeams(participants: readonly LiveMatchParticipant[]): LiveMatchParticipant[][] {
  const teams = new Map<number, LiveMatchParticipant[]>();

  for (const participant of participants) {
    if (participant.team === null) {
      return [];
    }

    const list = teams.get(participant.team) ?? [];
    list.push(participant);
    teams.set(participant.team, list);
  }

  return [...teams.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, list]) => list);
}

/**
 * Tiempo transcurrido desde el arranque de la partida, en la unidad que se lee
 * de un vistazo. La ventana de una partida en juego es de una hora, así que lo
 * normal son minutos; la hora se contempla por si el dato llega con retraso.
 */
function formatElapsed(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);

  if (minutes < 1) {
    return "menos de 1 min";
  }

  if (minutes < 60) {
    return `${minutes} min`;
  }

  const hours = Math.floor(minutes / 60);

  return `${hours} h ${minutes % 60} min`;
}
