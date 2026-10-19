import "server-only";

import { Prisma } from "@/generated/prisma/client";
import type { LadderCutoffsTable } from "@/lib/alerts/division-cutoffs";
import { CIVILIZATIONS, CIVILIZATION_IDS } from "@/lib/civs";
import { aoe4WorldProfileUrl } from "@/lib/format";
import { isRecord } from "@/lib/json";
import { rankedMatchSql, type ScoringWindow } from "@/lib/ranked-match";
import type { ScoringRuleset } from "@/lib/scoring";

/**
 * Los objetivos del torneo de `docs/OBJETIVOS.md`.
 *
 * Hay **dos formas de cobrar** un objetivo, y es la diferencia de fondo de este
 * catálogo:
 *
 * - **Competición** (`kind: "competition"`): *winner-takes-all*, un único
 *   poseedor, el que va primero en su métrica. Es el modelo de siempre.
 * - **Logro** (`kind: "achievement"`): lo cobra **todo el que cumple la
 *   condición**. Puede ser binario (se cumple o no), con tope (p. ej. `imparable`,
 *   con puntos por día hasta 14) o **sin tope** (`victorias`, que paga los puntos
 *   por victoria de la regla activa por cada victoria). No tiene poseedor único.
 *
 * Ojo con la suma nominal: **no todos los `points` del catálogo son un premio
 * fijo**. `victorias` reparte por unidad y sin tope, así que su `points` (2) es
 * documental y queda fuera de la cifra que resume `/puntuacion` (ver
 * `hasFixedPrize`).
 *
 * Este módulo no decide nada por su cuenta: recibe las partidas clasificatorias
 * ya cargadas, el ruleset activo y el pool de mapas, y devuelve qué objetivos
 * posee cada jugador. La lectura de la base (y la escritura de la clasificación)
 * vive en `scoring.ts`, que es quien importa de aquí, así el grafo de módulos no
 * se enrolla sobre sí mismo.
 */

/** Grupos de objetivos, en el orden en que se presentan. */
export type ObjectiveGroup = "actividad" | "racha" | "hazanas" | "formato" | "civilizacion";

/** Forma de cobrar: un solo poseedor o todo el que cumple. */
export type ObjectiveKind = "competition" | "achievement";

/** Métrica que decide el progreso o el poseedor (ver `docs/OBJETIVOS.md`). */
export type ObjectiveMetric =
  | "partidas"
  | "victorias"
  | "racha"
  | "racha-partidas"
  | "dias"
  | "civilizaciones"
  | "mapas";

export type ObjectiveDefinition = {
  id: string;
  group: ObjectiveGroup;
  kind: ObjectiveKind;
  label: string;
  /**
   * Una frase corta con la regla, para la tarjeta y el modal del objetivo.
   *
   * Se escribe aquí y no en la interfaz porque es la **regla**: si el copy viviera
   * en el componente, cada tarjeta podría acabar contando una cosa distinta de la
   * que el motor aplica. Los umbrales de los logros son fijos y están en el
   * catálogo (`target`), así que la frase puede decirlos sin quedarse mintiendo.
   */
  description: string;
  metric: ObjectiveMetric;
  /**
   * Puntos por defecto; el ruleset activo puede sobrescribirlos por id.
   *
   * La excepción es `victorias`: no tiene premio propio, paga `ruleset.pointsPerWin`
   * por victoria (ver su definición en el catálogo).
   */
  points: number;
  /**
   * Id del objetivo **cabeza de familia** (el logro global que agrupa a sus
   * hijos), o `null` si es independiente. `polifacetico` es cabeza de los
   * `lider-<civ>` y `jugon` lo es de los `acolito-<civ>`; la interfaz los agrupa
   * en una tarjeta a partir de este campo.
   */
  parent: string | null;
  /**
   * Umbral del logro, para la barra de avance de la interfaz; `null` en las
   * competiciones y en `por-tierra-y-agua`, cuyo umbral es el tamaño del pool
   * activo y por tanto solo se conoce en tiempo de cálculo.
   */
  target: number | null;
};

/**
 * Detalle extra de un contendiente, cuando el objetivo lo tiene. Hoy no lo usa
 * ninguno, pero el campo se mantiene para que la interfaz pueda añadir contexto
 * (la civilización de un `masterizando-*`, por ejemplo) sin cambiar el contrato.
 */
export type ObjectiveDetail = { id: string; label: string };

/**
 * Un jugador en la lista de un objetivo. `value` es lo que hay que pintar
 * (partidas, victorias, racha, días…), `matches` el número de partidas del que
 * sale, y `eligible` significa:
 *
 * - en una **competición**, que cumple lo mínimo para poder poseerla;
 * - en un **logro**, que **ya lo ha completado** (es el check de la interfaz).
 */
export type ObjectiveContender = {
  profileId: number;
  name: string;
  avatarUrl: string | null;
  /** Enlace al perfil en AoE4World, con el mismo criterio que `StandingRow`. */
  profileUrl: string | null;
  value: number;
  matches: number;
  eligible: boolean;
  /** Detalle del objetivo; `null` cuando no aporta nada (ver `ObjectiveDetail`). */
  detail?: ObjectiveDetail | null;
  /**
   * Avance **por mapa**, solo en `por-tierra-y-agua`: los mapas del pool que al
   * jugador le faltan por completar y cuántas partidas le faltan en cada uno.
   *
   * Es opcional y solo se publica donde aplica: el resto de objetivos no tiene
   * mapas, y meter un `null` en cada contendiente de cada objetivo engordaría el
   * snapshot de `Setting` sin decir nada. `null` explícito no llega: cuando no hay
   * mapas el campo simplemente no está.
   *
   * `missing` es 1..3 (el umbral por mapa no se publica, el dato ya viene masticado
   * como "cuántas partidas le faltan") y los mapas completos no aparecen. El orden es
   * de menos a más `missing` y, a igualdad, el del pool.
   */
  mapGaps?: ObjectiveMapGap[] | null;
};

/** Un mapa del pool en el que a un jugador le faltan partidas (`ObjectiveContender.mapGaps`). */
export type ObjectiveMapGap = {
  /** Nombre del mapa, tal cual está en el pool (`Match.map`). */
  map: string;
  /** Partidas que le faltan para completarlo: 1..3. */
  missing: number;
};

/**
 * Un beneficiario de un logro: quien lo ha completado, cuántos puntos cobra y
 * cuántas veces lo ha conseguido.
 *
 * `points` es variable en `imparable` (1 por día, con tope) y en `victorias`
 * (`pointsPerWin` por victoria, sin tope); en el resto de logros coincide con los
 * puntos de la tarjeta. `count` es lo que permite pintar "2 x Imparable": los días en
 * `imparable`, las victorias en `victorias` y `1` en los objetivos que no se repiten.
 */
export type ObjectiveBeneficiary = {
  profileId: number;
  name: string;
  avatarUrl: string | null;
  profileUrl: string | null;
  points: number;
  /** Repeticiones: días, victorias o 1 (ver `ObjectiveBeneficiary`). */
  count: number;
};

/** Umbral de un logro: en qué unidad y cuánto hace falta para completarlo. */
export type ObjectiveTarget = {
  unit: ObjectiveMetric;
  value: number;
};

export type ObjectiveOption = {
  id: string;
  group: ObjectiveGroup;
  kind: ObjectiveKind;
  label: string;
  /** La regla en una frase, tal cual está en el catálogo (`ObjectiveDefinition`). */
  description: string;
  metric: ObjectiveMetric;
  /**
   * Puntos que otorga poseerlo, ya con los overrides del ruleset aplicado.
   *
   * En `victorias` es el precio **por victoria** (`ruleset.pointsPerWin`), porque el
   * objetivo se repite: los puntos de un beneficiario son `points × count`.
   */
  points: number;
  /** Cabeza de familia del objetivo (`ObjectiveDefinition.parent`). */
  parent: string | null;
  /**
   * Poseedor único; `null` si nadie cumple. **Solo en competiciones**: en un logro
   * es siempre `null`, porque lo cobra cualquiera que cumpla (ver
   * `beneficiaries`).
   */
  holder: ObjectiveContender | null;
  /**
   * **Todos** los contendientes, ordenados por la cadena de desempate.
   *
   * Va entero, sin acotar: quien pinta decide cuánto enseña y con qué paginación.
   * No se rellena con jugadores a cero: solo entra quien tiene al menos una partida
   * dentro del objetivo. El poseedor **no** se pone el primero: aparece donde le
   * deja su métrica y lo marca `holder`.
   */
  ranking: ObjectiveContender[];
  /**
   * Quién ha completado un **logro**, con sus puntos. Vacío en las competiciones.
   * Es la lista que pinta el check de "conseguido" en la ficha de un participante
   * y el reparto de puntos.
   */
  beneficiaries: ObjectiveBeneficiary[];
  /**
   * Umbral del logro, listo para una barra de avance; `null` en las
   * competiciones.
   */
  target: ObjectiveTarget | null;
};

