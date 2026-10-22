import { describe, expect, it } from "vitest";

import {
  compareFeedInstants,
  historyFeedPage,
  historyFeedWindows,
  type HistoryFeedRow,
} from "@/lib/history-feed";

/**
 * El feed mezclado del historial: el orden natural y la aritmética de las ventanas.
 *
 * Son las piezas que comparten el panel (`/admin/historial`) y el historial público
 * (`/historial`), y son puras: se comprueban con filas sintéticas, sin base de datos. Lo que
 * **no** se puede comprobar aquí es que cada fuente llegue de su consulta ya ordenada como
 * el comparador: eso es Prisma y sale en `npm run verify:sync` (que pagina el feed entero
 * con `historyFeedWindows()` y comprueba que ninguna fila se repite ni se pierde).
 */

type Fila = HistoryFeedRow & { id: string };

/**
 * Un comparador **total** de prueba, con la forma de los de verdad: fecha descendente, la
 * partida antes que el objetivo y la clave de la clase como desempate final.
 *
 * El desempate no es un detalle de la prueba: sin él, `Array.prototype.sort` deja las filas
 * empatadas en el orden en que llegaron y el recorrido de páginas pasaría el test por
 * casualidad, que es justo lo que no se quiere demostrar.
 */
function comparador(a: Fila, b: Fila): number {
  const porInstante = compareFeedInstants(a, b);

  if (porInstante !== 0) {
    return porInstante;
  }

  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** Una partida del feed. */
function partida(id: string, fecha: string): Fila {
  return { id, startedAt: new Date(fecha), objective: null };
}

/** Un objetivo cumplido del feed: nunca comparte clave con una partida. */
function objetivo(id: string, fecha: string): Fila {
  return { id, startedAt: new Date(fecha), objective: { id } };
}

/** Un objetivo con un id de clase que se puede repetir entre filas. */
function objetivoDe(id: string, fecha: string, objetivoId: string): Fila {
  return { id, startedAt: new Date(fecha), objective: { id: objetivoId } };
}

/** Un cambio de poseedor del feed. */
function liderazgo(
  id: string,
  fecha: string,
  objetivoId: string,
  lead: "GAINED" | "LOST",
): Fila {
  return { id, startedAt: new Date(fecha), objective: { id: objetivoId, lead } };
}

const T1 = "2026-09-01T10:00:00.000Z";
const T2 = "2026-09-02T10:00:00.000Z";
const T3 = "2026-09-03T10:00:00.000Z";
const T4 = "2026-09-04T10:00:00.000Z";

describe("compareFeedInstants", () => {
  it("ordena de lo más reciente a lo más antiguo", () => {
    expect(compareFeedInstants(partida("a", T2), partida("b", T1))).toBeLessThan(0);
    expect(compareFeedInstants(partida("a", T1), partida("b", T2))).toBeGreaterThan(0);
  });

  it("a igual instante, la partida va antes que el objetivo", () => {
    expect(compareFeedInstants(partida("m", T1), objetivo("o", T1))).toBeLessThan(0);
    expect(compareFeedInstants(objetivo("o", T1), partida("m", T1))).toBeGreaterThan(0);
  });

  it("devuelve 0 si comparten instante y clase: el desempate es de quien lo use", () => {
    expect(compareFeedInstants(partida("m1", T1), partida("m2", T1))).toBe(0);
    expect(compareFeedInstants(objetivo("o1", T1), objetivo("o2", T1))).toBe(0);
  });

  it("es simétrico", () => {
    const filas = [partida("m", T1), partida("m2", T2), objetivo("o", T1), objetivo("o2", T2)];

    for (const a of filas) {
      for (const b of filas) {
        // La suma, y no `-comparar(b, a)`, porque el neutro del otro lado es `-0`.
        expect(compareFeedInstants(a, b) + compareFeedInstants(b, a)).toBe(0);
      }
    }
  });

  it("no mira más que el instante y la clase: revertir una fila no la mueve de sitio", () => {
    const revertida = { ...partida("m", T2), revertedAt: new Date(T2) } as HistoryFeedRow;

    expect(compareFeedInstants(revertida, partida("b", T1))).toBeLessThan(0);
    expect(compareFeedInstants(revertida, objetivo("o", T1))).toBeLessThan(0);
  });
});

describe("historyFeedWindows", () => {
  it("sin filas, no pide nada a ninguna fuente", () => {
    expect(historyFeedWindows(0, 10, [0, 0, 0])).toEqual({
      windows: [
        { skip: 0, take: 0 },
        { skip: 0, take: 0 },
        { skip: 0, take: 0 },
      ],
      offset: 0,
    });
  });

  it("una fuente vacía no aporta filas pero no descuadra el offset", () => {
    // 4 filas en la fuente 1 y la página empieza en la 1: se salta una fila de esa fuente.
    expect(historyFeedWindows(1, 2, [0, 4, 0])).toEqual({
      windows: [
        { skip: 0, take: 0 },
        { skip: 1, take: 2 },
        { skip: 0, take: 0 },
      ],
      offset: 0,
    });
  });

  it("en la primera página no se salta nada: la unión empieza en la página", () => {
    expect(historyFeedWindows(0, 3, [4, 2, 1])).toEqual({
      windows: [
        { skip: 0, take: 3 },
        { skip: 0, take: 2 },
        { skip: 0, take: 1 },
      ],
      offset: 0,
    });
  });

  it("en una página intermedia, el offset descuenta las filas saltadas", () => {
    // 16 filas; la página 4 de tamaño 3 empieza en la posición 10. La fuente 0 tiene 10
    // filas y las otras dos suman 6: las primeras 4 de la fuente 0 son seguro anteriores,
    // y la unión de las ventanas empieza en el índice 6.
    expect(historyFeedWindows(10, 3, [10, 4, 2])).toEqual({
      windows: [
        { skip: 4, take: 6 },
        { skip: 0, take: 4 },
        { skip: 0, take: 2 },
      ],
      offset: 6,
    });
  });

  it("más allá del final pide ventanas vacías y deja el offset donde toca", () => {
    // Con 6 filas y una página que empieza en la 6: todo lo que hay queda antes.
    expect(historyFeedWindows(6, 5, [3, 2, 1])).toEqual({
      windows: [
        { skip: 3, take: 0 },
        { skip: 2, take: 0 },
        { skip: 1, take: 0 },
      ],
      offset: 0,
    });

    // Y muy por encima del final, las tres ventanas siguen vacías: la página sale vacía.
    expect(historyFeedWindows(20, 5, [3, 2, 1])).toEqual({
      windows: [
        { skip: 3, take: 0 },
        { skip: 2, take: 0 },
        { skip: 1, take: 0 },
      ],
      offset: 14,
    });
  });

  it("con fuentes muy desequilibradas, salta casi todo en la fuente grande", () => {
    expect(historyFeedWindows(500, 10, [1000, 1, 0])).toEqual({
      windows: [
        { skip: 499, take: 11 },
        { skip: 0, take: 1 },
        { skip: 0, take: 0 },
      ],
      offset: 1,
    });
  });
});

describe("historyFeedPage", () => {
  it("la página es una ventana del feed, no una muestra", () => {
    const partidas = [partida("m3", T2), partida("m2", T1), partida("m1", T1)];
    const objetivos = [objetivo("o1", T2), objetivo("o2", T1)];

    const feed = [...partidas, ...objetivos].sort(comparador).map((fila) => fila.id);
    const { windows, offset } = historyFeedWindows(3, 2, [partidas.length, objetivos.length]);
    const ventanas = [partidas, objetivos].map((fuente, i) =>
      fuente.slice(windows[i].skip, windows[i].skip + windows[i].take),
    );

    const pagina = historyFeedPage(ventanas, {
      offset,
      pageSize: 2,
      compare: comparador,
    }).map((fila) => fila.id);

    expect(pagina).toEqual(feed.slice(3, 5));
  });

  it("recorrer todas las páginas no repite ni pierde ninguna fila", () => {
    // Empates de fecha a propósito, y las dos clases mezcladas: es la peor combinación para
    // las ventanas, porque los objetivos pueden ir intercalados entre las partidas.
    const partidas = [
      partida("m1", T2),
      partida("m2", T2),
      partida("m3", T1),
      partida("m4", T1),
      partida("m5", T1),
    ];
    const objetivos = [objetivo("o1", T2), objetivo("o2", T2), objetivo("o3", T1)];
    const fuentes = [partidas, objetivos];

    const feed = [...partidas, ...objetivos].sort(comparador).map((fila) => fila.id);

    for (const pageSize of [1, 2, 3, 7]) {
      const pageCount = Math.ceil(feed.length / pageSize);
      const recorrido: string[] = [];

      for (let page = 1; page <= pageCount; page += 1) {
        const skip = (page - 1) * pageSize;
        const { windows, offset } = historyFeedWindows(
          skip,
          pageSize,
          fuentes.map((fuente) => fuente.length),
        );
        const ventanas = fuentes.map((fuente, i) =>
          [...fuente]
            .sort(comparador)
            .slice(windows[i].skip, windows[i].skip + windows[i].take),
        );

        recorrido.push(
          ...historyFeedPage(ventanas, {
            offset,
            pageSize,
            compare: comparador,
          }).map((fila) => fila.id),
        );
      }

      expect(recorrido).toEqual(feed);
      expect(new Set(recorrido).size).toBe(feed.length);
    }
  });

  it("las ventanas reproducen la página exacta con empates de fecha y claves repetidas", () => {
    // Tres fuentes con instantes repetidos dentro y entre ellas, y con ids de objetivo que
    // se repiten: es el caso que obliga al desempate del comparador y el que más puede
    // descolocar una ventana calculada solo con los totales.
    const fuentes = [
      [
        partida("m1", T1),
        partida("m2", T1),
        partida("m3", T2),
        partida("m4", T2),
        partida("m5", T2),
        partida("m6", T3),
        partida("m7", T3),
        partida("m8", T4),
      ],
      [
        objetivoDe("objective:o1:1", T1, "o1"),
        objetivoDe("objective:o1:2", T1, "o1"),
        objetivoDe("objective:o2:1", T2, "o2"),
        objetivoDe("objective:o2:2", T2, "o2"),
        objetivoDe("objective:o3:1", T3, "o3"),
        objetivoDe("objective:o3:2", T3, "o3"),
      ],
      [
        liderazgo("lead:rey:GAINED:11:1", T1, "rey", "GAINED"),
        liderazgo("lead:rey:LOST:12:1", T1, "rey", "LOST"),
        liderazgo("lead:rey:GAINED:11:2", T2, "rey", "GAINED"),
        liderazgo("lead:loco:GAINED:13", T2, "loco", "GAINED"),
        liderazgo("lead:loco:LOST:14", T4, "loco", "LOST"),
      ],
    ];

    const ordenadas = fuentes.map((fuente) => [...fuente].sort(comparador));
    const feed = ordenadas.flat().sort(comparador).map((fila) => fila.id);

    expect(new Set(feed).size).toBe(feed.length);

    for (const pageSize of [1, 2, 3, 5, 7]) {
      const pageCount = Math.ceil(feed.length / pageSize);
      const recorrido: string[] = [];

      // Una página más allá del final: tiene que salir vacía y no repetir nada.
      for (let page = 1; page <= pageCount + 1; page += 1) {
        const skip = (page - 1) * pageSize;
        const { windows, offset } = historyFeedWindows(
          skip,
          pageSize,
          ordenadas.map((fuente) => fuente.length),
        );
        const ventanas = ordenadas.map((fuente, i) =>
          fuente.slice(windows[i].skip, windows[i].skip + windows[i].take),
        );

        const pagina = historyFeedPage(ventanas, {
          offset,
          pageSize,
          compare: comparador,
        }).map((fila) => fila.id);

        expect(pagina).toEqual(feed.slice(skip, skip + pageSize));
        recorrido.push(...pagina);
      }

      expect(recorrido).toEqual(feed);
      expect(new Set(recorrido).size).toBe(feed.length);
    }
  });

  it("respeta el comparador que se le pasa, sea cual sea el eje", () => {
    const partidas = [partida("m1", T2), partida("m2", T2)];
    const objetivos = [objetivo("o1", T2)];

    // Un eje inventado para la prueba: solo la clave, en ascendente. Lo que se comprueba es
    // que la página sale ordenada con **ese** comparador y no con el orden natural.
    const porClave = (a: Fila, b: Fila) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

    const pagina = historyFeedPage([partidas, objetivos], {
      offset: 0,
      pageSize: 3,
      compare: porClave,
    }).map((fila) => fila.id);

    expect(pagina).toEqual(["m1", "m2", "o1"]);
  });

  it("una página pedida más allá del feed sale vacía, no con filas de rebote", () => {
    const objetivos = [objetivo("o1", T2)];
    const { windows, offset } = historyFeedWindows(9, 5, [0, objetivos.length]);
    const ventanas = [[], objetivos].map((fuente, i) =>
      fuente.slice(windows[i].skip, windows[i].skip + windows[i].take),
    );

    expect(historyFeedPage(ventanas, { offset, pageSize: 5, compare: comparador })).toEqual([]);
  });
});
