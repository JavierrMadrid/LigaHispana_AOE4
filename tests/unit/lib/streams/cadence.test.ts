import { describe, expect, it } from "vitest";

import {
  STREAMS_MIN_INTERVAL_MINUTES,
  shouldRefreshStreams,
} from "@/lib/streams/cadence";

const NOW = new Date("2026-10-28T12:00:00.000Z");

describe("shouldRefreshStreams", () => {
  it("sin marca previa comprueba: es la primera pasada o no se pudo leer", () => {
    expect(shouldRefreshStreams(null, NOW)).toBe(true);
  });

  it("con la marca reciente no vuelve a preguntar", () => {
    const haceCincoMinutos = new Date(NOW.getTime() - 5 * 60_000);

    expect(shouldRefreshStreams(haceCincoMinutos, NOW)).toBe(false);
  });

  it("a los diez minutos exactos ya toca", () => {
    const haceDiezMinutos = new Date(NOW.getTime() - STREAMS_MIN_INTERVAL_MINUTES * 60_000);

    expect(shouldRefreshStreams(haceDiezMinutos, NOW)).toBe(true);
  });

  it("un segundo antes todavía no", () => {
    const casiDiez = new Date(NOW.getTime() - STREAMS_MIN_INTERVAL_MINUTES * 60_000 + 1_000);

    expect(shouldRefreshStreams(casiDiez, NOW)).toBe(false);
  });

  it("una marca en el futuro no adelanta la comprobación", () => {
    const enElFuturo = new Date(NOW.getTime() + 30 * 60_000);

    expect(shouldRefreshStreams(enElFuturo, NOW)).toBe(false);
  });

  it("el intervalo se puede bajar por configuración", () => {
    const haceCuatroMinutos = new Date(NOW.getTime() - 4 * 60_000);

    expect(shouldRefreshStreams(haceCuatroMinutos, NOW, 3)).toBe(true);
    expect(shouldRefreshStreams(haceCuatroMinutos, NOW, 5)).toBe(false);
  });
});
