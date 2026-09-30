"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

/** Los tamaños de página que ofrece la interfaz, en orden. */
export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;

export const DEFAULT_PAGE_SIZE_VALUE = 25;

/** El tamaño pedido, saneado a los valores que existen. */
export function readPageSize(value: string | null): number {
  const parsed = Number(value);

  return (PAGE_SIZE_OPTIONS as readonly number[]).includes(parsed)
    ? parsed
    : DEFAULT_PAGE_SIZE_VALUE;
}

type PageSizeSelectProps = {
  label?: string;
};

/**
 * Selector del tamaño de página de un listado paginado en servidor.
 *
 * Lee su valor de la URL y lo escribe ahí, sin props de estado: es un control del
 * listado, no de quien lo pinta, y así se puede soltar en cualquier barra sin que la
 * página tenga que leer `pageSize` y pasárselo. El DAL sanea el valor igualmente.
 *
 * Al cambiar el tamaño se quita `page`: la página 5 con 10 filas por página no es
 * ninguna página con 100, y mantenerla daría un salto a una posición que no está en la
 * pantalla anterior.
 *
 * El valor se sanea contra `PAGE_SIZE_OPTIONS` porque el `pageSize` de la URL es
 * público: aquí solo se elige entre los tamaños que la interfaz ofrece, así que un
 * `?pageSize=1000` no se convierte en una lectura de mil filas.
 */
export function PageSizeSelect({ label = "Filas por página" }: PageSizeSelectProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const value = readPageSize(searchParams.get("pageSize"));
  const id = `${pathname.replaceAll("/", "-")}-page-size`;

  function change(next: string) {
    const params = new URLSearchParams(searchParams.toString());

    if (next === String(DEFAULT_PAGE_SIZE_VALUE)) {
      params.delete("pageSize");
    } else {
      params.set("pageSize", next);
    }

    params.delete("page");

    const query = params.toString();
    router.push(query === "" ? pathname : `${pathname}?${query}`);
  }

  return (
    <div className="flex items-center gap-2 text-xs text-muted">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        value={String(value)}
        onChange={(event) => change(event.target.value)}
        className="h-10 rounded-md border border-line bg-background px-2 text-foreground"
      >
        {PAGE_SIZE_OPTIONS.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </div>
  );
}
