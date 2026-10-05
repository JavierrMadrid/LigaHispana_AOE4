import { describe, expect, it } from "vitest";

import {
  readCutoffsTable,
  subdivisionForRating,
  type LadderCutoffs,
  type LadderCutoffsTable,
  type StoredDivisionCutoffs,
} from "@/lib/alerts/division-cutoffs";
import { SUBDIVISION_RANK_LEVELS } from "@/lib/divisions";

/**
 * La traducción de rating a subdivisión y la lectura de la caché que la alimenta.
 *
 * Es lo que decide R5, así que lo que se cubren son las dos promesas del docblock: un
 * `rating` se sitúa en el bloque de la ladder que lo contiene (y se recorta por
 * debajo del último corte), y un documento guardado con una fila mala **se pierde
 * esa ladder y solo esa**, sin lanzar y sin tirar el resto de la caché.
 */

const FECHA = "2026-09-15T00:00:00.000Z";

/**
 * Cortes inventados pero **monótonos y de la misma escala** que la ladder real: se
 * construyen hacia abajo desde `conqueror_3` en pasos de 100, así cada escalón vale
 * exactamente 100 de elo y las cuentas salen a mano. Lo que importa es la
 * aritmética de escalones, no el rating exacto.
 */
function cortes(nombre: string, tope = 3000, paso = 100): LadderCutoffs {
  return {
    ladder: nombre,
    derivedAt: FECHA,
    totalCount: 50_000,
    cutoffs: SUBDIVISION_RANK_LEVELS.map((rankLevel, indice) => ({
      rankLevel,
      minRating: tope - indice * paso,
    })),
    requests: 1,
  };
}

/** La tabla tal y como la deja escribir `derive-cutoffs.ts`. */
function tabla(...ladders: LadderCutoffs[]): LadderCutoffsTable {
  return Object.fromEntries(ladders.map((entrada) => [entrada.ladder, entrada]));
}

/**
 * Lee **después de un viaje por JSON**, que es como llega el documento: lo que se
 * guarda en `Setting["alerts.divisionCutoffs"]` es texto. Un `readCutoffsTable`
 * alimentado con objetos en memoria mediría el parseo de Node y no la caché.
 */
function desdeJson(value: unknown): LadderCutoffsTable | null {
  return readCutoffsTable(JSON.parse(JSON.stringify(value)) as unknown);
}

/** El documento completo, tal y como se guarda. */
function guardado(ladders: LadderCutoffsTable): StoredDivisionCutoffs {
  return { ladders };
}

const RM_TEAM = cortes("rm_team");
const RM_SOLO = cortes("rm_solo", 5000);

describe("readCutoffsTable — lo que se guarda se vuelve a leer igual", () => {
  it("la tabla entera sobrevive al viaje por JSON, campo a campo", () => {
    // `requests`, `totalCount` y `derivedAt` no deciden nada de R5, pero son lo que
    // permite comparar el coste de derivar una ladder con el resultado (ver
    // `alerts:cutoffs --show`), así que tampoco pueden perderse por el camino.
    const leidos = desdeJson(guardado(tabla(RM_TEAM, RM_SOLO)));

    expect(leidos).toEqual(tabla(RM_TEAM, RM_SOLO));
  });

  it("una ladder derivada se lee con sus dieciocho cortes y su coste", () => {
    const leidos = desdeJson(guardado(tabla(RM_TEAM)));

    expect(leidos?.["rm_team"]?.cutoffs).toHaveLength(18);
    expect(leidos?.["rm_team"]?.requests).toBe(1);
    expect(leidos?.["rm_team"]?.totalCount).toBe(50_000);
    expect(leidos?.["rm_team"]?.derivedAt).toBe(FECHA);
  });

  it("las ladders se guardan por separado, con su propia escala", () => {
    // `average_mmr` es elo de equipos: las dos ladders no comparten cortes y
    // confundirlas daría escalones que no existen.
    const leidos = desdeJson(guardado(tabla(RM_SOLO, RM_TEAM)));

    expect(leidos?.["rm_solo"]?.cutoffs[0]?.minRating).toBe(5000);
    expect(leidos?.["rm_team"]?.cutoffs[0]?.minRating).toBe(3000);
  });

  it("sin metadatos la ladder sigue sirviendo, y la fecha dice que no la hay", () => {
    // Lo que decide R5 son los cortes: un documento escrito por una versión anterior
    // que no guardara el coste no puede dejar de servir la ladder entera.
    const leidos = desdeJson({
      ladders: { rm_team: { cutoffs: RM_TEAM.cutoffs } },
    });

    expect(leidos?.["rm_team"]?.cutoffs).toHaveLength(18);
    expect(leidos?.["rm_team"]?.requests).toBe(0);
    expect(leidos?.["rm_team"]?.totalCount).toBe(0);
    expect(leidos?.["rm_team"]?.derivedAt).toBe("sin fecha");
    // El nombre sale de la clave con la que se indexa, que es la que usa la partida.
    expect(leidos?.["rm_team"]?.ladder).toBe("rm_team");
  });
});

