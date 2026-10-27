import "server-only";

import type { Prisma } from "@/generated/prisma/client";
import { ObjectiveProgressKind, PlayerStatus } from "@/generated/prisma/enums";
import { CIVILIZATION_DIRECTORY, civilizationFile, objectiveCivilization } from "@/lib/civs";
import { db } from "@/lib/db";
import { divisionFromRankLevel, subdivisionNumber } from "@/lib/divisions";
import { objectiveMaxProgress } from "@/lib/objective-progress";
import {
  OBJECTIVE_DEFINITIONS,
  VICTORIAS_ID,
  objectiveRepeatable,
  type ObjectiveDefinition,
} from "@/lib/objectives";
import {
  objectiveLookup,
  resolveStandingsVersion,
  splitStandingPoints,
  type StandingObjective,
} from "@/lib/public";
import { windowBounds } from "@/lib/ranked-match";
import { RULESET_VERSION, readRuleset, type ScoringRuleset } from "@/lib/scoring";
import { readMapPool } from "@/lib/settings";

/**
 * La API pública del overlay (`/api/v0`).
 *
 * Es la cara de los datos que el overlay de stream pinta encima del juego: qué
 * participantes hay y qué objetivos reparte el torneo, con lo justo para dibujar
 * una tarjeta. No es la API de la web ni la de administración: aquí no hay
 * sesión, ni Server Actions, ni datos de nadie que no esté aprobado.
 *
 * ## Qué se publica y qué no
 *
 * Solo lo que el overlay necesita para pintar: `id` y `alias` de cada
 * participante, y el catálogo de objetivos con sus puntos, su forma de cobro y su
 * icono. Ni avatares, ni correos, ni el desglose de puntos, ni la clasificación
 * (esa es otra ruta de esta API). Todo sale de `Player` con `status: APPROVED`,
 * que es la misma cohorte que publica la clasificación.
 *
 * ## Por qué el módulo es `server-only`
 *
 * Porque los lectores hablan con la base de datos y el catálogo de objetivos
 * (`src/lib/objectives.ts`) ya es de servidor. Lo que sí es puro —tipos,
 * parsers, mapeadores y la forma de las respuestas— vive aquí y se prueba en
 * `tests/unit/lib/overlay-api.test.ts` sin base de datos; los lectores se
 * comprueban con la API en marcha.
 *
 * ## Las cabeceras
 *
 * El overlay corre en un navegador de la organización, en otro origen (OBS, una
 * página local, un panel de control), así que la respuesta lleva CORS abierto.
 * Se puede abrir sin riesgo porque **no hay credenciales**: ni cookies, ni
 * `Authorization`, y `Access-Control-Allow-Credentials` no aparece, así que el
 * navegador no manda la sesión de nadie aunque la tuviera. Los datos son
 * públicos por definición: son los mismos que enseña la web.
 *
 * `Cache-Control: no-store` es deliberado: el overlay se refresca solo y espera
 * el estado del torneo de este momento, no el de hace cinco minutos. Cachear una
 * lista de participantes u objetivos que la organización puede cambiar desde el
 * panel sería enseñar el torneo de antes.
 */

/* -------------------------------------------------------------------------- */
/* Contrato                                                                    */
/* -------------------------------------------------------------------------- */

/** Un participante del torneo, en lo que el overlay necesita. */
export type OverlayParticipante = {
  /**
   * `Player.profileId` de AoE4World como cadena.
   *
   * Viaja como texto y no como número porque es un identificador, no una
   * cantidad: el overlay lo usa para cruzar datos y compararlo consigo mismo, y
   * un `Number` grande perdería precisión en cuanto alguien lo tocara.
   */
  id: string;
  /** Nombre con el que compite (`Player.name`). */
  alias: string;
};

