import "server-only";

import { readInstant } from "@/lib/ranked-match";

/**
 * Los parámetros de la URL de una lectura paginada, y el ajuste de la página.
 *
 * Vivía dentro de `src/lib/admin.ts`, en su sección de filtros compartidos, y sale
 * aparte desde que el **historial público** (`/historial`, `getPointHistory()` en
 * `src/lib/public.ts`) necesita exactamente lo mismo: leer de la URL un jugador, un
 * rango de fechas y una página, con los mismos bordes y las mismas reglas. La
 * alternativa era una segunda copia de `readDateBound()`, que es justo donde una
 * divergencia (un `to` que incluyera el día en una pantalla y no en la otra) no se
 * notaría hasta que alguien comparara las dos tablas.
 *
 * Se llama "de la URL" y no "del historial" porque no es del historial: las alertas del
 * panel usan los mismos filtros de fecha, y `readBoundedInt()` sirve a las tres listas
 * paginadas. Lo que sí es solo del panel —`Player.id` frente al `profileId` público, y
 * el orden que elige la cabecera de una tabla— se queda en `src/lib/admin.ts`.
 *
 * Dos reglas rigen lo de aquí, y las dos venían del panel:
 *
 * - **Un valor que no se entiende es ausencia, no error.** `?playerId=noSoyUnCuid`,
 *   `?to=2026-13-45` o `?pageSize=inventado` se comportan como si no estuvieran
 *   escritos. Una URL manipulada no rompe la página y, sobre todo, no hace creer que
 *   un filtro deja cero filas cuando en realidad no está filtrando nada.
 * - **El texto de un parámetro es un texto, no una decisión.** Un parámetro repetido
 *   (`?from=a&from=b`) se queda con el primero, y un vacío es ausencia: quien decide
 *   qué significa cada valor es la lectura que lo pide, no este módulo.
 */

/**
 * Un valor de `searchParams`, tal como lo entrega Next.
 *
 * Es `string | string[] | undefined` porque `?playerId=a&playerId=b` es una URL
 * válida, así que el tipo solo no basta: todo lo que llega de aquí se valida antes
 * de tocar la base de datos.
 */
export type QueryParam = string | string[] | null | undefined;

/**
 * Un parámetro de la URL, reducido a un único texto.
 *
 * Un parámetro repetido (`?playerId=a&playerId=b`) se queda con el primero en vez
 * de fallar la página: es una URL válida y descartar el segundo no cambia lo que
 * quien la escribió quería ver. Un vacío sí es ausencia de filtro.
 */
export function readSingleParam(value: QueryParam): string | null {
  if (Array.isArray(value)) {
    return readSingleParam(value[0]);
  }

  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();

  return trimmed === "" ? null : trimmed;
}

/** Filas por página que se piden por defecto. */
export const DEFAULT_PAGE_SIZE = 25;

/**
 * Tope de `pageSize`.
 *
 * El parámetro viene de la URL, así que sin tope un `?pageSize=100000` sería una
 * consulta que trae la tabla entera y la manda al navegador dentro del *payload* de
 * RSC. 100 filas dan de sobra para una tabla y dejan el histórico navegable.
 */
export const MAX_PAGE_SIZE = 100;

/** Entero de un parámetro, acotado a `[min, max]`; lo que no vale, es `fallback`. */
export function readBoundedInt(
  value: QueryParam,
  { min, max, fallback }: { min: number; max: number; fallback: number },
): number {
  const raw = readSingleParam(value);

  if (raw === null || !/^\d{1,6}$/.test(raw)) {
    return fallback;
  }

  const parsed = Number(raw);

  return Math.min(Math.max(parsed, min), max);
}

/**
 * Filas de una lectura paginada, con la paginación ya resuelta.
 *
 * No lleva el orden **a propósito**: cada lista publica el suyo —`AdminPage` le añade el
 * `sort` efectivo de la tabla— porque un tipo con "el orden" mezclado obligaría al
 * historial público, que no tiene selector de orden, a declarar uno igualmente.
 */
export type PagedRows<T> = {
  rows: T[];
  /** Filas que cumplen el filtro, sin paginar: de ahí sale `pageCount`. */
  total: number;
  /** Página devuelta, acotada a `[1, pageCount]`. */
  page: number;
  pageSize: number;
  /** Páginas que hay con este filtro; `0` si no hay ninguna fila. */
  pageCount: number;
};

/**
 * Resuelve una página de un listado paginado.
 *
 * `load` hace **las dos** consultas en paralelo (filas y total) y devuelve la
 * `page` que se le pide. Encapsularlo aquí evita repetir el mismo cálculo en las
 * lecturas paginadas, y sobre todo evita el error de contar una página y traer las
 * filas de otra.
 *
 * Se ajusta la página al rango real (una URL que pide la 7 con un filtro que solo
 * tiene dos páginas devuelve la última con filas): una tabla vacía con "página 7 de
 * 2" desconcierta más que devolver directamente lo que hay. El ajuste solo repite
 * la consulta cuando hace falta, porque el camino normal es una sola pasada.
 */
