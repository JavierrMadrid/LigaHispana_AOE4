import { describe, expect, it } from "vitest";

import {
  countryFlagSvgUrl,
  countryFlagUrl,
} from "@/lib/flag";

/**
 * El paso de rótulo canónico a bandera.
 *
 * Lo que se comprueba es la política de resolución, no las URLs del CDN: los dos
 * mapas comparten las mismas reglas, así que un caso conocido, un `null` y un
 * rótulo desconocido recorren los caminos que importan. Las dos funciones tienen
 * que coincidir en qué países existen y en devolver `null` a la vez.
 */

/** Los países admitidos; el mismo conjunto que siembra `paises.txt`. */
const COUNTRIES = [
  "Colombia",
  "España",
  "Venezuela",
  "Perú",
  "Ecuador",
  "Guatemala",
  "Bolivia",
  "Cuba",
  "República Dominicana",
  "Honduras",
  "Paraguay",
  "El Salvador",
  "Nicaragua",
  "Costa Rica",
  "Panamá",
  "Guinea Ecuatorial",
  "Antigua y Barbuda",
  "México",
  "Argentina",
  "Chile",
  "Uruguay",
  "Puerto Rico",
] as const;

describe("countryFlagUrl", () => {
  it("resuelve un rótulo canónico a su PNG", () => {
    expect(countryFlagUrl("España")).toBe("https://flagcdn.com/w40/es.png");
  });

  it("`pr` es Puerto Rico y `do` la República Dominicana, sin confundirlos", () => {
    expect(countryFlagUrl("Puerto Rico")).toBe("https://flagcdn.com/w40/pr.png");
    expect(countryFlagUrl("República Dominicana")).toBe("https://flagcdn.com/w40/do.png");
  });

  it("sin país devuelve `null`", () => {
    expect(countryFlagUrl(null)).toBeNull();
  });

  it("un rótulo que no está en el mapa devuelve `null`", () => {
    expect(countryFlagUrl("Narnia")).toBeNull();
  });
});

describe("countryFlagSvgUrl", () => {
  it("resuelve un rótulo canónico a su SVG", () => {
    expect(countryFlagSvgUrl("España")).toBe("https://flagcdn.com/es.svg");
  });

  it("sin país devuelve `null`", () => {
    expect(countryFlagSvgUrl(null)).toBeNull();
  });

  it("un rótulo que no está en el mapa devuelve `null`", () => {
    expect(countryFlagSvgUrl("Narnia")).toBeNull();
  });
});

describe("los dos mapas cubren el mismo conjunto de países", () => {
  it("cada país admitido tiene PNG y SVG", () => {
    // Comparten mapa y política de `null`: si uno devuelve algo, el otro también;
    // solo pueden discrepar en `null` a la vez.
    for (const country of COUNTRIES) {
      expect(countryFlagUrl(country), `PNG de ${country}`).not.toBeNull();
      expect(countryFlagSvgUrl(country), `SVG de ${country}`).not.toBeNull();
    }
  });
});
