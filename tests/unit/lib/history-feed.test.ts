import { describe, expect, it } from "vitest";

import {
  compareFeedInstants,
  historyFeedPage,
  historyHole,
  type HistoryFeedRow,
} from "@/lib/history-feed";

/**
 * El feed mezclado del historial: el orden natural y la aritmética del merge.
 *
 * Son las dos piezas que comparten el panel (`/admin/historial`) y el historial público
 * (`/historial`), y las dos son puras: se comprueban con filas sintéticas, sin base de
 * datos. Lo que **no** se puede comprobar aquí es que cada mitad llegue de su consulta ya
 * ordenada como el comparador: eso es Prisma y sale en `npm run verify:sync` (que pagina
 * el feed entero con `historyHole()` y comprueba que ninguna fila se repite ni se pierde).
 */

/**
 * Un comparador **total** de prueba, con la forma de los de verdad: fecha descendente, la
 * partida antes que el objetivo y la clave de la clase como desempate final.
 *
 * El desempate no es un detalle de la prueba: sin él, `Array.prototype.sort` deja las filas
 * empatadas en el orden en que llegaron y el recorrido de páginas pasaría el test por
 * casualidad, que es justo lo que no se quiere demostrar.
 */
function comparador(a: HistoryFeedRow & { id: string }, b: HistoryFeedRow & { id: string }): number {
  const porInstante = compareFeedInstants(a, b);

  if (porInstante !== 0) {
    return porInstante;
  }

  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** Una partida del feed. */
function partida(id: string, fecha: string): HistoryFeedRow & { id: string } {
  return { id, startedAt: new Date(fecha), objective: null };
}

/** Un objetivo cumplido del feed: nunca comparte clave con una partida. */
function objetivo(id: string, fecha: string): HistoryFeedRow & { id: string } {
  return { id, startedAt: new Date(fecha), objective: { id } };
}

const T1 = "2026-09-01T10:00:00.000Z";
const T2 = "2026-09-02T10:00:00.000Z";

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

describe("historyHole", () => {
  it("sin objetivos por delante, la página empieza donde empieza el feed", () => {
    expect(historyHole(0, 25, 0)).toEqual({ skipPartidas: 0, takePartidas: 25, desde: 0 });
    expect(historyHole(50, 25, 0)).toEqual({ skipPartidas: 50, takePartidas: 25, desde: 0 });
  });

  it("si los objetivos caben en lo saltado, no se ha saltado ninguna partida", () => {
    // 10 objetivos y se pide la tercera página de 25: los 10 van delante, pero ninguna
    // partida ha quedado atrás.
    expect(historyHole(50, 25, 10)).toEqual({ skipPartidas: 40, takePartidas: 35, desde: 10 });
    expect(historyHole(5, 25, 10)).toEqual({ skipPartidas: 0, takePartidas: 30, desde: 5 });
  });

  it("trae una partida de más por cada objetivo que pueda ir intercalado", () => {
    // En el peor caso todos los objetivos van antes de la página: la primera partida de la
    // página está en `skip - eventosAntes` y hay que seguir hasta `skip + pageSize - 1`.
    for (const eventosAntes of [1, 3, 40]) {
      const hole = historyHole(100, 25, eventosAntes);

      expect(hole.skipPartidas + hole.takePartidas).toBe(125);
      expect(hole.desde).toBe(100 - hole.skipPartidas);
    }
  });

  it("nunca pide partidas de índices negativos", () => {
    expect(historyHole(0, 10, 5)).toEqual({ skipPartidas: 0, takePartidas: 10, desde: 0 });
  });
});

describe("historyFeedPage", () => {
  it("la página es una ventana del feed, no una muestra", () => {
    const partidas = [partida("m3", T2), partida("m2", T1), partida("m1", T1)];
    const objetivos = [objetivo("o1", T2), objetivo("o2", T1)];

    const feed = [...partidas, ...objetivos].sort(comparador).map((fila) => fila.id);
    const pagina = historyFeedPage(partidas, objetivos, {
      skip: 2,
      pageSize: 2,
      compare: comparador,
    }).map((fila) => fila.id);

    expect(pagina).toEqual(feed.slice(2, 4));
  });

  it("recorrer todas las páginas no repite ni pierde ninguna fila", () => {
    // Empates de fecha a propósito, y las dos clases mezcladas: es la peor combinación para
    // el hueco, porque los objetivos pueden ir intercalados entre las partidas.
    const partidas = [
      partida("m1", T2),
      partida("m2", T2),
      partida("m3", T1),
      partida("m4", T1),
      partida("m5", T1),
    ];
    const objetivos = [objetivo("o1", T2), objetivo("o2", T2), objetivo("o3", T1)];

    const feed = [...partidas, ...objetivos].sort(comparador).map((fila) => fila.id);

    for (const pageSize of [1, 2, 3, 7]) {
      const pageCount = Math.ceil(feed.length / pageSize);
      const recorrido: string[] = [];

      for (let page = 1; page <= pageCount; page += 1) {
        const skip = (page - 1) * pageSize;
        // La ventana de partidas que traería la consulta con el hueco del merge.
        const { skipPartidas, takePartidas } = historyHole(skip, pageSize, objetivos.length);
        const ventana = [...partidas]
          .sort(comparador)
          .slice(skipPartidas, skipPartidas + takePartidas);

        recorrido.push(
          ...historyFeedPage(ventana, objetivos, {
            skip,
            pageSize,
            compare: comparador,
          }).map((fila) => fila.id),
        );
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
    const porClave = (a: HistoryFeedRow & { id: string }, b: HistoryFeedRow & { id: string }) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

    const pagina = historyFeedPage(partidas, objetivos, {
      skip: 0,
      pageSize: 3,
      compare: porClave,
    }).map((fila) => fila.id);

    expect(pagina).toEqual(["m1", "m2", "o1"]);
  });

  it("una página pedida más allá del feed sale vacía, no con filas de rebote", () => {
    // Es lo que devolvería una consulta con `skipPartidas` por encima del final: la ventana
    // de partidas viene vacía y lo único que queda es el objetivo, que cae fuera del recorte.
    const objetivos = [objetivo("o1", T2)];

    expect(
      historyFeedPage([], objetivos, { skip: 9, pageSize: 5, compare: comparador }),
    ).toEqual([]);
  });
});
