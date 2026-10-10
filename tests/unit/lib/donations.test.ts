import { describe, expect, it } from "vitest";

import {
  DEFAULT_MATCHERINO_DONATIONS,
  MATCHERINO_DONATIONS_KEY,
  parseMatcherinoDonations,
} from "@/lib/donations";

/**
 * El contrato de la campaña de donaciones es puro: no toca la base ni la red, así
 * que aquí solo se comprueba lo que decide —la clave, el valor por defecto y cómo
 * se lee lo guardado—, no quién lo lee ni cuándo. La lectura real vive en
 * `src/lib/settings.ts` y se ejerce con la base de datos, no aquí.
 */

describe("parseMatcherinoDonations", () => {
  it("un valor válido se respeta tal cual", () => {
    expect(
      parseMatcherinoDonations({ enabled: true, url: "https://matcherino.com/c/abc" }),
    ).toEqual({ enabled: true, url: "https://matcherino.com/c/abc" });

    expect(
      parseMatcherinoDonations({ enabled: false, url: "https://matcherino.com/c/abc" }),
    ).toEqual({ enabled: false, url: "https://matcherino.com/c/abc" });
  });

  it("acepta también http sin cifrar", () => {
    expect(parseMatcherinoDonations({ enabled: true, url: "http://matcherino.com/c/abc" })).toEqual({
      enabled: true,
      url: "http://matcherino.com/c/abc",
    });
  });

  it("recorta los espacios de la URL", () => {
    expect(
      parseMatcherinoDonations({ enabled: true, url: "  https://matcherino.com/c/abc  " }),
    ).toEqual({ enabled: true, url: "https://matcherino.com/c/abc" });
  });

  it("un valor ausente o que no sea objeto cae al default, que es apagada", () => {
    for (const raro of [null, undefined, 0, 1, true, "https://matcherino.com/c/abc", []]) {
      expect(parseMatcherinoDonations(raro)).toEqual(DEFAULT_MATCHERINO_DONATIONS);
    }
  });

  it("campos con el tipo incorrecto se degradan, no revientan", () => {
    expect(parseMatcherinoDonations({ enabled: "true", url: "https://matcherino.com/c/abc" })).toEqual(
      { enabled: false, url: "https://matcherino.com/c/abc" },
    );

    expect(parseMatcherinoDonations({ enabled: true, url: 42 })).toEqual({
      enabled: false,
      url: "",
    });

    expect(parseMatcherinoDonations({ enabled: true })).toEqual({ enabled: false, url: "" });
  });

  it("una URL vacía es 'sin URL'", () => {
    expect(parseMatcherinoDonations({ enabled: true, url: "" })).toEqual({
      enabled: false,
      url: "",
    });

    expect(parseMatcherinoDonations({ enabled: true, url: "   " })).toEqual({
      enabled: false,
      url: "",
    });
  });

  it("una URL que no sea http o https se descarta y apaga la campaña", () => {
    for (const mala of [
      "javascript:alert(1)",
      "data:text/html,<script>",
      "ftp://matcherino.com/c/abc",
      "matcherino.com/c/abc",
      "no es una dirección",
    ]) {
      expect(parseMatcherinoDonations({ enabled: true, url: mala })).toEqual({
        enabled: false,
        url: "",
      });
    }
  });
});

describe("clave y default", () => {
  it("la clave es la que lee y escribe `Setting`", () => {
    expect(MATCHERINO_DONATIONS_KEY).toBe("donations.matcherino");
  });

  it("sin fila publicada la campaña está apagada y sin URL", () => {
    expect(DEFAULT_MATCHERINO_DONATIONS).toEqual({ enabled: false, url: "" });
  });
});
