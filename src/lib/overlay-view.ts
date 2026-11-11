import type {
  OverlayClasificacion,
  OverlayEventoObjetivo,
  OverlayEventoObjetivoListado,
  OverlayObjetivo,
  OverlayParticipante,
} from "@/lib/overlay-api";

/**
 * La vista del overlay: todo lo que se decide **sin** base de datos ni DOM.
 *
 * El overlay pinta con tres piezas que llegan de la API —las filas de la
 * clasificación, el catálogo de objetivos y el feed de eventos— y aquí se
 * resuelven las preguntas de presentación que no dependen de React: cuántos
 * puntos lleva una fila, qué alias y país toca a cada vecino, qué eventos son
 * "recientes" y positivos, cómo se compone la unidad de un progreso o cuánto se
 * espera tras un fallo de red.
 *
 * Es un módulo **puro** a propósito: no importa valores de `@/lib/overlay-api`
 * (solo tipos), no lee el reloj, ni `localStorage`, ni la red. Así se puede
 * probar en `tests/unit/lib/overlay-view.test.ts` sin montar nada y se puede
 * ejecutar en el cliente sin arrastrar el árbol `server-only` de la API.
 */

/* -------------------------------------------------------------------------- */
/* Tipos                                                                       */
/* -------------------------------------------------------------------------- */

/** Una fila del ranking del overlay, ya resuelta contra el mapa de participantes. */
export type OverlayRankingRow = {
  id: string;
  posicion: number;
  alias: string;
  pais: string | null;
  avatarUrl: string | null;
  puntos: number;
  /** ¿Es la fila del participante que se está retransmitiendo? */
  isRequested: boolean;
};

/** Un evento del overlay con el objetivo resuelto, listo para pintar. */
export type OverlayEventView = {
  /** Clave única del evento (`<objetivoId>@<fechahora>`), para deduplicar y animar. */
  key: string;
  objetivoId: string;
  /** Nombre del objetivo; el id si el catálogo no lo conoce. */
  nombre: string;
  descripcion: string;
  iconoUrl: string;
  /** Métrica del objetivo (`victorias`, `dias`…); cadena vacía si falta. */
  metrica: string;
  tipo: OverlayEventoObjetivo["tipo"];
  /** ISO 8601 con zona, tal y como lo publica la API. */
  fechahora: string;
  progresoPropio: number;
  /** Valor del nuevo poseedor en un `perdido`; `null` en el resto. */
  progresoAjeno: number | null;
  repeticion: number | null;
  maxProgreso: number | null;
  volatil: boolean;
  repetible: boolean;
  /** Premio del catálogo; en las metas y competiciones, lo que pagan de una vez. */
  puntos: number;
  /** Lo que paga por unidad un repetible (`victorias`, `imparable`); `null` si no. */
  puntosPorUnidad: number | null;
};

/** Un participante del selector de `/overlay` (el configurador), no del ranking. */
export type OverlayConfiguratorParticipant = {
  id: string;
  alias: string;
  rank: number;
  points: number;
  pais: string | null;
  avatarUrl: string | null;
};

/** Fila de clasificación de la que sale un participante del configurador. */
export type OverlayConfiguratorSource = {
  profileId: number;
  name: string;
  rank: number;
  points: number;
  country: string | null;
  avatarUrl: string | null;
};

/* -------------------------------------------------------------------------- */
/* Ranking                                                                     */
/* -------------------------------------------------------------------------- */

/** El total de una fila: competiciones más logros. */
export function overlayTotalPoints(row: { puntos: { volatiles: number; permanentes: number } }): number {
  return row.puntos.volatiles + row.puntos.permanentes;
}

/**
 * Filas de la clasificación → filas del ranking del overlay.
 *
 * Conserva el orden que publica la API (posición y desempate incluidos) y
 * resuelve alias, país y avatar desde el mapa de `/participantes`. Si un id no
 * está en el mapa —la foto de participantes es tolerante a fallos— el alias cae
 * al propio id y los datos opcionales a `null`: el ranking sigue pintándose con
 * lo que haya.
 */
