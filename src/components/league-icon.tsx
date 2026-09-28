"use client";

import { useEffect, useState } from "react";
import { DIVISIONS, type Division, type DivisionId } from "@/lib/divisions";
import { DivisionIcon, divisionLabel } from "@/components/division-icon";

/**
 * Iconos oficiales de liga de Age of Empires IV para la clasificación.
 *
 * Los SVG viven en `public/imagenes/iconos-ligas` con el patrón
 * `solo_<liga>_<rango>.svg` (`solo_gold_2.svg`). El rango exacto sale de
 * `rankLevel`; cuando AoE4World no manda número se usa el rango 3, el mismo
 * emblema con el que los filtros representan a toda la liga.
 *
 * El asset se resuelve por nombre de fichero, no por una lista cerrada de
 * rangos: si el SVG no existe todavía, se cae al escudo propio de
 * `DivisionIcon`. Así, en cuanto se sube el SVG que falta, aparece sin tocar
 * el código.
 */

/** Rango usado cuando `rankLevel` viene sin número o con un tier fuera de 1-3. */
const FALLBACK_TIER = 3;

/** Rango con el que los filtros identifican a la liga entera. */
const FILTER_TIER = 3;

const ICON_DIRECTORY = "/imagenes/iconos-ligas";

const DIVISION_BY_ID = Object.fromEntries(
  DIVISIONS.map((division) => [division.id, division]),
) as Record<DivisionId, Division>;

const DIVISION_BY_PREFIX = new Map(
  DIVISIONS.map((division) => [division.rankLevelPrefix, division]),
);

export type LeagueRank = {
  division: DivisionId;
  tier: number;
  /** Ruta pública del SVG oficial. */
  src: string;
  /** Nombre en español para lectores de pantalla ("Oro 2"). */
  label: string;
};

function toRank(division: Division, tier: number): LeagueRank {
  return {
    division: division.id,
    tier,
    src: `${ICON_DIRECTORY}/solo_${division.rankLevelPrefix}_${tier}.svg`,
    label: `${divisionLabel(division.id)} ${tier}`,
  };
}

/** Rango de un `rankLevel` de AoE4World, o `null` si no se reconoce la liga. */
export function rankLevelToLeague(rankLevel: string | null): LeagueRank | null {
  if (rankLevel === null) {
    return null;
  }

  const [prefix, rawTier] = rankLevel.trim().toLowerCase().split("_");
  const division = DIVISION_BY_PREFIX.get(prefix);

  if (division === undefined) {
    return null;
  }

  const tier = Number.parseInt(rawTier ?? "", 10);
  const resolvedTier =
    Number.isInteger(tier) && tier >= 1 && tier <= 3 ? tier : FALLBACK_TIER;

  return toRank(division, resolvedTier);
}

/** Icono de rango 3 de una liga: el que usan los filtros de la clasificación. */
export function leagueFilterRank(division: DivisionId): LeagueRank {
  return toRank(DIVISION_BY_ID[division], FILTER_TIER);
}

type LeagueIconProps = {
  rank: LeagueRank;
  /**
   * Caja del icono. Por defecto 16x24 px, la proporción 2:3 del asset, para que
   * la celda no cambie de alto.
   */
  className?: string;
  /** Texto en español para lectores de pantalla. Sin él, el icono es decorativo. */
  label?: string;
};

export function LeagueIcon({ rank, className = "h-6 w-4", label }: LeagueIconProps) {
  const [missingSrc, setMissingSrc] = useState<string | null>(null);
  const missing = missingSrc === rank.src;

  useEffect(() => {
    // Sonda propia: si el `<img>` falló antes de que React hidratara, su
    // `onError` ya no se dispara y el 404 pasaría desapercibido.
    const probe = new Image();
    const markMissing = () => setMissingSrc(rank.src);

    probe.addEventListener("error", markMissing);
    probe.src = rank.src;

    return () => probe.removeEventListener("error", markMissing);
  }, [rank.src]);

  return (
    <span
      aria-hidden={label === undefined ? true : undefined}
      className={`inline-flex shrink-0 items-center justify-center ${className}`}
    >
      {missing ? (
        <DivisionIcon division={rank.division} className="h-full w-full" />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element -- SVG estático de `public`: el optimizador de next/image no procesa SVG sin `dangerouslyAllowSVG` y aquí hace falta `onError` para el reemplazo.
        <img
          src={rank.src}
          alt=""
          width={160}
          height={240}
          loading="lazy"
          decoding="async"
          onError={() => setMissingSrc(rank.src)}
          className="h-full w-full object-contain"
        />
      )}
      {label === undefined ? null : <span className="sr-only">{label}</span>}
    </span>
  );
}
