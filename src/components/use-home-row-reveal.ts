"use client";

import { useEffect, type RefObject } from "react";

export function useHomeRowReveal(
  root: RefObject<HTMLElement | null>,
  pageKey: string,
  reducedMotion: boolean | null
) {
  useEffect(() => {
    const element = root.current;
    if (!element || reducedMotion || !window.IntersectionObserver) return;
    const rows = [...element.querySelectorAll<HTMLElement>(".home-standing")];
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.remove("home-reveal-pending");
          observer.unobserve(entry.target);
        }
      },
      { threshold: 0.08, rootMargin: "0px 0px -16px 0px" }
    );
    for (const row of rows) {
      row.classList.add("home-scroll-reveal");
      const bounds = row.getBoundingClientRect();
      if (bounds.top >= window.innerHeight || bounds.bottom <= 0) {
        row.classList.add("home-reveal-pending");
        observer.observe(row);
      }
    }
    function revealFocus(event: FocusEvent) {
      const row = (event.target as HTMLElement).closest(".home-standing");
      if (!row) return;
      row.classList.add("home-reveal-immediate");
      row.classList.remove("home-reveal-pending");
      observer.unobserve(row);
    }
    element.addEventListener("focusin", revealFocus);
    return () => {
      observer.disconnect();
      element.removeEventListener("focusin", revealFocus);
      for (const row of rows)
        row.classList.remove(
          "home-reveal-pending",
          "home-scroll-reveal",
          "home-reveal-immediate"
        );
    };
  }, [root, pageKey, reducedMotion]);
}
