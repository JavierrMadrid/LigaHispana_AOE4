"use client";

import { useEffect, useRef, useState } from "react";

/** Altura de scroll a partir de la cual el control tiene sentido. */
const REVEAL_AT_PX = 400;

/**
 * Control flotante para volver al principio de la página.
 *
 * La visibilidad se decide con un centinela de 1px anclado al inicio del
 * documento y un `IntersectionObserver` cuyo margen superior amplía la raíz en
 * `REVEAL_AT_PX`: mientras el centinela siga dentro de esa raíz ampliada, el
 * usuario está cerca del principio y el botón se oculta. Así no hay ningún
 * escucha de `scroll` por fotograma. El centinela se posiciona en absoluto, por
 * eso el `body` del layout raíz declara `relative`.
 */
export function BackToTop() {
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      ([entry]) => setVisible(!entry.isIntersecting),
      { rootMargin: `${REVEAL_AT_PX}px 0px 0px 0px` },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, []);

  function scrollToTop() {
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
  }

  return (
    <>
      <div
        ref={sentinelRef}
        aria-hidden="true"
        className="pointer-events-none absolute top-0 h-px w-full"
      />
      <button
        type="button"
        onClick={scrollToTop}
        aria-label="Volver arriba"
        className={`fixed bottom-4 right-4 z-20 inline-flex size-11 items-center justify-center rounded-full border border-line bg-surface-raised text-muted transition-[opacity,transform,visibility] duration-200 ease-out hover:border-accent/60 hover:text-accent active:translate-y-px motion-reduce:transition-none sm:bottom-6 sm:right-6 ${
          visible ? "visible translate-y-0 opacity-100" : "invisible translate-y-2 opacity-0"
        }`}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className="size-5"
        >
          <path d="M12 19.5V5.5" />
          <path d="m5.5 12 6.5-6.5 6.5 6.5" />
        </svg>
      </button>
    </>
  );
}
