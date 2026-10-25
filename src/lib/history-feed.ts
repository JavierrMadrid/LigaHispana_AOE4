import "server-only";

/**
 * El feed mezclado del historial: las piezas puras que comparten el panel y la web.
 *
 * El feed es el mismo en las dos pantallas —victorias clasificatorias, objetivos
 * cumplidos y cambios de poseedor, mezclados en un solo listado paginado en servidor y
 * de lo más reciente a lo más antiguo—, así que la aritmética que decide **qué ventana de
 * cada fuente hay que traer** y **cómo se recorta la página** no puede vivir en una sola
 * de ellas. Vivía en `src/lib/admin.ts` y sale aparte cuando el historial público
 * (`/historial`, `getPointHistory()` en `src/lib/public.ts`) empieza a paginar el mismo
 * feed.
 *
 * Lo que **no** es común se queda en cada pantalla: el desempate por clave del panel
 * (`historyComparator()`), el orden fijo de la web (`comparePointHistory()`) y las
 * consultas. Aquí solo está lo que tiene que decir lo
 * mismo en las dos, porque una divergencia no se vería en una captura: se vería como
 * una fila que sale dos veces o que no sale, y solo al recorrer el historial entero.
 */

/**
 * Lo mínimo para ordenar una fila del feed: su instante y de qué clase es.
 *
 * La clase se lee de `objective` (`null` = partida), y no de un `kind` aparte, por el
 * mismo motivo que en las filas del panel: un segundo discriminante que nadie mantiene
 * en sincronía con el primero es una forma de que las dos clases se contradigan.
 */
export type HistoryFeedRow = {
  /**
   * La fecha de la fila, y por lo que se ordena el feed: `Match.startedAt` en una
   * partida, `ObjectiveEvent.achievedAt` en un logro cumplido y `ObjectiveLeadEvent.at`
   * en un cambio de poseedor.
   */
  startedAt: Date;
  /** `null` en una partida; no `null` en un objetivo cumplido. */
  objective: object | null;
};

/**
 * El orden natural del feed: la fecha descendente y, a igual instante, la partida antes
 * que el objetivo.
 *
 * No es un orden total, y por eso es `compare` y no `Comparator`: devuelve `0` cuando
 * las dos filas comparten instante y clase, y quien lo use **tiene que** completar el
 * desempate con la clave de su clase (`Match.id`/`gameId` en el panel, la clave de la
 * fila en la web). Sin ese desempate, dos filas del mismo instante pueden salir en
 * cualquier orden entre sí y una página puede repetir o perder filas de la anterior.
 *
 * La partida va delante del objetivo a propósito: casi siempre es la fila que explica el
 * hito, y así se lee mejor. Y la convención es la de un comparador descendente —un
 * número negativo significa "a va antes"—, para que el que ordene al revés solo tenga
 * que multiplicar por `-1` (ver `historyComparator()`).
 */
export function compareFeedInstants(a: HistoryFeedRow, b: HistoryFeedRow): number {
  const porFecha = b.startedAt.getTime() - a.startedAt.getTime();

  if (porFecha !== 0) {
    return porFecha;
  }

  const aEsPartida = a.objective === null;

  if (aEsPartida === (b.objective === null)) {
    return 0;
  }

  return aEsPartida ? -1 : 1;
}

/** Ventana de una fuente: cuántas filas saltar y cuántas traer. */
export type HistoryFeedWindow = { skip: number; take: number };

/**
 * La ventana que hay que pedir a cada fuente para servir una página del feed.
 *
 * `totals[i]` es el número de filas de la fuente `i` **después de aplicar los filtros**,
 * y no una estimación: la exactitud de la aritmética depende de que el recuento y la
 * consulta vean lo mismo. Devuelve, en el mismo orden, la ventana de cada fuente y
 * `offset`, el índice del inicio de la página dentro de la **unión ordenada** de las
 * ventanas. Quien llama pide cada ventana con `skip`/`take`, concatena, ordena con el
 * comparador y recorta `[offset, offset + pageSize)`.
 *
 * ## La aritmética
 *
 * Sea `total` la suma de las fuentes. Una fila de la fuente `i` no puede tener delante
 * más de `total - totals[i]` filas de las demás, así que si su índice dentro de la fuente
 * es `j`, su posición en el feed está entre `j` y `j + (total - totals[i])`. Una fila de
 * la página empieza en la posición `skip` o después, luego `j >= skip - (total -
 * totals[i])`; las primeras `start = max(0, skip - others)` filas de la fuente son
 * **seguro** anteriores a la página y se pueden saltar. Y como la página termina antes de
 * `skip + pageSize`, tampoco hace falta nada a partir de `min(totals[i], skip +
 * pageSize)` en cada fuente.
 *
 * `offset` es `skip` menos las filas que se han saltado. Todas las filas saltadas van
 * antes de la página, así que las que faltan para llegar a `skip` son las que quedan
 * antes de ella dentro de las ventanas; de ahí el índice. La unión conserva el orden del
 * feed porque cada fuente llega ordenada con el mismo comparador. Por eso la ventana es
 * **exacta** y no aproximada: con los recuentos reales, la unión contiene la página
 * entera y no se cuela ninguna fila de fuera.
 *
 * **No depende del eje del orden**: solo cuenta cuántas filas de las demás fuentes caben
 * en las `skip` posiciones anteriores. Lo que sí necesita cualquier eje es que el
 * comparador sea un orden total y que todas las fuentes lleguen ya ordenadas con él.
 *
 * Exportado para `npm run verify:sync`, que pagina el feed entero con esta aritmética y
 * comprueba que ninguna fila se repite ni se pierde.
 */
export function historyFeedWindows(
  skip: number,
  pageSize: number,
  totals: readonly number[],
): { windows: HistoryFeedWindow[]; offset: number } {
  const total = totals.reduce((sum, n) => sum + n, 0);
  const end = Math.min(total, skip + pageSize);
  let omitted = 0;

  const windows = totals.map((sourceTotal) => {
    const others = total - sourceTotal;
    const start = Math.min(sourceTotal, Math.max(0, skip - others));
    omitted += start;

    return { skip: start, take: Math.max(0, Math.min(sourceTotal, end) - start) };
  });

  return { windows, offset: skip - omitted };
}

/**
 * La página del feed: el merge de las ventanas y el recorte.
 *
 * `sources` son las ventanas ya recortadas por `historyFeedWindows()`, en el mismo orden
 * de fuentes con el que se calcularon. Se concatenan y se ordenan; `offset` es el índice
 * del inicio de la página dentro de esa unión (ver `historyFeedWindows()`).
 *
 * El comparador lo pasa quien llama porque el eje es suyo: el panel ordena por fecha en
 * los dos sentidos y la web siempre de lo más reciente a lo más antiguo. Lo que **no**
 * puede es ser parcial
 * (ver `compareFeedInstants()`): el merge ordena la concatenación de las fuentes, así que
 * con un orden que dejara empates, dos páginas consecutivas podrían solaparse.
 */
export function historyFeedPage<T extends HistoryFeedRow>(
  sources: readonly (readonly T[])[],
  options: { offset: number; pageSize: number; compare: (a: T, b: T) => number },
): T[] {
  return sources
    .flat()
    .sort(options.compare)
    .slice(options.offset, options.offset + options.pageSize);
}
