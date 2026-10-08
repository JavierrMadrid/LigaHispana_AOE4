import Link from "next/link";
import type { ReactNode } from "react";

/**
 * Cabecera ordenable compartida por las tablas del panel.
 *
 * La misma interacción —pulsar una columna para recorrer los tres estados de
 * orden— aparece en el historial de partidas, las alertas, el historial de
 * acciones y el listado de participantes. Vive aquí una sola vez para que el
 * ciclo, el `aria-sort` y el chevron no se reimplementen cuatro veces y para que
 * una tabla no pueda quedar con un comportamiento distinto de las demás.
 *
 * ## Dos variantes, una interacción
 *
 * En las tres listas de servidor el estado vive en la **URL** (el servidor filtra
 * y ordena con `searchParams`), así que la cabecera es un `<Link>`: sin
 * JavaScript, compartible y resistente a la recarga. En participantes, que filtra
 * y ordena en cliente, la cabecera es un `<button>` con estado de React. Las dos
 * variantes usan el mismo `SortIndicator` y el mismo texto accesible.
 *
 * ## `aria-sort` desde el orden efectivo
 *
 * El estado de la cabecera se decide comparando la columna con el **orden
 * efectivo** que publica el DAL (`data.sort`), no con el parámetro crudo de la
 * URL: si la URL trae `?sort=inventado`, el DAL lo trata como ausencia y aplica
 * el orden por defecto, y es ese el que debe reflejar la cabecera. En la variante
 * de enlace, el parámetro crudo sí se mira para decidir el **siguiente** estado
 * (es lo único que distingue "sin orden explícito" de "orden explícito"), pero
 * nunca para pintar.
 *
 * El módulo no lleva `"use client"` a propósito: la variante de enlace tiene que
 * poder renderizarse desde un Server Component, y la de botón solo se usa desde
 * componentes cliente.
 */

export type SortDir = "asc" | "desc";

/** Orden efectivo: la columna y el sentido. `null` en la variante de cliente = sin orden. */
export type ActiveSort<K extends string = string> = { key: K; dir: SortDir } | null;

type ColumnState = "none" | SortDir;

/**
 * Ciclo de tres estados de una columna: ascendente, descendente y vuelta al orden
 * original. Pinchar **otra** columna siempre arranca en ascendente.
 */
export function nextSortState<K extends string>(
  current: ActiveSort<K>,
  column: K,
): ActiveSort<K> {
  if (current === null || current.key !== column) {
    return { key: column, dir: "asc" };
  }

  return current.dir === "asc" ? { key: column, dir: "desc" } : null;
}

/**
 * Texto accesible del control. El ciclo tiene tres estados, así que el
 * `aria-label` anticipa el **siguiente**, no solo describe el actual.
 */
export function sortHint(label: string, state: ColumnState): string {
  if (state === "asc") {
    return `${label}: orden ascendente. Pulsar para descendente`;
  }

  if (state === "desc") {
    return `${label}: orden descendente. Pulsar para quitar la ordenación`;
  }

  return `Ordenar por ${label}`;
}

/**
 * Indicador de orden: la forma distingue el sentido, no solo el color. Sin
 * ordenar se ven dos chevrones apagados como pista de que la columna se puede
 * pulsar; ascendente y descendente muestran uno solo, orientado.
 */
