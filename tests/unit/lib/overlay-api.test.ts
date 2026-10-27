import { describe, expect, it } from "vitest";

import {
  OBJECTIVE_DEFINITIONS,
  type ObjectiveDefinition,
} from "@/lib/objectives";
import {
  overlayError,
  overlayJson,
  overlayObjectives,
  overlayParticipants,
  overlayPreflight,
  readOverlayDesde,
  readOverlayProfileId,
  type OverlayObjetivo,
} from "@/lib/overlay-api";
import { DEFAULT_RULESET, type ScoringRuleset } from "@/lib/scoring";

/**
 * La API del overlay, en lo que se puede comprobar sin base de datos: los parsers
 * de los parámetros, los mapeadores del contrato y la forma de las respuestas.
 *
 * Los dos lectores (`loadOverlayParticipants`, `loadOverlayObjectives`) no se
 * prueban aquí: necesitan base de datos, y los comprueba la API en marcha. Lo que
 * sí se prueba es todo lo que hay entre la consulta y el JSON, que es donde se
 * decide qué se publica.
 */

const ORIGEN = "https://liga.example";

/** Una definición del catálogo por id; falla si el catálogo cambia de ids. */
function definicion(id: string): ObjectiveDefinition {
  const found = OBJECTIVE_DEFINITIONS.find((item) => item.id === id);

  if (found === undefined) {
    throw new Error(`El catálogo no tiene el objetivo ${id}`);
  }

  return found;
}

const SUBCONJUNTO = [
  "loco-por-ganar",
  "victorias",
  "imparable",
  "por-tierra-y-agua",
  "rey-1v1",
  "lider-japanese",
  "masterizando-japanese",
].map(definicion);

/** Los objetivos publicados, indexados por id, para no recorrer el array. */
function porId(objetivos: readonly OverlayObjetivo[]): Map<string, OverlayObjetivo> {
  return new Map(objetivos.map((objetivo) => [objetivo.id, objetivo]));
}

describe("readOverlayProfileId", () => {
  it("sin parámetro, ausente", () => {
    expect(readOverlayProfileId(null)).toEqual({ status: "absent" });
  });

  it("acepta un entero positivo", () => {
    expect(readOverlayProfileId("12345")).toEqual({ status: "ok", value: 12345 });
  });

  it("rechaza vacío, cero, ceros a la izquierda y texto", () => {
    expect(readOverlayProfileId("")).toEqual({ status: "invalid" });
    expect(readOverlayProfileId("0")).toEqual({ status: "invalid" });
    expect(readOverlayProfileId("007")).toEqual({ status: "invalid" });
    expect(readOverlayProfileId("abc")).toEqual({ status: "invalid" });
  });

  it("rechaza más de diez dígitos", () => {
    expect(readOverlayProfileId("12345678901")).toEqual({ status: "invalid" });
  });
});

describe("readOverlayDesde", () => {
  it("sin parámetro, ausente", () => {
    expect(readOverlayDesde(null)).toEqual({ status: "absent" });
  });

  it("acepta ISO 8601 con Z", () => {
    expect(readOverlayDesde("2026-10-24T14:30:00Z")).toEqual({
      status: "ok",
      value: new Date("2026-10-24T14:30:00Z"),
    });
  });

  it("acepta milisegundos", () => {
    expect(readOverlayDesde("2026-10-24T14:30:00.250Z")).toEqual({
      status: "ok",
      value: new Date("2026-10-24T14:30:00.250Z"),
    });
  });

  it("acepta un offset explícito", () => {
    expect(readOverlayDesde("2026-10-24T14:30:00+02:00")).toEqual({
      status: "ok",
      value: new Date("2026-10-24T14:30:00+02:00"),
    });
  });

  it("rechaza una fecha sin hora", () => {
    expect(readOverlayDesde("2026-10-24")).toEqual({ status: "invalid" });
  });

  it("rechaza una fecha sin zona", () => {
    expect(readOverlayDesde("2026-10-24T14:30:00")).toEqual({ status: "invalid" });
  });

  it("rechaza un mes o un día imposibles", () => {
    expect(readOverlayDesde("2026-13-24T14:30:00Z")).toEqual({ status: "invalid" });
    expect(readOverlayDesde("2026-02-30T14:30:00Z")).toEqual({ status: "invalid" });
  });

  it("rechaza basura", () => {
    expect(readOverlayDesde("ayer")).toEqual({ status: "invalid" });
    expect(readOverlayDesde("")).toEqual({ status: "invalid" });
  });
});

describe("overlayParticipants", () => {
  it("mapea el identificador a cadena y el nombre a alias", () => {
    expect(overlayParticipants([{ profileId: 42, name: "Kaiserklein" }])).toEqual([
      { id: "42", alias: "Kaiserklein" },
    ]);
  });

  it("conserva el orden de las filas y admite la lista vacía", () => {
    expect(overlayParticipants([])).toEqual([]);
    expect(
      overlayParticipants([
        { profileId: 2, name: "B" },
        { profileId: 1, name: "A" },
      ]),
    ).toEqual([
      { id: "2", alias: "B" },
      { id: "1", alias: "A" },
    ]);
  });
});

