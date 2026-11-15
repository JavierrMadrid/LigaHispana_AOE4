import Image from "next/image";
import { ArrowUpRight } from "@phosphor-icons/react/dist/csr/ArrowUpRight";
import { Broadcast } from "@phosphor-icons/react/dist/csr/Broadcast";
import { Clock } from "@phosphor-icons/react/dist/csr/Clock";
import { MapTrifold } from "@phosphor-icons/react/dist/csr/MapTrifold";
import { SquaresFour } from "@phosphor-icons/react/dist/csr/SquaresFour";
import type { DivisionId, LiveMatch, LiveMatchParticipant } from "@/lib/public";
import { civilizationName } from "@/lib/civs";
import { countryFlagUrl } from "@/lib/flag";
import { ChannelLinks } from "@/components/channel-links";
import { CivilizationIcon } from "@/components/civilization-icon";
import { divisionLabel } from "@/components/division-icon";
import { LeagueIcon, leagueFilterRank } from "@/components/league-icon";
import {
  liveChannelValues,
  matchLiveChannels,
  participantIsLive,
} from "@/components/live-channels";
import { formatAbsoluteTime, multistreamViewerUrl } from "@/lib/format";
import { mapImage } from "@/lib/maps";
import { normalizeTwitchChannel } from "@/lib/stream-channels";
import { MatchTwitchPreview } from "@/components/match-twitch-preview";

export function LiveMatchCard({
  match,
  previewThumbnails = false,
}: {
  match: LiveMatch;
  previewThumbnails?: boolean;
}) {
  const teams = groupTeams(match.participants);
  const image = mapImage(match.map);
  const mapName = match.map?.trim() || "Mapa por determinar";
  const livePlayerCount = match.participants.filter(participantIsLive).length;
  const twitch = match.participants.flatMap((player) => {
    const login = player.twitchIsLive
      ? normalizeTwitchChannel(player.twitchChannel)
      : null;
    return login ? [{ login, name: player.name.trim() || login }] : [];
  })[0];
  const multistream = multistreamViewerUrl(
    matchLiveChannels(match.participants)
  );
  return (
    <li className="matches-card">
      <article aria-labelledby={`match-${match.gameId}`}>
        <header className="matches-map">
          {image ? (
            <Image
              src={image}
              alt=""
              fill
              sizes="(min-width:1440px) 550px, (min-width:1100px) 40vw, (min-width:768px) 50vw, 100vw"
              className="matches-map-image"
            />
          ) : (
            <div className="matches-map-fallback" aria-hidden="true">
              <MapTrifold size={40} />
            </div>
          )}
          {twitch ? (
            <MatchTwitchPreview
              key={twitch.login}
              login={twitch.login}
              name={twitch.name}
              previewSrc={
                previewThumbnails
                  ? image ?? "/imagenes/portada/aoe4-hre-panorama.webp"
                  : undefined
              }
            />
          ) : null}
          <div className="matches-map-veil" aria-hidden="true" />
          <div className="matches-map-top">
            <span className="matches-format">
              <span className="matches-live-dot" aria-hidden="true" />
              {match.format}
              <span className="sr-only"> en juego</span>
            </span>
            <span
              className="matches-elapsed"
              title={`Empezó a las ${formatAbsoluteTime(match.startedAt)}`}
            >
              <Clock size={14} aria-hidden="true" />
              {formatElapsed(match.elapsedSeconds)}
            </span>
          </div>
          <h2 id={`match-${match.gameId}`}>
            <MapTrifold size={16} aria-hidden="true" />
            {mapName}
          </h2>
        </header>
        <div className="matches-card-meta">
          <span>
            {match.leaguePlayerCount === 1
              ? "1 jugador de la liga"
              : `${match.leaguePlayerCount} jugadores de la liga`}
          </span>
          {livePlayerCount > 0 ? (
            <span className="matches-broadcast-count">
              <Broadcast size={14} aria-hidden="true" />
              {livePlayerCount} en directo
            </span>
          ) : (
            <span>Sin directo confirmado</span>
          )}
        </div>
        <div className="matches-roster">
          {teams.length === 2 ? (
            <div className="matches-duel">
              <TeamBlock participants={teams[0]} label="Equipo 1" />
              <span className="matches-versus" aria-hidden="true">
                vs
              </span>
              <TeamBlock participants={teams[1]} label="Equipo 2" />
            </div>
          ) : (
            <div className="matches-flat-roster">
              <p>Alineación de la partida</p>
              <ul aria-label="Jugadores de la partida">
                {match.participants.map((participant, index) => (
                  <ParticipantRow
                    key={`${participant.profileId ?? "unknown"}-${index}`}
                    participant={participant}
                  />
                ))}
              </ul>
            </div>
          )}
        </div>
        {multistream ? (
          <footer className="matches-card-footer">
            <a
              href={multistream}
              target="_blank"
              rel="noopener noreferrer"
              title="Visor multi-stream de StreamsCharts"
            >
              <SquaresFour size={17} aria-hidden="true" />
              Ver directos a la vez
              <ArrowUpRight size={15} aria-hidden="true" />
            </a>
          </footer>
        ) : null}
      </article>
    </li>
  );
}