export type ObjectiveView = {
  ruleSetVersion: number;
  /** Etiqueta de la regla activa, la misma que guarda el desglose. */
  rule: string;
  /** Puntos por victoria clasificatoria del ruleset activo. */
  pointsPerWin: number;
  /**
   * Ventana del torneo (`[from, to)` sobre `Match.startedAt`), tal cual está en el
   * ruleset activo: instantes ISO-8601 UTC, `to` a `null` si está abierta por la
   * derecha.
   */
  window: ScoringWindow;
  /**
   * Pool de mapas activo, el mismo que resuelve `por-tierra-y-agua`. Se publica
   * para que la interfaz pueda listar los mapas del objetivo sin volver a leer
   * `Setting`.
   */
  mapPool: string[];
  /**
   * En orden estable: por grupo (`actividad` → `civilizacion`) y, dentro de cada
   * uno, por el orden de la lista (las cabezas de familia antes que sus hijos,
   * civilizaciones por `id`).
   */
  options: ObjectiveOption[];
};

/* -------------------------------------------------------------------------- */
/* Snapshot de la vista en `Setting`                                           */
/* -------------------------------------------------------------------------- */

/**
 * Versión de la **forma** del snapshot de `Setting["scoring.objectives"]`.
 *
 * Sube cuando cambia la forma de `ObjectiveView` y también cuando un documento
 * guardado dejaría de ser cierto aunque su forma siga siendo válida: un catálogo con
 * objetivos nuevos, por ejemplo, que un snapshot anterior no lleva. Un documento con
 * otra marca se rechaza y la vista se recalcula en vivo, que es lo que permite
 * desplegar una vista nueva sin que el primer lector interprete mal un documento
 * guardado antes.
 *
 * La v3 es el segundo caso: la forma de `ObjectiveView` no cambia, pero el catálogo
 * pasa de 83 a 88 objetivos (los cinco del *summary*), así que un snapshot v2 —que
 * no los tiene— se rechaza en vez de publicarse sin ellos.
 */
export const OBJECTIVES_SNAPSHOT_VERSION = 3;

/**
 * La vista de objetivos tal y como se guarda: `ObjectiveView` más la marca de forma
 * y la huella de contenido.
 *
 * La escribe `recomputeScores()` en su transacción, y de ahí que las páginas puedan
 * leerla en vez de barrer todas las clasificatorias y recomputar el catálogo en JS
 * en cada visita (ver `docs/OPERACION.md`, "El límite de CPU del plan Free").
 */
export type ObjectivesSnapshot = ObjectiveView & {
  snapshotVersion: number;
  fingerprint: string;
};

/**
 * Huella de contenido de una vista, para decidir si hay que reescribir el snapshot.
 *
 * FNV-1a de 32 bits en JS puro: `node:crypto` no está garantizado en el runtime de
 * los Workers y aquí no hace falta resistencia a colisiones —que dos vistas
 * distintas compartan huella solo significa saltarse una reescritura, que se
 * recupera en la siguiente pasada—. El hash va sobre la **serialización canónica
 * que producimos aquí** (un objeto con el orden de campos fijo), nunca sobre lo que
 * devuelve Postgres: `jsonb` normaliza el orden de las claves, así que comparar el
 * JSON guardado con el nuevo daría siempre distinto. La marca de forma entra en el
 * hash para que subir `OBJECTIVES_SNAPSHOT_VERSION` fuerce una reescritura.
 */
