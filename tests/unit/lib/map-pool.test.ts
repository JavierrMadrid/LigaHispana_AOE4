import { describe, expect, it } from "vitest";

import {
  DEFAULT_MAP_POOL,
  MAP_POOL_REFRESH_INTERVAL_MS,
  mapPoolRefreshDue,
  parseMapPool,
  parseMapPoolSync,
  type MapPoolSyncState,
} from "@/lib/map-pool";

/**
 * El pool de mapas como configuración: normalización de `Setting["scoring.mapPool"]`
 * y contabilidad del refresco. Puro, sin base de datos.
 */

const ESTADO: MapPoolSyncState = {
  fetchedAt: "2026-10-08T00:00:00.000Z",
  startedAt: "2026-10-01T00:00:00Z",
  nextRefresh: "2026-11-01T00:00:00Z",
  maps: ["Atacama", "Baltic"],
};

describe("parseMapPool", () => {
  it("recorta, quita duplicados y conserva el orden", () => {
    expect(parseMapPool([" Atacama ", "Baltic", "Atacama", "", 42])).toEqual([
      "Atacama",
      "Baltic",
    ]);
  });

  it("cae al valor por defecto con algo que no es una lista o está vacía", () => {
    expect(parseMapPool(null)).toEqual([...DEFAULT_MAP_POOL]);
    expect(parseMapPool([])).toEqual([...DEFAULT_MAP_POOL]);
    expect(parseMapPool(["   ", 7])).toEqual([...DEFAULT_MAP_POOL]);
  });

  it("el valor por defecto son los nueve mapas reales", () => {
    expect(DEFAULT_MAP_POOL).toHaveLength(9);
    expect(DEFAULT_MAP_POOL).toContain("King of the Hill");
  });
});

describe("parseMapPoolSync", () => {
  it("lee la contabilidad completa", () => {
    expect(parseMapPoolSync(ESTADO)).toEqual(ESTADO);
  });

  it("devuelve null si falta la fecha, no es legible o no hay mapas", () => {
    expect(parseMapPoolSync({})).toBeNull();
    expect(parseMapPoolSync({ ...ESTADO, fetchedAt: "no-es-fecha" })).toBeNull();
    expect(parseMapPoolSync({ ...ESTADO, maps: [] })).toBeNull();
    expect(parseMapPoolSync({ ...ESTADO, maps: ["Atacama", ""] })).toBeNull();
    expect(parseMapPoolSync(null)).toBeNull();
  });

  it("admite `startedAt` y `nextRefresh` ausentes", () => {
    const parsed = parseMapPoolSync({ fetchedAt: ESTADO.fetchedAt, maps: ESTADO.maps });

    expect(parsed).not.toBeNull();
    expect(parsed?.startedAt).toBeNull();
    expect(parsed?.nextRefresh).toBeNull();
  });
});

describe("mapPoolRefreshDue", () => {
  const ahora = new Date("2026-10-08T12:00:00.000Z");

  it("sin contabilidad toca refrescar", () => {
    expect(mapPoolRefreshDue(null, ahora)).toBe(true);
  });

  it("con menos de 24 h no toca", () => {
    expect(mapPoolRefreshDue({ ...ESTADO, fetchedAt: "2026-10-08T00:00:00.000Z" }, ahora)).toBe(
      false,
    );
  });

  it("con más de 24 h vuelve a tocar", () => {
    const viejo = new Date(ahora.getTime() - MAP_POOL_REFRESH_INTERVAL_MS - 1).toISOString();

    expect(mapPoolRefreshDue({ ...ESTADO, fetchedAt: viejo }, ahora)).toBe(true);
  });

  it("con una fecha ilegible toca (lado seguro)", () => {
    expect(mapPoolRefreshDue({ ...ESTADO, fetchedAt: "x" }, ahora)).toBe(true);
  });
});