function TeamBlock({
  participants,
  label,
}: {
  participants: LiveMatchParticipant[];
  label: string;
}) {
  return (
    <div className="matches-team">
      <p>{label}</p>
      <ul aria-label={label}>
        {participants.map((participant, index) => (
          <ParticipantRow
            key={`${participant.profileId ?? "unknown"}-${index}`}
            participant={participant}
          />
        ))}
      </ul>
    </div>
  );
}

function ParticipantRow({
  participant,
}: {
  participant: LiveMatchParticipant;
}) {
  const name = participant.name.trim() || "Jugador sin identificar";
  const country = participant.country
    ? countryFlagUrl(participant.country)
    : null;
  const civ = participant.civ
    ? civilizationName(participant.civ)
    : "Civilización sin publicar";
  return (
    <li
      className={`matches-player ${
        participant.isLeaguePlayer ? "matches-league-player" : ""
      }`}
    >
      <CivilizationIcon
        civ={participant.civ}
        className="matches-civ"
        label={civ}
      />
      <div className="matches-player-copy">
        <div className="matches-player-name">
          {participant.isLeaguePlayer && participant.profileUrl ? (
            <a
              href={participant.profileUrl}
              target="_blank"
              rel="noopener noreferrer"
              title={`${name}, perfil en AoE4World (se abre en otra pestaña)`}
            >
              {name}
            </a>
          ) : (
            <span title={name}>{name}</span>
          )}
          {country ? (
            <Image
              src={country}
              alt={participant.country ?? ""}
              width={18}
              height={12}
              unoptimized
              style={{ height: "auto" }}
              className="matches-country"
            />
          ) : null}
        </div>
        <div className="matches-player-detail">
          <span title={civ}>{civ}</span>
          <ChannelLinks name={name} {...liveChannelValues(participant)} />
        </div>
      </div>
      {participant.division ? (
        <DivisionBadge division={participant.division} />
      ) : null}
    </li>
  );
}

function DivisionBadge({ division }: { division: DivisionId }) {
  return (
    <span
      title={`${divisionLabel(division)}, jugador de la liga`}
      className="matches-player-division"
    >
      <LeagueIcon rank={leagueFilterRank(division)} className="matches-rank" />
      <span className="sr-only">
        {divisionLabel(division)}, jugador de la liga
      </span>
    </span>
  );
}

function groupTeams(
  participants: readonly LiveMatchParticipant[]
): LiveMatchParticipant[][] {
  const teams = new Map<number, LiveMatchParticipant[]>();
  for (const participant of participants) {
    if (participant.team === null) return [];
    const list = teams.get(participant.team) ?? [];
    list.push(participant);
    teams.set(participant.team, list);
  }
  return [...teams.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, list]) => list);
}

function formatElapsed(seconds: number): string {
  const minutes = Math.floor(Math.max(0, seconds) / 60);
  if (minutes < 1) return "menos de 1 min";
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