/** Un objetivo del catálogo, en lo que el overlay necesita para pintarlo. */
export type OverlayObjetivo = {
  id: string;
  nombre: string;
  descripcion: string;
  /**
   * URL absoluta del icono, o cadena vacía si el objetivo no tiene asset.
   *
   * Solo los objetivos de civilización (`masterizando-*`, `lider-*`,
   * `acolito-*`) tienen imagen: es la del juego de esa civilización. Los demás
   * se dibujan con el glifo que elija el overlay, y por eso el campo vacío es la
   * respuesta correcta y no un `null` ni una URL rota.
   */
  icono_url: string;
  /**
   * Puntos que otorga el objetivo con la regla activa.
   *
   * En `victorias` es el precio **por victoria** (`ruleset.pointsPerWin`), no un
   * premio único: el objetivo se repite con cada victoria.
   */
  puntos: number;
  /**
   * ¿El objetivo se posee y se pierde?
   *
   * `true` en las competiciones (un único poseedor, que cambia si alguien
   * adelanta) y `false` en los logros, que una vez cumplidos no se des-cumplen.
   */
  volatil: boolean;
  /** ¿Se puede cobrar más de una vez? (`victorias`, `imparable`). */
  repetible: boolean;
  /**
   * Tope de progreso, o `null` si no lo tiene.
   *
   * `null` en las **competiciones** (no se progresa hacia ellas, se poseen) y en
   * `victorias` (paga por unidad y no se completa nunca). En los logros con tope
   * es su umbral y en `por-tierra-y-agua`, el tamaño del pool activo, que solo se
   * conoce al calcular. Un `null` no es un cero: es "no hay tope".
   */
  max_progreso: number | null;
};

/**
 * Los puntos de una fila de la clasificación, repartidos como los publica la web.
 *
 * `volatiles` son los de las competiciones, que se poseen y se pierden, y
 * `permanentes` los de los logros, que una vez cobrados no se pierden. La suma es
 * siempre el total de la fila, también con un desglose ausente o de otra versión
 * (ver `splitStandingPoints`).
 */
export type OverlayPuntos = { volatiles: number; permanentes: number };

/**
 * La ladder del jugador, tal y como la pinta el overlay.
 *
 * `liga` es el id de división en español (`plata`, `oro`…), el mismo vocabulario
 * que usa la web, y `division` el subrango 1..3 dentro de ella.
 */
export type OverlayRango = { puntos: number; liga: string; division: number };

/** Un cambio de progreso de un objetivo, en el feed de un participante. */
export type OverlayEventoObjetivo = {
  /** `cumplido` lo logró, `perdido` dejó de poseerlo y `progresado` avanzó. */
  tipo: "cumplido" | "perdido" | "progresado";
  /** Instante del recálculo que lo detectó, en ISO 8601 con zona. */
  fechahora: string;
  /** Progreso propio y, en un `perdido`, el valor del nuevo poseedor. */
  progreso: { propio: number; ajeno?: number };
  /** Repetición del objetivo repetible (`victorias`, `imparable`), si la hay. */
  repeticion?: number;
};

/**
 * Una fila de la clasificación del overlay.
 *
 * `eventos_objetivos` solo viaja en el participante solicitado: los vecinos son
 * contexto de posición y llevan el mapa vacío, porque el feed de cada uno es una
 * consulta aparte y el overlay no lo pinta.
 */
export type OverlayClasificacion = {
  /** `Player.profileId` como cadena, igual que en `/participantes`. */
  id: string;
  posicion: number;
  partidas: number;
  puntos: OverlayPuntos;
  /** `null` si el jugador no tiene ladder: sin ELO o sin subdivisión conocida. */
  rango: OverlayRango | null;
  victorias: number;
  derrotas: number;
  /** Racha firmada del torneo; `null` sin partidas. Nunca 0. */
  racha: number | null;
  /** Último evento por objetivo; vacío en los vecinos. */
  eventos_objetivos: Record<string, OverlayEventoObjetivo>;
};

/** Una fila de `PlayerScore` con lo que publica la clasificación del overlay. */
export type OverlayStandingSource = {
  rank: number;
  total: number;
  wins: number;
  matches: number;
  streak: number | null;
  breakdown: unknown;
  player: { id: string; profileId: number; elo: number | null; rankLevel: string | null };
};

/** Una fila de `ObjectiveProgressEvent`, sin el jugador ni la edición. */
export type OverlayProgressEventSource = {
  objectiveId: string;
  kind: ObjectiveProgressKind;
  at: Date;
  ownValue: number;
  otherValue: number | null;
  repetition: number | null;
};

/** Cuerpo de una respuesta de error, con un código estable para el overlay. */
export type OverlayError = {
  /** Identificador del error, en `snake_case` y sin traducir. */
  codigo: string;
  /** Frase en español para enseñar tal cual. */
  mensaje: string;
};

