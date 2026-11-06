import { describe, expect, it } from "vitest";

import { paginateRows } from "@/lib/pagination";

describe("paginación de filas", () => {
  it("recorre las 1500 filas en 60 páginas de 25, sin omisiones ni duplicados", () => {
    const source = Array.from({ length: 1500 }, (_, index) => ({ id: index + 1 }));
    const pages = Array.from({ length: 60 }, (_, index) => paginateRows(source, index + 1));

    expect(pages.flatMap((page) => page.rows)).toEqual(source);
    for (const [index, page] of pages.entries()) {
      expect(page.rows).toHaveLength(25);
      expect(page).toMatchObject({ page: index + 1, pageCount: 60, total: 1500, start: index * 25 + 1, end: (index + 1) * 25 });
    }
  });

  it("acota la última página parcial y una página anterior a un filtrado", () => {
    const source = Array.from({ length: 61 }, (_, index) => index + 1);
    expect(paginateRows(source, 99)).toMatchObject({ rows: source.slice(50), page: 3, pageCount: 3, start: 51, end: 61 });
    expect(paginateRows(source.slice(0, 8), 3)).toMatchObject({ rows: source.slice(0, 8), page: 1, pageCount: 1, start: 1, end: 8 });
  });

  it("representa el conjunto vacío con un rango 0–0", () => {
    expect(paginateRows([], 7)).toEqual({ rows: [], page: 1, pageSize: 25, pageCount: 1, total: 0, start: 0, end: 0 });
  });

  it("normaliza páginas fuera de rango sin modificar el orden de entrada", () => {
    const source = Object.freeze(["tercero", "primero", "segundo", "cuarto"]);
    for (const page of [-10, 0, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(paginateRows(source, page, 2).rows).toEqual(["tercero", "primero"]);
    }
    expect(paginateRows(source, 2.9, 2).rows).toEqual(["segundo", "cuarto"]);
    expect(source).toEqual(["tercero", "primero", "segundo", "cuarto"]);
  });

  it.each([0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY])("rechaza el tamaño de página inválido %s", (size) => {
    expect(() => paginateRows([1], 1, size)).toThrow(RangeError);
  });
});