export function overlayRankingRows(
  rows: readonly OverlayClasificacion[],
  participants: ReadonlyMap<string, OverlayParticipante>,
  requestedId: string,
): OverlayRankingRow[] {
  return rows.map((row) => {
    const participant = participants.get(row.id);

    return {
      id: row.id,
      posicion: row.posicion,
      alias: participant?.alias ?? row.id,
      pais: participant?.pais ?? null,
      avatarUrl: participant?.avatar_url ?? null,
      puntos: overlayTotalPoints(row),
      isRequested: row.id === requestedId,
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Eventos                                                                     */
/* -------------------------------------------------------------------------- */

/** La clave de un evento, la misma que usan el mapa, el `Set` de vistos y React. */
export function overlayEventKey(
  objetivoId: string,
  event: { fechahora: string },
): string {
  return `${objetivoId}@${event.fechahora}`;
}

/**
 * Un evento y su objetivo → la vista que pinta el overlay.
 *
 * Tolera un objetivo ausente (el catálogo no cargó o la organización lo apagó
 * entre dos consultas): se usa el id como nombre y valores neutros, porque un
 * evento huérfano sigue siendo una noticia y esconderlo sería peor que pintarlo
 * sin icono.
 */
export function overlayEventView(
  objetivoId: string,
  event: OverlayEventoObjetivo,
  objective: OverlayObjetivo | undefined,
): OverlayEventView {
  return {
    key: overlayEventKey(objetivoId, event),
    objetivoId,
    nombre: objective?.nombre ?? objetivoId,
    descripcion: objective?.descripcion ?? "",
    iconoUrl: objective?.icono_url ?? "",
    metrica: objective?.metrica ?? "",
    tipo: event.tipo,
    fechahora: event.fechahora,
    progresoPropio: event.progreso.propio,
    progresoAjeno: event.progreso.ajeno ?? null,
    repeticion: event.repeticion ?? null,
    maxProgreso: objective?.max_progreso ?? null,
    volatil: objective?.volatil ?? false,
    repetible: objective?.repetible ?? false,
    puntos: objective?.puntos ?? 0,
    puntosPorUnidad: objective?.puntos_por_unidad ?? null,
  };
}

/**
 * El mapa de eventos → vistas en orden **ascendente** por instante.
 *
 * A igualdad de instante desempata por id de objetivo ascendente, que es el
 * mismo orden estable que usa la API para la siembra de un recálculo.
 */
export function overlayEventViews(
  events: Readonly<Record<string, OverlayEventoObjetivo>>,
  objectives: ReadonlyMap<string, OverlayObjetivo>,
): OverlayEventView[] {
  return Object.entries(events)
    .map(([objetivoId, event]) => overlayEventView(objetivoId, event, objectives.get(objetivoId)))
    .sort(compareViewsAsc);
}

/** Los últimos eventos positivos de un mapa, sin repetir objetivo. */
export function overlayRecentEventViews(
  events: Readonly<Record<string, OverlayEventoObjetivo>>,
  objectives: ReadonlyMap<string, OverlayObjetivo>,
  limit = 3,
): OverlayEventView[] {
  return recentPositiveViews(overlayEventViews(events, objectives), limit);
}

/** Los últimos eventos positivos del feed de `/eventos`, sin repetir objetivo. */
export function overlayRecentFromFeed(
  feed: readonly OverlayEventoObjetivoListado[],
  objectives: ReadonlyMap<string, OverlayObjetivo>,
  limit = 3,
): OverlayEventView[] {
  return recentPositiveViews(
    feed.map((event) =>
      overlayEventView(event.objetivo_id, event, objectives.get(event.objetivo_id)),
    ),
    limit,
  );
}

/**
 * Los últimos eventos positivos combinando el feed inicial y el mapa vivo.
 *
 * El feed trae la historia reciente de `/eventos` y el mapa lo que ha ido
 * llegando por el sondeo de la clasificación; para cada objetivo se queda el
 * positivo **más reciente** de los dos, así que un `perdido` posterior no borra
 * el último hito que sí se celebró.
 */
export function overlayRecentCombined(
  feed: readonly OverlayEventoObjetivoListado[],
  events: Readonly<Record<string, OverlayEventoObjetivo>>,
  objectives: ReadonlyMap<string, OverlayObjetivo>,
  limit = 3,
): OverlayEventView[] {
  const views = [
    ...feed.map((event) =>
      overlayEventView(event.objetivo_id, event, objectives.get(event.objetivo_id)),
    ),
    ...overlayEventViews(events, objectives),
  ];

  return recentPositiveViews(views, limit);
}

/**
 * Fusiona el mapa de eventos con uno nuevo: `incoming` pisa por objetivo.
 *
 * Es la operación del sondeo, donde la clasificación devuelve el último evento
 * de cada objetivo desde `desde` y ese evento es, por definición, más reciente
 * que el que había.
 */
export function overlayMergeEvents(
  current: Readonly<Record<string, OverlayEventoObjetivo>>,
  incoming: Readonly<Record<string, OverlayEventoObjetivo>>,
): Record<string, OverlayEventoObjetivo> {
  return { ...current, ...incoming };
}

/**
 * Las vistas de los eventos que aún no se habían visto, en orden ascendente.
 *
 * Solo lo que cobra: los objetivos directos en cada avance y las metas y los
 * lideratos al cobrarse de verdad (`overlayAnimates`). Un `perdido` o el avance
 * parcial de una meta se anotan como vistos pero no se encolan ni interrumpen. El
 * recorte se hace **después** de ordenar, para animar primero lo más antiguo de
 * lo nuevo y no perder el orden natural; por defecto no recorta, porque un
 * recálculo puede avanzar muchos objetivos a la vez y todos tienen su animación.
 */
export function overlayNewEventViews(
  seenKeys: ReadonlySet<string>,
  incoming: Readonly<Record<string, OverlayEventoObjetivo>>,
  objectives: ReadonlyMap<string, OverlayObjetivo>,
  limit = Number.POSITIVE_INFINITY,
): OverlayEventView[] {
  return overlayEventViews(incoming, objectives)
    .filter((view) => overlayAnimates(view) && !seenKeys.has(view.key))
    .slice(0, Math.max(0, limit));
}

/** El instante ISO más reciente de un mapa de eventos, o `null` si está vacío. */
export function overlayMaxEventTime(
  events: Readonly<Record<string, OverlayEventoObjetivo>>,
): string | null {
  let maximo: string | null = null;

  for (const event of Object.values(events)) {
    if (maximo === null || compareInstant(event.fechahora, maximo) > 0) {
      maximo = event.fechahora;
    }
  }

  return maximo;
}

/**
 * Hasta cuándo hay que pedir en el siguiente sondeo.
 *
 * Preferencias: el evento más reciente que tengamos (el contrato de `desde` es
 * inclusivo, así que repetirlo no pierde nada), después la fecha del servidor
 * (la cabecera `Date` de la respuesta, que salva el arranque cuando no hay
 * eventos) y, si no hay ninguna, lo que ya se tenía. La fecha del servidor se
 * normaliza a ISO porque `Date` llega en formato HTTP y `desde` exige ISO 8601.
 */
export function overlayPollSince(
  previous: string | null,
  events: Readonly<Record<string, OverlayEventoObjetivo>>,
  serverDate: string | null,
): string | null {
  const fromEvents = overlayMaxEventTime(events);

  if (fromEvents !== null) {
    return fromEvents;
  }

  if (serverDate !== null) {
    const parsed = new Date(serverDate);

    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }

  return previous;
}

/** Espera tras `failures` fallos seguidos: 30 s, 60 s y 120 s con tope. */
export function overlayReconnectDelay(failures: number): number {
  const intento = Math.max(1, Math.trunc(failures));

  return Math.min(30_000 * 2 ** (intento - 1), 120_000);
}

/* -------------------------------------------------------------------------- */
/* Configurador y URL                                                          */
/* -------------------------------------------------------------------------- */

/** Filas de la clasificación → participantes del selector de `/overlay`. */
export function overlayConfiguratorParticipants(
  rows: readonly OverlayConfiguratorSource[],
): OverlayConfiguratorParticipant[] {
  return rows.map((row) => ({
    id: String(row.profileId),
    alias: row.name,
    rank: row.rank,
    points: row.points,
    pais: row.country,
    avatarUrl: row.avatarUrl,
  }));
}

/* -------------------------------------------------------------------------- */
/* Configuración por URL                                                       */
/* -------------------------------------------------------------------------- */

/** Esquina donde se ancla la tarjeta del overlay. */
export type OverlayPosition = "tr" | "tl" | "br" | "bl";

/** Tamaño de la tarjeta del overlay. */
export type OverlaySize = "compacto" | "normal" | "grande";

/** Qué bloques enseña la tarjeta del overlay. */
export type OverlaySections = "ambas" | "ranking" | "objetivos";

/** Las opciones de la tarjeta que viajan en la URL del overlay. */
export type OverlayConfig = {
  posicion: OverlayPosition;
  tamano: OverlaySize;
  secciones: OverlaySections;
  animaciones: boolean;
};

/** Lo que se pinta cuando la URL no dice otra cosa. */
export const DEFAULT_OVERLAY_CONFIG: OverlayConfig = {
  posicion: "tr",
  tamano: "normal",
  secciones: "ambas",
  animaciones: true,
};

const OVERLAY_POSITIONS: readonly OverlayPosition[] = ["tr", "tl", "br", "bl"];
const OVERLAY_SIZES: readonly OverlaySize[] = ["compacto", "normal", "grande"];
const OVERLAY_SECTIONS: readonly OverlaySections[] = ["ambas", "ranking", "objetivos"];

/**
 * Los `searchParams` de la página → la configuración de la tarjeta.
 *
 * Acepta la forma de Next (cadena, lista de cadenas o `undefined`) y se queda
 * con el primer valor si un parámetro viene repetido. Normaliza a minúsculas y
 * recorta espacios porque la URL se escribe a mano desde OBS. Cualquier valor
 * desconocido cae al defecto en lugar de romper: un overlay con una errata en la
 * URL sigue siendo mejor que una pantalla negra en directo.
 */
export function readOverlayConfig(
  params: Readonly<Record<string, string | string[] | undefined>>,
): OverlayConfig {
  return {
    posicion: readEnumParam(params.posicion, OVERLAY_POSITIONS, DEFAULT_OVERLAY_CONFIG.posicion),
    tamano: readEnumParam(params.tamano, OVERLAY_SIZES, DEFAULT_OVERLAY_CONFIG.tamano),
    secciones: readEnumParam(
      params.secciones,
      OVERLAY_SECTIONS,
      DEFAULT_OVERLAY_CONFIG.secciones,
    ),
    animaciones: readBooleanParam(params.animaciones, DEFAULT_OVERLAY_CONFIG.animaciones),
  };
}

/**
 * La configuración de la tarjeta → la query de la URL, sin los valores defecto.
 *
 * Solo se serializa lo que difiere del defecto, para que la URL de un overlay
 * normal siga siendo corta. El orden es fijo —`posicion`, `tamano`, `secciones`,
 * `animaciones`— y `URLSearchParams` no lo altera, así que dos configuraciones
 * iguales producen exactamente la misma cadena.
 */
export function overlayConfigQuery(config: OverlayConfig): string {
  const params = new URLSearchParams();

  if (config.posicion !== DEFAULT_OVERLAY_CONFIG.posicion) {
    params.set("posicion", config.posicion);
  }

  if (config.tamano !== DEFAULT_OVERLAY_CONFIG.tamano) {
    params.set("tamano", config.tamano);
  }

  if (config.secciones !== DEFAULT_OVERLAY_CONFIG.secciones) {
    params.set("secciones", config.secciones);
  }

  if (!config.animaciones) {
    params.set("animaciones", "0");
  }

  return params.toString();
}

/**
 * La URL del overlay de un participante.
 *
 * Con origen devuelve la absoluta (para abrirla desde un panel que corre en otro
 * sitio); sin origen, la relativa del mismo host. Se normaliza la barra final
 * para no acabar en `//overlay`. La configuración solo añade los parámetros que
 * no están en el defecto, así que sin config la URL es la de siempre.
 */
export function overlayPreviewUrl(
  origin: string | null,
  profileId: string,
  config: OverlayConfig = DEFAULT_OVERLAY_CONFIG,
): string {
  const path =
    origin === null
      ? `/overlay/${profileId}`
      : `${origin.replace(/\/+$/, "")}/overlay/${profileId}`;
  const query = overlayConfigQuery(config);

  return query === "" ? path : `${path}?${query}`;
}

/* -------------------------------------------------------------------------- */
/* Textos de evento                                                            */
/* -------------------------------------------------------------------------- */

/** Singular y plural de la unidad de cada métrica conocida. */
const METRIC_UNITS: Readonly<Record<string, readonly [string, string]>> = {
  partidas: ["partida", "partidas"],
  victorias: ["victoria", "victorias"],
  racha: ["victoria seguida", "victorias seguidas"],
  "racha-partidas": ["partida seguida", "partidas seguidas"],
  dias: ["día", "días"],
  civilizaciones: ["civilización", "civilizaciones"],
  mapas: ["mapa", "mapas"],
  subobjetivos: ["subobjetivo", "subobjetivos"],
};

/**
 * La unidad de una métrica en singular o plural.
 *
 * Una métrica desconocida (el catálogo puede crecer antes que este módulo) cae a
 * «progreso»/«progresos», que es lo único cierto que se puede decir de un
 * contador sin unidad conocida.
 */
export function overlayMetricUnit(metrica: string, count: number): string {
  const units = METRIC_UNITS[metrica] ?? (["progreso", "progresos"] as const);

  return count === 1 ? units[0] : units[1];
}

/** La insignia de un evento: `Cumplido`, `Progreso` o `Perdido`. */
export function overlayEventBadge(view: OverlayEventView): string {
  switch (view.tipo) {
    case "cumplido":
      return "Cumplido";
    case "progresado":
      return "Progreso";
    case "perdido":
      return "Perdido";
  }
}

/**
 * La cifra de progreso de un evento, para pintar junto a la insignia.
 *
 * - `cumplido` con tope: `propio/max unidad` (recortado al tope);
 * - `cumplido` sin tope: «Cumplido»;
 * - `progresado` con tope: `min(propio, max)/max unidad`;
 * - `progresado` sin tope y repetible: `xN`;
 * - `progresado` sin tope: `propio unidad`;
 * - `perdido`: «Ahora N unidad» si hay nuevo poseedor y «Perdido» si no.
 *
 * La unidad se elige por el **tope** cuando lo hay, porque es la cantidad que
 * se está midiendo («3/3 victorias»), y por el propio progreso cuando no.
 */
export function overlayEventProgress(view: OverlayEventView): string {
  const maximo = view.maxProgreso;

  if (view.tipo === "cumplido") {
    if (maximo === null) {
      // Un repetible sin tope nunca se completa (`victorias`); un `cumplido` así
      // solo puede venir de la primera siembra antigua, y lo que toca es su cuenta.
      return view.repetible ? eventCountText(view) : "Cumplido";
    }

    const propio = Math.min(view.progresoPropio, maximo);

    return `${propio}/${maximo} ${overlayMetricUnit(view.metrica, maximo)}`;
  }

  if (view.tipo === "progresado") {
    if (maximo !== null) {
      const propio = Math.min(view.progresoPropio, maximo);

      return `${propio}/${maximo} ${overlayMetricUnit(view.metrica, maximo)}`;
    }

    return eventCountText(view);
  }

  if (view.progresoAjeno !== null) {
    return `Ahora ${view.progresoAjeno} ${overlayMetricUnit(view.metrica, view.progresoAjeno)}`;
  }

  return "Perdido";
}

/** La cuenta de un evento repetible: `xN` si la API publica la repetición. */
function eventCountText(view: OverlayEventView): string {
  if (view.repeticion !== null) {
    return `x${view.repeticion}`;
  }

  return `${view.progresoPropio} ${overlayMetricUnit(view.metrica, view.progresoPropio)}`;
}

/**
 * ¿El evento celebra un objetivo realmente completado?
 *
 * El tipo manda, pero no basta: `imparable` y `victorias` son repetibles y la
 * API los anotó como `cumplido` en su primera siembra aunque solo llevaran un
 * día o una victoria (el estado de entonces daba por cumplido a cualquier
 * beneficiario). Un `cumplido` con menos progreso que su tope, o de un objetivo
 * sin tope que se repite, se pinta como avance: sin tick y con la cifra.
 */
export function overlayEventCompleted(view: OverlayEventView): boolean {
  if (view.tipo !== "cumplido") {
    return false;
  }

  if (view.maxProgreso === null) {
    return !view.repetible;
  }

  return view.progresoPropio >= view.maxProgreso;
}

/**
 * Los tres repartos del overlay.
 *
 * - `directo`: paga por unidad al ganar o jugar (`victorias`, `imparable`, los
 *   `maestro-<civ>`). Su evento se celebra cada vez que avanza.
 * - `meta`: un logro con umbral que se cobra al completarlo (`imbatible`,
 *   `lider-<civ>`, las hazañas). Solo se celebra al llegar.
 * - `liderato`: una competición, que solo paga al que va primero y se puede
 *   perder. Se celebra al ponerse primero.
 */
export type OverlayEventKind = "directo" | "meta" | "liderato";

/** El reparto de un objetivo (o de su evento) a partir de `volatil` y `repetible`. */
export function overlayEventKind(
  objective: Pick<OverlayEventView, "volatil" | "repetible">,
): OverlayEventKind {
  if (objective.volatil) {
    return "liderato";
  }

  return objective.repetible ? "directo" : "meta";
}

/**
 * Los puntos que da **este evento**, o `null` si no cobra.
 *
 * - Competición y meta: el premio del catálogo, que es lo que pagan una vez.
 * - Objetivos repetibles: lo que pagan por unidad, que la API resuelve
 *   (`puntos_por_unidad`): 2 por victoria, 1 por día de `imparable`, 1 por
 *   victoria de los `maestro-<civ>`.
 *
 * No es el acumulado del objetivo: una victoria enseña `+2`, no `+22` por las
 * once que lleve. Un `perdido` no cobra.
 */
export function overlayEventReward(view: OverlayEventView): number | null {
  if (view.tipo === "perdido") {
    return null;
  }

  if (view.volatil || !view.repetible) {
    return view.puntos;
  }

  return view.puntosPorUnidad ?? view.puntos;
}

/**
 * Los puntos que **quita** un evento, o `null` si no quita nada.
 *
 * Solo una competición se pierde: cuando otro jugador adelanta, el evento
 * `perdido` devuelve el premio al marcador y la tarjeta enseña lo que deja de
 * sumar. Un logro no se des-cumple, así que ahí nunca aplica.
 */
export function overlayEventLoss(view: OverlayEventView): number | null {
  if (view.tipo !== "perdido" || !view.volatil) {
    return null;
  }

  return view.puntos > 0 ? view.puntos : null;
}

/**
 * ¿Este evento tiene animación?
 *
 * Los objetivos directos se celebran en cada avance (cobran por unidad). Las
 * metas y los lideratos, cuando de verdad se cobran o se pierden: al completar
 * el umbral, al ponerse primero y al dejar de estarlo. Un `perdido` de un logro
 * no existe; el de una competición, sí.
 */
export function overlayAnimates(view: OverlayEventView): boolean {
  if (view.tipo === "perdido") {
    return overlayEventKind(view) === "liderato";
  }

  if (overlayEventKind(view) === "directo") {
    return true;
  }

  return view.tipo === "cumplido" && overlayEventCompleted(view);
}

/* -------------------------------------------------------------------------- */
/* Internos                                                                    */
/* -------------------------------------------------------------------------- */

/** ¿El evento es de los que se celebran? */
function isPositiveEvent(tipo: OverlayEventoObjetivo["tipo"]): boolean {
  return tipo === "cumplido" || tipo === "progresado";
}

/**
 * El primer valor de un parámetro de la URL, recortado y en minúsculas.
 *
 * Devuelve `null` para lo ausente y para la cadena vacía, que es lo que deja un
 * `?posicion=` escrito a mano y no debe interpretarse como un valor válido.
 */
function firstParamValue(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;

  if (typeof raw !== "string") {
    return null;
  }

  const normalized = raw.trim().toLowerCase();

  return normalized === "" ? null : normalized;
}

/** Un parámetro de la URL que solo admite un conjunto cerrado de valores. */
function readEnumParam<T extends string>(
  value: string | string[] | undefined,
  allowed: readonly T[],
  fallback: T,
): T {
  const normalized = firstParamValue(value);

  if (normalized === null) {
    return fallback;
  }

  return (allowed as readonly string[]).includes(normalized) ? (normalized as T) : fallback;
}

/** Un parámetro booleano escrito como `0`/`1` o `false`/`true`. */
function readBooleanParam(
  value: string | string[] | undefined,
  fallback: boolean,
): boolean {
  const normalized = firstParamValue(value);

  if (normalized === "0" || normalized === "false") {
    return false;
  }

  if (normalized === "1" || normalized === "true") {
    return true;
  }

  return fallback;
}

/**
 * De una lista de vistas, los positivos más recientes por objetivo, recortados.
 *
 * Se ordena ascendente y se escribe en un mapa por objetivo: el último que pasa
 * es el más reciente. Después se ordena descendente para enseñar primero lo
 * último que ocurrió.
 */
function recentPositiveViews(
  views: readonly OverlayEventView[],
  limit: number,
): OverlayEventView[] {
  if (limit <= 0) {
    return [];
  }

  const latest = new Map<string, OverlayEventView>();

  for (const view of [...views].sort(compareViewsAsc)) {
    if (isPositiveEvent(view.tipo)) {
      latest.set(view.objetivoId, view);
    }
  }

  return [...latest.values()].sort(compareViewsDesc).slice(0, limit);
}

/** Orden ascendente por instante y, a igualdad, por objetivo. */
function compareViewsAsc(a: OverlayEventView, b: OverlayEventView): number {
  return (
    compareInstant(a.fechahora, b.fechahora) || compareIds(a.objetivoId, b.objetivoId)
  );
}

/** Orden descendente por instante y, a igualdad, por objetivo. */
function compareViewsDesc(a: OverlayEventView, b: OverlayEventView): number {
  return compareInstant(b.fechahora, a.fechahora) || compareIds(a.objetivoId, b.objetivoId);
}

/** Compara dos instantes ISO sin depender del idioma del runtime. */
function compareInstant(a: string, b: string): number {
  const ta = Date.parse(a);
  const tb = Date.parse(b);

  if (Number.isNaN(ta) || Number.isNaN(tb)) {
    return a < b ? -1 : a > b ? 1 : 0;
  }

  return ta - tb;
}

/** Compara ids con `<`/`>` para que el orden no dependa del locale. */
function compareIds(a: string, b: string): number {
  return a === b ? 0 : a < b ? -1 : 1;
}
