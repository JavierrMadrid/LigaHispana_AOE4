import "server-only";

import { PlayerStatus } from "@/generated/prisma/enums";
import { CIVILIZATION_DIRECTORY, civilizationFile, objectiveCivilization } from "@/lib/civs";
import { db } from "@/lib/db";
import { objectiveMaxProgress } from "@/lib/objective-progress";
import {
  OBJECTIVE_DEFINITIONS,
  VICTORIAS_ID,
  objectiveRepeatable,
  type ObjectiveDefinition,
} from "@/lib/objectives";
import { readRuleset, type ScoringRuleset } from "@/lib/scoring";
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
 * milisegundos y los segundos son opcionales, y el offset admite `Z` o
 * `±HH:MM`.
 */
const OVERLAY_DESDE_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

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