export function objectivesSnapshotFingerprint(view: ObjectiveView): string {
  const canonical = JSON.stringify({
    snapshotVersion: OBJECTIVES_SNAPSHOT_VERSION,
    ruleSetVersion: view.ruleSetVersion,
    rule: view.rule,
    pointsPerWin: view.pointsPerWin,
    window: view.window,
    mapPool: view.mapPool,
    options: view.options,
  });
  let hash = 0x811c9dc5;

  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Valida el documento guardado en `Setting["scoring.objectives"]`.
 *
 * Puro y deliberadamente **poco estricto**: corre en cada visita, así que solo
 * comprueba lo que hace falta para no mentir —la marca de forma, la versión de las
 * reglas (un bump invalida el snapshot) y que cada opción traiga `id`, `ranking` y
 * `beneficiaries`— y deja pasar el resto sin recorrerlo a fondo. Devuelve `null` si
 * algo no cuadra; quien llama cae entonces al cómputo en vivo.
 *
 * La versión de reglas esperada llega **como argumento** y no se importa de
 * `scoring.ts` a propósito: `scoring.ts` ya importa este módulo, y traer aquí un
 * valor suyo cerraría un ciclo entre los dos (ver el docblock del módulo).
 */
export function readObjectivesSnapshotValue(
  value: unknown,
  ruleSetVersion: number,
): ObjectiveView | null {
  if (!isRecord(value)) {
    return null;
  }

  if (value.snapshotVersion !== OBJECTIVES_SNAPSHOT_VERSION) {
    return null;
  }

  if (value.ruleSetVersion !== ruleSetVersion) {
    return null;
  }

  const { rule, pointsPerWin, window, mapPool, options } = value;

  if (typeof rule !== "string" || typeof pointsPerWin !== "number") {
    return null;
  }

  if (!isRecord(window) || typeof window.from !== "string") {
    return null;
  }

  if (window.to !== null && typeof window.to !== "string") {
    return null;
  }

  if (!Array.isArray(mapPool) || !Array.isArray(options)) {
    return null;
  }

  // Solo la forma mínima de cada opción: validar el ranking y los beneficiarios
  // entero costaría tanto como recomputarlos, que es justo lo que se evita.
  for (const option of options) {
    if (
      !isRecord(option) ||
      typeof option.id !== "string" ||
      !Array.isArray(option.ranking) ||
      !Array.isArray(option.beneficiaries)
    ) {
      return null;
    }
  }

  return {
    ruleSetVersion,
    rule,
    pointsPerWin,
    window: { from: window.from, to: window.to },
    mapPool: mapPool.filter((item): item is string => typeof item === "string"),
    options: options as ObjectiveOption[],
  };
}

export type ObjectiveGroupLabel = Record<ObjectiveGroup, string>;

/** Rótulos de grupo para la interfaz; el orden es el de `ObjectiveGroup`. */
export const OBJECTIVE_GROUP_LABELS: ObjectiveGroupLabel = {
  actividad: "Actividad",
  racha: "Racha",
  hazanas: "Hazañas",
  formato: "Formatos",
  civilizacion: "Civilizaciones",
};

/** Formatos de partida que reconocen los objetivos `rey-*`. */
export const FORMAT_IDS = ["1v1", "2v2", "3v3", "4v4"] as const;

export type FormatId = (typeof FORMAT_IDS)[number];

/** Puntos de un `rey-*`, los mismos para los cuatro formatos. */
const REY_POINTS = 240;

/** Puntos de un `masterizando-<civ>`. */
const MASTERIZANDO_POINTS = 120;

/** Puntos de un `lider-<civ>` y de un `acolito-<civ>`. */
const LIDER_POINTS = 12;
const ACOLITO_POINTS = 6;

/** Ids de familia y de los logros globales. */
export const POLIFACETICO_ID = "polifacetico";
export const JUGON_ID = "jugon";
export const IMPARABLE_ID = "imparable";
export const POR_TIERRA_ID = "por-tierra-y-agua";
export const VICTORIAS_ID = "victorias";
export const ANSIOSO_ID = "ansioso";
export const FAST_FEUDAL_ID = "avance-relampago-feudal";
export const FAST_CASTLE_ID = "avance-relampago-castillos";
export const FAST_IMPERIAL_ID = "avance-relampago-imperial";
export const DEFENDER_ID = "defensor-del-pueblo";

/**
 * Frase de desempate de las **competiciones**: es el desempate 3 de
 * `docs/OBJETIVOS.md` dicho en una línea para la tarjeta.
 *
 * Se escribe aquí y no en cada descripción porque es la misma regla para todas
 * (`loco-por-ganar`, `bienhadado`, los `rey-*` y los `masterizando-*`) y porque es
 * la interfaz la que la enseña: una copia por objetivo acabaría diciendo cosas
 * distintas del mismo desempate.
 */
const TIE_BREAK = "En caso de empate, lo cobra quien alcanzó esa cifra antes.";

/**
 * Umbrales de los logros. Son **fijos** (están en `docs/OBJETIVOS.md`), a
 * diferencia de los mínimos configurables que tenía el catálogo anterior: por eso
 * viven como constantes y no en `Setting`.
 */
const WINS_PER_CIV = 3;
const MATCHES_PER_CIV = 3;
const MATCHES_PER_MAP = 3;
const IMBATIBLE_STREAK = 5;
const IMPARABLE_DAYS = 14;
/** Duración de una partida corta (`agresor`) y larga (`estratega`), en segundos. */
const SHORT_MATCH_SECONDS = 600;
const LONG_MATCH_SECONDS = 1200;

/**
 * Umbrales de los objetivos que se cobran con el **summary** de la partida.
 *
 * Salen de `Match.apm`, `Match.feudalAgeSeconds` (y compañía) y de los aldeanos
 * perdidos, que los rellena `src/lib/aoe4world/summary.ts`: la partida no los trae
 * en el listado, así que hasta que ese paso no ha corrido estas constantes no
 * tienen con qué cumplirse. Están aquí y no en `Setting` por lo mismo que el resto
 * de umbrales: son fijos y están en `docs/OBJETIVOS.md`.
 */
const APM_THRESHOLD = 120;
const ANSIOSO_STREAK = 3;
/** Segundos de los tres `avance-relampago-*`: 4, 9 y 16 minutos. */
const FAST_FEUDAL_SECONDS = 240;
const FAST_CASTLE_SECONDS = 540;
const FAST_IMPERIAL_SECONDS = 960;
/** Partidas que hay que cumplir para cobrar una hazaña: una basta. */
const HAZANA_MATCHES = 1;
/** Umbrales de `defensor-del-pueblo`: partida larga y bajas de aldeanos. */
const DEFENDER_MATCH_SECONDS = 900;
const DEFENDER_VILLAGERS_LOST = 3;
const DEFENDER_GILDED_LOST = 2;
const DEFENDER_MOUNTED_LOST = 1;

/**
 * Los objetivos en orden de presentación.
 *
 * El `id` es estable y forma parte de la configuración guardada en `Setting`
 * (`scoring.ruleset.objectives`) y del desglose de `PlayerScore`: renombrarlo deja
 * huérfanos los puntos ya publicados.
 *
 * Dentro del grupo `civilizacion` el orden respeta la jerarquía: primero las 23
 * `masterizando-<civ>` (competiciones), después la cabeza `polifacetico` seguida
 * de sus 23 `lider-<civ>`, y por último `jugon` seguida de sus 23 `acolito-<civ>`.
 */
export const OBJECTIVE_DEFINITIONS: readonly ObjectiveDefinition[] = [
  {
    id: "loco-por-ganar",
    group: "actividad",
    kind: "competition",
    label: "Loco por ganar",
    description: `El jugador con más partidas clasificatorias jugadas en el torneo. ${TIE_BREAK}`,
    metric: "partidas",
    points: 50,
    parent: null,
    target: null,
  },
  {
    id: IMPARABLE_ID,
    group: "actividad",
    kind: "achievement",
    label: "Imparable",
    description: `Juega al menos una partida clasificatoria cada día natural: 1 punto por día, hasta ${IMPARABLE_DAYS}.`,
    metric: "dias",
    points: IMPARABLE_DAYS,
    parent: null,
    target: IMPARABLE_DAYS,
  },
  /**
   * El objetivo de ganar partidas.
   *
   * Es el único objetivo **sin tope**: paga los puntos por victoria de la regla
   * activa por cada victoria clasificatoria, así que su `points` (2) es solo
   * documental y el valor real es **siempre** `ruleset.pointsPerWin`. El motor lee
   * la fuente única —`ruleset.pointsPerWin`— e **ignora** un
   * `ruleset.objectives["victorias"]` si alguien llegara a guardarlo, que es lo que
   * impide tener dos verdades sobre lo que vale una victoria.
   *
   * Por eso tampoco entra en la **suma nominal** del catálogo (ver
   * `hasFixedPrize`): su reparto dependería de cuántas victorias sume el torneo.
   */
  {
    id: VICTORIAS_ID,
    group: "actividad",
    kind: "achievement",
    label: "Victorias",
    description:
      "Cada victoria clasificatoria paga los puntos por victoria de la regla activa, sin tope.",
    metric: "victorias",
    points: 2,
    parent: null,
    // Sin tope: el objetivo se repite con cada victoria y no se completa nunca.
    target: null,
  },
  {
    id: "bienhadado",
    group: "racha",
    kind: "competition",
    label: "Bienhadado",
    description: `La racha de victorias seguidas más larga del torneo. ${TIE_BREAK}`,
    metric: "racha",
    points: 200,
    parent: null,
    target: null,
  },
  {
    id: "imbatible",
    group: "racha",
    kind: "achievement",
    label: "Imbatible",
    description: `Encadena una racha de ${IMBATIBLE_STREAK} victorias seguidas.`,
    metric: "racha",
    points: 32,
    parent: null,
    target: IMBATIBLE_STREAK,
  },
  {
    id: ANSIOSO_ID,
    group: "racha",
    kind: "achievement",
    label: "Ansioso",
    description: `Encadena una racha de ${ANSIOSO_STREAK} partidas clasificatorias seguidas con ${APM_THRESHOLD} APM o más.`,
    // Racha de **partidas** por encima del umbral de APM, no de victorias: la
    // métrica `racha` la reservan las rachas de victorias (`bienhadado`,
    // `imbatible`), y las unidades de la interfaz no pueden mentir aquí.
    metric: "racha-partidas",
    points: 6,
    parent: null,
    target: ANSIOSO_STREAK,
  },
  {
    id: "agresor",
    group: "hazanas",
    kind: "achievement",
    label: "Agresor",
    description: `Gana al menos ${WINS_PER_CIV} partidas de menos de 10 minutos.`,
    metric: "victorias",
    points: 24,
    parent: null,
    target: WINS_PER_CIV,
  },
  {
    id: "estratega",
    group: "hazanas",
    kind: "achievement",
    label: "Estratega",
    description: `Gana al menos ${WINS_PER_CIV} partidas de más de 20 minutos.`,
    metric: "victorias",
    points: 24,
    parent: null,
    target: WINS_PER_CIV,
  },
  {
    id: FAST_FEUDAL_ID,
    group: "hazanas",
    kind: "achievement",
    label: "Avance relámpago: Feudal",
    description: `Llega a la Edad Feudal antes de ${FAST_FEUDAL_SECONDS / 60} minutos en una partida clasificatoria.`,
    metric: "partidas",
    points: 4,
    parent: null,
    target: HAZANA_MATCHES,
  },
  {
    id: FAST_CASTLE_ID,
    group: "hazanas",
    kind: "achievement",
    label: "Avance relámpago: Castillos",
    description: `Llega a la Edad de los Castillos antes de ${FAST_CASTLE_SECONDS / 60} minutos en una partida clasificatoria.`,
    metric: "partidas",
    points: 8,
    parent: null,
    target: HAZANA_MATCHES,
  },
  {
    id: FAST_IMPERIAL_ID,
    group: "hazanas",
    kind: "achievement",
    label: "Avance relámpago: Imperial",
    description: `Llega a la Edad Imperial antes de ${FAST_IMPERIAL_SECONDS / 60} minutos en una partida clasificatoria.`,
    metric: "partidas",
    points: 12,
    parent: null,
    target: HAZANA_MATCHES,
  },
  {
    id: DEFENDER_ID,
    group: "hazanas",
    kind: "achievement",
    label: "Defensor del pueblo",
    description: `Termina una partida de ${DEFENDER_MATCH_SECONDS / 60} minutos o más perdiendo menos de ${DEFENDER_VILLAGERS_LOST} aldeanos, menos de ${DEFENDER_GILDED_LOST} aldeanos dorados y ningún aldeano montado.`,
    metric: "partidas",
    points: 12,
    parent: null,
    target: HAZANA_MATCHES,
  },
  {
    id: POR_TIERRA_ID,
    group: "hazanas",
    kind: "achievement",
    label: "Por tierra y agua",
    description: `Juega al menos ${MATCHES_PER_MAP} partidas en cada mapa del pool activo.`,
    metric: "mapas",
    points: 81,
    parent: null,
    // El umbral es el tamaño del pool activo, que solo se conoce al calcular.
    target: null,
  },
  ...FORMAT_IDS.map((format) => ({
    id: `rey-${format}`,
    group: "formato" as const,
    kind: "competition" as const,
    label: `Rey del ${format}`,
    description: `El jugador con más victorias jugando en formato ${format}. ${TIE_BREAK}`,
    metric: "victorias" as const,
    points: REY_POINTS,
    parent: null,
    target: null,
  })),
  ...CIVILIZATIONS.map((civ) => ({
    id: `masterizando-${civ.id}`,
    group: "civilizacion" as const,
    kind: "competition" as const,
    label: `Masterizando ${civ.name}`,
    description: `El jugador con más victorias con ${civ.name}. ${TIE_BREAK}`,
    metric: "victorias" as const,
    points: MASTERIZANDO_POINTS,
    parent: null,
    target: null,
  })),
  {
    id: POLIFACETICO_ID,
    group: "civilizacion",
    kind: "achievement",
    label: "Polifacético",
    description: `Gana al menos ${WINS_PER_CIV} partidas con cada una de las ${CIVILIZATIONS.length} civilizaciones.`,
    metric: "civilizaciones",
    points: 96,
    parent: null,
    target: CIVILIZATION_IDS.length,
  },
  ...CIVILIZATIONS.map((civ) => ({
    id: `lider-${civ.id}`,
    group: "civilizacion" as const,
    kind: "achievement" as const,
    label: `Líder ${civ.name}`,
    description: `Gana al menos ${WINS_PER_CIV} partidas con ${civ.name}.`,
    metric: "victorias" as const,
    points: LIDER_POINTS,
    parent: POLIFACETICO_ID,
    target: WINS_PER_CIV,
  })),
  {
    id: JUGON_ID,
    group: "civilizacion",
    kind: "achievement",
    label: "Jugón",
    description: `Juega al menos ${MATCHES_PER_CIV} partidas con cada una de las ${CIVILIZATIONS.length} civilizaciones.`,
    metric: "civilizaciones",
    points: 24,
    parent: null,
    target: CIVILIZATION_IDS.length,
  },
  ...CIVILIZATIONS.map((civ) => ({
    id: `acolito-${civ.id}`,
    group: "civilizacion" as const,
    kind: "achievement" as const,
    label: `Acólito ${civ.name}`,
    description: `Juega al menos ${MATCHES_PER_CIV} partidas con ${civ.name}.`,
    metric: "partidas" as const,
    points: ACOLITO_POINTS,
    parent: JUGON_ID,
    target: MATCHES_PER_CIV,
  })),
];

/** Total de objetivos del catálogo. */
export const OBJECTIVE_COUNT = OBJECTIVE_DEFINITIONS.length;

/**
 * Los ids del catálogo.
 *
 * Lo usan los historiales para filtrar en la consulta las filas cuyo `objectiveId` ya no
 * existe en el catálogo —solo puede pasar si alguien insertó a mano—, de modo que el
 * recuento que decide la ventana y las filas que se publican cuenten lo mismo.
 */
export const OBJECTIVE_IDS: readonly string[] = OBJECTIVE_DEFINITIONS.map(
  (definition) => definition.id,
);

/**
 * ¿El objetivo reparte un **premio fijo**, de los que cuenta la suma nominal de
 * `docs/OBJETIVOS.md`?
 *
 * Solo `victorias` no lo es: paga `ruleset.pointsPerWin` por cada victoria y no
 * tiene tope, así que sumar su `points` del catálogo diría que el torneo reparte una
 * cifra que no reparte. Los demás logros sí tienen un tope (`imparable`, 14 días;
 * `por-tierra-y-agua`, uno por mapa) y las competiciones, un único premio.
 *
 * `por-tierra-y-agua` se reconoce por su id y no por `target` porque su tope es el
 * tamaño del pool activo y solo se conoce al calcular. En una `ObjectiveOption` ya
 * resuelta el mismo criterio se lee en `kind === "achievement" && target === null`.
 */
export function hasFixedPrize(definition: ObjectiveDefinition): boolean {
  return (
    definition.kind === "competition" ||
    definition.target !== null ||
    definition.id === POR_TIERRA_ID
  );
}

/** Puntos por defecto de cada objetivo, indexados por id. */
export const OBJECTIVE_POINTS: Record<string, number> = Object.fromEntries(
  OBJECTIVE_DEFINITIONS.map((definition) => [definition.id, definition.points]),
);

/**
 * La forma de cobrar de cada id del catálogo, indexada por id.
 *
 * Es un `Map` a nivel de módulo (el catálogo es una constante del código) y tiene
 * que ir **después** de `OBJECTIVE_DEFINITIONS`: se construye al cargar el módulo.
 */
const KINDS_BY_ID: ReadonlyMap<string, ObjectiveKind> = new Map(
  OBJECTIVE_DEFINITIONS.map((definition) => [definition.id, definition.kind]),
);

/**
 * La forma de cobrar de un id del catálogo: competición, logro, o `null` si el id
 * no está en el catálogo.
 *
 * Se pregunta **por id** y no por definición porque quien pregunta lo tiene por id:
 * el motor reparte los objetivos cobrados como `ObjectiveAwarded` (id y jugador, sin
 * la definición delante), y los dos registros que se reparten ese `awarded` —el
 * espejo de logros (`ObjectiveEvent`) y el registro de poseedores de competiciones
 * (`ObjectiveLeadEvent`)— tienen que decidir cuál les toca sin volver a recorrer el
 * catálogo.
 *
 * Un id que no está en el catálogo (solo puede venir de una fila escrita a mano) no
 * pertenece a ninguno de los dos y no se anota en ninguno.
 */
export function objectiveKind(id: string): ObjectiveKind | null {
  return KINDS_BY_ID.get(id) ?? null;
}

/**
 * Lo que un jugador cobra por **un** objetivo: importe real y repeticiones.
 *
 * Va junto al id y no en una lista aparte porque las dos cosas definen la misma
 * fila del resumen (`2 x Imparable +2`), y separarlas obligaría a cruzar dos listas
 * en cada lector.
 */
export type ObjectiveAwardEntry = {
  /** Puntos cobrados de verdad, ya con el tope o el precio por unidad aplicado. */
  points: number;
  /** Veces que se ha conseguido: días, victorias o `1` si no se repite. */
  count: number;
};

export type ObjectiveAward = {
  /** Puntos que suma el jugador por objetivos. */
  points: number;
  /** Ids de los objetivos que posee o ha completado, en orden de presentación. */
  earned: string[];
  /**
   * El importe real y las repeticiones de cada id de `earned`, indexado por id.
   *
   * `earned` da los ids en orden; aquí está lo que hay que pintar de cada uno. Se
   * guarda en el desglose de `PlayerScore` para que la clasificación publicada no
   * tenga que reconstruir lo que cobró `imparable` (1 por día, con tope) a partir
   * del precio del catálogo, que es solo el tope.
   */
  awards: Record<string, ObjectiveAwardEntry>;
};

/**
 * Un objetivo cobrado por un jugador, visto desde el motor.
 *
 * Va en `awarded` y no en `ObjectiveOption` a propósito: es lo que consumen los dos
 * registros del historial —el espejo de logros (`ObjectiveEvent`, escrito por
 * `reconcileObjectiveEvents()`) y el log de poseedores de competiciones
 * (`ObjectiveLeadEvent`, escrito por `reconcileObjectiveLeadEvents()`), los dos en
 * `scoring.ts`— y `/objetivos` no tiene por qué enterarse de que existen esas
 * tablas. En una competición hay una entrada; en un logro, una por beneficiario.
 */
export type ObjectiveAwarded = {
  /** Id estable del objetivo (`loco-por-ganar`, `lider-japanese`…). */
  id: string;
  /** `Player.id` de quien lo cobra. */
  playerId: string;
};

export type ObjectivesComputation = {
  options: ObjectiveOption[];
  /** Solo aparece quien cobra al menos un objetivo. */
  pointsByPlayer: Map<string, ObjectiveAward>;
  /** Cuántos objetivos tienen al menos un beneficiario hoy. */
  holders: number;
  /** Un objetivo cobrado por jugador; alimenta el registro de hitos. */
  awarded: ObjectiveAwarded[];
};

/** Cliente con la única consulta que necesita este módulo (`db` o una `tx`). */
export type ObjectiveQueryClient = Pick<Prisma.TransactionClient, "$queryRaw">;

export type ObjectiveMatchRow = {
  playerId: string;
  profileId: number;
  name: string;
  avatarUrl: string | null;
  rankLevel: string | null;
  mode: string | null;
  result: string;
  civ: string | null;
  civRandomized: boolean;
  map: string | null;
  durationSeconds: number | null;
  /**
   * Métricas del summary de la partida (`src/lib/aoe4world/summary.ts`). `null`
   * significa "**no hay summary**", no cero: una partida sin summary no puede
   * contar como una sin aldeanos perdidos ni romper una racha por APM bajo.
   * `apm` es la marca de que hay summary.
   */
  apm: number | null;
  feudalAgeSeconds: number | null;
  castleAgeSeconds: number | null;
  imperialAgeSeconds: number | null;
  villagersLost: number | null;
  gildedVillagersLost: number | null;
  mountedVillagersLost: number | null;
  gameId: string;
  leaderboard: string;
  kind: string | null;
  finishedAtMs: number;
};

/**
 * Partidas clasificatorias de los jugadores aprobados, con lo que hace falta
 * para los objetivos, en una sola sentencia.
 *
 * Qué es una partida clasificatoria **no** se decide aquí: sale de
 * `rankedMatchSql()`, el mismo predicado que aplica el `UPDATE` de `Match.points`
 * y el agregado de la clasificación (`src/lib/ranked-match.ts`). Así los
 * objetivos cuentan exactamente las mismas partidas que las victorias, incluido el
 * **corte de inscripción**, el final de la ventana, la marca de revertida y la
 * condición de compañeros de las partidas de equipo. Los cortes rating →
 * subdivisión que esa última necesita los recibe **como argumento**: este módulo no
 * lee `Setting` (los lee `scoring.ts`, una vez por pasada, igual que el ruleset).
 *
 * `map` y `durationSeconds` entran porque los necesitan `por-tierra-y-agua`,
 * `agresor` y `estratega`; antes no se leían. Las columnas del **summary** (`apm`
 * y compañía) entran porque son la única fuente de `ansioso`, los tres
 * `avance-relampago-*` y `defensor-del-pueblo`: las rellena
 * `src/lib/sync-summaries.ts` y sin ellas valen `null` (partida sin summary), que
 * estos objetivos tratan como "no lo sé" y no como cero. Los `finishedAt` viajan
 * como milisegundos: es un número, no una fecha, y evita discutir con la zona
 * horaria de la sesión al cruzar los tiempos. `at time zone 'UTC'` hace falta
 * porque Prisma guarda los `DateTime` como timestamp sin zona interpretado en UTC.
 */
function objectiveRowsQuery(ruleset: ScoringRuleset, cutoffs: LadderCutoffsTable | null): Prisma.Sql {
  return Prisma.sql`
    select p."id" as "playerId",
           p."profileId" as "profileId",
           p."name" as "name",
           p."avatarUrl" as "avatarUrl",
           p."rankLevel" as "rankLevel",
           m."mode" as "mode",
           m."result"::text as "result",
           m."civ" as "civ",
           m."civRandomized" as "civRandomized",
           m."map" as "map",
           m."durationSeconds" as "durationSeconds",
           m."apm" as "apm",
           m."feudalAgeSeconds" as "feudalAgeSeconds",
           m."castleAgeSeconds" as "castleAgeSeconds",
           m."imperialAgeSeconds" as "imperialAgeSeconds",
           m."villagersLost" as "villagersLost",
           m."gildedVillagersLost" as "gildedVillagersLost",
           m."mountedVillagersLost" as "mountedVillagersLost",
           m."gameId" as "gameId",
           m."leaderboard" as "leaderboard",
           m."rawJson" ->> 'kind' as "kind",
           (extract(epoch from m."finishedAt" at time zone 'UTC') * 1000)::double precision as "finishedAtMs"
    from "Match" m
    join "Player" p on p."id" = m."playerId"
    where p."status" = 'APPROVED'
      and ${rankedMatchSql(Prisma.sql`m`, Prisma.sql`p`, ruleset.modes, ruleset.window, cutoffs)}
    order by p."id", m."finishedAt", m."gameId"
  `;
}

export type PlayerMeta = {
  playerId: string;
  profileId: number;
  name: string;
  avatarUrl: string | null;
  rankLevel: string | null;
};

type CivRecord = {
  matches: number;
  wins: number;
  /** Última victoria con esta civ, para el desempate 3. */
  lastWinAt: number;
};

type FormatRecord = {
  matches: number;
  wins: number;
  lastWinAt: number;
};

export type PlayerAggregate = {
  playerId: string;
  profileId: number;
  name: string;
  avatarUrl: string | null;
  rankLevel: string | null;
  matches: number;
  wins: number;
  lastMatchAt: number;
  lastWinAt: number;
  /** Victorias seguidas más larga y cuándo terminó. */
  streak: number;
  streakEndsAt: number;
  /**
   * Racha **actual** del torneo, firmada (positiva = victorias seguidas,
   * negativa = derrotas), o `null` sin ninguna clasificatoria. Es distinta de
   * `streak` (la más larga del torneo): ver `currentTournamentStreak`.
   */
  currentStreak: number | null;
  /** Victorias cortas (`< 10 min`) y largas (`> 20 min`). */
  shortWins: number;
  longWins: number;
  /**
   * Racha **más larga** de partidas clasificatorias seguidas con `APM_THRESHOLD`
   * o más, y cuándo terminó esa racha (para el desempate 3). Una partida sin
   * summary **rompe** la racha: no se sabe si cumplía el umbral, así que no puede
   * contarse como parte de ella.
   */
  apmStreak: number;
  apmStreakEndsAt: number;
  /**
   * Las cuatro hazañas del summary: partidas clasificatorias en las que se llegó a
   * cada edad por debajo del umbral y partidas largas con pocas pérdidas de
   * aldeanos (`defensor-del-pueblo`). Una partida sin summary no cumple ninguna.
   */
  fastFeudal: number;
  fastCastle: number;
  fastImperial: number;
  defenderMatches: number;
  /** Días naturales (Europe/Madrid) con al menos una partida clasificatoria. */
  playedDays: Set<string>;
  byFormat: Map<FormatId, FormatRecord>;
  byCiv: Map<string, CivRecord>;
  /** Partidas clasificatorias por mapa (`Match.map` tal cual). */
  byMap: Map<string, number>;
};

/** Los ids del catálogo en `Set`, para el recuento de civilizaciones dominadas. */
const CATALOG_CIVS: ReadonlySet<string> = new Set(CIVILIZATION_IDS);

/**
 * El día natural de un instante en la zona del torneo.
 *
 * `Europe/Madrid` es la zona que la organización usa para leer el torneo (la misma
 * que `src/lib/alerts/report.ts` para fechas de informe): lo que decide `imparable`
 * es "el día" del calendario de la liga, no el día UTC, que cambiaría de frontera
 * a las 2 de la madrugada local. El formato `en-CA` da `YYYY-MM-DD`, que ordena
 * alfabéticamente igual que cronológicamente.
 */
const MADRID_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Madrid",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function naturalDay(ms: number): string {
  return MADRID_DAY.format(ms);
}

