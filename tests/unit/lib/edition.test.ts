import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_EDITION_CONFIG,
  EDITION_CONFIG_KEY,
  EDITION_CONFIG_VERSION,
  EDITION_NAME_MAX_LENGTH,
  EDITION_PRIZE_NOTE_MAX_LENGTH,
  isAccentColor,
  isEmblemUrl,
  mergeEditionConfig,
  readEditionConfig,
  writeEditionConfig,
  type EditionConfig,
  type EditionConfigClient,
} from "@/lib/edition";

/**
 * La configuración de la edición: validación, lectura y escritura.
 *
 * Todo lo que se prueba aquí es **puro**: el módulo se escribe y se lee con un cliente
 * falso que solo apunta lo que le llega, así que no hace falta base de datos ni red. Lo
 * que se comprueba es lo que el panel y la web no pueden permitirse: que un documento
 * a medias no tumbe la lectura, que lo que no se entiende se avise y se quede en su
 * valor por defecto, y que lo que se escribe sea exactamente lo que el sistema va a
 * volver a leer.
 */

/** Documento guardado mínimo y válido: solo la versión. */
const VALIDO = { version: EDITION_CONFIG_VERSION };

/**
 * Un cliente con la única tabla que usa el módulo.
 *
 * Se castea porque el tipo de Prisma es un *thenable* con métodos extra y aquí solo
 * hacen falta los dos que se llaman de verdad; el cast es de forma, no de
 * comportamiento, y es lo que permite comprobar la escritura sin base de datos.
 */
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
          : { key: EDITION_CONFIG_KEY, value: row.value, updatedAt: new Date(0) };
      },
      upsert: async (args: { create: { key: string; value: unknown } }) => {
        upserts.push(args.create);

        return { key: args.create.key, value: args.create.value, updatedAt: new Date(0) };
      },
    },
  } as unknown as EditionConfigClient;

  return { client, upserts };
}

