import { describe, expect, it } from "vitest";

import {
  announcementText,
  dueAnnouncements,
  EDITION_ANNOUNCEMENTS_KEY,
  EMPTY_ANNOUNCEMENTS,
  markAnnouncementSent,
  markRegistrationWasOpen,
  parseAnnouncementsMemory,
  readAnnouncementsMemory,
  writeAnnouncementsMemory,
  type AnnouncementsClient,
  type DueAnnouncementsInput,
  type EditionAnnouncementsMemory,
} from "@/lib/edition-announcements";
import { DEFAULT_RULESET } from "@/lib/scoring";

/**
 * Los avisos de la edición: cuándo toca avisar, qué se dice y cómo se guarda la memoria.
 *
 * Todo lo que se prueba aquí es **puro**: la decisión de qué avisos tocan no toca la
 * base ni la red, y la memoria se lee y se escribe con un cliente falso. Lo que se fija
 * es lo que no puede fallar: que un hito salga **una sola vez** aunque la ventana se
 * mueva, que un recordatorio tarde no se dispare, y que la memoria vieja (sin los hitos
 * nuevos) se siga leyendo sin perder lo ya avisado.
 */

const WINDOW = { from: "2026-09-15T00:00:00.000Z", to: "2026-10-15T00:00:00.000Z" };

/** Una ventana que no aporta hitos propios, para aislar los de inscripciones. */
const VENTANA_LEJANA = { from: "2027-01-01T00:00:00.000Z", to: null };

const NADA: EditionAnnouncementsMemory = { ...EMPTY_ANNOUNCEMENTS };

/** La decisión con los valores por defecto, para no repetir el objeto entero. */
function dueEn(now: string, extra: Partial<DueAnnouncementsInput> = {}) {
  return dueAnnouncements({
    window: WINDOW,
    closesAt: null,
    registrationOpen: false,
    memory: NADA,
    now: new Date(now),
    ...extra,
  });
}

describe("dueAnnouncements: comienzo y final (los de siempre)", () => {
  it("antes de la ventana no toca nada", () => {
    // Antes del primer recordatorio (7 días): ni hitos ni recordatorios.
    expect(dueEn("2026-09-07T23:59:59.000Z")).toEqual([]);
  });

  it("al cruzar el inicio toca el aviso de comienzo, y solo ese", () => {
    expect(dueEn(WINDOW.from)).toEqual(["start"]);
    expect(dueEn("2026-10-01T00:00:00.000Z")).toEqual(["start"]);
  });

  it("al cruzar el final toca el de final", () => {
    expect(dueEn(WINDOW.to)).toEqual(["start", "end"]);
    expect(
      dueEn(WINDOW.to, {
        memory: { ...NADA, startedAt: "2026-09-15T00:00:00.000Z" },
      }),
    ).toEqual(["end"]);
  });

  it("un aviso ya dado no vuelve a salir, aunque la ventana se mueva", () => {
    const memoria: EditionAnnouncementsMemory = {
      ...NADA,
      startedAt: "2026-09-15T00:00:00.000Z",
    };

    expect(dueEn("2026-10-01T00:00:00.000Z", { memory: memoria })).toEqual([]);

    // La organización alarga el torneo: el aviso de comienzo ya se dio y no se repite.
    expect(
      dueEn("2026-11-01T00:00:00.000Z", {
        memory: memoria,
        window: { from: "2026-11-01T00:00:00.000Z", to: "2026-12-01T00:00:00.000Z" },
      }),
    ).toEqual([]);
  });

  it("con la ventana abierta (`to: null`) el aviso de final no existe", () => {
    const abierta = { from: WINDOW.from, to: null };

    expect(dueEn("2027-01-01T00:00:00.000Z", { window: abierta })).toEqual(["start"]);
    expect(
      dueEn("2027-01-01T00:00:00.000Z", {
        window: abierta,
        memory: { ...NADA, startedAt: "2026-09-15T00:00:00.000Z" },
      }),
    ).toEqual([]);
  });

  it("con la memoria entera no toca nada", () => {
    expect(
      dueEn("2027-01-01T00:00:00.000Z", {
        memory: {
          ...NADA,
          startedAt: "2026-09-15T00:00:00.000Z",
          finishedAt: "2026-10-15T00:00:00.000Z",
        },
      }),
    ).toEqual([]);
  });

  it("una ventana ilegible no dispara nada", () => {
    expect(dueEn("2026-01-01T00:00:00.000Z", { window: { from: "no es una fecha", to: null } })).toEqual(
      [],
    );
  });
});