/* -------------------------------------------------------------------------- */
/* Respuestas                                                                  */
/* -------------------------------------------------------------------------- */

const OVERLAY_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Accept, Content-Type",
  "Cache-Control": "no-store",
};

/** Respuesta JSON de la API, con las cabeceras del overlay. */
export function overlayJson(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: OVERLAY_HEADERS });
}

/**
 * Respuesta de error de la API.
 *
 * El `codigo` es lo que el overlay compara y el `mensaje` lo que puede enseñar:
 * separar los dos evita que un cambio de copy rompa a quien consume la API.
 */
export function overlayError(codigo: string, mensaje: string, status: number): Response {
  const body: OverlayError = { codigo, mensaje };

  return overlayJson(body, status);
}

/**
 * Respuesta al `preflight` de CORS (`OPTIONS`).
 *
 * El navegador la pide antes de un `GET` con cabeceras que no son simples; el
 * cuerpo va vacío porque el 204 no lleva ninguno.
 */
export function overlayPreflight(): Response {
  return new Response(null, { status: 204, headers: OVERLAY_HEADERS });
}

/* -------------------------------------------------------------------------- */
/* Parámetros                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * El `?id=` de `/participantes`, ya interpretado.
 *
 * Tres estados y no dos porque "no venía" y "venía mal" no son lo mismo: sin
 * `id` se publica la lista entera y con un `id` ilegible se responde 400. Un
 * `null` que significara las dos cosas obligaría a repetir la comprobación en
 * cada ruta.
 */
export type OverlayProfileIdParam =
  | { status: "absent" }
  | { status: "invalid" }
  | { status: "ok"; value: number };

/**
 * Forma canónica de un `profileId` en la URL: de 1 a 10 dígitos y sin ceros a la
 * izquierda.
 *
 * Un `profileId` de AoE4World es un entero positivo, así que `0`, `007` y `abc`
 * no son "casi válidos": son otra cosa. Rechazarlos aquí evita que `Number()`
 * acepte `"  12 "`, `"1e3"` o `"0x10"`, que convertirían en una consulta a la
 * base algo que nadie ha pedido.
 */
const OVERLAY_PROFILE_ID_PATTERN = /^[1-9]\d{0,9}$/;

export function readOverlayProfileId(value: string | null): OverlayProfileIdParam {
  if (value === null) {
    return { status: "absent" };
  }

  if (!OVERLAY_PROFILE_ID_PATTERN.test(value)) {
    return { status: "invalid" };
  }

  const id = Number(value);

  // El patrón ya acota a 10 dígitos, muy por debajo de `MAX_SAFE_INTEGER`; la
  // comprobación se queda para que el tipo no dependa de que el patrón no cambie.
  if (!Number.isSafeInteger(id)) {
    return { status: "invalid" };
  }

  return { status: "ok", value: id };
}

/** El `?desde=` de la API, ya interpretado (mismos tres estados que el `id`). */
export type OverlayDesdeParam =
  | { status: "absent" }
  | { status: "invalid" }
  | { status: "ok"; value: Date };

/**
 * ISO 8601 **con hora y con zona**, que es lo único que no deja dudas.
 *
 * La zona es obligatoria a propósito: `2026-10-24T14:30:00` sin zona la
 * interpreta cada runtime en la suya (JavaScript la lee como hora local, otros
 * lenguajes como UTC), así que la misma URL diría dos instantes distintos. Los
 * segundos y la fracción de segundo son opcionales, y el offset admite `Z` o
 * `±HH:MM`.
 */
const OVERLAY_DESDE_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

export function readOverlayDesde(value: string | null): OverlayDesdeParam {
  if (value === null) {
    return { status: "absent" };
  }

  const match = OVERLAY_DESDE_PATTERN.exec(value);

  if (match === null) {
    return { status: "invalid" };
  }

  // `new Date()` **no** valida el calendario: `2026-02-30` lo acepta y lo
  // convierte en el 2 de marzo. El día se comprueba contra el mes antes de
  // construir la fecha, y el `NaN` final se queda como red de seguridad por si
  // algún runtime se pone creativo con un valor que aquí parece correcto.
  if (!isRealDate(Number(match[1]), Number(match[2]), Number(match[3]))) {
    return { status: "invalid" };
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return { status: "invalid" };
  }

  return { status: "ok", value: date };
}

