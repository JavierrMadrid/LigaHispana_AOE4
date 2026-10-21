import { describe, expect, it } from "vitest";

import {
  GAMES_BATCH_ERRORS_LIMIT,
  parseGamesCursorValue,
  readGamesBatchErrors,
  readSyncRunTraceValue,
} from "@/lib/settings";

/**
 * Los parsers tolerantes de la memoria persistida del sincronizador.
 *
 * Son funciones puras sobre `Setting.value`: se prueban sin base de datos y con
 * el mismo criterio que el resto de la frontera de `settings.ts` —un campo que
 * no se puede leer cae a su valor por defecto, y una fila sin las dos fechas del
 * cursor se descarta entera porque no hay `updated_since` que usar.
 */

const CURSOR_COMPLETO = {
  updatedAt: "2026-10-20T21:00:00.000Z",
  seededAt: "2026-10-12T22:00:00.000Z",
  seededFrom: "sync.lastRun.finishedAt",
  bulkIncompleteStreak: 3,
  pendingBestCount: 7,
  pendingBestAt: "2026-10-20T20:00:00.000Z",
} as const;

describe("parseGamesCursorValue", () => {
  it("lee un cursor completo", () => {
    expect(parseGamesCursorValue(CURSOR_COMPLETO)).toEqual(CURSOR_COMPLETO);
  });

  it("una fila solo-semilla sale con los contadores a cero", () => {
    expect(
      parseGamesCursorValue({
        updatedAt: "2026-10-20T21:00:00.000Z",
        seededAt: "2026-10-12T22:00:00.000Z",
        seededFrom: "catch-up",
      }),
    ).toEqual({
      updatedAt: "2026-10-20T21:00:00.000Z",
      seededAt: "2026-10-12T22:00:00.000Z",
      seededFrom: "catch-up",
      bulkIncompleteStreak: 0,
      pendingBestCount: 0,
      pendingBestAt: null,
    });
  });

  it("sin fechas legibles no hay cursor", () => {
    expect(parseGamesCursorValue(null)).toBeNull();
    expect(parseGamesCursorValue({})).toBeNull();
    expect(parseGamesCursorValue({ updatedAt: "2026-10-20T21:00:00.000Z" })).toBeNull();
    expect(
      parseGamesCursorValue({
        updatedAt: "ayer",
        seededAt: "2026-10-12T22:00:00.000Z",
      }),
    ).toBeNull();
    expect(
      parseGamesCursorValue({
        updatedAt: "2026-10-20T21:00:00.000Z",
        seededAt: 42,
      }),
    ).toBeNull();
  });

  it("un `seededFrom` desconocido se lee como `catch-up`", () => {
    const estado = parseGamesCursorValue({
      ...CURSOR_COMPLETO,
      seededFrom: "otra-cosa",
    });

    expect(estado?.seededFrom).toBe("catch-up");
  });

  it("los contadores negativos o no numéricos se sanean a 0", () => {
    const estado = parseGamesCursorValue({
      ...CURSOR_COMPLETO,
      bulkIncompleteStreak: -4,
      pendingBestCount: "muchos",
      pendingBestAt: "",
    });

    expect(estado?.bulkIncompleteStreak).toBe(0);
    expect(estado?.pendingBestCount).toBe(0);
    expect(estado?.pendingBestAt).toBeNull();
  });
});

describe("readGamesBatchErrors", () => {
  it("lee los errores válidos y se queda con el tope", () => {
    const errores = Array.from({ length: GAMES_BATCH_ERRORS_LIMIT + 2 }, (_, index) => ({
      batch: index + 1,
      firstProfileId: 100 + index,
      lastProfileId: 149 + index,
      error: `fallo ${index + 1}`,
    }));

    expect(readGamesBatchErrors(errores)).toEqual(errores.slice(0, GAMES_BATCH_ERRORS_LIMIT));
  });

  it("descarta los items incompletos y lo que no es una lista", () => {
    expect(readGamesBatchErrors(undefined)).toEqual([]);
    expect(readGamesBatchErrors({})).toEqual([]);
    expect(
      readGamesBatchErrors([
        { batch: 1, firstProfileId: 10, lastProfileId: 20, error: "ok" },
        { batch: 2, firstProfileId: 10, lastProfileId: 20 },
        { batch: "3", firstProfileId: 10, lastProfileId: 20, error: "mal" },
        null,
      ]),
    ).toEqual([{ batch: 1, firstProfileId: 10, lastProfileId: 20, error: "ok" }]);
  });
});

describe("readSyncRunTraceValue", () => {
  it("un rastro viejo sale con los campos nuevos a su valor neutro", () => {
    const traza = readSyncRunTraceValue({
      startedAt: "2026-10-20T21:00:00.000Z",
      finishedAt: "2026-10-20T21:00:10.000Z",
      playersTotal: 10,
      playersOk: 10,
      failures: [],
    });

    expect(traza).not.toBeNull();
    expect(traza?.gamesPagesRead).toBe(0);
    expect(traza?.gamesBatchesIncomplete).toBe(0);
    expect(traza?.gamesBatchesFailed).toBe(0);
    expect(traza?.gamesPlayersQueuedForBackfill).toBe(0);
    expect(traza?.gamesBatchErrors).toEqual([]);
    expect(traza?.gamesCursor).toBeNull();
    expect(traza?.gamesCursorAdvanced).toBe(false);
    expect(traza?.gamesCursorSeeded).toBe(false);
    expect(traza?.backfillPlayers).toBe(0);
    expect(traza?.backfillPagesRead).toBe(0);
    expect(traza?.backfillPending).toBe(0);
    expect(traza?.apiNotice).toBeNull();
  });

  it("lee los campos nuevos y solo acepta `true` como booleano", () => {
    const traza = readSyncRunTraceValue({
      startedAt: "2026-10-20T21:00:00.000Z",
      finishedAt: "2026-10-20T21:00:10.000Z",
      gamesPagesRead: 3,
      gamesBatchesIncomplete: 1,
      gamesBatchesFailed: 0,
      gamesPlayersQueuedForBackfill: 2,
      gamesBatchErrors: [
        { batch: 1, firstProfileId: 10, lastProfileId: 20, error: "429" },
      ],
      gamesCursor: "2026-10-20T20:00:00.000Z",
      gamesCursorAdvanced: "true",
      gamesCursorSeeded: true,
      backfillPlayers: 2,
      backfillPagesRead: 4,
      backfillPending: 2,
      apiNotice: "aviso",
    });

    expect(traza?.gamesPagesRead).toBe(3);
    expect(traza?.gamesBatchesIncomplete).toBe(1);
    expect(traza?.gamesPlayersQueuedForBackfill).toBe(2);
    expect(traza?.gamesBatchErrors).toHaveLength(1);
    expect(traza?.gamesCursor).toBe("2026-10-20T20:00:00.000Z");
    // Un `"true"` de texto no es un booleano: solo el literal `true` lo es.
    expect(traza?.gamesCursorAdvanced).toBe(false);
    expect(traza?.gamesCursorSeeded).toBe(true);
    expect(traza?.backfillPlayers).toBe(2);
    expect(traza?.backfillPagesRead).toBe(4);
    expect(traza?.backfillPending).toBe(2);
    expect(traza?.apiNotice).toBe("aviso");
  });
});