describe("readCutoffsTable — una caché vacía no es una caché de cortes", () => {
  it("sin documento o sin ladders devuelve `null`, no un objeto vacío", () => {
    // La diferencia importa: `settings.ts` trata `null` como "aún no hay cortes" y
    // deja que R5 se omita con aviso, mientras que un `{}` fingiría tener cortes y
    // callaría el aviso.
    for (const vacio of [null, {}, { ladders: {} }, "texto", 42, [], { ladders: [] }]) {
      expect(desdeJson(vacio), JSON.stringify(vacio) ?? "null").toBeNull();
    }
  });

  it("un documento cuya forma no es la esperada tampoco inventa cortes", () => {
    expect(readCutoffsTable({ ladders: "texto" })).toBeNull();
    expect(readCutoffsTable({ ladders: [RM_TEAM] })).toBeNull();
  });
});

describe("readCutoffsTable — una fila mala tumba su ladder y solo la suya", () => {
  it("una subdivisión fuera del catálogo hace inservible la ladder entera", () => {
    // `plata_1` no existe: `subdivisionForRating` no la encontraría nunca, así que
    // dejarla en la lista dejaría la cuenta de R5 falseada sin que nada fallara.
    const leidos = desdeJson({
      ladders: {
        rm_team: {
          ladder: "rm_team",
          cutoffs: [
            { rankLevel: "plata_1", minRating: 1000 },
            { rankLevel: "gold_3", minRating: 900 },
          ],
        },
      },
    });

    expect(leidos).toBeNull();
  });

  it("un corte con el rating o el `rank_level` ilegible también invalida la ladder", () => {
    // `minRating` decide en qué bloque cae un `average_mmr`, así que un string, un
    // `NaN` o un corte que no es un objeto hacen la ladder tan inservible como una
    // subdivisión inventada.
    const malos: unknown[] = [
      { rankLevel: "gold_2", minRating: "900" },
      { rankLevel: "gold_2", minRating: Number.NaN },
      { rankLevel: "gold_2" },
      { rankLevel: "  ", minRating: 900 },
      { minRating: 900 },
      "gold_2",
    ];

    for (const malo of malos) {
      const leidos = desdeJson({
        ladders: {
          rm_team: {
            ladder: "rm_team",
            cutoffs: [
              { rankLevel: "gold_3", minRating: 1000 },
              malo,
            ],
          },
        },
      });

      expect(leidos, JSON.stringify(malo)).toBeNull();
    }
  });

  it("una ladder desordenada se cae sin tumbar la buena", () => {
    // El orden es de la más fuerte a la más débil, y es lo que permite parar en el
    // primer corte alcanzado. Aquí `conqueror_3` (3000) va después de `gold_2` (900):
    // una ladder servida así situaría cualquier media en la división equivocada.
    const leidos = desdeJson({
      ladders: {
        rm_solo: {
          ladder: "rm_solo",
          cutoffs: [
            { rankLevel: "gold_2", minRating: 900 },
            { rankLevel: "conqueror_3", minRating: 3000 },
          ],
        },
        ...tabla(RM_TEAM),
      },
    });

    expect(leidos).not.toBeNull();
    expect(leidos?.["rm_solo"]).toBeUndefined();
    expect(leidos?.["rm_team"]?.cutoffs).toHaveLength(18);
  });

  it("una ladder con el orden bueno pero los ratings al revés también se cae", () => {
    // El orden de subdivisión y el de rating son las dos cosas que hacen válida la
    // lista. Aquí el primero es el correcto y el segundo no, así que esta
    // comprobación no se solapa con la anterior: es la que impide que un corte mal
    // derivado se cuele por el hueco de la otra.
    const leidos = desdeJson({
      ladders: {
        rm_team: {
          ladder: "rm_team",
          cutoffs: [
            { rankLevel: "conqueror_3", minRating: 2800 },
            { rankLevel: "conqueror_2", minRating: 3000 },
          ],
        },
      },
    });

    expect(leidos).toBeNull();
  });

  it("una ladder sin cortes no se cuela como una ladder derivable", () => {
    expect(readCutoffsTable({ ladders: { rm_team: { ladder: "rm_team", cutoffs: [] } } })).toBeNull();
    expect(readCutoffsTable({ ladders: { rm_team: { ladder: "rm_team" } } })).toBeNull();
  });
});

