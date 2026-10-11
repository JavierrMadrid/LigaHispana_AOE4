"use client";

import Link from "next/link";
import "./globals.css";

/**
 * Frontera de error global.
 *
 * Salta cuando lo que falla es el propio layout raíz, así que no hay layout que
 * la envuelva: define su propio documento y trae los tokens con `globals.css`
 * para no perder la paleta. Es la misma caja que `error.tsx`, reducida a lo
 * mínimo.
 */
export default function GlobalError({
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <html lang="es">
      <body className="min-h-full bg-background text-foreground antialiased">
        <div className="flex min-h-screen items-center justify-center px-4 py-24 sm:px-6">
          <div className="w-full max-w-[58ch] rounded-lg border border-line bg-surface p-8 sm:p-10">
            <h1 className="text-lg font-semibold text-foreground">
              Algo se ha roto
            </h1>
            <p className="mt-2 text-sm leading-relaxed text-muted">
              No se ha podido cargar la página. Vuelve a intentarlo.
            </p>
            <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-3">
              <button
                type="button"
                onClick={retry}
                className="inline-flex h-10 items-center rounded-md bg-accent px-4 text-sm font-semibold text-accent-ink transition-colors hover:bg-accent-strong active:translate-y-px"
              >
                Reintentar
              </button>
              <Link
                href="/"
                className="text-sm text-muted transition-colors hover:text-accent"
              >
                Ir a la clasificación
              </Link>
            </div>
          </div>
        </div>
      </body>
    </html>
  );
}
