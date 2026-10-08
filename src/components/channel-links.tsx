import type { ReactNode } from "react";
import { KickIcon } from "@/components/kick-icon";
import { TwitchIcon } from "@/components/twitch-icon";
import { YoutubeIcon } from "@/components/youtube-icon";
import { kickChannelUrl, twitchChannelUrl, youtubeChannelUrl } from "@/lib/format";

/**
 * Canal de una plataforma, tal y como lo consume el componente: el canal ya
 * canónico (lo resuelve el DAL) y si está emitiendo ahora mismo.
 */
export type ChannelValue = {
  channel: string;
  isLive: boolean;
};

type PlatformMeta = {
  id: "twitch" | "youtube" | "kick";
  label: string;
  Icon: (props: { className?: string }) => ReactNode;
  url: (channel: string) => string;
  /** Color del icono cuando la plataforma está emitiendo. */
  live: string;
};

/** Orden de presentación de las tres plataformas. */
const PLATFORMS: readonly PlatformMeta[] = [
  {
    id: "twitch",
    label: "Twitch",
    Icon: TwitchIcon,
    url: twitchChannelUrl,
    live: "text-twitch hover:opacity-80",
  },
  {
    id: "youtube",
    label: "YouTube",
    Icon: YoutubeIcon,
    url: youtubeChannelUrl,
    live: "text-youtube hover:opacity-80",
  },
  {
    id: "kick",
    label: "Kick",
    Icon: KickIcon,
    url: kickChannelUrl,
    live: "text-kick hover:opacity-80",
  },
];

function ChannelLink({
  meta,
  value,
  name,
}: {
  meta: PlatformMeta;
  value: ChannelValue;
  name: string;
}) {
  const { Icon } = meta;

  return (
    <a
      href={meta.url(value.channel)}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Canal de ${meta.label} de ${name}${
        value.isLive ? ", en directo ahora mismo" : ""
      } (se abre en una pestaña nueva)`}
      title={`${meta.label}: ${value.channel}`}
      className={`-m-1.5 inline-flex shrink-0 items-center justify-center p-1.5 transition-colors ${
        value.isLive ? meta.live : "text-muted/70 hover:text-muted"
      }`}
    >
      <Icon className="size-3.5" />
    </a>
  );
}

type ChannelLinksProps = {
  /** Nombre del jugador, para el texto accesible de cada enlace. */
  name: string;
  twitch?: ChannelValue | null;
  youtube?: ChannelValue | null;
  kick?: ChannelValue | null;
  className?: string;
};

/**
 * Los tres canales de directo como icono-enlace, cada uno con su glifo y el color
 * de su plataforma cuando está emitiendo.
 *
 * Es el único sitio que conoce los tres glifos y las tres URL: la clasificación
 * pública, el listado de participantes y cualquier otra pantalla que los muestre
 * pasan por aquí, de modo que un canal no puede salir como enlace en un sitio y
 * como texto en otro. Las plataformas sin canal **no se pintan**: un hueco vacío
 * no dice nada.
 */
export function ChannelLinks({
  name,
  twitch,
  youtube,
  kick,
  className,
}: ChannelLinksProps) {
  const channels: Record<PlatformMeta["id"], ChannelValue | null | undefined> = {
    twitch,
    youtube,
    kick,
  };
  const present = PLATFORMS.filter((meta) => {
    const value = channels[meta.id];

    return value !== null && value !== undefined;
  });

  if (present.length === 0) {
    return null;
  }

  return (
    <span
      className={`inline-flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 ${className ?? ""}`}
    >
      {present.map((meta) => {
        const value = channels[meta.id];

        // `present` ya ha filtrado los ausentes; esto solo estrecha el tipo.
        if (value === null || value === undefined) {
          return null;
        }

        return <ChannelLink key={meta.id} meta={meta} value={value} name={name} />;
      })}
    </span>
  );
}