describe("overlayObjectives", () => {
  const objetivos = porId(overlayObjectives(SUBCONJUNTO, DEFAULT_RULESET, 9, ORIGEN));

  it("publica el orden del catálogo", () => {
    expect(overlayObjectives(SUBCONJUNTO, DEFAULT_RULESET, 9, ORIGEN).map((o) => o.id)).toEqual(
      SUBCONJUNTO.map((item) => item.id),
    );
  });

  it("loco-por-ganar: competición con premio fijo y sin icono", () => {
    expect(objetivos.get("loco-por-ganar")).toMatchObject({
      puntos: 50,
      volatil: true,
      repetible: false,
      max_progreso: null,
      icono_url: "",
    });
  });

  it("victorias: paga los puntos por victoria de la regla y no tiene tope", () => {
    expect(objetivos.get("victorias")).toMatchObject({
      puntos: DEFAULT_RULESET.pointsPerWin,
      volatil: false,
      repetible: true,
      max_progreso: null,
      icono_url: "",
    });
  });

  it("imparable: logro repetible con tope de 14", () => {
    expect(objetivos.get("imparable")).toMatchObject({
      puntos: 14,
      volatil: false,
      repetible: true,
      max_progreso: 14,
      icono_url: "",
    });
  });

  it("por-tierra-y-agua: el tope es el tamaño del pool activo", () => {
    expect(objetivos.get("por-tierra-y-agua")).toMatchObject({
      max_progreso: 9,
      icono_url: "",
    });
  });

  it("rey-1v1: competición de formato sin tope ni icono", () => {
    expect(objetivos.get("rey-1v1")).toMatchObject({
      volatil: true,
      max_progreso: null,
      icono_url: "",
    });
  });

  it("lider-japanese: logro de civilización con el icono de la civ", () => {
    const lider = objetivos.get("lider-japanese");

    expect(lider).toMatchObject({ volatil: false, repetible: false, max_progreso: 3 });
    expect(lider?.icono_url).toBe(`${ORIGEN}/imagenes/civilizaciones/Japanese_AoE4.webp`);
  });

  it("masterizando-japanese: competición de civilización, también con icono", () => {
    const masterizando = objetivos.get("masterizando-japanese");

    expect(masterizando).toMatchObject({ volatil: true, repetible: false, max_progreso: null });
    expect(masterizando?.icono_url).toBe(
      `${ORIGEN}/imagenes/civilizaciones/Japanese_AoE4.webp`,
    );
  });

  it("normaliza el origen sin doblar la barra", () => {
    const [lider] = overlayObjectives(
      [definicion("lider-japanese")],
      DEFAULT_RULESET,
      9,
      `${ORIGEN}/`,
    );

    expect(lider?.icono_url).toBe(`${ORIGEN}/imagenes/civilizaciones/Japanese_AoE4.webp`);
  });

  it("salta los objetivos desactivados por la regla", () => {
    const regla: ScoringRuleset = { ...DEFAULT_RULESET, disabledObjectives: ["imparable"] };
    const ids = overlayObjectives(SUBCONJUNTO, regla, 9, ORIGEN).map((objetivo) => objetivo.id);

    expect(ids).not.toContain("imparable");
    expect(ids).toContain("victorias");
  });

  it("aplica el override de puntos de la regla", () => {
    const regla: ScoringRuleset = {
      ...DEFAULT_RULESET,
      objectives: { ...DEFAULT_RULESET.objectives, imparable: 20 },
    };

    expect(porId(overlayObjectives(SUBCONJUNTO, regla, 9, ORIGEN)).get("imparable")?.puntos).toBe(
      20,
    );
  });
});

describe("overlayJson", () => {
  it("responde 200 con CORS abierto, sin caché y cuerpo JSON", async () => {
    const response = overlayJson([{ id: "42", alias: "Kaiserklein" }]);

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe("GET, OPTIONS");
    expect(response.headers.get("Access-Control-Allow-Headers")).toBe("Accept, Content-Type");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual([{ id: "42", alias: "Kaiserklein" }]);
  });
});

describe("overlayError", () => {
  it("responde con el estado y el cuerpo de error", async () => {
    const response = overlayError("parametro_invalido", "El identificador no es válido.", 400);

    expect(response.status).toBe(400);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    await expect(response.json()).resolves.toEqual({
      codigo: "parametro_invalido",
      mensaje: "El identificador no es válido.",
    });
  });
});

describe("overlayPreflight", () => {
  it("responde 204 sin cuerpo y con las mismas cabeceras", async () => {
    const response = overlayPreflight();

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe("GET, OPTIONS");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.text()).resolves.toBe("");
  });
});
