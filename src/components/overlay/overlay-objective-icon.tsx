"use client";

import { useState } from "react";
import { ObjectiveIcon } from "@/components/objective-icon";

/**
 * Icono de un objetivo en el overlay.
 *
 * La API publica `icono_url` solo en los objetivos de civilización; el resto van
 * con la cadena vacía y se pintan con el glifo de la casa. Si la URL existe pero
 * el asset no carga, se cae al glifo en lugar de dejar un hueco roto.
 *
 * Usa `<img>` y no `next/image` porque la URL puede ser externa y el overlay no
 * debe tocar `images.remotePatterns` de la web.
 */
export function OverlayObjectiveIcon({
  iconoUrl,
  objetivoId,
  className = "size-6 shrink-0",
}: {
  iconoUrl: string;
  objetivoId: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);

  if (iconoUrl !== "" && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- icono externo de civilización
      <img
        src={iconoUrl}
        alt=""
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
        className={`${className} object-contain`}
      />
    );
  }

  return <ObjectiveIcon option={{ id: objetivoId }} className={className} />;
}
