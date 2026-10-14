import { describe, expect, it } from "vitest";

import {
  DEFAULT_REGISTRATION_OPEN,
  normalizeRegistrationClosesAt,
  parseRegistrationClosesAt,
  parseRegistrationOpen,
  REGISTRATION_CLOSED_MESSAGE,
  REGISTRATION_CLOSES_AT_KEY,
  REGISTRATION_DEADLINE_PASSED_MESSAGE,
  REGISTRATION_OPEN_KEY,
  registrationClosedMessage,
  resolveRegistrationState,
} from "@/lib/registration-open";

/**
 * El contrato del plazo de inscripción es puro: no toca la base ni la red, así que
 * aquí solo se comprueba lo que decide —las dos claves, el valor por defecto, cómo se
 * lee el booleano, cómo se normaliza la fecha y qué estado sale de la conjunción—, no
 * quién lo lee ni cuándo. La lectura real vive en `src/lib/settings.ts` y se ejerce con
 * la base de datos, no aquí.
 */

/** El instante de referencia de los casos de estado: 2026-09-20 12:00 UTC. */
const AHORA = new Date("2026-09-20T12:00:00.000Z");

/** Una fecha de cierre futura (diez días) y una pasada, ambas en UTC. */
const FUTURA = "2026-09-30T00:00:00.000Z";
const PASADA = "2026-09-10T00:00:00.000Z";

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

describe("normalizeRegistrationClosesAt", () => {
  it("acepta un instante con `Z` y lo deja en ISO UTC", () => {
    expect(normalizeRegistrationClosesAt("2026-10-01T00:00:00Z")).toBe("2026-10-01T00:00:00.000Z");
  });

  it("acepta un desplazamiento y lo pasa a UTC", () => {
    expect(normalizeRegistrationClosesAt("2026-10-01T02:00:00+02:00")).toBe(
      "2026-10-01T00:00:00.000Z",
    );
  });

  it("los segundos son opcionales", () => {
    expect(normalizeRegistrationClosesAt("2026-10-01T00:00Z")).toBe("2026-10-01T00:00:00.000Z");
  });

  it("rechaza lo que no es un instante con zona", () => {
    // Sin zona es el caso que importa: `datetime-local` del navegador no la manda, y sin
    // ella el instante quedaría a merced de la zona del proceso que lo lea.
    for (const malo of [
      "",
      "   ",
      "2026-10-01T00:00",
      "2026-10-01",
      "2026-10-01T00:00:00",
      "mañana",
      "2026-13-01T00:00:00Z",
    ]) {
      expect(normalizeRegistrationClosesAt(malo)).toBeNull();
    }
  });
});

describe("parseRegistrationClosesAt", () => {
  it("una fecha guardada válida se normaliza", () => {
    expect(parseRegistrationClosesAt("2026-10-01T02:00:00+02:00")).toBe(
      "2026-10-01T00:00:00.000Z",
    );
  });

  it("cualquier cosa que no sea una fecha legible se lee como 'sin fecha'", () => {
    for (const raro of [null, undefined, 0, true, {}, "no es una fecha", ""]) {
      expect(parseRegistrationClosesAt(raro)).toBeNull();
    }
  });
});

describe("resolveRegistrationState", () => {
  it("sin fecha, el estado es el del interruptor", () => {
    expect(resolveRegistrationState({ open: true, closesAt: null, now: AHORA })).toEqual({
      open: true,
      switchOpen: true,
      closesAt: null,
      reason: "open",
    });
    expect(resolveRegistrationState({ open: false, closesAt: null, now: AHORA })).toEqual({
      open: false,
      switchOpen: false,
      closesAt: null,
      reason: "switch",
    });
  });

  it("con la fecha en el futuro y el interruptor abierto, están abiertas", () => {
    expect(resolveRegistrationState({ open: true, closesAt: FUTURA, now: AHORA }).open).toBe(true);
  });

  it("con la fecha pasada se cierran solas, aunque el interruptor siga abierto", () => {
    expect(resolveRegistrationState({ open: true, closesAt: PASADA, now: AHORA })).toEqual({
      open: false,
      switchOpen: true,
      closesAt: PASADA,
      reason: "deadline",
    });
  });

  it("el interruptor cierra antes de la fecha", () => {
    expect(resolveRegistrationState({ open: false, closesAt: FUTURA, now: AHORA })).toEqual({
      open: false,
      switchOpen: false,
      closesAt: FUTURA,
      reason: "switch",
    });
  });

  it("en el instante exacto del cierre ya están cerradas", () => {
    expect(resolveRegistrationState({ open: true, closesAt: FUTURA, now: new Date(FUTURA) }).open).toBe(
      false,
    );
  });
});

describe("registrationClosedMessage", () => {
  it("distingue el cierre por fecha del cierre por interruptor", () => {
    const porFecha = registrationClosedMessage(
      resolveRegistrationState({ open: true, closesAt: PASADA, now: AHORA }),
    );
    const porInterruptor = registrationClosedMessage(
      resolveRegistrationState({ open: false, closesAt: null, now: AHORA }),
    );

    expect(porFecha).toBe(REGISTRATION_DEADLINE_PASSED_MESSAGE);
    expect(porInterruptor).toBe(REGISTRATION_CLOSED_MESSAGE);
    expect(porFecha).not.toBe(porInterruptor);
  });
});

describe("clave y default", () => {
  it("las claves son las que lee y escribe `Setting`", () => {
    expect(REGISTRATION_OPEN_KEY).toBe("registration.open");
    expect(REGISTRATION_CLOSES_AT_KEY).toBe("registration.closesAt");
  });

  it("sin fila publicada el plazo está cerrado", () => {
    expect(DEFAULT_REGISTRATION_OPEN).toBe(false);
  });

  it("los mensajes no juzgan la oficialidad del torneo", () => {
    expect(REGISTRATION_CLOSED_MESSAGE.length).toBeGreaterThan(0);
    expect(REGISTRATION_CLOSED_MESSAGE.toLowerCase()).not.toContain("oficial");
    expect(REGISTRATION_DEADLINE_PASSED_MESSAGE.toLowerCase()).not.toContain("oficial");
  });
});
