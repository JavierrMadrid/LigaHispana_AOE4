import { describe, expect, it } from "vitest";

import { DEFAULT_COUNTRIES, normalizeCountrySelection } from "@/lib/countries";

/**
 * La selección de países de un formulario, validada y normalizada.
 *
 * `normalizeCountrySelection()` es **pura**: no lee nada y no escribe nada, así que se
 * comprueba sin base de datos. Es lo que valida la Server Action que publica la lista
 * (`saveCountries`) antes de tocar `Setting["registration.countries"]`, y lo que se fija
 * aquí es su contrato: qué se admite, qué se rechaza con un mensaje y en qué orden sale
 * lo admitido —el del catálogo, nunca el del formulario, porque es el orden en el que
 * se enseña y en el que se guarda—.
 */

describe("normalizeCountrySelection", () => {
  it("acepta una selección del catálogo y la devuelve", () => {
    const resultado = normalizeCountrySelection(["Colombia", "España", "México"]);

    expect(resultado).toEqual({ ok: true, countries: ["Colombia", "España", "México"] });
  });

  it("normaliza al orden del catálogo, no al del formulario", () => {
    const resultado = normalizeCountrySelection(["México", "Colombia", "España"]);

    // Colombia y España van antes que México en `DEFAULT_COUNTRIES`, así que el orden
    // del formulario no se respeta: el resultado es el del catálogo.
    expect(resultado).toEqual({ ok: true, countries: ["Colombia", "España", "México"] });
  });

  it("rechaza un rótulo que no está en el catálogo, diciendo cuál", () => {
    const resultado = normalizeCountrySelection(["Colombia", "Atlántida"]);

    expect(resultado.ok).toBe(false);
    expect(resultado).toEqual({
      ok: false,
      error: "No se puede admitir «Atlántida»: no está en el catálogo de países del torneo.",
    });
  });

  it("rechaza un rótulo que no coincide exactamente con el del catálogo", () => {
    // Ni la mayúscula ni el acento se pliegan: aquí se publica la lista, no se resuelve
    // lo que escribió una persona (eso es `parseCountry()`).
    expect(normalizeCountrySelection(["ESPAÑA"]).ok).toBe(false);
    expect(normalizeCountrySelection(["Espana"]).ok).toBe(false);
  });

  it("rechaza una selección vacía", () => {
    expect(normalizeCountrySelection([])).toEqual({
      ok: false,
      error: "Hay que admitir al menos un país: sin lista no se puede inscribir nadie.",
    });
  });

  it("rechaza los duplicados", () => {
    const resultado = normalizeCountrySelection(["Colombia", "Colombia"]);

    expect(resultado).toEqual({
      ok: false,
      error: "«Colombia» está repetido en la lista de países admitidos.",
    });
  });

  it("recorta los espacios de fuera e ignora las entradas vacías", () => {
    const resultado = normalizeCountrySelection(["  Colombia ", "", "   ", "España"]);

    expect(resultado).toEqual({ ok: true, countries: ["Colombia", "España"] });
  });

  it("admite la lista entera del catálogo", () => {
    const resultado = normalizeCountrySelection(DEFAULT_COUNTRIES);

    expect(resultado).toEqual({ ok: true, countries: [...DEFAULT_COUNTRIES] });
  });
});