/**
 * El tamaño de la partida, si se puede determinar.
 *
 * `mode` no sirve para esto (`rm_team` colapsa 2v2, 3v3 y 4v4): el tamaño solo
 * está en el `kind` del payload (`rm_2v2`) o, de reserva, en el `leaderboard`.
 * Si no aparece ninguno de los dos, la partida puntúa en todo lo demás pero no
 * entra en ningún `rey-*`.
 */
function resolveFormat(row: ObjectiveMatchRow): FormatId | null {
  for (const candidate of [row.kind, row.leaderboard]) {
    if (candidate === null) {
      continue;
    }

    const match = /^rm_(\d)v(\d)$/.exec(candidate);

    if (match === null || match[1] !== match[2]) {
      continue;
    }

    const format = `${match[1]}v${match[2]}`;

    if ((FORMAT_IDS as readonly string[]).includes(format)) {
      return format as FormatId;
    }
  }

  return null;
}

export function emptyObjectiveAggregate(meta: PlayerMeta): PlayerAggregate {
  return {
    playerId: meta.playerId,
    profileId: meta.profileId,
    name: meta.name,
    avatarUrl: meta.avatarUrl,
    rankLevel: meta.rankLevel,
    matches: 0,
    wins: 0,
    lastMatchAt: 0,
    lastWinAt: 0,
    streak: 0,
    streakEndsAt: 0,
    currentStreak: null,
    shortWins: 0,
    longWins: 0,
    apmStreak: 0,
    apmStreakEndsAt: 0,
    fastFeudal: 0,
    fastCastle: 0,
    fastImperial: 0,
    defenderMatches: 0,
    playedDays: new Set(),
    byFormat: new Map(),
    byCiv: new Map(),
    byMap: new Map(),
  };
}