describe("dueAnnouncements: recordatorios del torneo", () => {
  it("a 7, 3 y 1 días del inicio sale el recordatorio de cada tramo", () => {
    expect(dueEn("2026-09-08T00:00:00.000Z")).toEqual(["start-7"]);
    expect(dueEn("2026-09-12T00:00:00.000Z")).toEqual(["start-3"]);
    expect(dueEn("2026-09-14T00:00:00.000Z")).toEqual(["start-1"]);
  });

  it("a 7, 3 y 1 días del final sale el recordatorio de cada tramo", () => {
    // El de inicio ya se dio, para que no ensucie el resultado.
    const memoria = { ...NADA, startedAt: "2026-09-15T00:00:00.000Z" };

    expect(dueEn("2026-10-08T00:00:00.000Z", { memory: memoria })).toEqual(["end-7"]);
    expect(dueEn("2026-10-12T00:00:00.000Z", { memory: memoria })).toEqual(["end-3"]);
    expect(dueEn("2026-10-14T00:00:00.000Z", { memory: memoria })).toEqual(["end-1"]);
  });

  it("cruzado el inicio ya no salen sus recordatorios, sale el aviso de comienzo", () => {
    expect(dueEn("2026-09-16T00:00:00.000Z")).toEqual(["start"]);
  });

  it("no dispara un recordatorio cuyo tramo ya pasó (nada de ráfagas)", () => {
    // El sistema se pone en marcha con 5 días de margen: cae en el tramo del de 7, así
    // que sale ese y no los dos que ya no aplican; y el de 3 sale cuando llega su tramo.
    expect(dueEn("2026-09-10T00:00:00.000Z")).toEqual(["start-7"]);
    expect(
      dueEn("2026-09-10T00:00:00.000Z", {
        memory: { ...NADA, sent: { "start-7": "2026-09-10T00:00:00.000Z" } },
      }),
    ).toEqual([]);
  });

  it("un recordatorio ya dado no vuelve a salir", () => {
    expect(
      dueEn("2026-09-12T00:00:00.000Z", {
        memory: { ...NADA, sent: { "start-3": "2026-09-12T00:00:00.000Z" } },
      }),
    ).toEqual([]);
  });
});

