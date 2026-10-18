import { describe, expect, it } from "vitest";

import {
  describeParticipantRoleSync,
  EMPTY_PARTICIPANT_ROLE_MEMORY,
  PARTICIPANT_ROLE_KEY,
  parseParticipantRoleMemory,
  planParticipantRoleSync,
  type ParticipantRoleSyncResult,
} from "@/lib/discord/participant-role";

/**
 * El rol de participante en Discord: qué toca hacer con él y qué se puede concluir de la
 * memoria.
 *
 * Todo es puro y sin red: los conjuntos de ids van escritos a mano y el resultado es una
 * resta, así que ni la base de datos ni el token del bot hacen falta. Lo que se comprueba
 * aquí es **lo que decide a quién se le pone o se le quita el rol**, que es justo la
 * parte que no puede equivocarse: una resta al revés le pone el rol de participante a
 * quien no lo es, o se lo quita a quien sí.
 */

function baseResult(overrides: Partial<ParticipantRoleSyncResult> = {}): ParticipantRoleSyncResult {
  return {
    participants: 0,
    withAccount: 0,
    withoutAccount: 0,
    granted: 0,
    added: 0,
    removed: 0,
    skippedByBudget: 0,
    failed: 0,
    error: null,
    warnings: [],
    durationMs: 0,
    ...overrides,
  };
}

describe("la clave de la memoria", () => {
  it("es la que documenta `docs/MODELO-DATOS.md`", () => {
    expect(PARTICIPANT_ROLE_KEY).toBe("discord.participantRole");
  });
});

describe("qué hay que hacer en la pasada", () => {
  it("a quien debería tener el rol y no lo tiene, se le pone", () => {
    const plan = planParticipantRoleSync(["1", "2"], ["1"], { maxPerRun: 10 });

    expect(plan.toAdd).toEqual(["2"]);
    expect(plan.toRemove).toEqual([]);
    expect(plan.skipped).toBe(0);
  });

  it("a quien lo tiene y ya no debería, se le quita", () => {
    const plan = planParticipantRoleSync(["1"], ["1", "2"], { maxPerRun: 10 });

    expect(plan.toAdd).toEqual([]);
    expect(plan.toRemove).toEqual(["2"]);
    expect(plan.skipped).toBe(0);
  });

  it("lo que ya cuadra no se toca, y repetir la resta no hace nada", () => {
    const plan = planParticipantRoleSync(["1", "2"], ["2", "1"], { maxPerRun: 10 });

    expect(plan.toAdd).toEqual([]);
    expect(plan.toRemove).toEqual([]);
    expect(plan.skipped).toBe(0);
  });

  it("devuelve listas ordenadas, para que el rastro y las pruebas sean deterministas", () => {
    const plan = planParticipantRoleSync(["3", "1", "2"], ["5", "4"], { maxPerRun: 10 });

    expect(plan.toAdd).toEqual(["1", "2", "3"]);
    expect(plan.toRemove).toEqual(["4", "5"]);
  });

  it("no repite un id aunque llegue duplicado", () => {
    const plan = planParticipantRoleSync(["1", "1"], [], { maxPerRun: 10 });

    expect(plan.toAdd).toEqual(["1"]);
  });

  it("las quitas van antes que las puestas dentro del tope", () => {
    // Con dos de presupuesto, la quita no puede quedarse esperando a que se gasten las
    // puestas: dejar con el rol de participante a quien ya no lo es es el error visible.
    const plan = planParticipantRoleSync(["10", "11"], ["20", "21"], { maxPerRun: 2 });

    expect(plan.toRemove).toEqual(["20", "21"]);
    expect(plan.toAdd).toEqual([]);
    expect(plan.skipped).toBe(2);
  });

  it("reparte el tope entre quitar y poner, y cuenta lo que queda", () => {
    const plan = planParticipantRoleSync(["10", "11"], ["20"], { maxPerRun: 2 });

    expect(plan.toRemove).toEqual(["20"]);
    expect(plan.toAdd).toEqual(["10"]);
    expect(plan.skipped).toBe(1);
  });

  it("con un tope de cero no hace nada y lo deja todo para la siguiente pasada", () => {
    const plan = planParticipantRoleSync(["1"], ["2"], { maxPerRun: 0 });

    expect(plan.toAdd).toEqual([]);
    expect(plan.toRemove).toEqual([]);
    expect(plan.skipped).toBe(2);
  });

  it("con un tope que no es un número tampoco hace nada", () => {
    const plan = planParticipantRoleSync(["1"], ["2"], { maxPerRun: Number.NaN });

    expect(plan.toAdd).toEqual([]);
    expect(plan.toRemove).toEqual([]);
    expect(plan.skipped).toBe(2);
  });
});

describe("la memoria del rol", () => {
  it("sin nada guardado está vacía", () => {
    expect(parseParticipantRoleMemory(null)).toEqual(EMPTY_PARTICIPANT_ROLE_MEMORY);
    expect(parseParticipantRoleMemory({})).toEqual(EMPTY_PARTICIPANT_ROLE_MEMORY);
  });

  it("un documento que no se entiende se lee como vacío, nunca al revés", () => {
    // Dirección segura: como mucho, se vuelve a poner un rol que ya estaba (un `PUT`
    // idempotente); no se quita ninguno hasta que la memoria se reconstruya.
    expect(parseParticipantRoleMemory({ granted: "1" })).toEqual(EMPTY_PARTICIPANT_ROLE_MEMORY);
    expect(parseParticipantRoleMemory("texto")).toEqual(EMPTY_PARTICIPANT_ROLE_MEMORY);
  });

  it("conserva los ids y descarta lo que no es un id", () => {
    const memory = parseParticipantRoleMemory({
      granted: ["1", "", 3, "1", "2"],
      syncedAt: "2026-10-06T12:00:00.000Z",
    });

    expect(memory.granted).toEqual(["1", "2"]);
    expect(memory.syncedAt).toBe("2026-10-06T12:00:00.000Z");
  });

  it("un `syncedAt` que no es texto se lee como `null`", () => {
    expect(parseParticipantRoleMemory({ granted: [], syncedAt: 5 }).syncedAt).toBeNull();
  });
});

describe("la línea del rastro", () => {
  it("no hay nada que decir cuando está configurado, sin cambios y sin avisos", () => {
    expect(describeParticipantRoleSync(baseResult())).toBeNull();
  });

  it("cuenta lo que se ha puesto y lo que se ha quitado", () => {
    const line = describeParticipantRoleSync(
      baseResult({ withAccount: 5, added: 2, removed: 1 }),
    );

    expect(line).toContain("Rol de participante:");
    expect(line).toContain("5 con cuenta");
    expect(line).toContain("2 con el rol puesto");
    expect(line).toContain("1 con el rol quitado");
  });

  it("dice el motivo cuando el paso no existe por falta de configuración", () => {
    const line = describeParticipantRoleSync(
      baseResult({ error: "Sin DISCORD_PARTICIPANT_ROLE_ID no se sincroniza el rol." }),
    );

    expect(line).toContain("Sin DISCORD_PARTICIPANT_ROLE_ID");
  });

  it("añade los avisos (un 403, un timeout) al final", () => {
    const line = describeParticipantRoleSync(
      baseResult({ failed: 1, warnings: ["Beast: no se le ha podido poner el rol (403)."] }),
    );

    expect(line).toContain("1 con error");
    expect(line).toContain("Beast: no se le ha podido poner el rol (403).");
  });
});
