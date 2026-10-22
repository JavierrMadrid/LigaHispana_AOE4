"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

type ActiveHelp = { id: string; dismiss: () => void };
type HelpGroup = {
  activeId: string | null;
  activate: (help: ActiveHelp) => void;
  release: (id: string) => void;
  dismiss: () => void;
};

const HelpGroupContext = createContext<HelpGroup | null>(null);

export function HomeObjectiveHelpProvider({ children }: { children: ReactNode }) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const active = useRef<ActiveHelp | null>(null);
  const activate = useCallback((help: ActiveHelp) => {
    if (active.current?.id !== help.id) active.current?.dismiss();
    active.current = help;
    setActiveId(help.id);
  }, []);
  const release = useCallback((id: string) => {
    if (active.current?.id !== id) return;
    active.current = null;
    setActiveId(null);
  }, []);
  const dismiss = useCallback(() => {
    active.current?.dismiss();
    active.current = null;
    setActiveId(null);
  }, []);
  const group = useMemo(
    () => ({ activeId, activate, release, dismiss }),
    [activeId, activate, release, dismiss]
  );

  return (
    <HelpGroupContext.Provider value={group}>
      {children}
    </HelpGroupContext.Provider>
  );
}

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
  const group = useContext(HelpGroupContext);
  const activate = group?.activate;
  const release = group?.release;
  const id = useId();
  const container = useRef<HTMLDivElement>(null);
  const tooltip = useRef<HTMLSpanElement>(null);
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearLeaveTimer = useCallback(() => {
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
    leaveTimer.current = null;
  }, []);
  const dismiss = useCallback(() => {
    clearLeaveTimer();
    setPinned(false);
    setHovered(false);
    setFocused(false);
    setDismissed(true);
  }, [clearLeaveTimer]);
  function enter() {
    clearLeaveTimer();
    activate?.({ id, dismiss });
    setHovered(true);
    setDismissed(false);
  }
  function leave() {
    clearLeaveTimer();
    leaveTimer.current = setTimeout(() => {
      leaveTimer.current = null;
      setHovered(false);
    }, 160);
  }
  useEffect(
    () => () => {
      clearLeaveTimer();
      release?.(id);
    },
    [clearLeaveTimer, id, release]
  );
  const [position, setPosition] = useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);
  useEffect(() => {
    if (!pinned) return;
    function outside(event: PointerEvent) {
      const target = event.target as Node;
      if (
        !container.current?.contains(target) &&
        !tooltip.current?.contains(target)
      ) {
        dismiss();
        release?.(id);
      }
    }
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [pinned, dismiss, release, id]);
  const open =
    (!group || group.activeId === id) &&
    !dismissed &&
    (pinned || hovered || focused);
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
        aria-expanded={open && pinned}
        onFocus={() => {
          clearLeaveTimer();
          activate?.({ id, dismiss });
          setFocused(true);
          setDismissed(false);
        }}
        onBlur={() => setFocused(false)}
        onClick={() => {
          if (pinned) {
            dismiss();
            release?.(id);
          } else {
            clearLeaveTimer();
            activate?.({ id, dismiss });
            setPinned(true);
            setDismissed(false);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            if (group) group.dismiss();
            else dismiss();
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