describe("dueAnnouncements: inscripciones", () => {
  const CLOSE = "2026-10-01T00:00:00.000Z";

  function inscripciones(now: string, extra: Partial<DueAnnouncementsInput> = {}) {
    return dueEn(now, {
      window: VENTANA_LEJANA,
      closesAt: CLOSE,
      registrationOpen: true,
      ...extra,
    });
  }

  it("a 7, 3 y 1 días del cierre sale el recordatorio de cada tramo", () => {
    expect(inscripciones("2026-09-24T00:00:00.000Z")).toEqual(["registration-7"]);
    expect(inscripciones("2026-09-28T00:00:00.000Z")).toEqual(["registration-3"]);
    expect(inscripciones("2026-09-30T00:00:00.000Z")).toEqual(["registration-1"]);
  });

  it("con el plazo cerrado por el interruptor no salen recordatorios", () => {
    // Sin la marca de que estuvo abierto, tampoco sale el aviso de cierre: es un plazo
    // que nunca abrió (ver el caso siguiente con la marca puesta).
    expect(inscripciones("2026-09-30T00:00:00.000Z", { registrationOpen: false })).toEqual([]);

    expect(
      inscripciones("2026-09-30T00:00:00.000Z", {
        registrationOpen: false,
        memory: { ...NADA, registrationWasOpen: true },
      }),
    ).toEqual(["registration-close"]);
  });

  it("anuncia el cierre cuando el plazo estaba abierto y pasa a cerrado", () => {
    const abiertoAntes = { ...NADA, registrationWasOpen: true };

    expect(
      dueEn("2026-10-01T00:00:00.000Z", {
        window: VENTANA_LEJANA,
        closesAt: CLOSE,
        registrationOpen: false,
        memory: abiertoAntes,
      }),
    ).toEqual(["registration-close"]);
  });

  it("cierra por el interruptor, sin fecha, si antes estuvo abierto", () => {
    expect(
      dueEn("2026-09-10T00:00:00.000Z", {
        window: VENTANA_LEJANA,
        closesAt: null,
        registrationOpen: false,
        memory: { ...NADA, registrationWasOpen: true },
      }),
    ).toEqual(["registration-close"]);
  });

  it("no anuncia un cierre que nunca se abrió", () => {
    expect(
      dueEn("2026-10-01T00:00:00.000Z", {
        window: VENTANA_LEJANA,
        closesAt: CLOSE,
        registrationOpen: false,
        memory: NADA,
      }),
    ).toEqual([]);
  });

  it("el cierre ya anunciado no se repite", () => {
    expect(
      dueEn("2026-10-01T00:00:00.000Z", {
        window: VENTANA_LEJANA,
        closesAt: CLOSE,
        registrationOpen: false,
        memory: {
          ...NADA,
          registrationWasOpen: true,
          sent: { "registration-close": "2026-10-01T00:00:00.000Z" },
        },
      }),
    ).toEqual([]);
  });
});

describe("announcementText", () => {
  const EDICION = "Liga Hispana AoE IV";

  it("el de comienzo y el de final son los de siempre", () => {
    const inicio = announcementText("start", EDICION, WINDOW, null);
    const final = announcementText("end", EDICION, WINDOW, null);

    expect(inicio).toContain("empieza");
    expect(inicio).toContain("Del 15 de septiembre al 15 de octubre de 2026");
    expect(final).toContain("terminado");
    expect(inicio).not.toBe(final);
  });

  it("los recordatorios dicen el nombre, el periodo y los días que quedan o menos", () => {
    const texto = announcementText("start-7", EDICION, WINDOW, null);

    expect(texto).toContain(EDICION);
    expect(texto).toContain("Del 15 de septiembre al 15 de octubre de 2026");
    expect(texto).toContain("7 días o menos");
  });

  it("el recordatorio de 1 día usa el singular", () => {
    expect(announcementText("registration-1", EDICION, WINDOW, "2026-10-01T00:00:00.000Z")).toContain(
      "Queda 1 día o menos",
    );
  });

  it("el de inscripciones dice la fecha de cierre; el de cierre, que están cerradas", () => {
    const recordatorio = announcementText(
      "registration-7",
      EDICION,
      WINDOW,
      "2026-10-01T00:00:00.000Z",
    );
    const cerradas = announcementText("registration-close", EDICION, WINDOW, "2026-10-01T00:00:00.000Z");

    expect(recordatorio).toContain("1 de octubre de 2026");
    expect(cerradas).toContain("cerradas");
  });
});

describe("parseAnnouncementsMemory", () => {
  it("un valor que no se entiende se lee como 'no se ha avisado'", () => {
    for (const raro of [null, undefined, 0, "2026-09-15", [], true]) {
      expect(parseAnnouncementsMemory(raro)).toEqual(EMPTY_ANNOUNCEMENTS);
    }
  });

  it("lee la memoria vieja (solo las dos marcas) sin perderla", () => {
    expect(
      parseAnnouncementsMemory({
        startedAt: "2026-09-15T00:00:00.000Z",
        finishedAt: 42,
      }),
    ).toEqual({
      startedAt: "2026-09-15T00:00:00.000Z",
      finishedAt: null,
      sent: {},
      registrationWasOpen: false,
    });
  });

  it("lee los hitos nuevos y descarta las marcas que no son texto", () => {
    expect(
      parseAnnouncementsMemory({
        sent: { "start-7": "2026-09-08T00:00:00.000Z", "start-3": 3, "": "x" },
        registrationWasOpen: true,
      }),
    ).toEqual({
      startedAt: null,
      finishedAt: null,
      sent: { "start-7": "2026-09-08T00:00:00.000Z" },
      registrationWasOpen: true,
    });
  });
});

