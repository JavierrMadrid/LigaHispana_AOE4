import { describe, expect, it } from "vitest";

import {
  announcementText,
  dueAnnouncements,
  EDITION_ANNOUNCEMENTS_KEY,
  EMPTY_ANNOUNCEMENTS,
  parseAnnouncementsMemory,
  readAnnouncementsMemory,
  writeAnnouncementsMemory,
  type AnnouncementsClient,
  type EditionAnnouncementsMemory,
} from "@/lib/edition-announcements";
import { DEFAULT_RULESET } from "@/lib/scoring";

/**
 * Los avisos del torneo: cuándo toca avisar, qué se dice y cómo se guarda la memoria.
 *
 * Todo lo que se prueba aquí es **puro**: la decisión de qué avisos tocan no toca la
 * base ni la red, y la memoria se lee y se escribe con un cliente falso. Lo que se fija
 * es lo que no puede fallar: que un aviso salga **una sola vez** aunque la ventana se
 * mueva, y que una ventana abierta no espere un final que no existe.
 */

const WINDOW = { from: "2026-09-15T00:00:00.000Z", to: "2026-10-15T00:00:00.000Z" };

const NADA: EditionAnnouncementsMemory = { ...EMPTY_ANNOUNCEMENTS };

describe("dueAnnouncements", () => {
  it("antes de la ventana no toca nada", () => {
    expect(dueAnnouncements(WINDOW, NADA, new Date("2026-09-14T23:59:59.000Z"))).toEqual([]);
  });

  it("al cruzar el inicio toca el aviso de comienzo, y solo ese", () => {
    expect(dueAnnouncements(WINDOW, NADA, new Date(WINDOW.from))).toEqual(["start"]);
    expect(dueAnnouncements(WINDOW, NADA, new Date("2026-10-01T00:00:00.000Z"))).toEqual(["start"]);
  });

  it("al cruzar el final toca el de final", () => {
    expect(dueAnnouncements(WINDOW, NADA, new Date(WINDOW.to))).toEqual(["start", "end"]);
    expect(
      dueAnnouncements(WINDOW, { startedAt: "2026-09-15T00:00:00.000Z", finishedAt: null }, new Date(WINDOW.to)),
    ).toEqual(["end"]);
  });

  it("un aviso ya dado no vuelve a salir, aunque la ventana se mueva", () => {
    const memoria: EditionAnnouncementsMemory = {
      startedAt: "2026-09-15T00:00:00.000Z",
      finishedAt: null,
    };

    expect(dueAnnouncements(WINDOW, memoria, new Date("2026-10-01T00:00:00.000Z"))).toEqual([]);

    // La organización alarga el torneo: el aviso de comienzo ya se dio y no se repite.
    expect(
      dueAnnouncements(
        { from: "2026-11-01T00:00:00.000Z", to: "2026-12-01T00:00:00.000Z" },
        memoria,
        new Date("2026-11-01T00:00:00.000Z"),
      ),
    ).toEqual([]);
  });

  it("con la ventana abierta (`to: null`) el aviso de final no existe", () => {
    const abierta = { from: WINDOW.from, to: null };

    expect(dueAnnouncements(abierta, NADA, new Date("2027-01-01T00:00:00.000Z"))).toEqual(["start"]);
    expect(
      dueAnnouncements(abierta, { startedAt: "2026-09-15T00:00:00.000Z", finishedAt: null }, new Date("2027-01-01T00:00:00.000Z")),
    ).toEqual([]);
  });

  it("con la memoria entera no toca nada", () => {
    expect(
      dueAnnouncements(
        WINDOW,
        { startedAt: "2026-09-15T00:00:00.000Z", finishedAt: "2026-10-15T00:00:00.000Z" },
        new Date("2027-01-01T00:00:00.000Z"),
      ),
    ).toEqual([]);
  });

  it("una ventana ilegible no dispara nada", () => {
    expect(dueAnnouncements({ from: "no es una fecha", to: null }, NADA, new Date())).toEqual([]);
  });
});

describe("announcementText", () => {
  it("dice el nombre de la edición y el periodo publicado", () => {
    const texto = announcementText("start", "Liga Hispana AoE IV", WINDOW);

    expect(texto).toContain("Liga Hispana AoE IV");
    expect(texto).toContain("Del 15 de septiembre al 15 de octubre de 2026");
  });

  it("el de comienzo y el de final no dicen lo mismo", () => {
    const inicio = announcementText("start", "Liga Hispana AoE IV", WINDOW);
    const final = announcementText("end", "Liga Hispana AoE IV", WINDOW);

    expect(inicio).not.toBe(final);
    expect(inicio).toContain("empieza");
    expect(final).toContain("terminado");
  });

  it("con la ventana abierta no inventa un final", () => {
    const texto = announcementText("start", "Liga Hispana AoE IV", { ...WINDOW, to: null });

    expect(texto).toContain("Desde el 15 de septiembre de 2026");
  });
});

describe("parseAnnouncementsMemory", () => {
  it("un valor que no se entiende se lee como 'no se ha avisado'", () => {
    for (const raro of [null, undefined, 0, "2026-09-15", [], true]) {
      expect(parseAnnouncementsMemory(raro)).toEqual(EMPTY_ANNOUNCEMENTS);
    }
  });

  it("lee las dos marcas y descarta las que no son texto", () => {
    expect(
      parseAnnouncementsMemory({
        startedAt: "2026-09-15T00:00:00.000Z",
        finishedAt: 42,
      }),
    ).toEqual({ startedAt: "2026-09-15T00:00:00.000Z", finishedAt: null });

    expect(parseAnnouncementsMemory({ startedAt: "", finishedAt: null })).toEqual(EMPTY_ANNOUNCEMENTS);
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
    });
  });

  it("escribe las dos marcas bajo la clave de la edición", async () => {
    const { client, upserts } = fakeClient(null);

    await writeAnnouncementsMemory(
      { startedAt: "2026-09-15T00:00:00.000Z", finishedAt: null },
      client,
    );

    expect(upserts).toEqual([
      {
        key: "edition.announcements",
        value: { startedAt: "2026-09-15T00:00:00.000Z", finishedAt: null },
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
    // memoria vacía ya anuncia el comienzo: es la comprobación de que las dos piezas
    // hablan del mismo tipo de ventana.
    expect(dueAnnouncements(DEFAULT_RULESET.window, NADA, new Date("2030-01-01T00:00:00.000Z"))).toEqual([
      "start",
      "end",
    ]);
  });
});
