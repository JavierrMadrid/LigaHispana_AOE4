import { describe, expect, it } from "vitest";

import {
  GILDED_VILLAGER_PBGID,
  MOUNTED_VILLAGER_PBGID,
  parseSummaryAnomalies,
  readSummaryAnomalies,
  type SummaryAnomalies,
} from "@/lib/aoe4world/summary-anomalies";

/**
 * El lector de la evidencia de comportamiento del *summary*.
 *
 * Es la pieza que decide qué es un hallazgo y qué es "no lo sé": las tres reglas por
 * partida del motor de alertas solo ven lo que sale de aquí, así que lo que se prueba
 * son los bordes que declara el docblock del módulo —el aldeano inicial que no cuenta,
 * la serie que no se pudo leer— y, sobre todo, que **`null` nunca se convierte en
 * cero**.
 *
 * Los payloads imitan la respuesta real con `camelize=true`: los `timestamps` cada
 * 20 s, `military` como puntuación y los `*Gathered` como acumulados.
 */

const PROFILE = 21_050_396;
const OTRO_PROFILE = 7_328_774;

const VILLAGER_PBGID = 129272;

/** Una lista de instantes cada 20 s, como la del resumen real. */
function cada20(segundos: number): number[] {
  return Array.from({ length: Math.floor(segundos / 20) + 1 }, (_, index) => index * 20);
}

type PayloadOptions = {
  duration?: number;
  buildOrder?: unknown;
  resources?: Record<string, unknown> | undefined;
  profileId?: number;
};

/** Un payload con la forma real, con el jugador `profileId` dentro. */
function payload(options: PayloadOptions = {}): unknown {
  return {
    gameId: 9_123_456,
    duration: options.duration ?? 1200,
    players: [
      {
        profileId: options.profileId ?? PROFILE,
        name: "Alguien",
        civilization: "english",
        apm: 137,
        ...("buildOrder" in options ? { buildOrder: options.buildOrder } : {}),
        ...(options.resources === undefined ? {} : { resources: options.resources }),
      },
    ],
  };
}

/** Las cuatro series de recursos con la misma longitud que los timestamps. */
function recursos(
  timestamps: number[],
  series: {
    military?: number[] | undefined;
    food?: (index: number) => number;
    wood?: (index: number) => number;
    gold?: (index: number) => number;
    stone?: (index: number) => number;
  } = {},
): Record<string, unknown> {
  return {
    timestamps,
    ...("military" in series ? { military: series.military } : {}),
    foodGathered: timestamps.map((_, index) => (series.food ?? (() => 0))(index)),
    woodGathered: timestamps.map((_, index) => (series.wood ?? (() => 0))(index)),
    goldGathered: timestamps.map((_, index) => (series.gold ?? (() => 0))(index)),
    stoneGathered: timestamps.map((_, index) => (series.stone ?? (() => 0))(index)),
  };
}

/* -------------------------------------------------------------------------- */

describe("aldeanos", () => {
  it("lee el primer aldeano creado a los 21 s, y los iniciales a 0 no cuentan", () => {
    const anomalies = parseSummaryAnomalies(
      payload({
        buildOrder: [
          { pbgid: VILLAGER_PBGID, type: "unit", finished: [0, 21, 41], destroyed: [900] },
        ],
      }),
      PROFILE,
    );

    expect(anomalies).toMatchObject({
      buildOrderReadable: true,
      firstVillagerSeconds: 21,
    });
  });

  it("con solo los aldeanos iniciales a 0 devuelve `null`, no cero", () => {
    const anomalies = parseSummaryAnomalies(
      payload({ buildOrder: [{ pbgid: VILLAGER_PBGID, finished: [0] }] }),
      PROFILE,
    );

    expect(anomalies?.firstVillagerSeconds).toBeNull();
    expect(anomalies?.firstVillagerSeconds).not.toBe(0);
  });

  it("el aldeano dorado y el montado también son aldeanos", () => {
    expect(
      parseSummaryAnomalies(
        payload({ buildOrder: [{ pbgid: GILDED_VILLAGER_PBGID, finished: [0, 30] }] }),
        PROFILE,
      )?.firstVillagerSeconds,
    ).toBe(30);

    expect(
      parseSummaryAnomalies(
        payload({ buildOrder: [{ pbgid: MOUNTED_VILLAGER_PBGID, finished: [0, 45] }] }),
        PROFILE,
      )?.firstVillagerSeconds,
    ).toBe(45);
  });

  it("sin `buildOrder` la lista no es legible, y el dato es `null`", () => {
    const anomalies = parseSummaryAnomalies(payload({ buildOrder: undefined }), PROFILE);

    expect(anomalies).toMatchObject({
      buildOrderReadable: false,
      firstVillagerSeconds: null,
    });
  });

  it("un `buildOrder` que no es una lista tampoco es legible", () => {
    for (const buildOrder of ["no es una lista", 3, {}]) {
      expect(
        parseSummaryAnomalies(payload({ buildOrder }), PROFILE)?.buildOrderReadable,
        JSON.stringify(buildOrder),
      ).toBe(false);
    }
  });

  it("una entrada de otra unidad no cuenta como aldeano", () => {
    const anomalies = parseSummaryAnomalies(
      payload({ buildOrder: [{ pbgid: 127_490, type: "building", finished: [0, 12] }] }),
      PROFILE,
    );

    expect(anomalies?.firstVillagerSeconds).toBeNull();
  });
});

