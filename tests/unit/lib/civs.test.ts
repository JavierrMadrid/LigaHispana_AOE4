import { describe, expect, it } from "vitest";

import { civilizationFile, objectiveCivilization } from "@/lib/civs";

/**
 * Los assets de civilización como dato: qué fichero le toca a cada una y qué
 * civilización lleva pegada un id de objetivo.
 *
 * Es puro y vive fuera de los componentes para que lo puedan usar la web y la
 * API del overlay, así que lo que se comprueba aquí es lo que las dos caras dan
 * por hecho: el nombre del fichero y los prefijos que lo resuelven.
 */

describe("civilizationFile", () => {
  it("devuelve el fichero de una civilización conocida", () => {
    expect(civilizationFile("japanese")).toBe("Japanese_AoE4.webp");
  });

  it("devuelve null para una civilización sin asset", () => {
    expect(civilizationFile("atlantis")).toBeNull();
    expect(civilizationFile("")).toBeNull();
  });

  it("no confunde una propiedad del prototipo con un fichero", () => {
    expect(civilizationFile("constructor")).toBeNull();
    expect(civilizationFile("toString")).toBeNull();
  });
});

describe("objectiveCivilization", () => {
  it("resuelve los tres prefijos de civilización", () => {
    expect(objectiveCivilization("lider-japanese")).toBe("japanese");
    expect(objectiveCivilization("acolito-holy_roman_empire")).toBe("holy_roman_empire");
    expect(objectiveCivilization("masterizando-japanese")).toBe("japanese");
  });

  it("devuelve null en los objetivos que no son de civilización", () => {
    expect(objectiveCivilization("rey-1v1")).toBeNull();
    expect(objectiveCivilization("loco-por-ganar")).toBeNull();
  });
});