/** ¿El año, mes y día forman una fecha del calendario? */
function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) {
    return false;
  }

  return day <= daysInMonth(year, month);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    return isLeapYear(year) ? 29 : 28;
  }

  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/* -------------------------------------------------------------------------- */
/* Mapeadores                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Filas de `Player` → participantes del overlay.
 *
 * Puro y aparte del lector para poder probarlo sin base de datos: lo único que
 * hace es elegir los nombres del contrato (`profileId` → `id`, `name` → `alias`)
 * y convertir el identificador a cadena.
 */
export function overlayParticipants(
  rows: readonly { profileId: number; name: string }[],
): OverlayParticipante[] {
  return rows.map((row) => ({ id: String(row.profileId), alias: row.name }));
}

/**
 * Catálogo de objetivos → objetivos del overlay, con la regla activa aplicada.
 *
 * Respeta el orden de `definitions`, que es el de presentación del catálogo, y
 * salta los objetivos **desactivados** por la organización: uno apagado no se
 * computa, no reparte puntos y no debe aparecer en el overlay, igual que no
 * aparece en `/objetivos`.
 *
 * `origin` es el origen de la petición (`https://liga.example`), del que se
 * compone la URL absoluta del icono: el overlay corre en otra página y una ruta
 * relativa como `/imagenes/...` apuntaría a su propio servidor, no al nuestro.
 */
export function overlayObjectives(
  definitions: readonly ObjectiveDefinition[],
  ruleset: ScoringRuleset,
  mapPoolSize: number,
  origin: string,
): OverlayObjetivo[] {
  const desactivados = new Set(ruleset.disabledObjectives);
  const base = trimTrailingSlash(origin);
  const objetivos: OverlayObjetivo[] = [];

  for (const definition of definitions) {
    if (desactivados.has(definition.id)) {
      continue;
    }

    objetivos.push({
      id: definition.id,
      nombre: definition.label,
      descripcion: definition.description,
      icono_url: objectiveIconUrl(definition.id, base),
      puntos: objectivePoints(definition, ruleset),
      volatil: definition.kind === "competition",
      repetible: objectiveRepeatable(definition.id),
      max_progreso: objectiveMaxProgress(definition, mapPoolSize),
    });
  }

  return objetivos;
}

/**
 * Puntos de un objetivo con la regla activa.
 *
 * `victorias` es la excepción y se resuelve **antes** que el override: paga
 * `ruleset.pointsPerWin` por victoria y su `points` del catálogo es documental,
 * así que un `ruleset.objectives["victorias"]` guardado a mano no puede abrir una
 * segunda verdad sobre lo que vale una victoria. El motor hace lo mismo.
 */
function objectivePoints(definition: ObjectiveDefinition, ruleset: ScoringRuleset): number {
  if (definition.id === VICTORIAS_ID) {
    return ruleset.pointsPerWin;
  }

  return ruleset.objectives[definition.id] ?? definition.points;
}

/**
 * URL absoluta del icono de un objetivo, o cadena vacía si no tiene.
 *
 * Solo la tienen los objetivos de civilización, y el asset es el del juego de esa
 * civilización: el mismo WebP que pinta `civilization-icon.tsx`, no una copia.
 * Una civilización sin fichero (un DLC que aún no tiene icono) devuelve vacío en
 * vez de una URL que daría 404.
 */
function objectiveIconUrl(objectiveId: string, origin: string): string {
  const civ = objectiveCivilization(objectiveId);

  if (civ === null) {
    return "";
  }

  const file = civilizationFile(civ);

  if (file === null) {
    return "";
  }

  return `${origin}${CIVILIZATION_DIRECTORY}/${file}`;
}

/** Quita **una** barra final del origen, para no acabar con `//imagenes`. */
function trimTrailingSlash(origin: string): string {
  return origin.endsWith("/") ? origin.slice(0, -1) : origin;
}

/** El vocabulario del evento en el contrato: el enum de Prisma, en minúsculas. */
const OVERLAY_EVENTO_TIPO: Record<ObjectiveProgressKind, OverlayEventoObjetivo["tipo"]> = {
  CUMPLIDO: "cumplido",
  PERDIDO: "perdido",
  PROGRESADO: "progresado",
};