/**
 * Racha **actual** del torneo, firmada, a partir de las partidas ya ordenadas
 * cronológicamente (`finishedAt`, desempate `gameId`).
 *
 * Positiva = victorias seguidas, negativa = derrotas seguidas, `null` sin
 * ninguna partida. Mira solo el tramo que **termina en la última partida**, así
 * que es distinta de `PlayerAggregate.streak`, que es la racha de victorias
 * **más larga** del torneo (`bienhadado`/`imbatible`). Es la que publica la
 * columna "Racha" de la clasificación.
 *
 * Es pura y se prueba aparte (`tests/unit/lib/objectives.test.ts`); la usa
 * `loadObjectivePlayers` sobre las filas ya ordenadas.
 */
export function currentTournamentStreak(rows: readonly { result: string }[]): number | null {
  let sign = 0;
  let length = 0;

  for (const row of rows) {
    const won = row.result === "WIN";

    if (won ? sign === 1 : sign === -1) {
      length += 1;
    } else {
      sign = won ? 1 : -1;
      length = 1;
    }
  }

  return sign === 0 ? null : sign * length;
}

/**
 * Racha **más larga** de partidas seguidas con `APM_THRESHOLD` o más, y cuándo
 * terminó, a partir de las partidas ya ordenadas cronológicamente.
 *
 * Una partida **sin summary** (`apm === null`) corta la racha: no se sabe si
 * cumplía el umbral, así que darla por buena o por mala sería inventarse el dato.
 *
 * Es pura y se prueba aparte, igual que `currentTournamentStreak`, y la aplica
 * `loadObjectivePlayers` sobre las filas ya ordenadas: la racha es lo único que
 * depende del orden, y dejarla en el barrido privado la haría incomprobable.
 */
