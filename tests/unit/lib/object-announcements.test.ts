import { describe, expect, it } from "vitest";

import { ObjectKind } from "@/generated/prisma/enums";
import {
  formatReturnProbability,
  newObjectAwardAnnouncementText,
  objectFulfillmentAnnouncementText,
  objectPenaltyText,
  objectThrowAnnouncementText,
} from "@/lib/object-announcements";

/**
 * Los textos de los avisos de objetos.
 *
 * Todo es puro: el catálogo resuelve el nombre y la desventaja, y las funciones solo
 * componen la frase. Lo que se fija es lo que no puede cambiar sin querer: que el
 * aviso diga quién, qué objeto y qué desventaja, que la probabilidad se lea como un
 * porcentaje y que un `penaltyId` que ya no está en el catálogo no invente texto.
 */

describe("newObjectAwardAnnouncementText", () => {
  it("nombra al ganador, el objeto, el motivo y la desventaja", () => {
    expect(
      newObjectAwardAnnouncementText({
        kind: ObjectKind.RELIQUIA,
        winnerName: "BeastWizard",
        penaltyId: "sin-guarecer-reliquias",
      }),
    ).toBe(
      "Objeto nuevo: «Reliquia pagana» para BeastWizard, por victoria sagrada o religiosa. Desventaja: No se pueden guarecer reliquias.",
    );
  });

  it("respalda al ganador borrado con una fórmula sin nombre", () => {
    expect(
      newObjectAwardAnnouncementText({
        kind: ObjectKind.MONEDA,
        winnerName: null,
        penaltyId: "sin-2tc",
      }),
    ).toBe(
      "Objeto nuevo: «Moneda del Rey falsificada» para un participante, por conquista. Desventaja: No se puede hacer 2TC.",
    );
  });

  it("no inventa una desventaja que ya no está en el catálogo", () => {
    expect(
      newObjectAwardAnnouncementText({
        kind: ObjectKind.MONUMENTO,
        winnerName: "Rival",
        penaltyId: "desventaja-retirada",
      }),
    ).toContain("Desventaja: desventaja no reconocida en el catálogo.");
  });
});

describe("objectThrowAnnouncementText", () => {
  it("cuenta el lanzamiento devuelto, con los dos jugadores y la probabilidad", () => {
    expect(
      objectThrowAnnouncementText({
        kind: ObjectKind.RELIQUIA,
        fromName: "BeastWizard",
        toName: "Rival",
        returned: true,
        probability: 0.12,
        penaltyId: "sin-guarecer-reliquias",
      }),
    ).toBe(
      "Objeto lanzado: «Reliquia pagana» de BeastWizard a Rival, con un 12 % de probabilidad de devolución. Se ha devuelto: el objeto sigue en manos de BeastWizard. Desventaja: No se pueden guarecer reliquias.",
    );
  });

  it("cuenta el lanzamiento aceptado y a quién pasa el objeto", () => {
    expect(
      objectThrowAnnouncementText({
        kind: ObjectKind.MONUMENTO,
        fromName: "BeastWizard",
        toName: "Rival",
        returned: false,
        probability: 0.01,
        penaltyId: "sin-fuertes",
      }),
    ).toBe(
      "Objeto lanzado: «Monumento» de BeastWizard a Rival, con un 1 % de probabilidad de devolución. No se ha devuelto: el objeto pasa a manos de Rival. Desventaja: No se pueden construir fuertes.",
    );
  });

  it("usa la fórmula de respaldo si falta alguno de los dos nombres", () => {
    expect(
      objectThrowAnnouncementText({
        kind: ObjectKind.MONEDA,
        fromName: null,
        toName: null,
        returned: false,
        probability: 0.5,
        penaltyId: "sin-2tc",
      }),
    ).toContain("de un participante a un participante");
  });
});

describe("objectFulfillmentAnnouncementText", () => {
  it("nombra al portador, la desventaja superada y que vuelve a puntuar", () => {
    expect(
      objectFulfillmentAnnouncementText({
        kind: ObjectKind.RELIQUIA,
        holderName: "BeastWizard",
        penaltyId: "sin-unidades-monasterio",
      }),
    ).toBe(
      "Objeto cumplido: «Reliquia pagana» en manos de BeastWizard. Desventaja superada: No se pueden crear unidades del monasterio. La partida con la que se cumple vuelve a puntuar.",
    );
  });
});

describe("formatReturnProbability", () => {
  it("redondea a un porcentaje entero", () => {
    expect(formatReturnProbability(0.01)).toBe("1 %");
    expect(formatReturnProbability(0.1234)).toBe("12 %");
    expect(formatReturnProbability(0.99)).toBe("99 %");
    expect(formatReturnProbability(0)).toBe("0 %");
  });
});

describe("objectPenaltyText", () => {
  it("resuelve el id contra el catálogo del objeto", () => {
    expect(objectPenaltyText(ObjectKind.MONUMENTO, "sin-fuertes")).toBe(
      "No se pueden construir fuertes.",
    );
  });

  it("devuelve null si el id no está en el catálogo de ese objeto", () => {
    expect(objectPenaltyText(ObjectKind.MONUMENTO, "sin-2tc")).toBeNull();
  });
});