export async function paginate<T>(
  load: (page: number) => Promise<{ rows: T[]; total: number }>,
  { page, pageSize }: { page: number; pageSize: number },
): Promise<PagedRows<T>> {
  const first = await load(page);
  const pageCount = Math.ceil(first.total / pageSize);
  const current = pageCount === 0 ? 1 : Math.min(page, pageCount);
  const { rows, total } = current === page ? first : await load(current);

  return { rows, total, page: current, pageSize, pageCount };
}

/** Un día en milisegundos, para resolver el `to` de una fecha suelta. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** Fecha suelta `YYYY-MM-DD`, que es lo que produce un `<input type="date">`. */
const DAY_PATTERN = /^(\d{4}-\d{2}-\d{2})$/;

/**
 * Un límite del filtro de fechas, ya resuelto a instante.
 *
 * Admite las dos formas que la interfaz tiene a mano: un instante con zona
 * explícita —el mismo criterio estricto que el ruleset, `readInstant`, que rechaza
 * `"2026-09-15T00:00:00"` porque se interpretaría en hora local— o una fecha suelta,
 * que se resuelve a medianoche UTC de ese día.
 *
 * La fecha suelta se resuelve distinto en cada borde, y es lo que hace que "del 1
 * al 30" incluya el día 30 entero:
 *
 * - `from`: las `00:00:00.000Z` de ese día, **inclusivo**.
 * - `to`: las `00:00:00.000Z` del día **siguiente**, con un filtro `< to`: el día
 *   que escribió quien filtró queda dentro y el siguiente, fuera.
 *
 * Un instante con zona se usa tal cual, sin desplazarlo. Cualquier otra cosa —un
 * `ayer`, un `2026-13-45`, un instante sin zona— se ignora y ese filtro no se
 * aplica: una URL manipulada se comporta como si el filtro no estuviera, en vez de
 * romper la página con un error que no sabe explicar nadie.
 */
function readDateBound(value: QueryParam, bound: "from" | "to"): Date | null {
  const raw = readSingleParam(value);

  if (raw === null) {
    return null;
  }

  const instant = readInstant(raw);

  if (instant !== null) {
    return instant;
  }

  const day = DAY_PATTERN.exec(raw);

  if (day === null) {
    return null;
  }

  const inicio = readInstant(`${day[1]}T00:00:00.000Z`);

  // `Date.parse` no rechaza los días que no existen: `"2026-02-31T00:00:00.000Z"`
  // rueda a `2026-03-03`. La ida y la vuelta es lo que los descarta, y con ello un
  // filtro escrito a mano con una fecha imposible se trata como ausencia de filtro
  // en vez de como un rango desplazado tres días.
  if (inicio === null || inicio.toISOString().slice(0, 10) !== day[1]) {
    return null;
  }

  return bound === "from" ? inicio : new Date(inicio.getTime() + DAY_MS);
}

/**
 * Rango de fechas de un filtro, ya validado y listo para una columna `DateTime`.
 *
 * Es un tipo propio y no el `DateTimeFilter` de Prisma a propósito: lo que sale de
 * aquí son dos comparadores opcionales, y el filtro los mete dentro de la columna
 * concreta (`Match.startedAt`, `ObjectiveEvent.achievedAt` o `Alert.createdAt`) junto
 * con lo que ya traiga el resto de condiciones.
 *
 * En el historial, los dos límites son los **mismos** para las dos clases de fila: el
 * filtro de la pantalla es un rango de fechas, no "fechas de partidas". Por eso se
 * resuelve una vez y se reparte.
 */
export type DateRange = { gte?: Date; lt?: Date };

/**
 * El rango de fechas de un filtro, ya validado.
 *
 * Vive aquí porque lo comparten el historial (panel y público) y las alertas, con los
 * **mismos** bordes inclusivo y exclusivo: un `?to=2026-09-30` tiene que incluir el día
 * 30 entero en las tres tablas, y sería una sorpresa que en una significara algo
 * distinto.
 */
export function dateRangeWhere(from: QueryParam, to: QueryParam): DateRange {
  const desde = readDateBound(from, "from");
  const hasta = readDateBound(to, "to");

  return {
    ...(desde === null ? {} : { gte: desde }),
    ...(hasta === null ? {} : { lt: hasta }),
  };
}

/**
 * ¿Ha quedado algún límite puesto?
 *
 * Para no meter `{ createdAt: {} }` en un `where`: un filtro de rango vacío no filtra
 * nada, pero obligaría a comprobar en cada sitio si un `DateTimeFilter` sin
 * comparadores significa "cualquier fecha" o es un error de Prisma.
 */
export function hasDateBounds(rango: DateRange): boolean {
  return rango.gte !== undefined || rango.lt !== undefined;
}
