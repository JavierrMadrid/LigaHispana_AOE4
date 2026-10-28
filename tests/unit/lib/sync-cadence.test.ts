import { describe, expect, it } from "vitest";

import {
  SYNC_INTERVAL_MAX_SECONDS,
  SYNC_INTERVAL_MIN_SECONDS,
  SYNC_PLAYERS_PER_MINUTE,
  SYNC_REQUESTS_PER_MINUTE,
  nextSyncIntervalSeconds,
  syncPassTimeoutMs,
  type SyncCadenceTrace,
} from "@/lib/sync-cadence";

/**
 * La cadencia es pura: se prueba con números, sin base, sin red y sin reloj. Los
 * casos están calcados de lo que deja el rastro de una pasada real, para que la
 * tabla de `docs/OPERACION.md` y esta prueba no puedan contar cosas distintas.
 */
function trace(overrides: Partial<SyncCadenceTrace> = {}): SyncCadenceTrace {
  return {
    playersTotal: 13,
    apiRequests: 20,
    durationMs: 15_853,
    rateLimitResponses: 0,
    ...overrides,
  };
}

describe("nextSyncIntervalSeconds", () => {
  it("sin rastro va al máximo: no hay medida que justifique apretar", () => {
    expect(nextSyncIntervalSeconds(null)).toBe(SYNC_INTERVAL_MAX_SECONDS);
  });

  it("con el torneo pequeño medido en producción baja al minuto", () => {
    // 13 jugadores, 15,9 s y ~20 peticiones: las tres cuentas piden 60 s o menos.
    expect(nextSyncIntervalSeconds(trace())).toBe(60);
  });

  it("con un torneo de 50-60 jugadores se queda en 3 minutos", () => {
    // Es el tamaño de un torneo de verdad: 60 / 15 = 4 → 240 s, recortado a 180.
    for (const playersTotal of [50, 60]) {
      expect(
        nextSyncIntervalSeconds(trace({ playersTotal, apiRequests: 80, durationMs: 40_000 })),
      ).toBe(SYNC_INTERVAL_MAX_SECONDS);
    }
  });

  it("20 jugadores piden dos minutos aunque la pasada sea rápida", () => {
    expect(
      nextSyncIntervalSeconds(trace({ playersTotal: 20, apiRequests: 20, durationMs: 20_000 })),
    ).toBe(120);
  });

  it("las peticiones también acotan: 45 caben en un minuto, 46 piden dos", () => {
    expect(nextSyncIntervalSeconds(trace({ apiRequests: 45 }))).toBe(60);
    expect(nextSyncIntervalSeconds(trace({ apiRequests: 46 }))).toBe(120);
  });

  it("una pasada lenta sube la cadencia aunque el roster sea pequeño", () => {
    // 70 s × 3 = 210 s, por encima del máximo: la siguiente pasada espera 3 min.
    expect(nextSyncIntervalSeconds(trace({ durationMs: 70_000 }))).toBe(
      SYNC_INTERVAL_MAX_SECONDS,
    );
  });

  it("un 429 fuerza el máximo, aunque el resto de cuentas digan que se puede ir rápido", () => {
    expect(nextSyncIntervalSeconds(trace({ rateLimitResponses: 1 }))).toBe(
      SYNC_INTERVAL_MAX_SECONDS,
    );
  });

  it("sin jugadores aprobados no se despierta cada minuto para nada", () => {
    expect(nextSyncIntervalSeconds(trace({ playersTotal: 0 }))).toBe(
      SYNC_INTERVAL_MAX_SECONDS,
    );
  });

  it("nunca baja del mínimo ni sube del máximo", () => {
    const pequeno = nextSyncIntervalSeconds(
      trace({ playersTotal: 1, apiRequests: 1, durationMs: 1_000 }),
    );
    const enorme = nextSyncIntervalSeconds(
      trace({ playersTotal: 500, apiRequests: 500, durationMs: 500_000 }),
    );

    expect(pequeno).toBe(SYNC_INTERVAL_MIN_SECONDS);
    expect(enorme).toBe(SYNC_INTERVAL_MAX_SECONDS);
  });

  it("un rastro sin peticiones no rompe la cuenta", () => {
    expect(nextSyncIntervalSeconds(trace({ apiRequests: 0, durationMs: 10_000 }))).toBe(60);
  });

  it("los presupuestos publicados son los que usa la fórmula", () => {
    expect(SYNC_PLAYERS_PER_MINUTE).toBe(15);
    expect(SYNC_REQUESTS_PER_MINUTE).toBe(45);
  });
});

describe("syncPassTimeoutMs", () => {
  it("deja 10 s de margen antes del siguiente disparo", () => {
    expect(syncPassTimeoutMs(60)).toBe(50_000);
    expect(syncPassTimeoutMs(90)).toBe(80_000);
    expect(syncPassTimeoutMs(180)).toBe(170_000);
  });

  it("no baja de 30 s aunque la ventana fuera más corta", () => {
    expect(syncPassTimeoutMs(20)).toBe(30_000);
  });
});
