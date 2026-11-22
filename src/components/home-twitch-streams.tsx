"use client";

import { useEffect, useRef, useState } from "react";
import { Eye } from "@phosphor-icons/react/dist/csr/Eye";
import { ArrowUpRight } from "@phosphor-icons/react/dist/csr/ArrowUpRight";
import { TwitchIcon } from "@/components/twitch-icon";
import type { TwitchStreamCard, TwitchStreamsRead } from "@/lib/streams/twitch";

function StreamThumbnail({ url, preview }: { url: string; preview: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [image, setImage] = useState<{ source: string; url: string } | null>(
    null
  );
  const [failed, setFailed] = useState<string | null>(null);
  const local = preview ? "/imagenes/portada/aoe4-hre-panorama.webp" : null;
  useEffect(() => {
    if (local || !ref.current) return;
    const controller = new AbortController();
    let objectUrl: string | null = null;
    async function load() {
      try {
        // Una emisión terminada redirige a un JPEG válido: se rechaza esa reserva.
        const response = await fetch(url, {
          credentials: "omit",
          redirect: "error",
          signal: controller.signal,
        });
        if (
          !response.ok ||
          !response.headers.get("content-type")?.startsWith("image/")
        )
          return;
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setImage({ source: url, url: objectUrl });
      } catch {
        // La tarjeta conserva nombre, audiencia y enlace aunque no haya imagen.
      }
    }
    const observer =
      "IntersectionObserver" in window
        ? new IntersectionObserver(
            (entries) => {
              if (entries.some((entry) => entry.isIntersecting)) {
                observer?.disconnect();
                void load();
              }
            },
            { rootMargin: "160px" }
          )
        : null;
    if (observer) observer.observe(ref.current);
    else void load();
    return () => {
      observer?.disconnect();
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url, local]);
  const src = local ?? (image?.source === url ? image.url : null);
  return (
    <span className="home-twitch-thumbnail" ref={ref}>
      <span className="home-twitch-image-fallback" aria-hidden="true">
        <TwitchIcon className="size-7" />
      </span>
      {src && src !== failed ? (
        // eslint-disable-next-line @next/next/no-img-element -- miniatura local o blob validado por el navegador, sin proxy ni credenciales.
        <img
          src={src}
          alt=""
          width={320}
          height={180}
          onError={() => setFailed(src)}
        />
      ) : null}
      <span className="home-twitch-live" aria-hidden="true">
        <span />
        En directo
      </span>
      <span className="home-twitch-open" aria-hidden="true">
        <ArrowUpRight size={15} />
      </span>
    </span>
  );
}

function StreamCard({
  stream,
  preview,
}: {
  stream: TwitchStreamCard;
  preview: boolean;
}) {
  const name = stream.displayName || stream.login;
  const title =
    name.toLowerCase() === stream.playerName.toLowerCase()
      ? name
      : `${name} · ${stream.playerName}`;
  const audience =
    stream.viewerCount === null
      ? null
      : `${stream.viewerCount.toLocaleString("es-ES")} ${
          stream.viewerCount === 1 ? "espectador" : "espectadores"
        }`;
  return (
    <li>
      <a
        className="home-twitch-card"
        href={stream.channelUrl}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`${title}, en directo en Twitch.${audience ? ` ${audience}.` : ""} Se abre en una pestaña nueva.`}
      >
        <StreamThumbnail url={stream.thumbnailUrl} preview={preview} />
        <span className="home-twitch-card-copy">
          <span className="home-twitch-name" title={title}>
            {name}
          </span>
          {audience !== null ? (
            <span className="home-twitch-audience">
              <Eye size={13} aria-hidden="true" />
              {audience}
            </span>
          ) : null}
        </span>
      </a>
    </li>
  );
}

export function HomeTwitchStreams({
  read,
  preview = false,
}: {
  read: TwitchStreamsRead;
  preview?: boolean;
}) {
  return (
    <section
      className="home-twitch-streams"
      aria-labelledby="home-twitch-heading"
    >
      <h2 id="home-twitch-heading">
        <TwitchIcon className="size-4" />
        En directo en Twitch
      </h2>
      {read.streams.length ? (
        <ul className="home-twitch-list">
          {read.streams.slice(0, 5).map((stream) => (
            <StreamCard key={stream.login} stream={stream} preview={preview} />
          ))}
        </ul>
      ) : (
        <p className="home-twitch-state">
          {read.status === "unavailable"
            ? "Los directos no están disponibles ahora."
            : "No hay canales en directo ahora."}
        </p>
      )}
    </section>
  );
}