export function apmRunStreak(
  rows: readonly { apm: number | null; finishedAtMs: number }[],
): { streak: number; endsAt: number } {
  let run = 0;
  let best = 0;
  let endsAt = 0;

  for (const row of rows) {
    if (row.apm !== null && row.apm >= APM_THRESHOLD) {
      run += 1;

      if (run > best) {
        best = run;
        endsAt = row.finishedAtMs;
      }
    } else {
      run = 0;
    }
  }

  return { streak: best, endsAt };
}

/** Las hazañas del summary que cumple una partida, una a una. */
export type MatchAchievements = {
  fastFeudal: boolean;
  fastCastle: boolean;
  fastImperial: boolean;
  defender: boolean;
};

/**
 * Qué hazañas del summary cumple **una** partida.
 *
 * Pura y por fila, y por eso se prueba sola: las cuatro condiciones llevan umbral
 * y todas tienen que decir "no" cuando el dato no está, que es el caso de una
 * partida sin summary. `null` nunca cumple: un umbral sobre un dato que no existe
 * no se puede afirmar.
 *
 * `defender` exige las **tres** pérdidas leídas a la vez: con una sola a `null` no
 * se puede decir que se defendiera el pueblo.
 */
export function matchAchievements(
  row: Pick<
    ObjectiveMatchRow,
    | "durationSeconds"
    | "feudalAgeSeconds"
    | "castleAgeSeconds"
    | "imperialAgeSeconds"
    | "villagersLost"
    | "gildedVillagersLost"
    | "mountedVillagersLost"
  >,
): MatchAchievements {
  return {
    fastFeudal: row.feudalAgeSeconds !== null && row.feudalAgeSeconds < FAST_FEUDAL_SECONDS,
    fastCastle: row.castleAgeSeconds !== null && row.castleAgeSeconds < FAST_CASTLE_SECONDS,
    fastImperial:
      row.imperialAgeSeconds !== null && row.imperialAgeSeconds < FAST_IMPERIAL_SECONDS,
    defender:
      row.durationSeconds !== null &&
      row.durationSeconds >= DEFENDER_MATCH_SECONDS &&
      row.villagersLost !== null &&
      row.villagersLost < DEFENDER_VILLAGERS_LOST &&
      row.gildedVillagersLost !== null &&
      row.gildedVillagersLost < DEFENDER_GILDED_LOST &&
      row.mountedVillagersLost !== null &&
      row.mountedVillagersLost < DEFENDER_MOUNTED_LOST,
  };
}

/**
 * Agrega las partidas de un jugador ya ordenadas por `finishedAt`.
 *
 * La racha de victorias se calcula aquí, en el mismo barrido: es el único cálculo
 * que depende del orden, y hacerlo en el cliente de la consulta obligaría a guardar
 * la partida entera en memoria. Los días (`imparable`), las partidas cortas y largas
 * (`agresor`/`estratega`), los mapas (`por-tierra-y-agua`) y las cuatro hazañas del
 * summary salen del mismo recorrido. La racha de APM (`ansioso`) es la otra que
 * depende del orden y se calcula aparte, con `apmRunStreak()`, para que sea
 * comprobable sin base de datos.
 *
 * ## Lo que una partida sin summary no puede decir
 *
 * Los cinco objetivos que salen del summary cuentan con los datos presentes: una
 * partida sin él no cumple ninguna hazaña (ver `matchAchievements()`) y corta la
 * racha de APM. Es el mismo criterio que el `null` de `historyPublic`: lo que no se
 * ha podido leer no se escribe.
 */
export function applyObjectiveMatch(
  aggregate: PlayerAggregate,
  row: ObjectiveMatchRow,
  ruleset: ScoringRuleset,
): void {
  const won = row.result === "WIN";

  aggregate.matches += 1;
  aggregate.lastMatchAt = row.finishedAtMs;
  aggregate.playedDays.add(naturalDay(row.finishedAtMs));

  if (won) {
    aggregate.wins += 1;
    aggregate.lastWinAt = row.finishedAtMs;

    if (row.durationSeconds !== null) {
      if (row.durationSeconds < SHORT_MATCH_SECONDS) {
        aggregate.shortWins += 1;
      } else if (row.durationSeconds > LONG_MATCH_SECONDS) {
        aggregate.longWins += 1;
      }
    }
  }

  const achievements = matchAchievements(row);

  if (achievements.fastFeudal) {
    aggregate.fastFeudal += 1;
  }

  if (achievements.fastCastle) {
    aggregate.fastCastle += 1;
  }

  if (achievements.fastImperial) {
    aggregate.fastImperial += 1;
  }

  if (achievements.defender) {
    aggregate.defenderMatches += 1;
  }

  const format = resolveFormat(row);

  if (format !== null) {
    const record = aggregate.byFormat.get(format) ?? { matches: 0, wins: 0, lastWinAt: 0 };
    record.matches += 1;

    if (won) {
      record.wins += 1;
      record.lastWinAt = row.finishedAtMs;
    }

    aggregate.byFormat.set(format, record);
  }

  if (row.map !== null) {
    aggregate.byMap.set(row.map, (aggregate.byMap.get(row.map) ?? 0) + 1);
  }

  // Las partidas con civ aleatoria no dicen nada de la civilización de nadie: se
  // excluyen de todos los objetivos de civilización. No afectan a los demás.
  if (row.civ === null || (!ruleset.countRandomizedCivs && row.civRandomized)) {
    return;
  }

  const civ = aggregate.byCiv.get(row.civ) ?? { matches: 0, wins: 0, lastWinAt: 0 };

  civ.matches += 1;

  if (won) {
    civ.wins += 1;
    civ.lastWinAt = row.finishedAtMs;
  }

  aggregate.byCiv.set(row.civ, civ);
}

/**
 * Agrega las partidas de un jugador **en orden cronológico** y cierra la racha
 * más larga de victorias.
 *
 * La racha vive fuera de `applyObjectiveMatch()` a propósito: es la única parte que
 * depende del orden y del estado anterior, y el backfill de liderazgos la mantiene a
 * mano con su propio contador, sin duplicar el resto de la agregación.
 */
function aggregatePlayer(
  aggregate: PlayerAggregate,
  rows: ObjectiveMatchRow[],
  ruleset: ScoringRuleset,
): void {
  let run = 0;

  for (const row of rows) {
    applyObjectiveMatch(aggregate, row, ruleset);

    if (row.result === "WIN") {
      run += 1;

      if (run > aggregate.streak) {
        aggregate.streak = run;
        aggregate.streakEndsAt = row.finishedAtMs;
      }
    } else {
      run = 0;
    }
  }
}

/**
 * Partidas clasificatorias → agregados por jugador, listos para los objetivos.
 *
 * Una sola consulta y ninguna por fila: 1300 partidas hoy y decenas de miles en el
 * peor caso, todo cabe en el mismo barrido. Los `cutoffs` son los de la condición
 * de equipos del predicado y los pasa quien llama (el motor de puntos los ha leído
 * de `Setting` una sola vez por pasada).
 */
export async function loadObjectiveMatchRows(
  client: ObjectiveQueryClient,
  ruleset: ScoringRuleset,
  cutoffs: LadderCutoffsTable | null,
): Promise<ObjectiveMatchRow[]> {
  if (ruleset.modes.length === 0) {
    return [];
  }

  return client.$queryRaw<ObjectiveMatchRow[]>(objectiveRowsQuery(ruleset, cutoffs));
}

export async function loadObjectivePlayers(
  client: ObjectiveQueryClient,
  ruleset: ScoringRuleset,
  cutoffs: LadderCutoffsTable | null,
): Promise<PlayerAggregate[]> {
  const rows = await loadObjectiveMatchRows(client, ruleset, cutoffs);
  const byPlayer = new Map<string, { meta: PlayerMeta; rows: ObjectiveMatchRow[] }>();

  for (const row of rows) {
    const entry = byPlayer.get(row.playerId);

    if (entry !== undefined) {
      entry.rows.push(row);
      continue;
    }

    byPlayer.set(row.playerId, {
      meta: {
        playerId: row.playerId,
        profileId: row.profileId,
        name: row.name,
        avatarUrl: row.avatarUrl,
        rankLevel: row.rankLevel,
      },
      rows: [row],
    });
  }

  const players: PlayerAggregate[] = [];

  for (const { meta, rows: playerRows } of byPlayer.values()) {
    // La consulta ya ordena, pero el orden sostiene la racha: no se deja en manos
    // del planificador.
    const ordered = [...playerRows].sort(
      (a, b) =>
        a.finishedAtMs - b.finishedAtMs ||
        (a.gameId < b.gameId ? -1 : a.gameId > b.gameId ? 1 : 0),
    );

    const aggregate = emptyObjectiveAggregate(meta);
    aggregatePlayer(aggregate, ordered, ruleset);
    // La racha actual y la de APM salen del mismo orden cronológico; se calculan
    // aparte para que las partes puras sean comprobables por sí solas.
    aggregate.currentStreak = currentTournamentStreak(ordered);

    const apm = apmRunStreak(ordered);
    aggregate.apmStreak = apm.streak;
    aggregate.apmStreakEndsAt = apm.endsAt;

    players.push(aggregate);
  }

  players.sort((a, b) => a.profileId - b.profileId);

  return players;
}