describe("markAnnouncementSent y markRegistrationWasOpen", () => {
  it("anota el comienzo y el final en su campo de siempre", () => {
    const conInicio = markAnnouncementSent(NADA, "start", "2026-09-15T00:00:00.000Z");

    expect(conInicio.startedAt).toBe("2026-09-15T00:00:00.000Z");
    expect(conInicio.sent).toEqual({});
  });

  it("anota los hitos nuevos en `sent`", () => {
    const conRecordatorio = markAnnouncementSent(NADA, "start-7", "2026-09-08T00:00:00.000Z");

    expect(conRecordatorio.sent).toEqual({ "start-7": "2026-09-08T00:00:00.000Z" });
  });

  it("marcar que el plazo estuvo abierto es idempotente", () => {
    const unaVez = markRegistrationWasOpen(NADA);
    const dosVeces = markRegistrationWasOpen(unaVez);

    expect(unaVez.registrationWasOpen).toBe(true);
    expect(dosVeces).toBe(unaVez);
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

        return { key: EDITION_ANNOUNCEMENTS_KEY, value: row.value, updatedAt: new Date(0) };
      },
      upsert: async (args: { create: { key: string; value: unknown } }) => {
        upserts.push(args.create);

        return { key: args.create.key, value: args.create.value, updatedAt: new Date(0) };
      },
    },
  } as unknown as AnnouncementsClient;

  return { client, upserts };
}

describe("readAnnouncementsMemory / writeAnnouncementsMemory", () => {
  it("sin fila devuelve la memoria vacía", async () => {
    const { client } = fakeClient(null);

    expect(await readAnnouncementsMemory(client)).toEqual(EMPTY_ANNOUNCEMENTS);
  });

  it("con fila devuelve lo guardado, ya validado", async () => {
    const { client } = fakeClient({ value: { startedAt: "2026-09-15T00:00:00.000Z" } });

    expect(await readAnnouncementsMemory(client)).toEqual({
      startedAt: "2026-09-15T00:00:00.000Z",
      finishedAt: null,
      sent: {},
      registrationWasOpen: false,
    });
  });

  it("escribe las cuatro marcas bajo la clave de la edición", async () => {
    const { client, upserts } = fakeClient(null);
    const memoria: EditionAnnouncementsMemory = {
      startedAt: "2026-09-15T00:00:00.000Z",
      finishedAt: null,
      sent: { "start-7": "2026-09-08T00:00:00.000Z" },
      registrationWasOpen: true,
    };

    await writeAnnouncementsMemory(memoria, client);

    expect(upserts).toEqual([
      {
        key: "edition.announcements",
        value: {
          startedAt: "2026-09-15T00:00:00.000Z",
          finishedAt: null,
          sent: { "start-7": "2026-09-08T00:00:00.000Z" },
          registrationWasOpen: true,
        },
      },
    ]);
  });
});

describe("la clave y el documento por defecto", () => {
  it("la clave es la que lee y escribe `Setting`", () => {
    expect(EDITION_ANNOUNCEMENTS_KEY).toBe("edition.announcements");
  });

  it("la ventana por defecto del ruleset es la que se usaría sin configurar nada", () => {
    // El aviso sale de la ventana del ruleset, así que con el documento por defecto la
    // memoria vacía ya anuncia el comienzo y el final: es la comprobación de que las dos
    // piezas hablan del mismo tipo de ventana.
    expect(
      dueAnnouncements({
        window: DEFAULT_RULESET.window,
        closesAt: null,
        registrationOpen: false,
        memory: NADA,
        now: new Date("2030-01-01T00:00:00.000Z"),
      }),
    ).toEqual(["start", "end"]);
  });
});
