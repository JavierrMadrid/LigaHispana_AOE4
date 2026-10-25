import { describe, expect, it } from "vitest";

import {
  DISCORD_MESSAGE_MAX_LENGTH,
  EDITION_EVENTS_ANNOUNCEMENTS_KEY,
  EMPTY_EVENTS_ANNOUNCEMENTS,
  dueEventAnnouncements,
  eventAnnouncementKey,
  eventAnnouncementText,
  eventAnnouncementsSummary,
  markEventAnnouncementSent,
  parseEventsAnnouncementsMemory,
  readEventsAnnouncementsMemory,
  startAnnouncementMessages,
  writeEventsAnnouncementsMemory,
  type EditionEventsAnnouncementsMemory,
  type EventsAnnouncementsClient,
} from "@/lib/edition-event-announcements";
import type { EditionEvent } from "@/lib/edition-events";

/**
 * Los avisos de los eventos puntuales: qué aviso toca, qué se dice y cómo se guarda la
 * memoria, más el resumen que acompaña al aviso de comienzo del torneo.
 *
 * Todo es **puro**: los tramos son comparaciones de fechas, el texto se compone con el
 * nombre y las fechas del evento, y la memoria se lee y se escribe con un cliente
 * falso. Lo que se fija es lo que no puede fallar: que un aviso salga una sola vez, que
 * un evento en curso mande el inicio y no un recordatorio, que uno terminado mande solo
 * el fin y que el aviso de inicio del torneo no se parta por la mitad.
 */

const INICIO = "2026-09-20T17:00:00.000Z";

/** Un evento válido; los casos cambian solo lo que prueban. */
function evento(overrides: Partial<EditionEvent> = {}): EditionEvent {
  return {
    id: "clasico",
    name: "Clásico de otoño",
    description: null,
    from: INICIO,
    to: "2026-09-20T20:00:00.000Z",
    multiplier: 2,
    discordRequired: false,
    ...overrides,
  };
}

const NADA: EditionEventsAnnouncementsMemory = { ...EMPTY_EVENTS_ANNOUNCEMENTS };

/** Un instante a `horas` del inicio, en ISO. */
function antesDeEmpezar(horas: number): Date {
  return new Date(new Date(INICIO).getTime() - horas * 3_600_000);
}

describe("dueEventAnnouncements: los tres recordatorios", () => {
  it("a 24 horas o menos, y antes de las 12, toca el de 24 h", () => {
    expect(dueEventAnnouncements([evento()], NADA, antesDeEmpezar(24))).toEqual([
      { event: evento(), milestone: "24h", key: "clasico:24h" },
    ]);
    expect(dueEventAnnouncements([evento()], NADA, antesDeEmpezar(13))).toEqual([
      { event: evento(), milestone: "24h", key: "clasico:24h" },
    ]);
  });

  it("entre 12 y 1 hora toca el de 12 h", () => {
    expect(dueEventAnnouncements([evento()], NADA, antesDeEmpezar(12))).toEqual([
      { event: evento(), milestone: "12h", key: "clasico:12h" },
    ]);
    expect(dueEventAnnouncements([evento()], NADA, antesDeEmpezar(2))).toEqual([
      { event: evento(), milestone: "12h", key: "clasico:12h" },
    ]);
  });

  it("en la última hora toca el de 1 h", () => {
    expect(dueEventAnnouncements([evento()], NADA, antesDeEmpezar(1))).toEqual([
      { event: evento(), milestone: "1h", key: "clasico:1h" },
    ]);
    expect(
      dueEventAnnouncements([evento()], NADA, new Date(new Date(INICIO).getTime() - 60_000)),
    ).toEqual([{ event: evento(), milestone: "1h", key: "clasico:1h" }]);
  });

  it("más de 24 horas antes no toca nada", () => {
    expect(dueEventAnnouncements([evento()], NADA, antesDeEmpezar(25))).toEqual([]);
  });

  it("un evento en curso no genera recordatorios: su aviso es el de inicio", () => {
    const enCurso = evento({
      from: "2026-09-20T16:00:00.000Z",
      to: "2026-09-20T18:00:00.000Z",
    });

    expect(dueEventAnnouncements([enCurso], NADA, new Date(INICIO))).toEqual([
      { event: enCurso, milestone: "start", key: "clasico:start" },
    ]);
  });

  it("un aviso ya anotado no se repite", () => {
    const memoria: EditionEventsAnnouncementsMemory = {
      ...NADA,
      sent: { "clasico:24h": "2026-09-19T17:00:00.000Z" },
    };

    expect(dueEventAnnouncements([evento()], memoria, antesDeEmpezar(24))).toEqual([]);
  });

  it("solo sale el tramo en el que estamos: un tramo saltado no se manda atrasado", () => {
    // La pasada se saltó el tramo de 24 h (caída, despliegue) y aparece a 5 horas: sale
    // el de 12 y nunca el de 24.
    expect(dueEventAnnouncements([evento()], NADA, antesDeEmpezar(5))).toEqual([
      { event: evento(), milestone: "12h", key: "clasico:12h" },
    ]);
  });

  it("ordena por el inicio del evento", () => {
    const tarde = evento({
      id: "tarde",
      name: "Tarde",
      from: "2026-09-20T18:00:00.000Z",
      to: "2026-09-20T21:00:00.000Z",
    });
    const pronto = evento({ id: "pronto", name: "Pronto" });

    expect(
      dueEventAnnouncements([tarde, pronto], NADA, new Date("2026-09-19T18:00:00.000Z")),
    ).toEqual([
      { event: pronto, milestone: "24h", key: "pronto:24h" },
      { event: tarde, milestone: "24h", key: "tarde:24h" },
    ]);
  });
});

