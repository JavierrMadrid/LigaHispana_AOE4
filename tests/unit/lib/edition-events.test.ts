import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_EDITION_EVENTS,
  DEFAULT_EDITION_EVENTS_STATE,
  EDITION_EVENTS_KEY,
  EDITION_EVENTS_MAX,
  EDITION_EVENTS_STATE_KEY,
  EDITION_EVENTS_STATE_VERSION,
  EDITION_EVENTS_VERSION,
  activeEditionEvent,
  editionEventsLocked,
  eventContains,
  eventWindowBounds,
  mergeEditionEvents,
  parseEditionEventsState,
  readEditionEvents,
  readEditionEventsState,
  removeEditionEventState,
  validateEditionEvents,
  writeEditionEvents,
  writeEditionEventsState,
  type EditionEvent,
  type EditionEventsClient,
  type EditionEventsState,
} from "@/lib/edition-events";

/**
 * Los eventos puntuales: validación, ventana, solapes, bloqueo y snapshot.
 *
 * Todo lo que se prueba aquí es **puro**: el módulo se lee y se escribe con un
 * cliente falso que solo apunta lo que le llega, así que no hace falta base de datos
 * ni red. Lo que se comprueba es lo que no puede permitirse un documento de eventos:
 * que uno roto no tumbe los demás, que no se publiquen eventos fuera del torneo ni
 * solapados, y que un evento que exige Discord sin snapshot no reparta bono.
 */

const VENTANA = { from: "2026-09-15T00:00:00.000Z", to: "2026-10-15T00:00:00.000Z" };

/** Un evento válido; los casos cambian solo lo que prueban. */
function evento(overrides: Partial<EditionEvent> = {}): EditionEvent {
  return {
    id: "clasico",
    name: "Clásico de otoño",
    description: null,
    from: "2026-09-20T17:00:00.000Z",
    to: "2026-09-20T20:00:00.000Z",
    multiplier: 2,
    discordRequired: false,
    ...overrides,
  };
}

/** Un cliente con la única tabla que usa el módulo. */
function fakeClient(row: { value: unknown } | null, options: { fail?: boolean } = {}) {
  const upserts: { key: string; value: unknown }[] = [];

  const client = {
    setting: {
      findUnique: async () => {
        if (options.fail === true) {
          throw new Error("la base no responde");
        }

        return row === null
          ? null
          : { key: EDITION_EVENTS_KEY, value: row.value, updatedAt: new Date(0) };
      },
      upsert: async (args: { create: { key: string; value: unknown } }) => {
        upserts.push(args.create);

        return { key: args.create.key, value: args.create.value, updatedAt: new Date(0) };
      },
    },
  } as unknown as EditionEventsClient;

  return { client, upserts };
}

