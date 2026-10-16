import "server-only";

/**
 * El feed mezclado del historial: las piezas puras que comparten el panel y la web.
 *
 * El feed es el mismo en las dos pantallas —victorias clasificatorias y objetivos
 * cumplidos, mezclados en un solo listado paginado en servidor y de lo más reciente a
 * lo más antiguo—, así que la aritmética que decide **qué ventana de cada mitad hay que
 * traer** y **cómo se recorta la página** no puede vivir en una sola de ellas. Vivía en
 * `src/lib/admin.ts` y sale aparte cuando el historial público (`/historial`,
 * `getPointHistory()` en `src/lib/public.ts`) empieza a paginar el mismo feed.
 *
 * Lo que **no** es común se queda en cada pantalla: el orden por resultado y el
 * desempate por clave del panel (`historyComparator()`), el orden fijo de la web
 * (`comparePointHistory()`) y las consultas. Aquí solo está lo que tiene que decir lo
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
   * partida y `ObjectiveEvent.achievedAt` en un objetivo cumplido.
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

/**
 * El hueco que hay que traer de partidas para servir una página del feed mezclado.
 *
 * Con `skip` el desplazamiento de la página **en el feed** y `eventosAntes` los
 * objetivos que pasan el filtro (los que van delante de la página en el peor caso):
 *
 * - `skipPartidas`: de dónde se leen las partidas. En el peor caso, los `eventosAntes`
 *   objetivos van todos antes de la página, así que la primera fila de la página está,
 *   como mucho, en la posición `skip - eventosAntes` de la lista de partidas. Antes de
 *   ese punto no hace falta traer nada.
 * - `takePartidas`: cuántas. `skip + pageSize - skipPartidas`, y **no** `pageSize` a
 *   secas: si la página tiene objetivos intercalados, con `pageSize` saldrían menos
 *   filas de las que la página pide.
 * - `desde`: el índice de la lista combinada que corresponde al inicio de la página. La
 *   combinada empieza en la partida número `skipPartidas`, así que lo que se ha dejado
 *   atrás son `skipPartidas` filas; con `skip < eventosAntes` no se ha saltado ninguna
 *   partida y el índice es `skip` directamente.
 *
 * **No depende del eje del orden**, y por eso el orden por resultado del panel no
 * necesita otro hueco: solo cuenta cuántas filas del otro lado del merge caben en las
 * `skip` posiciones anteriores. Lo que sí necesita cualquier eje es que el comparador
 * sea un orden total y que las dos mitades lleguen en ese mismo orden.
 *
 * Exportado para `npm run verify:sync`, que pagina el feed entero con esta aritmética y
 * comprueba que ninguna fila se repite ni se pierde.
 */
export function historyHole(
  skip: number,
  pageSize: number,
  eventosAntes: number,
): { skipPartidas: number; takePartidas: number; desde: number } {
  const skipPartidas = Math.max(0, skip - eventosAntes);

  return {
    skipPartidas,
    takePartidas: skip + pageSize - skipPartidas,
    desde: skip - skipPartidas,
  };
}

/**
 * La página del feed: el hueco de `historyHole()`, el merge y el recorte.
 *
 * `partidas` es la ventana que ha traído la consulta (a partir de
 * `historyHole().skipPartidas` y con `takePartidas` filas) y `objetivos` van **todos**:
 * son pocos —un objetivo por jugador y por objetivo del catálogo— y hace falta su
 * recuento para saber cuántas filas del otro lado caben delante de la página.
 *
 * El comparador lo pasa quien llama porque el eje es suyo: el panel puede ordenar por
 * fecha o por resultado y la web siempre por fecha. Lo que **no** puede es ser parcial
 * (ver `compareFeedInstants()`): el merge ordena la concatenación de las dos mitades, así
 * que con un orden que dejara empates, dos páginas consecutivas podrían solaparse.
 */
export function historyFeedPage<T extends HistoryFeedRow>(
  partidas: readonly T[],
  objetivos: readonly T[],
  options: { skip: number; pageSize: number; compare: (a: T, b: T) => number },
): T[] {
  // `desde` es el índice de la lista combinada que corresponde a la posición `skip` del
  // feed, según el mismo docblock de `historyHole()`.
  const { desde } = historyHole(options.skip, options.pageSize, objetivos.length);

  return [...partidas, ...objetivos].sort(options.compare).slice(desde, desde + options.pageSize);
}