export function SortIndicator({ state }: { state: ColumnState }) {
  if (state === "none") {
    return (
      <svg
        viewBox="0 0 12 12"
        aria-hidden="true"
        className="size-3 shrink-0 text-muted/40 transition-colors group-hover/header:text-muted"
      >
        <path
          d="M3 6.25 6 3.25l3 3"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M3 5.75 6 8.75l3-3"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 12 12" aria-hidden="true" className="size-3 shrink-0 text-accent">
      <path
        d={state === "asc" ? "M2.5 7.25 6 3.75l3.5 3.5" : "M2.5 4.75 6 8.25l3.5-3.5"}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const ALIGN = {
  left: "text-left",
  center: "text-center",
  right: "text-right",
} as const;

/**
 * Cabecera que se queda fija mientras el cuerpo de la tabla se desplaza.
 *
 * Se aplica a partir de `lg`, que es donde el contenedor acota su altura y
 * habilita el scroll vertical interno (`lg:max-h-[70vh] lg:overflow-y-auto`); por
 * debajo no hay scroll anidado y la cabecera se comporta como siempre. El fondo
 * sólido es imprescindible: sin él, las filas se verían a través de la cabecera.
 * Como el contenedor aplica `overflow`, el `sticky` se ancla a él y no a la
 * ventana, que es justo lo que se busca.
 */
const STICKY_HEAD = "lg:sticky lg:top-0 lg:z-10 bg-surface";

function ariaSortFor(state: ColumnState): "ascending" | "descending" | "none" {
  return state === "asc" ? "ascending" : state === "desc" ? "descending" : "none";
}

const CONTROL_CLASS =
  "group/header -m-1 inline-flex items-center gap-1 whitespace-nowrap rounded-sm p-1 transition-colors hover:text-foreground";

type HeaderVisualProps = {
  /** Texto accesible: alimenta el `aria-label` de la pista de ordenación. */
  label: string;
  /** Contenido visual cuando no coincide con el texto accesible (p. ej. con color). */
  visual?: ReactNode;
  align?: "left" | "center" | "right";
  className?: string;
};

type SortableHeaderLinkProps = HeaderVisualProps & {
  /** Nombre de la columna que viaja en `?sort=`. */
  column: string;
  /** Orden efectivo publicado por el DAL, no el parámetro crudo. */
  sort: { key: string; dir: SortDir };
  basePath: string;
  /** Filtros y `pageSize` vivos, para conservarlos al reordenar. */
  query: Record<string, string | undefined>;
};

/**
 * Cabecera ordenable de una lista de servidor: el orden vive en la URL.
 *
 * Al cambiar de orden se quita `page`, porque la página 5 de un orden nuevo no
 * significa nada. El `sort` y el `dir` crudos se descartan del enlace para volver
 * a calcularlos, y el resto de parámetros (filtros y tamaño de página) se
 * conservan tal cual.
 */
export function SortableHeaderLink({
  column,
  sort,
  basePath,
  query,
  label,
  visual,
  align = "left",
  className,
}: SortableHeaderLinkProps) {
  const state: ColumnState = sort.key === column ? sort.dir : "none";

  // El `sort` crudo distingue "sin orden explícito" (que cae al orden por defecto
  // del servidor) de "orden explícito". El primer clic sobre una columna, sea
  // cual sea, arranca en ascendente.
  const target: SortDir | null =
    query.sort !== column ? "asc" : query.dir === "asc" ? "desc" : null;

  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    if (
      value === undefined ||
      value === "" ||
      key === "sort" ||
      key === "dir" ||
      key === "page"
    ) {
      continue;
    }

    params.set(key, value);
  }

  if (target !== null) {
    params.set("sort", column);
    params.set("dir", target);
  }

  const queryString = params.toString();
  const href = queryString === "" ? basePath : `${basePath}?${queryString}`;

  return (
    <th
      scope="col"
      aria-sort={ariaSortFor(state)}
      className={`${ALIGN[align]} ${STICKY_HEAD} ${className ?? ""}`}
    >
      <Link href={href} aria-label={sortHint(label, state)} className={CONTROL_CLASS}>
        {visual ?? label}
        <SortIndicator state={state} />
      </Link>
    </th>
  );
}

type SortableHeaderButtonProps = HeaderVisualProps & {
  column: string;
  sort: ActiveSort;
  onSort: (column: string) => void;
};

/** Cabecera ordenable de una lista de cliente: el orden es estado de React. */
export function SortableHeaderButton({
  column,
  sort,
  onSort,
  label,
  visual,
  align = "left",
  className,
}: SortableHeaderButtonProps) {
  const state: ColumnState = sort !== null && sort.key === column ? sort.dir : "none";

  return (
    <th
      scope="col"
      aria-sort={ariaSortFor(state)}
      className={`${ALIGN[align]} ${STICKY_HEAD} ${className ?? ""}`}
    >
      <button
        type="button"
        onClick={() => onSort(column)}
        aria-label={sortHint(label, state)}
        className={CONTROL_CLASS}
      >
        {visual ?? label}
        <SortIndicator state={state} />
      </button>
    </th>
  );
}