/** Silencia el `console.warn` del módulo mientras corre una comprobación. */
function silenceWarnings(): void {
  vi.spyOn(console, "warn").mockImplementation(() => {});
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("las claves, la versión y los valores por defecto", () => {
  it("declara sus dos claves y su versión", () => {
    expect(EDITION_EVENTS_KEY).toBe("edition.events");
    expect(EDITION_EVENTS_STATE_KEY).toBe("edition.events.state");
    expect(EDITION_EVENTS_VERSION).toBe(1);
    expect(EDITION_EVENTS_STATE_VERSION).toBe(1);
  });

  it("arranca sin eventos y sin snapshots", () => {
    expect(DEFAULT_EDITION_EVENTS).toEqual({ version: EDITION_EVENTS_VERSION, events: [] });
    expect(DEFAULT_EDITION_EVENTS_STATE).toEqual({
      version: EDITION_EVENTS_STATE_VERSION,
      events: {},
    });
  });

  it("lee un documento ausente como la lista vacía", () => {
    silenceWarnings();
    const merged = mergeEditionEvents(undefined);

    expect(merged.config.events).toEqual([]);
    expect(merged.warnings).toHaveLength(1);
  });
});

describe("mergeEditionEvents: tolerante evento a evento", () => {
  it("acepta un evento válido y normaliza las fechas a ISO UTC", () => {
    const merged = mergeEditionEvents({
      version: EDITION_EVENTS_VERSION,
      events: [
        evento({
          from: "2026-09-20T19:00:00+02:00",
          to: "2026-09-20T22:00:00+02:00",
          name: "  Clásico  ",
          description: "  Dos días de ladder  ",
        }),
      ],
    });

    expect(merged.warnings).toEqual([]);
    expect(merged.config.events).toEqual([
      {
        id: "clasico",
        name: "Clásico",
        description: "Dos días de ladder",
        from: "2026-09-20T17:00:00.000Z",
        to: "2026-09-20T20:00:00.000Z",
        multiplier: 2,
        discordRequired: false,
      },
    ]);
  });

  it("un evento roto no se lleva por delante a los demás", () => {
    const merged = mergeEditionEvents({
      version: EDITION_EVENTS_VERSION,
      events: [evento({ id: "bueno" }), evento({ id: "malo", multiplier: 1 }), evento({ id: "otro" })],
    });

    expect(merged.config.events.map((event) => event.id)).toEqual(["bueno", "otro"]);
    expect(merged.warnings[0]).toContain("multiplier");
  });

  it("exige id y nombre: sin ellos el evento no existe", () => {
    const merged = mergeEditionEvents({
      version: EDITION_EVENTS_VERSION,
      events: [
        evento({ id: "" }),
        evento({ id: "sin-nombre", name: "   " }),
        evento({ id: "nombre-largo", name: "x".repeat(81) }),
      ],
    });

    expect(merged.config.events).toEqual([]);
    expect(merged.warnings).toHaveLength(3);
  });

  it("una descripción demasiado larga se descarta, pero el evento se queda", () => {
    const merged = mergeEditionEvents({
      version: EDITION_EVENTS_VERSION,
      events: [evento({ description: "x".repeat(501) })],
    });

    expect(merged.config.events).toHaveLength(1);
    expect(merged.config.events[0].description).toBeNull();
    expect(merged.warnings[0]).toContain("description");
  });

  it("exige fechas con zona y un rango real", () => {
    const merged = mergeEditionEvents({
      version: EDITION_EVENTS_VERSION,
      events: [
        evento({ id: "sin-zona", from: "2026-09-20T17:00:00" }),
        evento({ id: "invertido", from: "2026-09-20T20:00:00.000Z", to: "2026-09-20T17:00:00.000Z" }),
        evento({ id: "igual", to: "2026-09-20T17:00:00.000Z" }),
        evento({ id: "mes-13", from: "2026-13-20T17:00:00.000Z" }),
      ],
    });

    expect(merged.config.events).toEqual([]);
    expect(merged.warnings).toHaveLength(4);
  });

  it("el multiplicador es un entero mayor o igual que 2", () => {
    const merged = mergeEditionEvents({
      version: EDITION_EVENTS_VERSION,
      events: [
        evento({ id: "uno", multiplier: 1 }),
        evento({ id: "decimal", multiplier: 2.5 }),
        { ...evento({ id: "texto" }), multiplier: "3" },
        evento({ id: "tres", multiplier: 3 }),
      ],
    });

    expect(merged.config.events.map((event) => event.id)).toEqual(["tres"]);
    expect(merged.warnings).toHaveLength(3);
  });

  it("un `discordRequired` que no es booleano se lee como false", () => {
    const merged = mergeEditionEvents({
      version: EDITION_EVENTS_VERSION,
      events: [{ ...evento(), discordRequired: "sí" }],
    });

    expect(merged.config.events[0].discordRequired).toBe(false);
    expect(merged.warnings[0]).toContain("discordRequired");
  });

  it("no admite ids repetidos: se queda el primero", () => {
    const merged = mergeEditionEvents({
      version: EDITION_EVENTS_VERSION,
      events: [evento({ name: "Primero" }), evento({ name: "Segundo" })],
    });

    expect(merged.config.events).toHaveLength(1);
    expect(merged.config.events[0].name).toBe("Primero");
    expect(merged.warnings[0]).toContain("repetido");
  });

  it("conserva como mucho los primeros 20 eventos", () => {
    const events = Array.from({ length: EDITION_EVENTS_MAX + 2 }, (_, index) =>
      evento({ id: `evento-${index}` }),
    );
    const merged = mergeEditionEvents({ version: EDITION_EVENTS_VERSION, events });

    expect(merged.config.events).toHaveLength(EDITION_EVENTS_MAX);
    expect(merged.warnings[0]).toContain(String(EDITION_EVENTS_MAX));
  });

  it("una versión desconocida descarta el documento entero", () => {
    const merged = mergeEditionEvents({ version: 99, events: [evento()] });

    expect(merged.config.events).toEqual([]);
    expect(merged.warnings[0]).toContain("versión");
  });

  it("un `events` que no es lista también se descarta con aviso", () => {
    const merged = mergeEditionEvents({ version: EDITION_EVENTS_VERSION, events: "no" });

    expect(merged.config.events).toEqual([]);
    expect(merged.warnings[0]).toContain("no es una lista");
  });
});

describe("validateEditionEvents: ventana del torneo y solapes", () => {
  it("acepta un evento dentro de la ventana y lo devuelve ordenado", () => {
    const tarde = evento({ id: "tarde", from: "2026-10-01T17:00:00.000Z", to: "2026-10-02T17:00:00.000Z" });
    const pronto = evento({ id: "pronto", from: "2026-09-20T17:00:00.000Z", to: "2026-09-21T17:00:00.000Z" });
    const validado = validateEditionEvents([tarde, pronto], VENTANA);

    expect(validado.warnings).toEqual([]);
    expect(validado.events.map((event) => event.id)).toEqual(["pronto", "tarde"]);
  });

  it("rechaza un evento que empieza antes de la ventana", () => {
    const validado = validateEditionEvents(
      [evento({ from: "2026-09-14T23:00:00.000Z", to: "2026-09-16T00:00:00.000Z" })],
      VENTANA,
    );

    expect(validado.warnings[0]).toContain("antes de la ventana");
  });

  it("rechaza un evento que termina después de la ventana", () => {
    const validado = validateEditionEvents(
      [evento({ from: "2026-10-14T17:00:00.000Z", to: "2026-10-16T17:00:00.000Z" })],
      VENTANA,
    );

    expect(validado.warnings[0]).toContain("después de la ventana");
  });

  it("con la ventana abierta por la derecha no hay tope de fin", () => {
    const validado = validateEditionEvents([evento({ to: "2030-01-01T00:00:00.000Z" })], {
      from: "2026-09-15T00:00:00.000Z",
      to: null,
    });

    expect(validado.warnings).toEqual([]);
  });

  it("dos eventos no pueden solaparse, ni siquiera tocándose por dentro", () => {
    const validado = validateEditionEvents(
      [
        evento({ id: "a", from: "2026-09-20T17:00:00.000Z", to: "2026-09-20T20:00:00.000Z" }),
        evento({ id: "b", from: "2026-09-20T19:00:00.000Z", to: "2026-09-20T22:00:00.000Z" }),
      ],
      VENTANA,
    );

    expect(validado.warnings[0]).toContain("se solapa");
  });

  it("dos eventos contiguos no se solapan: el fin es exclusivo", () => {
    const validado = validateEditionEvents(
      [
        evento({ id: "a", from: "2026-09-20T17:00:00.000Z", to: "2026-09-20T20:00:00.000Z" }),
        evento({ id: "b", from: "2026-09-20T20:00:00.000Z", to: "2026-09-20T22:00:00.000Z" }),
      ],
      VENTANA,
    );

    expect(validado.warnings).toEqual([]);
  });
});

describe("consultas de ventana y bloqueo", () => {
  it("el evento contiene `from` y no contiene `to`", () => {
    const event = evento();

    expect(eventWindowBounds(event)).toEqual({
      from: new Date("2026-09-20T17:00:00.000Z"),
      to: new Date("2026-09-20T20:00:00.000Z"),
    });
    expect(eventContains(event, new Date("2026-09-20T17:00:00.000Z"))).toBe(true);
    expect(eventContains(event, new Date("2026-09-20T19:59:59.999Z"))).toBe(true);
    expect(eventContains(event, new Date("2026-09-20T20:00:00.000Z"))).toBe(false);
    expect(eventContains(event, new Date("2026-09-20T16:59:59.999Z"))).toBe(false);
  });

  it("`activeEditionEvent` devuelve el que está en curso, o `null`", () => {
    const events = [evento({ id: "a" }), evento({ id: "b", from: "2026-09-21T17:00:00.000Z", to: "2026-09-22T17:00:00.000Z" })];

    expect(activeEditionEvent(events, new Date("2026-09-20T18:00:00.000Z"))?.id).toBe("a");
    expect(activeEditionEvent(events, new Date("2026-09-22T17:00:00.000Z"))).toBeNull();
  });

  it("los eventos se bloquean al empezar la ventana del torneo", () => {
    expect(editionEventsLocked(VENTANA, new Date("2026-09-14T23:59:59.999Z"))).toBe(false);
    expect(editionEventsLocked(VENTANA, new Date("2026-09-15T00:00:00.000Z"))).toBe(true);
    expect(editionEventsLocked(VENTANA, new Date("2026-09-20T12:00:00.000Z"))).toBe(true);
  });
});

describe("el snapshot de elegibilidad", () => {
  const estado: EditionEventsState = {
    version: EDITION_EVENTS_STATE_VERSION,
    events: {
      clasico: {
        checkedAt: "2026-09-20T17:00:00.000Z",
        checkedPlayerIds: ["a"],
        eligiblePlayerIds: ["a"],
      },
    },
  };

  it("un documento roto se lee como vacío", () => {
    for (const roto of [null, "no", 42, { version: 99 }, { version: 1, events: [] }]) {
      expect(parseEditionEventsState(roto)).toEqual({
        version: EDITION_EVENTS_STATE_VERSION,
        events: {},
      });
    }
  });

  it("lee las listas sin repetidos y descarta los valores que no son ids", () => {
    const parsed = parseEditionEventsState({
      version: EDITION_EVENTS_STATE_VERSION,
      events: {
        clasico: {
          checkedAt: "2026-09-20T17:00:00.000Z",
          checkedPlayerIds: ["a", "a", 3, ""],
          eligiblePlayerIds: ["a", null],
        },
        roto: "no",
      },
    });

    expect(parsed.events).toEqual({
      clasico: {
        checkedAt: "2026-09-20T17:00:00.000Z",
        checkedPlayerIds: ["a"],
        eligiblePlayerIds: ["a"],
      },
    });
  });

  it("`checkedAt` que no es texto se lee como `null`", () => {
    const parsed = parseEditionEventsState({
      version: EDITION_EVENTS_STATE_VERSION,
      events: { clasico: { checkedAt: 7, checkedPlayerIds: [], eligiblePlayerIds: [] } },
    });

    expect(parsed.events.clasico.checkedAt).toBeNull();
  });

  it("quitar la entrada de un evento no muta el estado original", () => {
    const sinClasico = removeEditionEventState(estado, "clasico");

    expect(sinClasico).toEqual({ version: EDITION_EVENTS_STATE_VERSION, events: {} });
    expect(estado.events.clasico).toBeDefined();
  });

  it("quitar una entrada que no existe no devuelve nada que escribir", () => {
    expect(removeEditionEventState(estado, "otro")).toBeNull();
  });
});

describe("lectura y escritura", () => {
  it("sin fila en `Setting` devuelve la lista vacía sin escribir", async () => {
    const { client, upserts } = fakeClient(null);

    await expect(readEditionEvents(client)).resolves.toEqual(DEFAULT_EDITION_EVENTS);
    expect(upserts).toEqual([]);
  });

  it("lee el documento guardado y avisa de lo que descarta", async () => {
    silenceWarnings();
    const { client } = fakeClient({
      value: { version: EDITION_EVENTS_VERSION, events: [evento(), evento({ id: "malo", multiplier: 1 })] },
    });

    const config = await readEditionEvents(client);

    expect(config.events.map((event) => event.id)).toEqual(["clasico"]);
    expect(console.warn).toHaveBeenCalled();
  });

  it("lee el estado guardado, y uno roto como vacío", async () => {
    const { client } = fakeClient({
      value: {
        version: EDITION_EVENTS_STATE_VERSION,
        events: { clasico: { checkedAt: null, checkedPlayerIds: ["a"], eligiblePlayerIds: ["a"] } },
      },
    });

    await expect(readEditionEventsState(client)).resolves.toMatchObject({
      events: { clasico: { eligiblePlayerIds: ["a"] } },
    });
    await expect(readEditionEventsState(fakeClient({ value: "roto" }).client)).resolves.toEqual(
      DEFAULT_EDITION_EVENTS_STATE,
    );
  });

  it("escribe el documento validado", async () => {
    const { client, upserts } = fakeClient(null);

    await writeEditionEvents({ version: EDITION_EVENTS_VERSION, events: [evento()] }, client);

    expect(upserts).toHaveLength(1);
    expect(upserts[0].key).toBe(EDITION_EVENTS_KEY);
    expect(upserts[0].value).toMatchObject({ version: EDITION_EVENTS_VERSION, events: [evento()] });
  });

  it("no escribe un documento que el lector va a descartar", async () => {
    const { client, upserts } = fakeClient(null);

    await expect(
      writeEditionEvents({ version: EDITION_EVENTS_VERSION, events: [evento({ multiplier: 1 })] }, client),
    ).rejects.toThrow("no se publica");
    expect(upserts).toEqual([]);
  });

  it("escribe el snapshot normalizado", async () => {
    const { client, upserts } = fakeClient(null);

    await writeEditionEventsState(
      {
        version: EDITION_EVENTS_STATE_VERSION,
        events: {
          clasico: {
            checkedAt: null,
            checkedPlayerIds: ["a", "a"],
            eligiblePlayerIds: ["a"],
          },
        },
      },
      client,
    );

    expect(upserts[0].key).toBe(EDITION_EVENTS_STATE_KEY);
    expect(upserts[0].value).toEqual({
      version: EDITION_EVENTS_STATE_VERSION,
      events: {
        clasico: { checkedAt: null, checkedPlayerIds: ["a"], eligiblePlayerIds: ["a"] },
      },
    });
  });
});
