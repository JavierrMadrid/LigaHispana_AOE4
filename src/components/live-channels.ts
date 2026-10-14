import type { ChannelValue } from "@/components/channel-links";
import type { StreamChannel } from "@/lib/format";
import type { LiveMatchParticipant } from "@/lib/public";

/**
 * Quién está retransmitiendo **de verdad**, leído de los seis campos planos de un
 * participante.
 *
 * Es el único sitio que decide eso, y el criterio es más estricto de lo que
 * parece: el `…IsLive` de la capa de datos llega a `false` también cuando no se ha
 * podido comprobar la plataforma (sin credenciales de YouTube, por ejemplo). Un
 * canal **sin comprobar** no es un directo que se pueda ver, así que cuenta como
 * directo solo el que tiene canal no nulo **y** comprobado en emisión.
 *
 * Vive fuera del componente de la tarjeta porque la pregunta la hacen dos: el
 * filtro "En directo" de la lista (¿entra esta partida?) y la propia tarjeta (¿qué
 * iconos pinto y qué canales mando al visor multi-stream?).
 */
type ParticipantChannels = Pick<
  LiveMatchParticipant,
  | "twitchChannel"
  | "twitchIsLive"
  | "youtubeChannel"
  | "youtubeIsLive"
  | "kickChannel"
  | "kickIsLive"
>;

/** El canal de una plataforma, pero solo si está emitiendo ahora mismo. */
function liveChannel(channel: string | null, isLive: boolean): ChannelValue | null {
  return channel !== null && isLive ? { channel, isLive: true } : null;
}

/**
 * Los canales **en directo** de un participante, en la forma que come
 * `ChannelLinks`. Las plataformas que no emiten salen `null` y el componente no
 * las pinta: aquí no se enseña el canal apagado, solo lo que se puede ir a ver.
 */
export function liveChannelValues(participant: ParticipantChannels): {
  twitch: ChannelValue | null;
  youtube: ChannelValue | null;
  kick: ChannelValue | null;
} {
  return {
    twitch: liveChannel(participant.twitchChannel, participant.twitchIsLive),
    youtube: liveChannel(participant.youtubeChannel, participant.youtubeIsLive),
    kick: liveChannel(participant.kickChannel, participant.kickIsLive),
  };
}

/** ¿Tiene este participante algo que ver ahora mismo? */
export function participantIsLive(participant: ParticipantChannels): boolean {
  const channels = liveChannelValues(participant);

  return channels.twitch !== null || channels.youtube !== null || channels.kick !== null;
}

/**
 * Los canales en directo de toda la partida, en orden de participante y de
 * plataforma. Es la entrada de `multistreamViewerUrl`, que se queda con los de
 * Twitch y Kick y decide si con ellos hay visor o no.
 *
 * El orden importa y es el de la alineación: el enlace del visor sale idéntico
 * entre dos lecturas de la misma partida.
 */
export function matchLiveChannels(participants: readonly ParticipantChannels[]): StreamChannel[] {
  const channels: StreamChannel[] = [];

  for (const participant of participants) {
    const live = liveChannelValues(participant);

    if (live.twitch !== null) {
      channels.push({ platform: "twitch", channel: live.twitch.channel });
    }

    if (live.youtube !== null) {
      channels.push({ platform: "youtube", channel: live.youtube.channel });
    }

    if (live.kick !== null) {
      channels.push({ platform: "kick", channel: live.kick.channel });
    }
  }

  return channels;
}