describe("subdivisionForRating", () => {
  it("el corte justo da esa subdivisión, y un elo menos da la siguiente", () => {
    // La búsqueda para en el **primer** corte que el rating alcanza: el bloque de la
    // ladder al que pertenece, y no el primero que lo supere.
    expect(subdivisionForRating(RM_TEAM, 3000)).toEqual({ index: 0, rankLevel: "conqueror_3" });
    expect(subdivisionForRating(RM_TEAM, 2999)).toEqual({ index: 1, rankLevel: "conqueror_2" });
  });

  it("cada rating cae en el bloque cuyo corte alcanza", () => {
    expect(subdivisionForRating(RM_TEAM, 2100)?.rankLevel).toBe("gold_3");
    expect(subdivisionForRating(RM_TEAM, 1900)?.rankLevel).toBe("gold_1");
    expect(subdivisionForRating(RM_TEAM, 1800)?.rankLevel).toBe("silver_3");
    expect(subdivisionForRating(RM_TEAM, 1600)?.rankLevel).toBe("silver_1");
  });

  it("el índice que devuelve es la posición en el catálogo, que es lo que cuenta R5", () => {
    // R5 no resta `rank_level`: resta índices, así que el `index` que sale de aquí
    // tiene que ser el mismo que el del catálogo (`conqueror_3` 0, `gold_1` 11,
    // `bronze_1` 17) o "tres escalones por debajo" significaría otra cosa.
    expect(subdivisionForRating(RM_TEAM, 3000)?.index).toBe(0);
    expect(subdivisionForRating(RM_TEAM, 1900)?.index).toBe(11);
    expect(subdivisionForRating(RM_TEAM, 1200)?.index).toBe(17);
  });

  it("la escala es la de la ladder que se le pase, no una escala global", () => {
    // La misma media en dos ladders de distinta escala da dos divisiones distintas:
    // por eso los cortes se cachean por ladder y no son globales.
    expect(subdivisionForRating(RM_SOLO, 4800)).toEqual({ index: 2, rankLevel: "conqueror_1" });
    expect(subdivisionForRating(RM_TEAM, 4800)).toEqual({ index: 0, rankLevel: "conqueror_3" });
  });

  it("por debajo del último corte se recorta a la última subdivisión", () => {
    // Por debajo de bronce 1 la ladder no dice nada. Recortar solo puede **reducir**
    // la cuenta de escalones en un caso patológico, y no cambia ninguna decisión
    // cerca del umbral de tres.
    expect(subdivisionForRating(RM_TEAM, 1200)?.rankLevel).toBe("bronze_1");
    expect(subdivisionForRating(RM_TEAM, 0)?.rankLevel).toBe("bronze_1");
    expect(subdivisionForRating(RM_TEAM, -500)?.rankLevel).toBe("bronze_1");
  });

  it("un rating que no es un número no decide nada", () => {
    for (const rating of [Number.NaN, Infinity, -Infinity]) {
      expect(subdivisionForRating(RM_TEAM, rating), String(rating)).toBeNull();
    }
  });

  it("una ladder sin cortes no puede situar un rating", () => {
    expect(subdivisionForRating({ ...RM_TEAM, cutoffs: [] }, 1500)).toBeNull();
  });

  it("un corte con una subdivisión desconocida devuelve `null` en vez de inventarse un índice", () => {
    // Rama defensiva: `readCutoffsTable` ya no deja pasar una fila así, y por eso
    // está el comentario de que la ladder entera se descarta por su culpa.
    expect(
      subdivisionForRating(
        { ...RM_TEAM, cutoffs: [{ rankLevel: "plata_1", minRating: 1000 }] },
        1000,
      ),
    ).toBeNull();
  });
});