/* -------------------------------------------------------------------------- */
/* Cálculo                                                                    */
/* -------------------------------------------------------------------------- */

type ObjectiveCandidate = {
  player: PlayerAggregate;
  metric: ObjectiveMetric;
  /** Valor de la métrica (partidas, victorias, racha, días…). */
  value: number;
  /** Partidas de las que sale `value`. */
  matches: number;
  /** Cumple la condición: posee la competición o completa el logro. */
  eligible: boolean;
  /** Cuándo se alcanzó `value`, para el desempate 3. */
  achievedAt: number;
  detail: ObjectiveDetail | null;
  /** Avance por mapa, solo en `por-tierra-y-agua` (ver `ObjectiveContender.mapGaps`). */
  mapGaps: ObjectiveMapGap[] | null;
};

function candidate(
  player: PlayerAggregate,
  metric: ObjectiveMetric,
  value: number,
  matches: number,
  eligible: boolean,
  achievedAt: number,
  detail: ObjectiveDetail | null = null,
  mapGaps: ObjectiveMapGap[] | null = null,
): ObjectiveCandidate {
  return { player, metric, value, matches, eligible, achievedAt, detail, mapGaps };
}

/**
 * Cadena de desempate: métrica, victorias, antigüedad y `profileId`.
 *
 * Todas las métricas del catálogo son cantidades enteras, así que la comparación
 * es una resta; el desempate termina en `profileId`, que es único.
 */
function compareCandidates(a: ObjectiveCandidate, b: ObjectiveCandidate): number {
  if (a.value !== b.value) {
    return b.value - a.value;
  }

  if (a.player.wins !== b.player.wins) {
    return b.player.wins - a.player.wins;
  }

  if (a.achievedAt !== b.achievedAt) {
    return a.achievedAt - b.achievedAt;
  }

  return a.player.profileId - b.player.profileId;
}

function toContender(value: ObjectiveCandidate): ObjectiveContender {
  return {
    profileId: value.player.profileId,
    name: value.player.name,
    avatarUrl: value.player.avatarUrl,
    profileUrl: aoe4WorldProfileUrl(value.player.profileId),
    value: value.value,
    matches: value.matches,
    eligible: value.eligible,
    detail: value.detail,
    // Solo donde aplica: en el snapshot de `Setting` hay un contendiente por
    // objetivo y jugador, y un `null` por contender engordaría el documento sin
    // decir nada.
    ...(value.mapGaps === null ? {} : { mapGaps: value.mapGaps }),
  };
}

export type ObjectiveStanding = {
  /** Posición 1-based entre los aspirantes; `null` fuera del ranking. */
  position: number | null;
  /** Distancia al líder en la unidad de la métrica; `null` fuera del ranking. */
  distance: number | null;
};

/**
 * Posición y distancia al primero de un participante dentro del ranking de un
 * objetivo.
 *
 * `position` es 1-based (`1` es el líder) y `distance` son las unidades enteras
 * que le faltan. Los dos son `null` cuando el participante **no aparece** en el
 * ranking: `ObjectiveOption.ranking` solo lleva a quien tiene al menos una partida
 * dentro del objetivo, así que su ausencia significa "no disputa este objetivo
 * ahora mismo", no "va último".
 *
 * Es puro: solo depende del ranking ya ordenado que publica `computeObjectives`.
 */
export function objectiveStanding(
  ranking: readonly ObjectiveContender[],
  profileId: number,
): ObjectiveStanding {
  const index = ranking.findIndex((contender) => contender.profileId === profileId);

  if (index === -1 || ranking.length === 0) {
    return { position: null, distance: null };
  }

  return {
    position: index + 1,
    distance: ranking[0].value - ranking[index].value,
  };
}

/**
 * Cuántas civilizaciones del catálogo cumplen una condición sobre su registro.
 *
 * `byCiv` no se limita al catálogo: guarda la civ que venga en la partida, que
 * puede ser de un DLC que el catálogo todavía no conoce. Para los objetivos
 * globales solo cuentan las del catálogo, y por eso el filtro es explícito.
 */
function countCivs(
  byCiv: ReadonlyMap<string, CivRecord>,
  predicate: (record: CivRecord) => boolean,
): number {
  let count = 0;

  for (const civId of CATALOG_CIVS) {
    const record = byCiv.get(civId);

    if (record !== undefined && predicate(record)) {
      count += 1;
    }
  }

  return count;
}

/** Cuántos mapas del pool llevan al menos `MATCHES_PER_MAP` partidas. */
function countPoolMaps(byMap: ReadonlyMap<string, number>, mapPool: readonly string[]): number {
  let count = 0;

  for (const map of mapPool) {
    if ((byMap.get(map) ?? 0) >= MATCHES_PER_MAP) {
      count += 1;
    }
  }

  return count;
}

/**
 * Los mapas del pool que a un jugador le faltan, con las partidas que le faltan en
 * cada uno (`missing`, 1..3). Los completos no aparecen.
 *
 * Ordenado de menos a más `missing` y, a igualdad, en el orden del pool: el `sort`
 * de `Array` es estable desde ES2019, así que basta con recorrer el pool en orden y
 * pedir el orden por `missing`. El umbral (`MATCHES_PER_MAP`) no se publica: el dato
 * ya va masticado como "cuántas partidas le faltan".
 */
function mapGapsFor(
  byMap: ReadonlyMap<string, number>,
  mapPool: readonly string[],
): ObjectiveMapGap[] {
  const gaps: ObjectiveMapGap[] = [];

  for (const map of mapPool) {
    const missing = MATCHES_PER_MAP - (byMap.get(map) ?? 0);

    if (missing > 0) {
      gaps.push({ map, missing });
    }
  }

  return gaps.sort((a, b) => a.missing - b.missing);
}

