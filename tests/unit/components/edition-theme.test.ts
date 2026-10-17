import { describe, expect, it } from "vitest";
import type { CSSProperties } from "react";
import { accentTheme } from "@/components/edition-theme";

/**
 * El acento de la edición traducido a variables CSS.
 *
 * Lo que se comprueba es lo que no se ve en un `#rrggbb` a ojo: que sin color no
 * se toca nada, que un valor que no es un color no se cuela, y que la tinta que
 * va encima del acento se elige por contraste (oscura sobre un acento claro, clara
 * sobre uno oscuro).
 */

const ORO = "#c9a45c";
const AZUL_OSCURO = "#123456";

/** Lee una variable CSS del estilo devuelto (las claves no están en `CSSProperties`). */
function cssVar(theme: CSSProperties | undefined, name: string): string | undefined {
  return (theme as Record<string, string> | undefined)?.[name];
}

/** Suma de los tres canales, para comparar «más claro que» sin abrir el módulo. */
function channelSum(hex: string): number {
  return [1, 3, 5].reduce(
    (total, index) => total + Number.parseInt(hex.slice(index, index + 2), 16),
    0,
  );
}

describe("accentTheme", () => {
  it("no devuelve estilo sin color configurado", () => {
    expect(accentTheme(null)).toBeUndefined();
  });

  it("no devuelve estilo con un valor que no es un color", () => {
    expect(accentTheme("rojo")).toBeUndefined();
    expect(accentTheme("#12345")).toBeUndefined();
    expect(accentTheme("rgb(200, 160, 90)")).toBeUndefined();
  });

  it("normaliza el color a minúsculas y aclara el tono del `:hover`", () => {
    const theme = accentTheme("#C9A45C");

    expect(cssVar(theme, "--accent")).toBe(ORO);
    expect(channelSum(cssVar(theme, "--accent-strong") ?? "")).toBeGreaterThan(channelSum(ORO));
  });

  it("elige tinta oscura sobre un acento claro", () => {
    expect(cssVar(accentTheme(ORO), "--accent-ink")).toBe("#1a1408");
  });

  it("elige tinta clara sobre un acento oscuro", () => {
    expect(cssVar(accentTheme(AZUL_OSCURO), "--accent-ink")).toBe("#e9e3d5");
  });

  it("recalcula el hilo del chrome a partir del acento", () => {
    expect(cssVar(accentTheme(ORO), "--thread")).toContain(ORO);
  });
});