/**
 * Un evento de progreso → un evento del overlay.
 *
 * Los opcionales solo aparecen cuando existen: `ajeno` es del `PERDIDO` y
 * `repeticion` de los repetibles, y publicarlos como `null` obligaría al overlay a
 * distinguir "no hay" de "vale cero" en un campo que no es una cantidad propia.
 */
export function overlayEventoObjetivo(
  event: OverlayProgressEventSource,
): OverlayEventoObjetivo {
  const evento: OverlayEventoObjetivo = {
    tipo: OVERLAY_EVENTO_TIPO[event.kind],
    fechahora: event.at.toISOString(),
    progreso: { propio: event.ownValue },
  };

  if (event.otherValue !== null) {
    evento.progreso.ajeno = event.otherValue;
  }

  if (event.repetition !== null) {
    evento.repeticion = event.repetition;
  }

  return evento;
}

/**
 * El feed de eventos de un jugador → el último evento de cada objetivo.
 *
 * El overlay pinta el **estado de ahora** de cada objetivo, no la secuencia
 * entera: de la historia solo interesa el último capítulo, y es el que dice si el
 * objetivo está cumplido, perdido o a medias. Por eso se ordena por `at`
 * ascendente y se queda el último de cada id.
 *
 * El desempate por `objectiveId` existe para que dos eventos del mismo instante
 * (la siembra de un recálculo escribe varios a la vez) den siempre el mismo mapa,
 * y se compara con `<`/`>` y no con `localeCompare` para no depender del idioma
 * del runtime.
 *
 * Los objetivos que no están activos se descartan: el overlay resuelve el id
 * contra `/objetivos`, y publicar uno que la organización ha apagado le dejaría un
 * evento que no puede pintar.
 */
export function overlayEventosObjetivos(
  events: readonly OverlayProgressEventSource[],
  activeObjectiveIds: ReadonlySet<string>,
): Record<string, OverlayEventoObjetivo> {
  const ordenados = events
    .filter((event) => activeObjectiveIds.has(event.objectiveId))
    .sort(compareProgressEvents);

  const eventos: Record<string, OverlayEventoObjetivo> = {};

  for (const event of ordenados) {
    eventos[event.objectiveId] = overlayEventoObjetivo(event);
  }

  return eventos;
}

/** Orden del feed: por instante y, a igualdad, por id de objetivo. */
function compareProgressEvents(
  a: OverlayProgressEventSource,
  b: OverlayProgressEventSource,
): number {
  const at = a.at.getTime() - b.at.getTime();

  if (at !== 0) {
    return at;
  }

  if (a.objectiveId === b.objectiveId) {
    return 0;
  }

  return a.objectiveId < b.objectiveId ? -1 : 1;
}

/**
 * Una fila de `PlayerScore` → una fila de la clasificación del overlay.
 *
 * Es puro y aparte del lector porque aquí se decide lo que se publica: el reparto
 * de puntos (`splitStandingPoints`, la misma función que la web), las derrotas por
 * resta, el identificador como cadena y la ladder ya resuelta. La racha se copia
 * tal cual: ya viene firmada del motor y `null` es "sin partidas", no un cero.
 */
export function overlayStanding(
  row: OverlayStandingSource,
  lookup: ReadonlyMap<string, StandingObjective>,
  eventos: Record<string, OverlayEventoObjetivo>,
): OverlayClasificacion {
  const points = splitStandingPoints(row.total, row.breakdown, lookup);

  return {
    id: String(row.player.profileId),
    posicion: row.rank,
    partidas: row.matches,
    puntos: { volatiles: points.pointsByCompetitions, permanentes: points.pointsByAchievements },
    rango: overlayRango(row.player),
    victorias: row.wins,
    derrotas: row.matches - row.wins,
    racha: row.streak,
    eventos_objetivos: eventos,
  };
}

/**
 * La ladder de un jugador, o `null` si no está clasificado.
 *
 * Hacen falta las tres piezas: el ELO como cifra, la división del catálogo y el
 * número de subdivisión. Un jugador sin ladder no tiene ELO ni `rankLevel`, y un
 * `rankLevel` sin subrango (`gold`) resuelve la división pero no el número; en los
 * dos casos el overlay no puede pintar un rango completo y la respuesta correcta es
 * no pintar ninguno, no inventarle el subrango.
 */