function candidatesFor(
  definition: ObjectiveDefinition,
  players: readonly PlayerAggregate[],
  mapPool: readonly string[],
): ObjectiveCandidate[] {
  if (definition.id === "loco-por-ganar") {
    return players
      .filter((player) => player.matches >= 1)
      .map((player) =>
        candidate(player, "partidas", player.matches, player.matches, true, player.lastMatchAt),
      );
  }

  if (definition.id === IMPARABLE_ID) {
    return players
      .filter((player) => player.playedDays.size >= 1)
      .map((player) =>
        candidate(player, "dias", player.playedDays.size, player.matches, true, player.lastMatchAt),
      );
  }

  if (definition.id === VICTORIAS_ID) {
    // El ranking son todos los que han ganado algo, que es exactamente quien cobra:
    // el objetivo no tiene umbral, se repite con cada victoria.
    return players
      .filter((player) => player.wins >= 1)
      .map((player) =>
        candidate(player, "victorias", player.wins, player.matches, true, player.lastWinAt),
      );
  }

  if (definition.id === "bienhadado") {
    return players
      .filter((player) => player.streak >= 1)
      .map((player) =>
        candidate(player, "racha", player.streak, player.matches, true, player.streakEndsAt),
      );
  }

  if (definition.id === "imbatible") {
    return players
      .filter((player) => player.streak >= 1)
      .map((player) =>
        candidate(
          player,
          "racha",
          player.streak,
          player.matches,
          player.streak >= IMBATIBLE_STREAK,
          player.streakEndsAt,
        ),
      );
  }

  if (definition.id === ANSIOSO_ID) {
    // Como `imbatible`, pero con la racha de APM y sin mirar el resultado: el valor
    // que se pinta es la racha más larga de partidas con el ritmo por encima del
    // umbral, y quien llega a `ANSIOSO_STREAK` la cobra.
    return players
      .filter((player) => player.apmStreak >= 1)
      .map((player) =>
        candidate(
          player,
          "racha",
          player.apmStreak,
          player.matches,
          player.apmStreak >= ANSIOSO_STREAK,
          player.apmStreakEndsAt,
        ),
      );
  }

  if (
    definition.id === FAST_FEUDAL_ID ||
    definition.id === FAST_CASTLE_ID ||
    definition.id === FAST_IMPERIAL_ID
  ) {
    const field =
      definition.id === FAST_FEUDAL_ID
        ? "fastFeudal"
        : definition.id === FAST_CASTLE_ID
          ? "fastCastle"
          : "fastImperial";

    return players.flatMap((player) => {
      const value = player[field];

      if (value < 1) {
        return [];
      }

      return [
        candidate(
          player,
          "partidas",
          value,
          player.matches,
          value >= HAZANA_MATCHES,
          // El umbral es una sola partida, así que el desempate 3 no llega a
          // aplicarse: cualquier fecha sirve y se usa la de la última partida.
          player.lastMatchAt,
        ),
      ];
    });
  }

  if (definition.id === DEFENDER_ID) {
    return players.flatMap((player) => {
      const value = player.defenderMatches;

      if (value < 1) {
        return [];
      }

      return [
        candidate(
          player,
          "partidas",
          value,
          player.matches,
          value >= HAZANA_MATCHES,
          player.lastMatchAt,
        ),
      ];
    });
  }

  if (definition.id === "agresor" || definition.id === "estratega") {
    const field = definition.id === "agresor" ? "shortWins" : "longWins";

    return players.flatMap((player) => {
      const value = player[field];

      if (value < 1) {
        return [];
      }

      return [
        candidate(
          player,
          "victorias",
          value,
          player.matches,
          value >= WINS_PER_CIV,
          player.lastWinAt,
        ),
      ];
    });
  }

  if (definition.id === POR_TIERRA_ID) {
    return players.flatMap((player) => {
      const covered = countPoolMaps(player.byMap, mapPool);

      if (covered < 1) {
        return [];
      }

      return [
        candidate(
          player,
          "mapas",
          covered,
          player.matches,
          mapPool.length > 0 && covered === mapPool.length,
          player.lastMatchAt,
          null,
          mapGapsFor(player.byMap, mapPool),
        ),
      ];
    });
  }

  if (definition.group === "formato") {
    const format = definition.id.slice("rey-".length) as FormatId;

    return players.flatMap((player) => {
      const record = player.byFormat.get(format);

      if (record === undefined || record.matches < 1) {
        return [];
      }

      return [
        candidate(
          player,
          "victorias",
          record.wins,
          record.matches,
          record.wins >= 1,
          record.lastWinAt,
        ),
      ];
    });
  }

  if (definition.id === POLIFACETICO_ID || definition.id === JUGON_ID) {
    const wins = definition.id === POLIFACETICO_ID;

    return players.flatMap((player) => {
      const value = wins
        ? countCivs(player.byCiv, (record) => record.wins >= WINS_PER_CIV)
        : countCivs(player.byCiv, (record) => record.matches >= MATCHES_PER_CIV);

      if (value < 1) {
        return [];
      }

      return [
        candidate(
          player,
          "civilizaciones",
          value,
          player.matches,
          value === CIVILIZATION_IDS.length,
          player.lastWinAt,
        ),
      ];
    });
  }

  // Civilizaciones: `masterizando-<civ>` (competición), `lider-<civ>` y
  // `acolito-<civ>` (logros). Los tres comparten el registro por civ.
  const isMasterizando = definition.id.startsWith("masterizando-");
  const isLider = definition.id.startsWith("lider-");
  const civ = isMasterizando
    ? definition.id.slice("masterizando-".length)
    : isLider
      ? definition.id.slice("lider-".length)
      : definition.id.slice("acolito-".length);

  return players.flatMap((player) => {
    const record = player.byCiv.get(civ);

    if (record === undefined) {
      return [];
    }

    if (isMasterizando) {
      if (record.wins < 1) {
        return [];
      }

      return [
        candidate(player, "victorias", record.wins, record.matches, true, record.lastWinAt),
      ];
    }

    if (isLider) {
      if (record.wins < 1) {
        return [];
      }

      return [
        candidate(
          player,
          "victorias",
          record.wins,
          record.matches,
          record.wins >= WINS_PER_CIV,
          record.lastWinAt,
        ),
      ];
    }

    if (record.matches < 1) {
      return [];
    }

    return [
      candidate(
        player,
        "partidas",
        record.matches,
        record.matches,
        record.matches >= MATCHES_PER_CIV,
        record.lastWinAt,
      ),
    ];
  });
}

/** El umbral de un logro, listo para la barra de avance de la interfaz. */
function targetFor(
  definition: ObjectiveDefinition,
  mapPool: readonly string[],
): ObjectiveTarget | null {
  if (definition.kind === "competition") {
    return null;
  }

  // `victorias` no se completa nunca: se repite con cada victoria y no tiene tope,
  // así que no hay barra de avance que pintar. Es la única excepción del tipo
  // "sin umbral", y por eso `target: null` en la opción ya identifica el objetivo.
  if (definition.id === VICTORIAS_ID) {
    return null;
  }

  return {
    unit: definition.metric,
    value: definition.id === POR_TIERRA_ID ? mapPool.length : (definition.target ?? 0),
  };
}

/**
 * Resuelve el catálogo contra las reglas activas y el pool de mapas.
 *
 * Devuelve los puntos por jugador, que es lo que suma el motor a la clasificación:
 * en una competición solo el poseedor recibe sus puntos; en un logro, cada
 * beneficiario los suyos, con dos repartos variables —`imparable` los da por día,
 * con tope, y `victorias` paga `ruleset.pointsPerWin` por victoria, sin tope—. Un
 * objetivo sin nadie que lo cumpla no reparte nada.
 *
 * Los objetivos **desactivados** (`ruleset.disabledObjectives`) se saltan antes de
 * calcular nada: no entran en `options` (así no se publican ni entran en el
 * snapshot), no reparten puntos y no aparecen en `awarded`, que es lo que hace que
 * `reconcileObjectiveEvents()` borre sus eventos y que
 * `reconcileObjectiveLeadEvents()` anote la pérdida de su poseedor.
 */
export function computeObjectives(
  players: readonly PlayerAggregate[],
  ruleset: ScoringRuleset,
  mapPool: readonly string[],
): ObjectivesComputation {
  const options: ObjectiveOption[] = [];
  const pointsByPlayer = new Map<string, ObjectiveAward>();
  const awarded: ObjectiveAwarded[] = [];
  const desactivados = new Set(ruleset.disabledObjectives);
  let holders = 0;

  const addAward = (playerId: string, id: string, points: number, count: number): void => {
    const award = pointsByPlayer.get(playerId) ?? { points: 0, earned: [], awards: {} };

    award.points += points;
    award.earned.push(id);
    award.awards[id] = { points, count };
    pointsByPlayer.set(playerId, award);
  };

  for (const definition of OBJECTIVE_DEFINITIONS) {
    // Un objetivo desactivado no existe para el motor, y por eso se salta antes de
    // calcular sus candidatos: tampoco es un ranking que se publique.
    if (desactivados.has(definition.id)) {
      continue;
    }

    const sorted = candidatesFor(definition, players, mapPool).sort(compareCandidates);
    // `victorias` no tiene precio propio: cada victoria vale lo que diga
    // `ruleset.pointsPerWin`, y un `objectives["victorias"]` guardado se ignora para
    // que no haya dos verdades sobre lo que vale una victoria.
    const points =
      definition.id === VICTORIAS_ID
        ? ruleset.pointsPerWin
        : (ruleset.objectives[definition.id] ?? definition.points);

    if (definition.kind === "competition") {
      const holder = sorted[0];
      const winner = holder !== undefined && holder.eligible ? holder : null;

      if (winner !== null) {
        addAward(winner.player.playerId, definition.id, points, 1);
        awarded.push({ id: definition.id, playerId: winner.player.playerId });
        holders += 1;
      }

      options.push({
        id: definition.id,
        group: definition.group,
        kind: definition.kind,
        label: definition.label,
        description: definition.description,
        metric: definition.metric,
        points,
        parent: definition.parent,
        holder: winner === null ? null : toContender(winner),
        ranking: sorted.map(toContender),
        beneficiaries: [],
        target: null,
      });

      continue;
    }

    const beneficiaries = sorted.filter((value) => value.eligible);

    for (const beneficiary of beneficiaries) {
      // Los tres repartos de un logro, en un solo sitio: `imparable` paga 1 por día
      // con el tope que marque el ruleset, `victorias` paga por victoria sin tope y
      // el resto cobra los puntos de la tarjeta una sola vez.
      const earned =
        definition.id === VICTORIAS_ID
          ? beneficiary.value * ruleset.pointsPerWin
          : definition.id === IMPARABLE_ID
            ? Math.min(beneficiary.value, points)
            : points;
      const count =
        definition.id === VICTORIAS_ID || definition.id === IMPARABLE_ID ? beneficiary.value : 1;

      addAward(beneficiary.player.playerId, definition.id, earned, count);
      awarded.push({ id: definition.id, playerId: beneficiary.player.playerId });
    }

    if (beneficiaries.length > 0) {
      holders += 1;
    }

    options.push({
      id: definition.id,
      group: definition.group,
      kind: definition.kind,
      label: definition.label,
      description: definition.description,
      metric: definition.metric,
      points,
      parent: definition.parent,
      holder: null,
      ranking: sorted.map(toContender),
      beneficiaries: beneficiaries.map((value) => ({
        profileId: value.player.profileId,
        name: value.player.name,
        avatarUrl: value.player.avatarUrl,
        profileUrl: aoe4WorldProfileUrl(value.player.profileId),
        points:
          definition.id === VICTORIAS_ID
            ? value.value * ruleset.pointsPerWin
            : definition.id === IMPARABLE_ID
              ? Math.min(value.value, points)
              : points,
        count:
          definition.id === VICTORIAS_ID || definition.id === IMPARABLE_ID ? value.value : 1,
      })),
      target: targetFor(definition, mapPool),
    });
  }

  return { options, pointsByPlayer, holders, awarded };
}
