import { describe, expect, it } from "vitest";

import { alertEditionWhere } from "@/lib/alerts/edition";
import type { ScoringWindow } from "@/lib/ranked-match";

/**
 * El filtro de edición de las alertas.
 *
 * Es lo que decide qué alertas se publican en la pestaña y en el informe, y es puro: la
 * ventana entra como dato y el `where` de Prisma sale como objeto, sin base de datos. Lo
 * que se comprueba es el suelo (`window.from`) y, sobre todo, que **no** hay tope
 * superior: un `createdAt <= window.to` dejaría fuera las alertas de cierre de torneo,
 * que se escriben cuando la edición ya ha terminado.
 */

const DESDE = "2026-09-15T00:00:00.000Z";
const HASTA = "2026-10-15T00:00:00.000Z";

const ABIERTA: ScoringWindow = { from: DESDE, to: null };
const CERRADA: ScoringWindow = { from: DESDE, to: HASTA };

/** El filtro de `createdAt` del `where`, ya como objeto de fechas. */
function fecha(where: ReturnType<typeof alertEditionWhere>): { gte: Date; lt?: Date } {
  return where.createdAt as { gte: Date; lt?: Date };
}

describe("alertEditionWhere", () => {
  it("usa window.from como cota inferior inclusiva", () => {
    expect(alertEditionWhere(CERRADA)).toEqual({ createdAt: { gte: new Date(DESDE) } });
  });

  it("no añade cota superior aunque la ventana esté cerrada", () => {
    const where = alertEditionWhere(CERRADA);

    expect(fecha(where).lt).toBeUndefined();
    // El objeto entero: cualquier cota que se colara aquí rompería las alertas de cierre.
    expect(Object.keys(fecha(where))).toEqual(["gte"]);
  });

  it("da el mismo suelo con la ventana abierta y con la cerrada", () => {
    expect(alertEditionWhere(ABIERTA)).toEqual(alertEditionWhere(CERRADA));
  });

  it("deja fuera lo anterior al suelo y dentro lo posterior, incluso tras window.to", () => {
    const suelo = fecha(alertEditionWhere(CERRADA)).gte.getTime();
    const anterior = new Date("2026-09-14T23:59:59.999Z");
    const cierre = new Date("2026-10-20T00:00:00.000Z");

    expect(anterior.getTime() >= suelo).toBe(false);
    // `STREAK_AT_TOURNAMENT_END` se crea después de `window.to` y tiene que verse.
    expect(cierre.getTime() >= suelo).toBe(true);
  });
});