describe("dueEventAnnouncements: el inicio y el fin", () => {
  /** De 16:00 a 18:00 UTC: a las 17:00 está en curso y a las 18:00 ya ha terminado. */
  const EN_CURSO = evento({ from: "2026-09-20T16:00:00.000Z", to: "2026-09-20T18:00:00.000Z" });

  it("al empezar sale el aviso de inicio", () => {
    expect(dueEventAnnouncements([evento()], NADA, new Date(INICIO))).toEqual([
      { event: evento(), milestone: "start", key: "clasico:start" },
    ]);
  });

  it("un evento en curso manda el inicio aunque la pasada llegue tarde", () => {
    expect(dueEventAnnouncements([EN_CURSO], NADA, new Date(INICIO))).toEqual([
      { event: EN_CURSO, milestone: "start", key: "clasico:start" },
    ]);
  });

  it("al terminar sale el aviso de fin, y sigue saliendo si llega tarde", () => {
    expect(
      dueEventAnnouncements([EN_CURSO], NADA, new Date("2026-09-20T18:00:00.000Z")),
    ).toEqual([{ event: EN_CURSO, milestone: "end", key: "clasico:end" }]);

    expect(
      dueEventAnnouncements([EN_CURSO], NADA, new Date("2026-09-23T09:00:00.000Z")),
    ).toEqual([{ event: EN_CURSO, milestone: "end", key: "clasico:end" }]);
  });

  it("un evento perdido entero manda solo el fin, nunca el inicio atrasado", () => {
    expect(
      dueEventAnnouncements([EN_CURSO], NADA, new Date("2026-09-20T19:00:00.000Z")),
    ).toEqual([{ event: EN_CURSO, milestone: "end", key: "clasico:end" }]);
  });

  it("un inicio o un fin ya anotados no se repiten", () => {
    const conInicio: EditionEventsAnnouncementsMemory = {
      ...NADA,
      sent: { "clasico:start": "2026-09-20T16:00:00.000Z" },
    };
    const conFin: EditionEventsAnnouncementsMemory = {
      ...NADA,
      sent: { "clasico:end": "2026-09-20T18:00:00.000Z" },
    };

    expect(dueEventAnnouncements([EN_CURSO], conInicio, new Date(INICIO))).toEqual([]);
    expect(
      dueEventAnnouncements([EN_CURSO], conFin, new Date("2026-09-20T19:00:00.000Z")),
    ).toEqual([]);
  });

  it("ordena por el inicio del evento y da como mucho un aviso por evento", () => {
    const enCurso = evento({
      id: "en-curso",
      name: "En curso",
      from: "2026-09-20T15:00:00.000Z",
      to: "2026-09-20T17:30:00.000Z",
    });
    const proximo = evento({
      id: "proximo",
      name: "Próximo",
      from: "2026-09-20T18:00:00.000Z",
      to: "2026-09-20T20:00:00.000Z",
    });

    expect(dueEventAnnouncements([proximo, enCurso], NADA, new Date(INICIO))).toEqual([
      { event: enCurso, milestone: "start", key: "en-curso:start" },
      { event: proximo, milestone: "1h", key: "proximo:1h" },
    ]);
  });
});