describe("puntuación militar", () => {
  const timestamps = cada20(600);

  it("una serie plana es un único tramo, hasta el último punto si la serie termina pronto", () => {
    // La partida dura 1200 y la serie acaba en 600: los 600 s que faltan no se han
    // visto, así que el tramo se cierra en el último punto y no en el final.
    const anomalies = parseSummaryAnomalies(
      payload({ duration: 1200, resources: recursos(timestamps, { military: timestamps.map(() => 13) }) }),
      PROFILE,
    );

    expect(anomalies?.militaryNoGrowth).toEqual([{ fromSeconds: 0, toSeconds: 600 }]);
  });

  it("si la serie llega al final de la partida, el tramo se cierra en la duración", () => {
    const cortos = cada20(600);

    const anomalies = parseSummaryAnomalies(
      payload({
        duration: 620,
        resources: recursos(cortos, { military: cortos.map(() => 13) }),
      }),
      PROFILE,
    );

    expect(anomalies?.militaryNoGrowth).toEqual([{ fromSeconds: 0, toSeconds: 620 }]);
  });

  it("una serie que hace un máximo nuevo en cada punto no tiene ningún tramo", () => {
    const anomalies = parseSummaryAnomalies(
      payload({
        duration: 600,
        resources: recursos(timestamps, {
          military: timestamps.map((_, index) => 13 + index * 2),
        }),
      }),
      PROFILE,
    );

    expect(anomalies?.militaryNoGrowth).toEqual([]);
  });

  it("sin la serie, la lista es `null` y no una lista vacía", () => {
    // `null` es "no se pudo leer" y `[]` es "se leyó y no hay tramos": el motor no
    // las trata igual, porque de la primera no sabe nada.
    const sinMilitar = recursos(timestamps) as Record<string, unknown>;

    delete sinMilitar.military;

    const anomalies = parseSummaryAnomalies(payload({ resources: sinMilitar }), PROFILE);

    expect(anomalies?.militaryNoGrowth).toBeNull();
  });

  it("guarda todos los tramos, el más largo primero, no solo el más largo", () => {
    // Dos silencios: uno de 400 s al principio (que tras la gracia de 300 s solo
    // deja 100) y otro de 340 s a mitad de partida (que cuenta entero). Con solo el
    // más largo, la regla perdería el segundo.
    const largos = cada20(1400);

    const militar = largos.map((segundo) => {
      if (segundo <= 400) {
        return 13;
      }

      if (segundo <= 1000) {
        return 13 + ((segundo - 400) / 20) * 2;
      }

      if (segundo <= 1340) {
        return 73;
      }

      return 80;
    });

    const anomalies = parseSummaryAnomalies(
      payload({ duration: 1400, resources: recursos(largos, { military: militar }) }),
      PROFILE,
    );

    expect(anomalies?.militaryNoGrowth).toEqual([
      { fromSeconds: 0, toSeconds: 400 },
      { fromSeconds: 1000, toSeconds: 1340 },
      { fromSeconds: 1360, toSeconds: 1400 },
    ]);
  });
});

describe("recursos recolectados", () => {
  const timestamps = cada20(400);

  it("un tramo de 200 s con la suma congelada es el más largo", () => {
    // La suma sube 10 por punto hasta el índice 5, se queda quieta hasta el 15 y
    // luego sigue: el silencio va de 100 a 300 s, 200 en total. Son 200 y no 180
    // porque el tramo se cierra en el **último punto confirmado sin crecimiento**
    // (300), no en el punto donde la suma vuelve a subir (320): el algoritmo es
    // conservador y no cuenta como silencio el salto que lo rompe.
    const total = (index: number) => (index <= 5 ? index * 10 : index <= 15 ? 50 : 50 + (index - 15) * 10);

    const anomalies = parseSummaryAnomalies(
      payload({
        duration: 400,
        resources: recursos(timestamps, {
          food: total,
          military: timestamps.map((_, index) => 13 + index),
        }),
      }),
      PROFILE,
    );

    expect(anomalies?.noResourceGain).toEqual({ fromSeconds: 100, toSeconds: 300 });
  });

  it("una suma que sube en cada punto no tiene silencio", () => {
    const anomalies = parseSummaryAnomalies(
      payload({
        duration: 400,
        resources: recursos(timestamps, {
          food: (index) => index * 10,
          wood: (index) => index * 5,
        }),
      }),
      PROFILE,
    );

    // Se leyó y no hay ningún tramo con longitud positiva: `null`, que para la regla
    // es "no hay nada que avisar".
    expect(anomalies?.noResourceGain).toBeNull();
  });

  it("si falta una de las cuatro series, el tramo es `null`", () => {
    const incomplete = recursos(timestamps, { food: (index) => index * 10 }) as Record<string, unknown>;

    delete incomplete.stoneGathered;

    expect(parseSummaryAnomalies(payload({ resources: incomplete }), PROFILE)?.noResourceGain).toBeNull();
  });

  it("sin `resources` no hay series que leer", () => {
    const anomalies = parseSummaryAnomalies(payload(), PROFILE);

    expect(anomalies).toMatchObject({
      buildOrderReadable: false,
      militaryNoGrowth: null,
      noResourceGain: null,
    });
  });

  it("una serie con un punto ilegible no se lee a medias", () => {
    const rota = recursos(timestamps, { military: timestamps.map(() => 13) }) as Record<string, unknown>;

    rota.timestamps = [0, 20, "no", 60, 80];

    expect(parseSummaryAnomalies(payload({ resources: rota }), PROFILE)?.militaryNoGrowth).toBeNull();
  });
});

