"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUpRight } from "@phosphor-icons/react/dist/csr/ArrowUpRight";
import { TwitchIcon } from "@/components/twitch-icon";
import { twitchChannelUrl } from "@/lib/format";

export function MatchTwitchPreview({
  login,
  name,
  previewSrc,
}: {
  login: string;
  name: string;
  previewSrc?: string;
}) {
  const thumbnail = `https://static-cdn.jtvnw.net/previews-ttv/live_user_${login}-640x360.jpg`;
  const ref = useRef<HTMLAnchorElement>(null);
  const [asset, setAsset] = useState<{ source: string; url: string } | null>(
    null
  );
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  useEffect(() => {
    if (previewSrc || !ref.current) return;
    const controller = new AbortController();
    let objectUrl: string | null = null;
    async function load() {
      try {
        // Twitch redirige las emisiones apagadas a una imagen de reserva válida.
        const response = await fetch(thumbnail, {
          redirect: "error",
          credentials: "omit",
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
        setAsset({ source: thumbnail, url: objectUrl });
      } catch {
        // La imagen del mapa sigue visible si la miniatura no se puede leer.
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
  }, [thumbnail, previewSrc]);

  const src = previewSrc ?? (asset?.source === thumbnail ? asset.url : null);
  const ready = src !== null && loadedSrc === src && failedSrc !== src;
  const label = `Ver el directo de ${name} en Twitch (se abre en otra pestaña)`;

  return (
    <a
      ref={ref}
      className={`matches-twitch-preview ${
        ready ? "matches-twitch-ready" : ""
      }`}
      href={twitchChannelUrl(login)}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      aria-hidden={!ready}
      tabIndex={ready ? undefined : -1}
      title={ready ? label : undefined}
    >
      {src && failedSrc !== src ? (
        // eslint-disable-next-line @next/next/no-img-element -- URL local o blob ya leído por el cliente; Next no debe volver a pedirlo.
        <img
          src={src}
          alt=""
          width={640}
          height={360}
          onLoad={() => setLoadedSrc(src)}
          onError={() => setFailedSrc(src)}
        />
      ) : null}
      {ready ? (
        <span className="matches-twitch-badge">
          <TwitchIcon className="size-3.5" />
          Twitch
          <ArrowUpRight size={13} aria-hidden="true" />
        </span>
      ) : null}
    </a>
  );
}
