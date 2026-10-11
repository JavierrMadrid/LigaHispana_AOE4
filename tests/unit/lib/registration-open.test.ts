import { describe, expect, it } from "vitest";

import {
  DEFAULT_REGISTRATION_OPEN,
  parseRegistrationOpen,
  REGISTRATION_CLOSED_MESSAGE,
  REGISTRATION_OPEN_KEY,
} from "@/lib/registration-open";

/**
 * El contrato del plazo de inscripción es puro: no toca la base ni la red, así
 * que aquí solo se comprueba lo que decide —la clave, el valor por defecto y cómo
 * se lee el booleano guardado—, no quién lo lee ni cuándo. La lectura real vive en
 * `src/lib/settings.ts` y se ejerce con la base de datos, no aquí.
 */

describe("parseRegistrationOpen", () => {
  it("un booleano se respeta tal cual", () => {
    expect(parseRegistrationOpen(true)).toBe(true);
    expect(parseRegistrationOpen(false)).toBe(false);
  });

  it("un valor raro o ausente cae al default, que es cerrada", () => {
    for (const raro of [null, undefined, 0, 1, "true", "false", "sí", {}, [], ""]) {
      expect(parseRegistrationOpen(raro)).toBe(DEFAULT_REGISTRATION_OPEN);
    }
  });
});

describe("clave y default", () => {
  it("la clave es la que lee y escribe `Setting`", () => {
    expect(REGISTRATION_OPEN_KEY).toBe("registration.open");
  });

  it("sin fila publicada el plazo está cerrado", () => {
    expect(DEFAULT_REGISTRATION_OPEN).toBe(false);
  });

  it("el mensaje de cierre existe y no juzga la oficialidad del torneo", () => {
    expect(REGISTRATION_CLOSED_MESSAGE.length).toBeGreaterThan(0);
    expect(REGISTRATION_CLOSED_MESSAGE.toLowerCase()).not.toContain("oficial");
  });
});
