"use client";

import React, {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import {
  animate,
  motion,
  useMotionTemplate,
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform,
  type AnimationPlaybackControls,
  type MotionStyle,
} from "framer-motion";

/**
 * Tarjeta volteable: dos caras (frontal y posterior) sobre un eje, con clic,
 * arrastre/flick, inclinación, brillo especular y realce al pasar el ratón.
 * Al arrastrar, además de girar, la tarjeta sigue al puntero (acotada) y vuelve
 * a su sitio con un muelle al soltarla.
 *
 * Adaptación del componente de ejemplo a los tokens de la casa: superficie
 * `--surface`, tinta `--foreground`, radio de 8px (`rounded-lg`) y sin sombra,
 * porque la cara pública del sitio no la usa. El tamaño acepta número o cadena
 * (`width`/`height`), de modo que la misma tarjeta se fija en píxeles o llena su
 * contenedor (`100%`) según dónde se monte.
 *
 * Es deliberadamente genérico: quien lo usa decide las caras. Aquí solo se
 * resuelven el giro y el puntero; el contenido, el foco y el cierre de una capa
 * siguen siendo cosa del anfitrión.
 */

export type FlipCardAxis = "x" | "y";

export interface FlipCardProps {
  front?: ReactNode;
  back?: ReactNode;
  flipped?: boolean;
  defaultFlipped?: boolean;
  onFlipChange?: (flipped: boolean) => void;
  axis?: FlipCardAxis;
  flipOnClick?: boolean;
  draggable?: boolean;
  dragDistance?: number;
  tilt?: boolean;
  tiltMax?: number;
  glare?: boolean;
  glareOpacity?: number;
  hoverScale?: number;
  perspective?: number;
  stiffness?: number;
  damping?: number;
  /** Ancho: número (px) o cadena CSS (`"100%"`). */
  width?: number | string;
  /** Alto: número (px) o cadena CSS (`"100%"`). */
  height?: number | string;
  radius?: number;
  background?: string;
  color?: string;
  shadow?: boolean;
  shadowColor?: string;
  shadowOpacity?: number;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
}

interface Grip {
  id: number;
  x: number;
  y: number;
  base: number;
  baseX: number;
  baseY: number;
  moved: boolean;
  slop: number;
  hist: { t: number; v: number }[];
}

const SLOP = { fine: 4, coarse: 8 };
const TILT_SPRING = { stiffness: 240, damping: 24, mass: 0.6 };
const LIFT_SPRING = { stiffness: 320, damping: 26 };
const OFFSET_SPRING = { stiffness: 340, damping: 30, mass: 0.7 };
const FLING = 0.16;
const HISTORY_MS = 90;
/** Tope del desplazamiento al arrastrar, para no poder lanzar la tarjeta fuera. */
const OFFSET_LIMIT = 24;
/**
 * Cuánto sigue la tarjeta al puntero. Se queda por debajo de 1 para que el
 * desplazamiento sea más sutil que el recorrido del ratón.
 */
const OFFSET_DAMPING = 0.45;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const snap = (deg: number) => Math.round(deg / 180) * 180;
const isBack = (deg: number) => Math.abs(Math.round(deg / 180)) % 2 === 1;
const cssLength = (value: number | string) => (typeof value === "number" ? `${value}px` : value);
/**
 * El arrastre mide en píxeles. Con un tamaño en cadena (`100%`) no hay un ancho
 * real que usar, así que se recurre a un valor de referencia razonable.
 */
const dragSpan = (value: number | string, fallback: number) =>
  typeof value === "number" ? value : fallback;

/**
 * Controles dentro de una cara (enlaces a perfiles, botones) conservan su gesto:
 * si el puntero nace sobre uno, la tarjeta no inicia el arrastre ni el volteo por
 * clic, y el control recibe su clic de siempre.
 */
const isInteractive = (target: EventTarget | null, root: HTMLElement) => {
  if (!(target instanceof Element) || target === root) {
    return false;
  }

  const control = target.closest("a, button, input, textarea, select, [role='button']");

  // La propia tarjeta es `role="button"`: si el control más cercano es la raíz,
  // el clic nace en la superficie de la tarjeta y debe voltearla, no quedar
  // absorbido por el guardián.
  return control !== null && control !== root;
};

const FlipCard: React.FC<FlipCardProps> = ({
  front = null,
  back = null,
  flipped,
  defaultFlipped = false,
  onFlipChange,
  axis = "y",
  flipOnClick = true,
  draggable = true,
  dragDistance = 0,
  tilt = true,
  tiltMax = 12,
  glare = true,
  glareOpacity = 0.14,
  hoverScale = 1.03,
  perspective = 1100,
  stiffness = 170,
  damping = 20,
  width = 300,
  height = 400,
  radius = 8,
  background = "var(--surface)",
  color = "var(--foreground)",
  shadow = false,
  shadowColor = "#000000",
  shadowOpacity = 0.45,
  disabled = false,
  ariaLabel = "Tarjeta volteable",
  className = "",
}) => {
  const reduce = useReducedMotion();
  const controlled = flipped !== undefined;
  const [inner, setInner] = useState(defaultFlipped);
  const [dragging, setDragging] = useState(false);
  const shown = controlled ? flipped : inner;
  const rootRef = useRef<HTMLDivElement>(null);
  const grip = useRef<Grip | null>(null);
  const spin = useRef<AnimationPlaybackControls | null>(null);
  const offsetSpinX = useRef<AnimationPlaybackControls | null>(null);
  const offsetSpinY = useRef<AnimationPlaybackControls | null>(null);
  const target = useRef(shown ? 180 : 0);

  const turn = useMotionValue(shown ? 180 : 0);
  const offsetX = useMotionValue(0);
  const offsetY = useMotionValue(0);
  const tiltX = useSpring(0, TILT_SPRING);
  const tiltY = useSpring(0, TILT_SPRING);
  const lift = useSpring(1, LIFT_SPRING);
  const sheen = useSpring(0, LIFT_SPRING);
  const gx = useMotionValue(50);
  const gy = useMotionValue(50);

  const sumX = useTransform([turn, tiltX], ([t, x]: number[]) => t + x);
  const sumY = useTransform([turn, tiltY], ([t, y]: number[]) => t + y);
  const turnY = useMotionTemplate`translate3d(${offsetX}px, ${offsetY}px, 0) perspective(${perspective}px) scale(${lift}) rotateX(${tiltX}deg) rotateY(${sumY}deg)`;
  const turnX = useMotionTemplate`translate3d(${offsetX}px, ${offsetY}px, 0) perspective(${perspective}px) scale(${lift}) rotateY(${tiltY}deg) rotateX(${sumX}deg)`;
  const facing = useTransform(turn, (t) => Math.abs(Math.cos((t * Math.PI) / 180)));
  const spread = useTransform(facing, (f) => 0.08 + 0.92 * f);
  const shade = useTransform(facing, (f) => 0.1 + 0.9 * f * f);
  const gxPct = useMotionTemplate`${gx}%`;
  const gyPct = useMotionTemplate`${gy}%`;

  const settle = (to: number, velocity: number, instant: boolean) => {
    spin.current?.stop();
    target.current = to;
    if (instant || reduce) turn.jump(to);
    else
      spin.current = animate(turn, to, {
        type: "spring",
        stiffness,
        damping,
        velocity,
        restDelta: 0.05,
      });
    const next = isBack(to);
    if (next === shown) return;
    if (!controlled) setInner(next);
    onFlipChange?.(next);
  };
  const flip = (instant: boolean) => {
    const base = snap(turn.get());
    settle(isBack(base) ? base - 180 : base + 180, 0, instant);
  };
  const rest = () => {
    tiltX.set(0);
    tiltY.set(0);
    sheen.set(0);
    lift.set(1);
  };
  /** Devuelve la tarjeta a su sitio: con muelle, o de golpe con reduce. */
  const settleOffset = () => {
    offsetSpinX.current?.stop();
    offsetSpinY.current?.stop();
    if (reduce) {
      offsetX.jump(0);
      offsetY.jump(0);
      return;
    }
    offsetSpinX.current = animate(offsetX, 0, { type: "spring", ...OFFSET_SPRING });
    offsetSpinY.current = animate(offsetY, 0, { type: "spring", ...OFFSET_SPRING });
  };

  useEffect(() => {
    if (!controlled || isBack(target.current) === flipped) return;
    const base = target.current;
    spin.current?.stop();
    target.current = isBack(base) ? base - 180 : base + 180;
    if (reduce) turn.jump(target.current);
    else
      spin.current = animate(turn, target.current, {
        type: "spring",
        stiffness,
        damping,
        restDelta: 0.05,
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flipped]);
  useEffect(
    () => () => {
      spin.current?.stop();
      offsetSpinX.current?.stop();
      offsetSpinY.current?.stop();
    },
    [],
  );
  useEffect(() => {
    if (!disabled) return;
    rest();
    offsetSpinX.current?.stop();
    offsetSpinY.current?.stop();
    offsetX.jump(0);
    offsetY.jump(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled]);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (disabled || e.button !== 0 || grip.current) return;
    if (isInteractive(e.target, e.currentTarget)) return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {}
    spin.current?.stop();
    offsetSpinX.current?.stop();
    offsetSpinY.current?.stop();
    grip.current = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      base: turn.get(),
      baseX: offsetX.get(),
      baseY: offsetY.get(),
      moved: false,
      slop: e.pointerType === "touch" ? SLOP.coarse : SLOP.fine,
      hist: [],
    };
    if (!reduce) lift.set(hoverScale);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const g = grip.current;
    if (g && g.id === e.pointerId) {
      const dx = e.clientX - g.x;
      const dy = e.clientY - g.y;
      const d = axis === "x" ? dy : dx;
      if (!g.moved) {
        if (Math.abs(d) < g.slop || !draggable || reduce) return;
        g.moved = true;
        setDragging(true);
        tiltX.set(0);
        tiltY.set(0);
        sheen.set(0);
      }
      // Mientras se arrastra, la tarjeta sigue al puntero desde donde estuviera
      // (por si se agarra en plena vuelta), acotada para que no pueda salir de la
      // ventana; al soltar, `settleOffset` la devuelve con un muelle.
      offsetX.set(clamp(g.baseX + dx * OFFSET_DAMPING, -OFFSET_LIMIT, OFFSET_LIMIT));
      offsetY.set(clamp(g.baseY + dy * OFFSET_DAMPING, -OFFSET_LIMIT, OFFSET_LIMIT));
      const span = dragDistance > 0 ? dragDistance : axis === "x" ? dragSpan(height, 420) : dragSpan(width, 320);
      const deg = g.base + (axis === "x" ? -1 : 1) * (d / span) * 180;
      turn.set(deg);
      const now = performance.now();
      g.hist.push({ t: now, v: deg });
      while (g.hist.length > 2 && now - g.hist[0].t > HISTORY_MS) g.hist.shift();
      return;
    }
    if (!tilt || reduce || disabled || e.pointerType === "touch") return;
    const r = e.currentTarget.getBoundingClientRect();
    const px = clamp((e.clientX - r.left) / r.width, 0, 1);
    const py = clamp((e.clientY - r.top) / r.height, 0, 1);
    tiltX.set((0.5 - py) * 2 * tiltMax);
    tiltY.set((px - 0.5) * 2 * tiltMax);
    gx.set(px * 100);
    gy.set(py * 100);
    sheen.set(1);
  };
  const release = (e: PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const g = grip.current;
    if (!g || g.id !== e.pointerId) return;
    grip.current = null;
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId))
        e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {}
    setDragging(false);
    settleOffset();
    if (e.pointerType === "touch" || !rootRef.current?.matches(":hover")) rest();
    if (!g.moved) {
      if (!cancelled && flipOnClick) flip(false);
      else settle(target.current, 0, false);
      return;
    }
    const here = turn.get();
    let velocity = 0;
    const a = g.hist[0];
    const b = g.hist[g.hist.length - 1];
    if (!cancelled && a && b && b.t > a.t && performance.now() - b.t < 60)
      velocity = ((b.v - a.v) / (b.t - a.t)) * 1000;
    const to = cancelled
      ? snap(g.base)
      : clamp(snap(here + velocity * FLING), snap(here) - 180, snap(here) + 180);
    settle(to, velocity, false);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled || (e.key !== "Enter" && e.key !== " ")) return;
    e.preventDefault();
    if (!e.repeat) flip(true);
  };
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    if (!disabled && e.detail === 0) flip(true);
  };

  const rotorStyle = {
    transform: axis === "x" ? turnX : turnY,
    "--fc-gx": gxPct,
    "--fc-gy": gyPct,
    "--fc-sheen": sheen,
  } as MotionStyle;

  return (
    <div
      ref={rootRef}
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-pressed={shown}
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      className={`group relative inline-block max-w-full cursor-pointer touch-pan-y select-none [width:var(--fc-w)] [height:var(--fc-h)] [border-radius:var(--fc-radius)] [-webkit-tap-highlight-color:transparent] [-webkit-touch-callout:none] focus-visible:outline-2 focus-visible:outline-accent focus-visible:[outline-offset:-2px] data-[axis=x]:touch-pan-x data-[draggable]:cursor-grab data-[dragging]:cursor-grabbing data-[disabled]:cursor-default data-[disabled]:opacity-60${className ? ` ${className}` : ""}`}
      data-axis={axis}
      data-draggable={draggable && !disabled && !reduce ? "" : undefined}
      data-dragging={dragging ? "" : undefined}
      data-disabled={disabled ? "" : undefined}
      data-fade={reduce ? (shown ? "back" : "front") : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => release(e, false)}
      onPointerCancel={(e) => release(e, true)}
      onLostPointerCapture={(e) => release(e, true)}
      onPointerEnter={(e) => {
        if (!reduce && !disabled && e.pointerType !== "touch") lift.set(hoverScale);
      }}
      onPointerLeave={() => {
        if (!grip.current) rest();
      }}
      onKeyDown={onKeyDown}
      onClick={onClick}
      onDragStart={(e) => e.preventDefault()}
      style={
        {
          "--fc-w": cssLength(width),
          "--fc-h": cssLength(height),
          "--fc-radius": `${radius}px`,
          "--fc-bg": background,
          "--fc-ink": color,
          "--fc-shadow": shadowColor,
          "--fc-shadow-o": shadowOpacity,
          "--fc-glare": glareOpacity,
        } as CSSProperties
      }
    >
      {shadow ? (
        <motion.span
          className="pointer-events-none absolute [inset:12%_9%_-5%] [border-radius:var(--fc-radius)] [background:color-mix(in_srgb,var(--fc-shadow)_calc(var(--fc-shadow-o)*100%),transparent)] [filter:blur(22px)]"
          aria-hidden="true"
          style={axis === "x" ? { scaleY: spread, opacity: shade } : { scaleX: spread, opacity: shade }}
        />
      ) : null}
      <motion.div
        className="absolute inset-0 [transform-style:preserve-3d]"
        style={reduce ? undefined : rotorStyle}
      >
        <div
          className="absolute inset-0 overflow-hidden [border-radius:var(--fc-radius)] [background:var(--fc-bg)] [color:var(--fc-ink)] [backface-visibility:hidden] [-webkit-backface-visibility:hidden] [&_img]:[-webkit-user-drag:none] group-data-[fade]:opacity-0 group-data-[fade]:[backface-visibility:visible] group-data-[fade]:[-webkit-backface-visibility:visible] group-data-[fade]:[transition:opacity_200ms_ease] group-data-[fade=front]:opacity-100!"
          aria-hidden={shown}
          inert={shown}
        >
          {front}
          {glare ? (
            <span
              className="pointer-events-none absolute inset-0 [opacity:var(--fc-sheen,0)] [background:radial-gradient(circle_farthest-side_at_var(--fc-gx,50%)_var(--fc-gy,50%),rgba(255,255,255,var(--fc-glare))_0%,rgba(255,255,255,calc(var(--fc-glare)*0.76))_12%,rgba(255,255,255,calc(var(--fc-glare)*0.5))_26%,rgba(255,255,255,calc(var(--fc-glare)*0.28))_42%,rgba(255,255,255,calc(var(--fc-glare)*0.12))_60%,rgba(255,255,255,calc(var(--fc-glare)*0.04))_78%,rgba(255,255,255,0)_100%)]"
              aria-hidden="true"
            />
          ) : null}
        </div>
        <div
          className="absolute inset-0 overflow-hidden [border-radius:var(--fc-radius)] [background:var(--fc-bg)] [color:var(--fc-ink)] [backface-visibility:hidden] [-webkit-backface-visibility:hidden] [&_img]:[-webkit-user-drag:none] group-data-[fade]:opacity-0 group-data-[fade]:[backface-visibility:visible] group-data-[fade]:[-webkit-backface-visibility:visible] group-data-[fade]:[transition:opacity_200ms_ease] [transform:rotateY(180deg)] group-data-[axis=x]:[transform:rotateX(180deg)] group-data-[fade]:[transform:none]! group-data-[fade=back]:opacity-100!"
          aria-hidden={!shown}
          inert={!shown}
        >
          {back}
          {glare ? (
            <span
              className="pointer-events-none absolute inset-0 [opacity:var(--fc-sheen,0)] [background:radial-gradient(circle_farthest-side_at_var(--fc-gx,50%)_var(--fc-gy,50%),rgba(255,255,255,var(--fc-glare))_0%,rgba(255,255,255,calc(var(--fc-glare)*0.76))_12%,rgba(255,255,255,calc(var(--fc-glare)*0.5))_26%,rgba(255,255,255,calc(var(--fc-glare)*0.28))_42%,rgba(255,255,255,calc(var(--fc-glare)*0.12))_60%,rgba(255,255,255,calc(var(--fc-glare)*0.04))_78%,rgba(255,255,255,0)_100%)]"
              aria-hidden="true"
            />
          ) : null}
        </div>
      </motion.div>
    </div>
  );
};

export default FlipCard;