/** Silencia el `console.warn` del módulo mientras corre una comprobación. */
function silenceWarnings(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(console, "warn").mockImplementation(() => {});
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("la clave y los valores por defecto", () => {
  it("vive en `edition.config` y declara su versión", () => {
    expect(EDITION_CONFIG_KEY).toBe("edition.config");
    expect(EDITION_CONFIG_VERSION).toBe(1);
    expect(DEFAULT_EDITION_CONFIG.version).toBe(EDITION_CONFIG_VERSION);
  });

  it("arranca sin premio, sin retransmisión obligatoria y sin marca propia", () => {
    // Publicar un premio o exigir retransmisión es una decisión explícita de la
    // organización, no el estado en que queda el sistema si nadie dice nada.
    expect(DEFAULT_EDITION_CONFIG.name).not.toBe("");
    expect(DEFAULT_EDITION_CONFIG.prize).toEqual({ amount: null, note: null });
    expect(DEFAULT_EDITION_CONFIG.streamingRequired).toBe(false);
    expect(DEFAULT_EDITION_CONFIG.branding).toEqual({ emblemUrl: null, accentColor: null });
  });
});

describe("mergeEditionConfig: lo que se puede configurar", () => {
  it("con un documento válido sin más campos se queda en los valores por defecto", () => {
    const { config, warnings } = mergeEditionConfig(VALIDO);

    expect(warnings).toEqual([]);
    expect(config).toEqual(DEFAULT_EDITION_CONFIG);
  });

  it("el documento por defecto se puede volver a guardar sin avisos", () => {
    // Es lo que pasa cada vez que el panel guarda sin tocar nada: si el documento por
    // defecto se rechazara a sí mismo, no se podría guardar una edición recién creada.
    const { config, warnings } = mergeEditionConfig(DEFAULT_EDITION_CONFIG);

    expect(warnings).toEqual([]);
    expect(config).toEqual(DEFAULT_EDITION_CONFIG);
  });

  it("aplica el nombre, recortado", () => {
    const { config, warnings } = mergeEditionConfig({ ...VALIDO, name: "  Liga Hispana 2027  " });

    expect(warnings).toEqual([]);
    expect(config.name).toBe("Liga Hispana 2027");
  });

  it("aplica el premio base con su nota", () => {
    const { config, warnings } = mergeEditionConfig({
      ...VALIDO,
      prize: { amount: 500, note: "Reparto 60/25/15" },
    });

    expect(warnings).toEqual([]);
    expect(config.prize).toEqual({ amount: 500, note: "Reparto 60/25/15" });
  });

  it("un premio de cero es un dato, y su ausencia no", () => {
    expect(mergeEditionConfig({ ...VALIDO, prize: { amount: 0, note: null } }).config.prize).toEqual({
      amount: 0,
      note: null,
    });
    expect(mergeEditionConfig({ ...VALIDO, prize: { amount: null, note: "algo" } }).config.prize).toEqual(
      { amount: null, note: "algo" },
    );
  });

  it("aplica el interruptor de retransmisión obligatoria", () => {
    const { config, warnings } = mergeEditionConfig({ ...VALIDO, streamingRequired: true });

    expect(warnings).toEqual([]);
    expect(config.streamingRequired).toBe(true);
  });

  it("aplica el emblema y el color de acento, en minúsculas", () => {
    const { config, warnings } = mergeEditionConfig({
      ...VALIDO,
      branding: { emblemUrl: "/ediciones/2027/emblema.png", accentColor: "#E2B714" },
    });

    expect(warnings).toEqual([]);
    expect(config.branding).toEqual({
      emblemUrl: "/ediciones/2027/emblema.png",
      accentColor: "#e2b714",
    });
  });

  it("admite un emblema externo por http(s)", () => {
    const { config, warnings } = mergeEditionConfig({
      ...VALIDO,
      branding: { emblemUrl: "https://cdn.ejemplo.com/emblema.png", accentColor: null },
    });

    expect(warnings).toEqual([]);
    expect(config.branding.emblemUrl).toBe("https://cdn.ejemplo.com/emblema.png");
  });
});

describe("mergeEditionConfig: lo que se rechaza, siempre con aviso", () => {
  it("un valor que no es un objeto se descarta entero", () => {
    for (const guardado of [null, undefined, 3, "edition.config", [], true]) {
      const { config, warnings } = mergeEditionConfig(guardado);

      expect(config).toEqual(DEFAULT_EDITION_CONFIG);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("no es un objeto");
    }
  });

  it("una versión distinta invalida el documento entero, no campo a campo", () => {
    const { config, warnings } = mergeEditionConfig({
      version: EDITION_CONFIG_VERSION + 1,
      name: "Otra edición",
      streamingRequired: true,
    });

    expect(config).toEqual(DEFAULT_EDITION_CONFIG);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("se usa la configuración por defecto");
  });

  it("una versión ausente también invalida el documento", () => {
    const { config, warnings } = mergeEditionConfig({ name: "Sin versión" });

    expect(config).toEqual(DEFAULT_EDITION_CONFIG);
    expect(warnings.some((w) => w.includes(`no es ${EDITION_CONFIG_VERSION}`))).toBe(true);
  });

  it("un nombre vacío o demasiado largo cae al de por defecto, avisando", () => {
    for (const name of ["", "   ", "x".repeat(EDITION_NAME_MAX_LENGTH + 1), 42]) {
      const { config, warnings } = mergeEditionConfig({ ...VALIDO, name });

      expect(config.name).toBe(DEFAULT_EDITION_CONFIG.name);
      expect(warnings.length).toBeGreaterThan(0);
    }
  });

  it("un importe que no es un entero de euros se descarta, y la nota se queda", () => {
    for (const amount of [-1, 12.5, "500", Number.NaN]) {
      const { config, warnings } = mergeEditionConfig({
        ...VALIDO,
        prize: { amount, note: "nota" },
      });

      expect(config.prize.amount).toBeNull();
      expect(config.prize.note).toBe("nota");
      expect(warnings.some((w) => w.startsWith("prize.amount"))).toBe(true);
    }
  });

  it("una nota demasiado larga se descarta sin llevarse el importe", () => {
    const { config, warnings } = mergeEditionConfig({
      ...VALIDO,
      prize: { amount: 100, note: "x".repeat(EDITION_PRIZE_NOTE_MAX_LENGTH + 1) },
    });

    expect(config.prize.amount).toBe(100);
    expect(config.prize.note).toBeNull();
    expect(warnings.some((w) => w.startsWith("prize.note"))).toBe(true);
  });

  it("un `prize` que no es un objeto se descarta entero", () => {
    const { config, warnings } = mergeEditionConfig({ ...VALIDO, prize: [500] });

    expect(config.prize).toEqual(DEFAULT_EDITION_CONFIG.prize);
    expect(warnings).toContain("prize no es un objeto");
  });

  it("`streamingRequired` que no es booleano se descarta", () => {
    const { config, warnings } = mergeEditionConfig({ ...VALIDO, streamingRequired: "true" });

    expect(config.streamingRequired).toBe(false);
    expect(warnings).toContain("streamingRequired no es un booleano");
  });

  it("un emblema que no es dirección ni ruta del sitio se descarta", () => {
    for (const emblemUrl of ["javascript:alert(1)", "emblema.png", "//otro-sitio.com/x.png", 42]) {
      const { config, warnings } = mergeEditionConfig({
        ...VALIDO,
        branding: { emblemUrl, accentColor: null },
      });

      expect(config.branding.emblemUrl, String(emblemUrl)).toBeNull();
      expect(warnings.some((w) => w.startsWith("branding.emblemUrl"))).toBe(true);
    }
  });

  it("un color que no es `#rrggbb` se descarta", () => {
    for (const accentColor of ["#e2b71", "#e2b7140", "e2b714", "rojo", "rgb(1,2,3)"]) {
      const { config, warnings } = mergeEditionConfig({
        ...VALIDO,
        branding: { emblemUrl: null, accentColor },
      });

      expect(config.branding.accentColor, accentColor).toBeNull();
      expect(warnings.some((w) => w.startsWith("branding.accentColor"))).toBe(true);
    }
  });

  it("un `branding` que no es un objeto se descarta entero", () => {
    const { config, warnings } = mergeEditionConfig({ ...VALIDO, branding: "#fff" });

    expect(config.branding).toEqual(DEFAULT_EDITION_CONFIG.branding);
    expect(warnings).toContain("branding no es un objeto");
  });

  it("nunca lanza, con cualquier cosa guardada", () => {
    const basura: unknown[] = [
      Symbol("x"),
      () => "x",
      new Date(),
      { version: EDITION_CONFIG_VERSION, name: {}, prize: "500", branding: 3, streamingRequired: [] },
      { version: 1, prize: { amount: 1e400 } },
    ];

    for (const guardado of basura) {
      expect(() => mergeEditionConfig(guardado)).not.toThrow();
    }
  });

  it("no toca el documento por defecto", () => {
    const antes = structuredClone(DEFAULT_EDITION_CONFIG);

    mergeEditionConfig({
      ...VALIDO,
      name: "Otra",
      prize: { amount: 10, note: "x" },
      streamingRequired: true,
      branding: { emblemUrl: "/x.png", accentColor: "#000000" },
    });

    expect(DEFAULT_EDITION_CONFIG).toEqual(antes);
  });
});

describe("isEmblemUrl y isAccentColor", () => {
  it("el emblema admite http(s) y rutas del sitio, no una URL sin esquema", () => {
    expect(isEmblemUrl("https://cdn.ejemplo.com/e.png")).toBe(true);
    expect(isEmblemUrl("http://ejemplo.com/e.png")).toBe(true);
    expect(isEmblemUrl("/ediciones/e.png")).toBe(true);
    expect(isEmblemUrl("//otro.com/e.png")).toBe(false);
    expect(isEmblemUrl("javascript:alert(1)")).toBe(false);
    expect(isEmblemUrl("e.png")).toBe(false);
  });

  it("el color es `#rrggbb` y la caja no importa", () => {
    expect(isAccentColor("#e2b714")).toBe(true);
    expect(isAccentColor("#E2B714")).toBe(true);
    expect(isAccentColor(" #e2b714 ")).toBe(true);
    expect(isAccentColor("#e2b71")).toBe(false);
    expect(isAccentColor("e2b714")).toBe(false);
  });
});

describe("readEditionConfig", () => {
  it("sin la clave publicada devuelve el documento por defecto, sin escribir", async () => {
    const { client, upserts } = fakeClient(null);

    expect(await readEditionConfig(client)).toEqual(DEFAULT_EDITION_CONFIG);
    expect(upserts).toEqual([]);
  });

  it("devuelve lo guardado, ya normalizado", async () => {
    const { client } = fakeClient({
      value: { ...VALIDO, name: "Liga 2027", streamingRequired: true },
    });

    const config = await readEditionConfig(client);

    expect(config.name).toBe("Liga 2027");
    expect(config.streamingRequired).toBe(true);
  });

  it("un documento ilegible se descarta con un aviso y cae al valor por defecto", async () => {
    const warn = silenceWarnings();
    const { client } = fakeClient({ value: { version: 99, name: "Otra" } });

    expect(await readEditionConfig(client)).toEqual(DEFAULT_EDITION_CONFIG);
    expect(warn).toHaveBeenCalled();
  });

  it("un fallo de la base se propaga: no es lo mismo que no tener nada publicado", async () => {
    const { client } = fakeClient(null, { fail: true });

    await expect(readEditionConfig(client)).rejects.toThrow("la base no responde");
  });
});

describe("writeEditionConfig", () => {
  const CONFIG: EditionConfig = {
    version: EDITION_CONFIG_VERSION,
    name: "Liga Hispana 2027",
    prize: { amount: 500, note: "Reparto 60/25/15" },
    streamingRequired: true,
    branding: { emblemUrl: "/ediciones/2027/emblema.png", accentColor: "#e2b714" },
  };

  it("escribe el documento tal y como se volverá a leer", async () => {
    const { client, upserts } = fakeClient(null);

    await writeEditionConfig(CONFIG, client);

    expect(upserts).toHaveLength(1);
    expect(upserts[0].key).toBe(EDITION_CONFIG_KEY);
    expect(upserts[0].value).toEqual(CONFIG);
    // Y lo que se escribe se puede leer: es la propiedad que exige la escritura
    // validada (si no, el panel dejaría un documento que el sistema descartaría).
    expect(mergeEditionConfig(upserts[0].value).warnings).toEqual([]);
  });

  it("normaliza antes de escribir", async () => {
    const { client, upserts } = fakeClient(null);

    await writeEditionConfig({ ...CONFIG, name: "  Liga  ", branding: { emblemUrl: null, accentColor: "#E2B714" } }, client);

    expect(upserts[0].value).toMatchObject({
      name: "Liga",
      branding: { accentColor: "#e2b714" },
    });
  });

  it("se niega a escribir un documento que no se podría leer, y no toca la base", async () => {
    const { client, upserts } = fakeClient(null);

    await expect(writeEditionConfig({ ...CONFIG, name: "" }, client)).rejects.toThrow(
      EDITION_CONFIG_KEY,
    );
    expect(upserts).toEqual([]);
  });
});