function overlayRango(player: OverlayStandingSource["player"]): OverlayRango | null {
  if (player.elo === null) {
    return null;
  }

  const liga = divisionFromRankLevel(player.rankLevel);
  const division = subdivisionNumber(player.rankLevel);

  if (liga === null || division === null) {
    return null;
  }

  return { puntos: player.elo, liga, division };
}

/**
 * El participante solicitado y sus vecinos de clasificación, en orden de posición.
 *
 * `above` y `below` llegan de más cercano a más lejano, así que el recorte es el
 * de la ventana que se pinta: sin nadie por delante se enseñan los dos siguientes,
 * sin nadie por detrás los dos anteriores, y con los dos lados solo el inmediato de
 * cada uno. Un empate de posición no cambia nada: el vecino es el de al lado en el
 * orden publicado, no el de la misma puntuación.
 */
export function overlayNeighborhood(
  requested: OverlayClasificacion,
  above: readonly OverlayClasificacion[],
  below: readonly OverlayClasificacion[],
): OverlayClasificacion[] {
  if (above.length === 0) {
    return [requested, ...below.slice(0, 2)];
  }

  if (below.length === 0) {
    return [...above.slice(0, 2).reverse(), requested];
  }

  return [above[0], requested, below[0]];
}

/* -------------------------------------------------------------------------- */
/* Lectores                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Participantes aprobados, o solo uno si se pide por `profileId`.
 *
 * La consulta filtra por estado en la base y no en memoria: un participante
 * pendiente o expulsado no se publica, y traerlo para descartarlo después sería
 * leer datos que no salen de aquí. Se ordena por `profileId` porque el contrato
 * promete un orden estable y el overlay no tiene por qué ordenar nada.
 */
export async function loadOverlayParticipants(
  profileId?: number,
): Promise<OverlayParticipante[]> {
  const rows = await db.player.findMany({
    where: {
      status: PlayerStatus.APPROVED,
      ...(profileId === undefined ? {} : { profileId }),
    },
    select: { profileId: true, name: true },
    orderBy: { profileId: "asc" },
  });

  return overlayParticipants(rows);
}

/**
 * El catálogo de objetivos tal y como lo ve el overlay.
 *
 * Las dos configuraciones que lo modifican —el ruleset y el pool de mapas— se
 * leen a la vez: son dos consultas independientes y la respuesta las necesita
 * juntas. El tamaño del pool entra porque `por-tierra-y-agua` tiene ese umbral.
 */
export async function loadOverlayObjectives(origin: string): Promise<OverlayObjetivo[]> {
  const [ruleset, mapPool] = await Promise.all([readRuleset(), readMapPool()]);

  return overlayObjectives(OBJECTIVE_DEFINITIONS, ruleset, mapPool.length, origin);
}

/**
 * Las columnas de `PlayerScore` que necesita la clasificación del overlay.
 *
 * Es un `select` propio y más corto que el de la web (`STANDING_SELECT`): el
 * overlay no pinta canales, ni país, ni avatar, y leerlos sería traer datos que no
 * salen de esta API. `id` sí entra porque es la clave foránea con la que se busca
 * el feed de eventos del jugador.
 */
const OVERLAY_STANDING_SELECT = {
  rank: true,
  total: true,
  wins: true,
  matches: true,
  streak: true,
  breakdown: true,
  player: { select: { id: true, profileId: true, elo: true, rankLevel: true } },
} satisfies Prisma.PlayerScoreSelect;

/**
 * La versión de reglas anterior más alta **que tenga filas**, o `null`.
 *
 * Es la misma consulta que hace `public.ts` para su respaldo, y aquí se repite
 * porque la clasificación del overlay tiene que publicar **la misma** tabla que la
 * web: si un despliegue deja la versión activa sin recalcular, las dos rutas tienen
 * que caer en la anterior, no una sí y la otra no.
 */
async function previousRuleSetVersion(): Promise<number | null> {
  const highest = await db.playerScore.aggregate({
    where: { ruleSetVersion: { lt: RULESET_VERSION } },
    _max: { ruleSetVersion: true },
  });

  return highest._max.ruleSetVersion;
}

