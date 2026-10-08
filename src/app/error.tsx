"use client";

import Link from "next/link";

/**
 * Frontera de error de la aplicación.
 *
 * Vive en la raíz para cubrir cualquier ruta pública y de acceso, y sustituye a
 * todo el subárbol que falle (incluida la cabecera y el pie, que cuelgan del
 * layout del grupo), así que la caja se pinta sola sobre el fondo del sitio. Es
 * la misma caja que `EmptyState`, con el mismo tono, y siempre ofrece una salida:
 * reintentar o volver a la clasificación.
 */
export default function Error({
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <div className="flex flex-1 items-center justify-center px-4 py-24 sm:px-6">
      <div className="w-full max-w-[58ch] rounded-lg border border-line bg-surface p-8 sm:p-10">
        <h1 className="font-display text-lg font-semibold text-foreground">
          Algo se ha roto
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          No se ha podido cargar esta página. Puede ser un fallo temporal; vuelve
          a intentarlo y, si sigue igual, mira la clasificación.
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
  );
}
