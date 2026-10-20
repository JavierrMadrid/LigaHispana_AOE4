"use client";

import { useEffect, useRef } from "react";

export function useHomeTableGlow(reducedMotion: boolean | null) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (
      !element ||
      reducedMotion ||
      !matchMedia("(hover: hover) and (pointer: fine)").matches
    )
      return;
    let frame = 0;
    let activeRow: HTMLElement | null = null;
    let pointer: PointerEvent | null = null;
    function update() {
      frame = 0;
      if (!element || !pointer) return;
      const row = (pointer.target as HTMLElement).closest<HTMLElement>(
        ".home-standing"
      );
      if (row !== activeRow) {
        activeRow?.classList.remove("home-pointer-row");
        row?.classList.add("home-pointer-row");
        activeRow = row;
      }
      if (!row || !element.contains(row)) return;
      const bounds = row.getBoundingClientRect();
      row.style.setProperty(
        "--row-glow-x",
        `${pointer.clientX - bounds.left}px`
      );
      row.style.setProperty(
        "--row-glow-y",
        `${pointer.clientY - bounds.top}px`
      );
    }
    function move(event: PointerEvent) {
      if (event.pointerType === "touch") return;
      pointer = event;
      if (!frame) frame = requestAnimationFrame(update);
    }
    function leave() {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      activeRow?.classList.remove("home-pointer-row");
      activeRow = null;
    }
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerleave", leave);
    return () => {
      leave();
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerleave", leave);
    };
  }, [reducedMotion]);
  return ref;
}