/**
 * La clasificación de un participante con sus vecinos, o `null` si no está.
 *
 * El `?id=` es obligatorio en esta ruta: la respuesta es una ventana alrededor de
 * una fila, y sin fila no hay ventana. Se busca por `profileId` y `APPROVED` en la
 * base, así que un participante pendiente o expulsado da el mismo 404 que uno que
 * no existe, que es lo que promete la API.
 *
 * La versión publicada se resuelve como en `getStandings()`: la activa o, si aún no
 * tiene filas, la anterior más alta. Sin ese respaldo la ruta diría 404 durante el
 * rato en que el recálculo de una versión nueva todavía no ha corrido.
 *
 * ## Las consultas
 *
 * Primero la fila (no se puede pedir la ventana sin saber su puesto) y después, en
 * paralelo, los dos vecinos y el feed del jugador:
 *
 * - los vecinos son `rank` menor y mayor con desempate por `profileId`, que es el
 *   mismo orden de presentación que publica la web; se piden dos de cada lado
 *   porque el borde de la tabla necesita dos;
 * - el feed se filtra por la edición activa (`windowBounds`) y, si llega `desde`,
 *   por instante: el overlay que se reconecta pide solo lo nuevo. Sin `desde` trae
 *   la edición entera y el mapeador se queda con el último evento de cada objetivo,
 *   así que el resultado es el mismo estado con menos historia.
 *
 * Los eventos se recortan al catálogo activo antes de mapear, y el ruleset se lee
 * una sola vez para todo: el mismo documento da los puntos del reparto, los
 * objetivos apagados y la ventana de la edición.
 */
export async function loadOverlayClassification(
  profileId: number,
  desde: Date | null,
): Promise<OverlayClasificacion[] | null> {
  const ruleset = await readRuleset();

  const activeCount = await db.playerScore.count({
    where: { ruleSetVersion: RULESET_VERSION },
  });
  const previous = activeCount === 0 ? await previousRuleSetVersion() : null;
  const version = resolveStandingsVersion(RULESET_VERSION, activeCount, previous);

  const row = await db.playerScore.findFirst({
    where: {
      ruleSetVersion: version.ruleSetVersion,
      player: { profileId, status: PlayerStatus.APPROVED },
    },
    select: OVERLAY_STANDING_SELECT,
  });

  if (row === null) {
    return null;
  }

  const editionFrom = windowBounds(ruleset.window).from;

  const [above, below, events] = await Promise.all([
    db.playerScore.findMany({
      where: {
        ruleSetVersion: version.ruleSetVersion,
        player: { status: PlayerStatus.APPROVED },
        OR: [
          { rank: { lt: row.rank } },
          { rank: row.rank, player: { profileId: { lt: row.player.profileId } } },
        ],
      },
      orderBy: [{ rank: "desc" }, { player: { profileId: "desc" } }],
      take: 2,
      select: OVERLAY_STANDING_SELECT,
    }),
    db.playerScore.findMany({
      where: {
        ruleSetVersion: version.ruleSetVersion,
        player: { status: PlayerStatus.APPROVED },
        OR: [
          { rank: { gt: row.rank } },
          { rank: row.rank, player: { profileId: { gt: row.player.profileId } } },
        ],
      },
      orderBy: [{ rank: "asc" }, { player: { profileId: "asc" } }],
      take: 2,
      select: OVERLAY_STANDING_SELECT,
    }),
    db.objectiveProgressEvent.findMany({
      where: {
        playerId: row.player.id,
        editionFrom,
        ...(desde === null ? {} : { at: { gte: desde } }),
      },
      select: {
        objectiveId: true,
        kind: true,
        at: true,
        ownValue: true,
        otherValue: true,
        repetition: true,
      },
      orderBy: [{ at: "asc" }, { objectiveId: "asc" }],
    }),
  ]);

  const lookup = objectiveLookup(ruleset);
  const activeObjectiveIds = new Set(
    OBJECTIVE_DEFINITIONS.filter(
      (definition) => !ruleset.disabledObjectives.includes(definition.id),
    ).map((definition) => definition.id),
  );

  const eventos = overlayEventosObjetivos(events, activeObjectiveIds);
  const requested = overlayStanding(row, lookup, eventos);
  const arriba = above.map((fila) => overlayStanding(fila, lookup, {}));
  const abajo = below.map((fila) => overlayStanding(fila, lookup, {}));

  return overlayNeighborhood(requested, arriba, abajo);
}
