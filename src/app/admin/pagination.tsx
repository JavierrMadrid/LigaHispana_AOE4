import Link from "next/link";

type PaginationProps = {
  /** Página devuelta, ya acotada por el DAL. */
  page: number;
  pageCount: number;
  /** Filas que trae esta página, para el resumen de "Mostrando…". */
  shown: number;
  /** Filas totales con el filtro aplicado. */
  total: number;
  basePath: string;
  /** Filtros que viajan con la paginación; `page` lo pone este componente. */
  query: Record<string, string | undefined>;
};

/** Enlace de la página pedida, conservando los filtros de la URL. */
function buildHref(basePath: string, query: Record<string, string | undefined>, page: number): string {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") {
      params.set(key, value);
    }
  }

  if (page > 1) {
    params.set("page", String(page));
  }

  const format = params.toString();

  return format === "" ? basePath : `${basePath}?${format}`;
}

/**
 * Paginación de un listado de administración.
 *
 * El DAL ya acota la página al rango real, así que aquí solo se decide si hay
 * anterior y siguiente. En los extremos el control desaparece en lugar de
 * quedarse como enlace muerto: un "Siguiente" que no lleva a ninguna parte es
 * peor que su ausencia.
 */
export function Pagination({ page, pageCount, shown, total, basePath, query }: PaginationProps) {
  const linkClass =
    "inline-flex h-10 items-center rounded-md border border-line bg-surface px-3 text-sm text-foreground transition-colors hover:border-accent/50 hover:text-accent";
  const disabledClass =
    "inline-flex h-10 items-center rounded-md border border-line px-3 text-sm text-muted/60";

  return (
    <nav
      aria-label="Paginación"
      className="flex flex-wrap items-center justify-between gap-3"
    >
      <p className="text-xs text-muted">
        Mostrando {shown} de {total.toLocaleString("es-ES")}
        {pageCount > 1 ? ` · página ${page} de ${pageCount}` : ""}
      </p>

      {pageCount > 1 ? (
        <div className="flex items-center gap-2">
          {page > 1 ? (
            <Link href={buildHref(basePath, query, page - 1)} className={linkClass}>
              Anterior
            </Link>
          ) : (
            <span aria-disabled="true" className={disabledClass}>
              Anterior
            </span>
          )}

          {page < pageCount ? (
            <Link href={buildHref(basePath, query, page + 1)} className={linkClass}>
              Siguiente
            </Link>
          ) : (
            <span aria-disabled="true" className={disabledClass}>
              Siguiente
            </span>
          )}
        </div>
      ) : null}
    </nav>
  );
}