describe("el payload que no dice nada", () => {
  it("sin `players` o sin el jugador no hay evidencia", () => {
    expect(parseSummaryAnomalies(null, PROFILE)).toBeNull();
    expect(parseSummaryAnomalies("lo que sea", PROFILE)).toBeNull();
    expect(parseSummaryAnomalies({ players: "no es una lista" }, PROFILE)).toBeNull();
    expect(parseSummaryAnomalies({}, PROFILE)).toBeNull();
    expect(parseSummaryAnomalies(payload(), OTRO_PROFILE)).toBeNull();
  });
});

describe("readSummaryAnomalies", () => {
  const VALIDA: SummaryAnomalies = {
    buildOrderReadable: true,
    firstVillagerSeconds: 21,
    militaryNoGrowth: [
      { fromSeconds: 100, toSeconds: 700 },
      { fromSeconds: 900, toSeconds: 1000 },
    ],
    noResourceGain: { fromSeconds: 120, toSeconds: 300 },
  };

  it("acepta la forma que escribe el worker", () => {
    expect(readSummaryAnomalies(VALIDA)).toEqual(VALIDA);
  });

  it("acepta los tres datos ausentes como `null`", () => {
    const vacia = {
      buildOrderReadable: false,
      firstVillagerSeconds: null,
      militaryNoGrowth: null,
      noResourceGain: null,
    };

    expect(readSummaryAnomalies(vacia)).toEqual(vacia);
  });

  it("acepta una lista de tramos vacía, que es 'se leyó y no hay ninguno'", () => {
    const vacia = { ...VALIDA, militaryNoGrowth: [] };

    expect(readSummaryAnomalies(vacia)).toEqual(vacia);
  });

  it("rechaza lo que no tiene la forma, sin lanzar", () => {
    for (const guardado of [
      null,
      undefined,
      "lo que sea",
      3,
      [],
      {},
      { ...VALIDA, buildOrderReadable: "true" },
      { ...VALIDA, firstVillagerSeconds: -1 },
      { ...VALIDA, firstVillagerSeconds: 1.5 },
    ]) {
      expect(readSummaryAnomalies(guardado), JSON.stringify(guardado)).toBeNull();
    }
  });

  it("rechaza un tramo al revés, con negativos o fuera de una lista", () => {
    expect(
      readSummaryAnomalies({
        ...VALIDA,
        militaryNoGrowth: [{ fromSeconds: 700, toSeconds: 100 }],
      }),
    ).toBeNull();
    expect(
      readSummaryAnomalies({ ...VALIDA, noResourceGain: { fromSeconds: -20, toSeconds: 100 } }),
    ).toBeNull();
    expect(
      readSummaryAnomalies({ ...VALIDA, noResourceGain: { fromSeconds: "x", toSeconds: 100 } }),
    ).toBeNull();
    // Un tramo suelto ya no vale: la forma nueva es una lista.
    expect(
      readSummaryAnomalies({ ...VALIDA, militaryNoGrowth: { fromSeconds: 100, toSeconds: 700 } }),
    ).toBeNull();
  });

  it("un elemento inválido invalida la lista entera", () => {
    // Media lista de silencios haría creer que se vieron todos los tramos.
    expect(
      readSummaryAnomalies({
        ...VALIDA,
        militaryNoGrowth: [{ fromSeconds: 0, toSeconds: 100 }, { fromSeconds: 300, toSeconds: 200 }],
      }),
    ).toBeNull();
    expect(
      readSummaryAnomalies({ ...VALIDA, militaryNoGrowth: [{ fromSeconds: 0, toSeconds: 100 }, null] }),
    ).toBeNull();
  });
});
