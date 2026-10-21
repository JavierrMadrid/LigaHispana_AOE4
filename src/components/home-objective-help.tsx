"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export function HomeObjectiveHelp({
  description,
  children,
  className = "",
  ariaLabel,
  compact = false,
}: {
  description: string;
  children: ReactNode;
  className?: string;
  ariaLabel?: string;
  compact?: boolean;
}) {
  const id = useId();
  const container = useRef<HTMLDivElement>(null);
  const tooltip = useRef<HTMLSpanElement>(null);
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function enter() {
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
    setHovered(true);
    setDismissed(false);
  }
  function leave() {
    leaveTimer.current = setTimeout(() => setHovered(false), 160);
  }
  useEffect(
    () => () => {
      if (leaveTimer.current) clearTimeout(leaveTimer.current);
    },
    []
  );
  const [position, setPosition] = useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);
  useEffect(() => {
    if (!pinned) return;
    function outside(event: PointerEvent) {
      if (!container.current?.contains(event.target as Node)) {
        setPinned(false);
        setFocused(false);
      }
    }
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [pinned]);
  const open = !dismissed && (pinned || hovered || focused);
  useEffect(() => {
    if (!open) return;
    function place() {
      const box = container.current?.getBoundingClientRect();
      if (!box) return;
      const width = Math.min(
        compact ? (tooltip.current?.getBoundingClientRect().width ?? 340) : 340,
        window.innerWidth - 32
      );
      const height = compact ? (tooltip.current?.offsetHeight ?? 48) : 170;
      setPosition({
        top: Math.min(box.bottom + 8, window.innerHeight - height),
        left: Math.max(16, Math.min(box.left, window.innerWidth - width - 16)),
        width,
      });
    }
    const frame = requestAnimationFrame(place);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, compact]);
  return (
    <div
      className={`home-objective-help ${className}`}
      ref={container}
      onMouseEnter={enter}
      onMouseLeave={leave}
    >
      <button
        type="button"
        className="home-objective-help-trigger"
        aria-label={ariaLabel}
        aria-describedby={open ? id : undefined}
        aria-expanded={pinned}
        onFocus={() => {
          setFocused(true);
          setDismissed(false);
        }}
        onBlur={() => setFocused(false)}
        onClick={() => {
          setPinned(!pinned);
          setDismissed(pinned);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            setPinned(false);
            setDismissed(true);
          }
        }}
      >
        {children}
      </button>
      {open && (position || compact)
        ? createPortal(
            <span
              id={id}
              ref={tooltip}
              role="tooltip"
              className="home-objective-tooltip"
              onMouseEnter={enter}
              onMouseLeave={leave}
              style={
                compact
                  ? {
                      ...position,
                      width: "max-content",
                      maxWidth: "calc(100vw - 32px)",
                      visibility: position ? "visible" : "hidden",
                    }
                  : position ?? undefined
              }
            >
              {description}
            </span>,
            document.body
          )
        : null}
    </div>
  );
}