describe("eventAnnouncementText", () => {
  it("lleva el nombre, la ventana en Madrid y el multiplicador", () => {
    const texto = eventAnnouncementText(evento({ multiplier: 3 }), "24h");

    expect(texto).toContain("Clásico de otoño");
    expect(texto).toContain("20 de septiembre de 2026");
    expect(texto).toContain("19:00");
    expect(texto).toContain("x3");
    expect(texto).toContain("multiplica sus puntos por 3");
    expect(texto).toContain("24 horas");
  });

  it("dice el requisito de Discord solo si el evento lo pide", () => {
    expect(eventAnnouncementText(evento(), "1h")).not.toContain("servidor de Discord");
    expect(eventAnnouncementText(evento({ discordRequired: true }), "1h")).toContain(
      "servidor de Discord",
    );
  });

  it("incluye la descripción cuando la hay", () => {
    expect(
      eventAnnouncementText(evento({ description: "Solo mapas acuáticos." }), "12h"),
    ).toContain("Solo mapas acuáticos.");
  });
});

describe("eventAnnouncementText: el inicio y el fin", () => {
  it("el inicio dice que ya está en marcha y lleva lo accionable", () => {
    const texto = eventAnnouncementText(
      evento({ multiplier: 3, discordRequired: true, description: "Solo mapas acuáticos." }),
      "start",
    );

    expect(texto).toContain("Clásico de otoño");
    expect(texto).toContain("ya está en marcha");
    expect(texto).not.toContain("Empieza en");
    expect(texto).toContain("20 de septiembre de 2026");
    expect(texto).toContain("hora de Madrid");
    expect(texto).toContain("x3");
    expect(texto).toContain("servidor de Discord");
    expect(texto).toContain("Solo mapas acuáticos.");
  });

  it("el fin lleva el nombre y la ventana, sin repetir lo que ya no es accionable", () => {
    const texto = eventAnnouncementText(
      evento({ discordRequired: true, description: "Solo mapas acuáticos." }),
      "end",
    );

    expect(texto).toContain("Clásico de otoño");
    expect(texto).toContain("ha terminado");
    expect(texto).toContain("20 de septiembre de 2026");
    expect(texto).toContain("hora de Madrid");
    expect(texto).not.toContain("multiplica");
    expect(texto).not.toContain("Discord");
    expect(texto).not.toContain("Solo mapas acuáticos.");
  });
});

describe("eventAnnouncementsSummary", () => {
  it("sin eventos no hay resumen", () => {
    expect(eventAnnouncementsSummary([])).toBeNull();
  });

  it("resume cada evento con ventana, multiplicador y requisito", () => {
    const resumen = eventAnnouncementsSummary([
      evento({ multiplier: 3, discordRequired: true }),
      evento({ id: "otro", name: "Revancha", from: "2026-09-22T17:00:00.000Z" }),
    ]);

    expect(resumen).toContain("Eventos puntuales");
    expect(resumen).toContain("Clásico de otoño");
    expect(resumen).toContain("puntos por victoria x3");
    expect(resumen).toContain("Solo para participantes en Discord");
    expect(resumen).toContain("Revancha");
    expect(resumen).toContain("puntos por victoria x2");
  });
});

