import { describe, expect, it } from "vitest";

import { uniqueViolationOn } from "@/lib/db-errors";

/**
 * Qué unicidad saltó cuando Prisma avisa con `P2002`.
 *
 * `Player` tiene tres columnas únicas y las tres saltan con el mismo código, así que
 * la pregunta "¿cuál de las dos (o de las tres)?" la decide esta función y no otra
 * cosa: si se leyera mal, alguien cuyo perfil de AoE4World es nuevo recibiría "ese
 * perfil ya está registrado", que no lleva a ninguna corrección. Es pura (no toca la
 * base de datos) y lo que se prueba aquí es la forma de `meta.target`, que es lo
 * único que ha dado guerra: Prisma la devuelve como cadena en unas versiones y como
 * lista en otras, y el nombre puede ser el de la columna o el de la restricción de
 * Postgres.
 */

/** Un `P2002` con la forma que da Prisma sobre Postgres: `target` como lista. */
function p2002(target: unknown): Error {
  return Object.assign(new Error("Unique constraint failed"), { code: "P2002", meta: { target } });
}

describe("uniqueViolationOn", () => {
  it("reconoce la columna, sea cual sea la forma del `target`", () => {
    expect(uniqueViolationOn(p2002(["discordUsername"]), "discordUsername")).toBe(true);
    expect(uniqueViolationOn(p2002("discordUsername"), "discordUsername")).toBe(true);
    // El nombre de la restricción de Postgres en vez del de la columna.
    expect(uniqueViolationOn(p2002("Player_discordUsername_key"), "discordUsername")).toBe(true);
  });

  it("no confunde una columna con otra, ni `discordUserId` con `discordUsername`", () => {
    // Estas dos se parecen mucho y es justo el caso que falla si se compara con un
    // `startsWith` o con un `includes` mal colocado: las tres unicidades de `Player`
    // comparten prefijo y son tres mensajes distintos.
    expect(uniqueViolationOn(p2002(["discordUserId"]), "discordUsername")).toBe(false);
    expect(uniqueViolationOn(p2002(["discordUsername"]), "discordUserId")).toBe(false);
    expect(uniqueViolationOn(p2002(["profileId"]), "discordUsername")).toBe(false);
  });

  it("un error que no es un `P2002` no colisiona con ninguna columna", () => {
    expect(uniqueViolationOn(Object.assign(new Error("nope"), { code: "P2025" }), "profileId")).toBe(
      false,
    );
    expect(uniqueViolationOn(new Error("nope"), "profileId")).toBe(false);
    expect(uniqueViolationOn(null, "profileId")).toBe(false);
    expect(uniqueViolationOn(undefined, "profileId")).toBe(false);
    expect(uniqueViolationOn("P2002", "profileId")).toBe(false);
  });

  it("un `P2002` sin `target` legible sale `false`, que es lo menos malo", () => {
    // Depende de la versión del cliente: si no se puede saber qué unicidad saltó, el
    // que llama lo trata como su caso por defecto (`profileId` en la inscripción), que
    // es el comportamiento que había antes de distinguir nada.
    expect(uniqueViolationOn(p2002(undefined), "discordUsername")).toBe(false);
    expect(uniqueViolationOn(p2002(null), "discordUsername")).toBe(false);
    expect(uniqueViolationOn(p2002([]), "discordUsername")).toBe(false);
    expect(uniqueViolationOn(p2002({}), "discordUsername")).toBe(false);
    expect(uniqueViolationOn(Object.assign(new Error("x"), { code: "P2002" }), "discordUsername")).toBe(
      false,
    );
  });
});
