import { describe, expect, it } from "vitest";

import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  dateRangeWhere,
  hasDateBounds,
  paginate,
  readBoundedInt,
  readSingleParam,
} from "@/lib/query-params";

/**
 * Los parámetros de la URL de una lectura paginada.
 *
 * Todo lo de este módulo es puro y se comprueba aquí: qué hace una URL manipulada, cómo se
 * resuelve una fecha suelta y cómo se acota la página. Las mismas reglas las usan el panel y
 * el historial público, y por eso viven en un solo sitio: `npm run verify:sync` las sigue
 * comprobando por el camino del panel (`readAlertsFilters`/`readHistoryFilters`).
 */

describe("readSingleParam", () => {
  it("un parámetro repetido se queda con el primero", () => {
    expect(readSingleParam(["primero", "segundo"])).toBe("primero");
  });

  it("lo que no es un texto es ausencia", () => {
    expect(readSingleParam(undefined)).toBeNull();
    expect(readSingleParam(null)).toBeNull();
    expect(readSingleParam("")).toBeNull();
    expect(readSingleParam("   ")).toBeNull();
  });

  it("recorta los espacios de los extremos", () => {
    expect(readSingleParam(" 2026-09-01 ")).toBe("2026-09-01");
  });
});

describe("readBoundedInt", () => {
  const acotado = { min: 1, max: MAX_PAGE_SIZE, fallback: DEFAULT_PAGE_SIZE };

  it("un entero dentro del rango se respeta", () => {
    expect(readBoundedInt("25", acotado)).toBe(25);
  });

  it("lo que no se entiende es el valor por defecto, no cero", () => {
    expect(readBoundedInt("inventado", acotado)).toBe(DEFAULT_PAGE_SIZE);
    expect(readBoundedInt("-3", acotado)).toBe(DEFAULT_PAGE_SIZE);
    expect(readBoundedInt("1.5", acotado)).toBe(DEFAULT_PAGE_SIZE);
    expect(readBoundedInt("", acotado)).toBe(DEFAULT_PAGE_SIZE);
    expect(readBoundedInt(undefined, acotado)).toBe(DEFAULT_PAGE_SIZE);
  });

  it("se acota por arriba y por abajo", () => {
    expect(readBoundedInt("100000", acotado)).toBe(MAX_PAGE_SIZE);
    expect(readBoundedInt("0", acotado)).toBe(1);
  });
});

describe("dateRangeWhere", () => {
  it("`from` es medianoche UTC de ese día, inclusive", () => {
    const rango = dateRangeWhere("2026-09-01", undefined);

    expect(rango.gte?.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(rango.lt).toBeUndefined();
  });

  it("`to` es medianoche UTC del día siguiente, para que el día entero entre", () => {
    const rango = dateRangeWhere(undefined, "2026-09-30");

    expect(rango.lt?.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(rango.gte).toBeUndefined();
  });

  it("una fecha imposible es ausencia de filtro, no un rango desplazado", () => {
    // `Date.parse` rueda el 31 de febrero al 3 de marzo; la ida y la vuelta lo descarta.
    expect(dateRangeWhere("2026-02-31", "2026-13-01")).toEqual({});
    expect(dateRangeWhere("ayer", undefined)).toEqual({});
  });

  it("un instante con zona se respeta tal cual, y sin zona se ignora", () => {
    expect(dateRangeWhere("2026-09-01T10:00:00Z", undefined).gte?.toISOString()).toBe(
      "2026-09-01T10:00:00.000Z",
    );
    // Sin zona se interpretaría en hora local, así que no se admite.
    expect(dateRangeWhere("2026-09-01T10:00:00", undefined)).toEqual({});
  });

  it("sin límites no hay rango, y `hasDateBounds` lo dice", () => {
    expect(dateRangeWhere(undefined, "")).toEqual({});
    expect(hasDateBounds(dateRangeWhere(undefined, undefined))).toBe(false);
    expect(hasDateBounds(dateRangeWhere("2026-09-01", undefined))).toBe(true);
    expect(hasDateBounds(dateRangeWhere(undefined, "2026-09-30"))).toBe(true);
  });
});

describe("paginate", () => {
  it("reparte la página y cuenta las que hay", async () => {
    const pagina = await paginate(async (page) => ({ rows: [`fila-${page}`], total: 60 }), {
      page: 2,
      pageSize: 25,
    });

    expect(pagina).toEqual({
      rows: ["fila-2"],
      total: 60,
      page: 2,
      pageSize: 25,
      pageCount: 3,
    });
  });

  it("una página pedida más allá del final devuelve la última con filas", async () => {
    const pedidas: number[] = [];
    const pagina = await paginate(
      async (page) => {
        pedidas.push(page);

        return { rows: [`fila-${page}`], total: 3 };
      },
      { page: 7, pageSize: 2 },
    );

    expect(pedidas).toEqual([7, 2]);
    expect(pagina.page).toBe(2);
    expect(pagina.pageCount).toBe(2);
    expect(pagina.rows).toEqual(["fila-2"]);
  });

  it("sin filas deja la página en 1 y `pageCount` en 0", async () => {
    const pagina = await paginate(async () => ({ rows: [], total: 0 }), { page: 4, pageSize: 25 });

    expect(pagina).toEqual({ rows: [], total: 0, page: 1, pageSize: 25, pageCount: 0 });
  });

  it("no vuelve a consultar si la página pedida ya está dentro", async () => {
    const pedidas: number[] = [];

    await paginate(
      async (page) => {
        pedidas.push(page);

        return { rows: [], total: 100 };
      },
      { page: 3, pageSize: 25 },
    );

    expect(pedidas).toEqual([3]);
  });
});