describe("startAnnouncementMessages", () => {
  const INICIO_TORNEO = "Liga Hispana: empieza el torneo. Del 15 de septiembre al 15 de octubre.";

  it("sin eventos el mensaje de siempre no cambia", () => {
    expect(startAnnouncementMessages(INICIO_TORNEO, [])).toEqual([INICIO_TORNEO]);
  });

  it("con un evento que cabe, el resumen va en el mismo mensaje", () => {
    const mensajes = startAnnouncementMessages(INICIO_TORNEO, [evento()]);

    expect(mensajes).toHaveLength(1);
    expect(mensajes[0]).toContain(INICIO_TORNEO);
    expect(mensajes[0]).toContain("Clásico de otoño");
  });

  it("si no cabe, el aviso de inicio sale entero y el resumen aparte", () => {
    const muchos = Array.from({ length: 20 }, (_, index) =>
      evento({
        id: `evento-${index}`,
        name: `Evento número ${index} de la liga hispana con un nombre largo`,
        from: `2026-09-${String(20 + (index % 5)).padStart(2, "0")}T17:00:00.000Z`,
        to: `2026-09-${String(20 + (index % 5)).padStart(2, "0")}T20:00:00.000Z`,
        multiplier: 2,
      }),
    );

    const mensajes = startAnnouncementMessages(INICIO_TORNEO, muchos);

    expect(mensajes.length).toBeGreaterThan(1);
    expect(mensajes[0]).toBe(INICIO_TORNEO);

    for (const mensaje of mensajes) {
      expect(mensaje.length).toBeLessThanOrEqual(DISCORD_MESSAGE_MAX_LENGTH);
    }
  });
});

describe("parseEventsAnnouncementsMemory", () => {
  it("un documento que no se entiende se lee como vacío", () => {
    for (const raro of [null, undefined, 0, "2026-09-20", [], true, { version: 2, sent: {} }]) {
      expect(parseEventsAnnouncementsMemory(raro)).toEqual(EMPTY_EVENTS_ANNOUNCEMENTS);
    }
  });

  it("lee las marcas válidas y descarta las que no son texto", () => {
    expect(
      parseEventsAnnouncementsMemory({
        version: 1,
        sent: { "clasico:24h": "2026-09-19T17:00:00.000Z", "clasico:12h": 12, "": "x" },
      }),
    ).toEqual({
      version: 1,
      sent: { "clasico:24h": "2026-09-19T17:00:00.000Z" },
    });
  });
});

describe("markEventAnnouncementSent y eventAnnouncementKey", () => {
  it("la clave une el id del evento y el hito", () => {
    expect(eventAnnouncementKey("clasico", "1h")).toBe("clasico:1h");
    expect(eventAnnouncementKey("clasico", "start")).toBe("clasico:start");
    expect(eventAnnouncementKey("clasico", "end")).toBe("clasico:end");
  });

  it("anota el aviso sin tocar los demás", () => {
    const memoria = markEventAnnouncementSent(
      { ...NADA, sent: { "otro:24h": "2026-09-18T17:00:00.000Z" } },
      "clasico:24h",
      "2026-09-19T17:00:00.000Z",
    );

    expect(memoria.sent).toEqual({
      "otro:24h": "2026-09-18T17:00:00.000Z",
      "clasico:24h": "2026-09-19T17:00:00.000Z",
    });
  });
});

/** Un cliente falso con la única tabla que usa la memoria. */
function fakeClient(row: { value: unknown } | null) {
  const upserts: { key: string; value: unknown }[] = [];

  const client = {
    setting: {
      findUnique: async () => {
        if (row === null) {
          return null;
        }

        return {
          key: EDITION_EVENTS_ANNOUNCEMENTS_KEY,
          value: row.value,
          updatedAt: new Date(0),
        };
      },
      upsert: async (args: { create: { key: string; value: unknown } }) => {
        upserts.push(args.create);

        return { key: args.create.key, value: args.create.value, updatedAt: new Date(0) };
      },
    },
  } as unknown as EventsAnnouncementsClient;

  return { client, upserts };
}

describe("readEventsAnnouncementsMemory / writeEventsAnnouncementsMemory", () => {
  it("sin fila devuelve la memoria vacía", async () => {
    const { client } = fakeClient(null);

    expect(await readEventsAnnouncementsMemory(client)).toEqual(EMPTY_EVENTS_ANNOUNCEMENTS);
  });

  it("escribe la versión y las marcas bajo su propia clave", async () => {
    const { client, upserts } = fakeClient(null);

    await writeEventsAnnouncementsMemory(
      { version: 1, sent: { "clasico:1h": "2026-09-20T16:00:00.000Z" } },
      client,
    );

    expect(upserts).toEqual([
      {
        key: "edition.events.announcements",
        value: { version: 1, sent: { "clasico:1h": "2026-09-20T16:00:00.000Z" } },
      },
    ]);
  });

  it("la clave es la que lee y escribe `Setting`", () => {
    expect(EDITION_EVENTS_ANNOUNCEMENTS_KEY).toBe("edition.events.announcements");
  });
});
