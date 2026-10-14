import { describe, expect, it } from "vitest";

import { resolveStandingsVersion } from "@/lib/public";

/**
 * La decisión de qué versión de reglas publica la clasificación.
 *
 * `getStandings()` consulta primero la versión **activa** y, solo si sale vacía,
 * la **anterior más alta** que tenga filas: `PlayerScore` está particionada por
 * `ruleSetVersion` y cada recálculo escribe solo la activa, así que una preview
 * contra una base donde todavía no ha corrido el motor vería cero filas y la web
 * diría "0 participantes", que es falso.
 *
 * La decisión es una función pura y aquí se comprueban sus tres desenlaces sin
 * base de datos. Lo que **no** se puede probar aquí es la consulta en sí —cuál es
 * la "anterior más alta con filas" y que las filas publicadas sean todas de una
 * única versión—: eso es Prisma y sale en `npm run verify:sync`.
 */

/** Versión activa y anterior; los valores solo tienen que ser distintos y ordenados. */
const ACTIVA = 4;
const ANTERIOR = 3;

describe("resolveStandingsVersion", () => {
  it("caso A: la activa tiene filas, se publica tal cual y sin aviso", () => {
    expect(resolveStandingsVersion(ACTIVA, 8, ANTERIOR)).toEqual({
      ruleSetVersion: ACTIVA,
      pendingRuleSetVersion: null,
    });
  });

  it("caso A: con filas en la activa no importa que no haya ninguna anterior", () => {
    expect(resolveStandingsVersion(ACTIVA, 1, null)).toEqual({
      ruleSetVersion: ACTIVA,
      pendingRuleSetVersion: null,
    });
  });

  it("caso B: la activa está vacía y se publica la anterior, con la activa como pendiente", () => {
    expect(resolveStandingsVersion(ACTIVA, 0, ANTERIOR)).toEqual({
      ruleSetVersion: ANTERIOR,
      pendingRuleSetVersion: ACTIVA,
    });
  });

  it("caso C: sin filas en la activa ni en ninguna anterior, vacío y sin aviso", () => {
    expect(resolveStandingsVersion(ACTIVA, 0, null)).toEqual({
      ruleSetVersion: ACTIVA,
      pendingRuleSetVersion: null,
    });
  });

  it("nunca mezcla versiones: una sola fila en la activa gana a toda la anterior", () => {
    const decidido = resolveStandingsVersion(ACTIVA, 1, ANTERIOR);

    expect(decidido.ruleSetVersion).toBe(ACTIVA);
    expect(decidido.pendingRuleSetVersion).toBeNull();
  });

  it("el aviso de versión pendiente solo aparece cuando las filas no son de la activa", () => {
    const activa = resolveStandingsVersion(ACTIVA, 3, null);
    const respaldo = resolveStandingsVersion(ACTIVA, 0, ANTERIOR);
    const vacio = resolveStandingsVersion(ACTIVA, 0, null);

    expect(activa.pendingRuleSetVersion).toBeNull();
    expect(respaldo.pendingRuleSetVersion).toBe(ACTIVA);
    expect(respaldo.ruleSetVersion).not.toBe(ACTIVA);
    expect(vacio.pendingRuleSetVersion).toBeNull();
  });
});
