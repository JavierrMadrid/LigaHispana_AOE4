"use client";

import { useCallback, useEffect, useRef, type CSSProperties, type PointerEvent, type ReactNode } from "react";
import "./border-glow.css";

/**
 * Borde con malla de degradado que sigue al cursor (componente BorderGlow de
 * React Bits, adaptado).
 *
 * Se usa como cromo de las tarjetas de objetivo: pone el borde, el fondo y el
 * radio, dibuja el halo al pasar el ratón y deja una estela dorada que sigue al
 * cursor por el interior. El brillo sale de `--accent` y `--accent-strong`, así
 * que es el oro de la casa en vez de la paleta morada del original. No lleva la
 * pila de sombras del componente original: la cara pública del sitio no usa
 * sombras.
 */

type BorderGlowProps = {
  children?: ReactNode;
  className?: string;
  /** Color del halo, en HSL sin `hsl()` ("40 62 68"). Por defecto, el oro de la casa. */
  glowColor?: string;
  /** Colores del borde de malla; por defecto, los dos oros del tema. */
  colors?: string[];
  backgroundColor?: string;
  borderRadius?: number;
  /** Cuánto se sale el halo de la tarjeta, en píxeles. */
  glowRadius?: number;
  glowIntensity?: number;
  edgeSensitivity?: number;
  coneSpread?: number;
  /** Intensidad máxima de la estela dorada interior (0–1). */
  fillOpacity?: number;
  animated?: boolean;
};

const DEFAULT_COLORS = ["var(--accent-strong)", "var(--accent)", "var(--accent-strong)"];

function parseHSL(hslStr: string): { h: number; s: number; l: number } {
  const match = hslStr.match(/([\d.]+)\s*([\d.]+)%?\s*([\d.]+)%?/);

  if (!match) {
    return { h: 40, s: 62, l: 68 };
  }

  return { h: parseFloat(match[1]), s: parseFloat(match[2]), l: parseFloat(match[3]) };
}

function buildGlowVars(glowColor: string, intensity: number): Record<string, string> {
  const { h, s, l } = parseHSL(glowColor);
  const base = `${h}deg ${s}% ${l}%`;
  const opacities = [100, 60, 50, 40, 30, 20, 10];
  const keys = ["", "-60", "-50", "-40", "-30", "-20", "-10"];
  const vars: Record<string, string> = {};

  for (let i = 0; i < opacities.length; i++) {
    vars[`--glow-color${keys[i]}`] = `hsl(${base} / ${Math.min(opacities[i] * intensity, 100)}%)`;
  }

  return vars;
}

const GRADIENT_POSITIONS = ["80% 55%", "69% 34%", "8% 6%", "41% 38%", "86% 85%", "82% 18%", "51% 4%"];
const GRADIENT_KEYS = [
  "--gradient-one",
  "--gradient-two",
  "--gradient-three",
  "--gradient-four",
  "--gradient-five",
  "--gradient-six",
  "--gradient-seven",
];
const COLOR_MAP = [0, 1, 2, 0, 1, 2, 1];

function buildGradientVars(colors: string[]): Record<string, string> {
  const vars: Record<string, string> = {};

  for (let i = 0; i < 7; i++) {
    const color = colors[Math.min(COLOR_MAP[i], colors.length - 1)];
    vars[GRADIENT_KEYS[i]] = `radial-gradient(at ${GRADIENT_POSITIONS[i]}, ${color} 0px, transparent 50%)`;
  }

  vars["--gradient-base"] = `linear-gradient(${colors[0]} 0 100%)`;

  return vars;
}

export function BorderGlow({
  children,
  className = "",
  glowColor = "40 62 68",
  colors = DEFAULT_COLORS,
  backgroundColor = "var(--surface)",
  borderRadius = 8,
  glowRadius = 12,
  glowIntensity = 0.75,
  edgeSensitivity = 30,
  coneSpread = 25,
  fillOpacity = 0.28,
  animated = false,
}: BorderGlowProps) {
  const cardRef = useRef<HTMLDivElement>(null);

  const handlePointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const card = cardRef.current;

    if (card === null) {
      return;
    }

    const rect = card.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const dx = x - cx;
    const dy = y - cy;
    const kx = dx === 0 ? Infinity : cx / Math.abs(dx);
    const ky = dy === 0 ? Infinity : cy / Math.abs(dy);
    const edge = Math.min(Math.max(1 / Math.min(kx, ky), 0), 1);
    let degrees = Math.atan2(dy, dx) * (180 / Math.PI) + 90;

    if (degrees < 0) {
      degrees += 360;
    }

    card.style.setProperty("--edge-proximity", (edge * 100).toFixed(3));
    card.style.setProperty("--cursor-angle", `${degrees.toFixed(3)}deg`);
    // Posición del puntero dentro de la tarjeta, en píxeles: la estela interior
    // (`::after`) centra ahí el degradado radial que sigue al cursor.
    card.style.setProperty("--cursor-x", `${x.toFixed(1)}px`);
    card.style.setProperty("--cursor-y", `${y.toFixed(1)}px`);
  }, []);

  // Barrido de entrada opcional; solo corre si el llamante lo pide.
  useEffect(() => {
    if (!animated) {
      return;
    }

    const card = cardRef.current;

    if (card === null) {
      return;
    }

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (reduce) {
      return;
    }

    card.classList.add("sweep-active");
    card.style.setProperty("--cursor-angle", "110deg");

    const start = performance.now();
    let frame = 0;

    const tick = (now: number) => {
      const t = Math.min((now - start) / 1800, 1);
      card.style.setProperty("--edge-proximity", String(Math.round(Math.sin(t * Math.PI) * 100)));
      card.style.setProperty("--cursor-angle", `${110 + t * 355}deg`);

      if (t < 1) {
        frame = requestAnimationFrame(tick);
      } else {
        card.classList.remove("sweep-active");
        card.style.setProperty("--edge-proximity", "0");
      }
    };

    frame = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(frame);
  }, [animated]);

  return (
    <div
      ref={cardRef}
      onPointerMove={handlePointerMove}
      className={`border-glow-card ${className}`.trim()}
      style={
        {
          "--card-bg": backgroundColor,
          "--edge-sensitivity": edgeSensitivity,
          "--border-radius": `${borderRadius}px`,
          "--glow-padding": `${glowRadius}px`,
          "--cone-spread": coneSpread,
          "--fill-opacity": fillOpacity,
          ...buildGlowVars(glowColor, glowIntensity),
          ...buildGradientVars(colors),
        } as CSSProperties
      }
    >
      <span className="edge-light" aria-hidden="true" />
      <div className="border-glow-inner">{children}</div>
    </div>
  );
}
