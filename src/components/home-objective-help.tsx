"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export function HomeObjectiveHelp({
  description,
  children,
}: {
  description: string;
  children: ReactNode;
}) {
  const id = useId();
  const container = useRef<HTMLDivElement>(null);
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
      const width = Math.min(340, window.innerWidth - 32);
      setPosition({
        top: Math.min(box.bottom + 8, window.innerHeight - 170),
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
  }, [open]);
  return (
    <div
      className="home-objective-help"
      ref={container}
      onMouseEnter={enter}
      onMouseLeave={leave}
    >
      <button
        type="button"
        className="home-objective-help-trigger"
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
      {open && position
        ? createPortal(
            <span
              id={id}
              role="tooltip"
              className="home-objective-tooltip"
              onMouseEnter={enter}
              onMouseLeave={leave}
              style={position}
            >
              {description}
            </span>,
            document.body
          )
        : null}
    </div>
  );
}
