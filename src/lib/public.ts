import "server-only";

import { cache } from "react";
import { Prisma } from "@/generated/prisma/client";
import { MatchResult, ObjectiveLeadKind, PlayerStatus } from "@/generated/prisma/enums";
import { parseGamePlayer } from "@/lib/aoe4world/parse";
import { db } from "@/lib/db";
import { readFromDatabase, type PublicRead } from "@/lib/db-errors";
import { divisionFromRankLevel, type DivisionId } from "@/lib/divisions";
import { type MatcherinoDonations } from "@/lib/donations";
import { readEditionConfig, type EditionConfig } from "@/lib/edition";
import {
  aoe4WorldProfileUrl,
  describeMode,
  describeTeamSize,
  teamSizesFromRawJson,
} from "@/lib/format";
import {
  compareFeedInstants,
  historyFeedPage,
  historyFeedWindows,
  type HistoryFeedWindow,
} from "@/lib/history-feed";
import { isRecord } from "@/lib/json";
import { resolveObjective } from "@/lib/objective-events";
import { OBJECTIVE_LEAD_RANK } from "@/lib/objective-leads";
import {
  OBJECTIVE_DEFINITIONS,
  OBJECTIVE_IDS,
  VICTORIAS_ID,
  objectiveStanding,
  type ObjectiveBeneficiary,
  type ObjectiveContender,
  type ObjectiveDetail,
  type ObjectiveGroup,
  type ObjectiveKind,
  type ObjectiveMapGap,
  type ObjectiveMetric,
  type ObjectiveOption,
  type ObjectiveTarget,
} from "@/lib/objectives";
import { rankedModesWhere, classificatoryWhere, windowBounds } from "@/lib/ranked-match";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  dateRangeWhere,
  hasDateBounds,
  paginate,
  readBoundedInt,
  readSingleParam,
  type DateRange,
  type QueryParam,
} from "@/lib/query-params";
import { readMatcherinoDonations, readSyncRunTrace } from "@/lib/settings";
import {
  RULESET_VERSION,
  loadObjectiveView,
  playerObjectiveAwards,
  readObjectiveAwards,
  readRuleset,
  type ScoringRuleset,
} from "@/lib/scoring";
import {
  normalizeKickChannel,
  normalizeTwitchChannel,
  normalizeYoutubeChannel,
} from "@/lib/stream-channels";

export { getObjectives } from "@/lib/scoring";
export type {
  ObjectiveBeneficiary,
  ObjectiveContender,
  ObjectiveDefinition,
  ObjectiveDetail,
  ObjectiveGroup,
  ObjectiveKind,
  ObjectiveMapGap,
  ObjectiveMetric,
  ObjectiveOption,
  ObjectiveTarget,
  ObjectiveView,
} from "@/lib/objectives";
export {
  IMPARABLE_ID,
  JUGON_ID,
  OBJECTIVE_GROUP_LABELS,
  POLIFACETICO_ID,
  POR_TIERRA_ID,
  VICTORIAS_ID,
} from "@/lib/objectives";
export { DIVISIONS } from "@/lib/divisions";
export type { Division, DivisionId } from "@/lib/divisions";
export type { MatcherinoDonations } from "@/lib/donations";
export type { EditionConfig } from "@/lib/edition";

/**
 * El resultado de una lectura de las pantallas públicas: o los datos, o la
 * señal de que la base de datos no ha podido leer.
 *
 * Se reexporta desde aquí para que quien pinta importe del mismo sitio que las
 * funciones: `import { type PublicRead } from "@/lib/public"`.
 */
export type { PublicRead };

/**
 * Capa de lectura de las páginas públicas.
 *
 * Es la **única** puerta de entrada a la base de datos para el frontend: la UI no
 * importa `db` directamente, solo estas funciones (las seis de abajo más los
 * tipos que se reexportan). Cada una devuelve
 * exactamente los campos que necesita su pantalla, ya convertidos al tipo público,
 * para que ni la interfaz ni el cliente del navegador tengan que conocer la forma
 * de las tablas.
 *
 * ## Aviso importante para quien pinte estas pantallas
 *
 * Estas funciones leen de la base de datos en cada llamada, sin caché: no hay forma
 * de que un lector vea una clasificación vieja. Pero eso hace que **la página que
 * las llama tenga que ser dinámica**. Una página estática se genera en el `next
 * build` y su resultado se queda congelado en el HTML, así que la clasificación
 * dejaría de moverse sola por mucho que el worker recalcule cada 10 minutos. Lo más
 * simple y explícito es declararlo en la propia página:
 *
 * ```tsx
 * export const dynamic = "force-dynamic";
 * ```
 *
 * Alternativa si se prefiere dejar la decisión en el componente: llamar a
 * `await connection()` de `next/server` antes de leer.
 *
 * ## Por qué devuelven `PublicRead<T>` y no el dato pelado
 *
 * Un corte de la base de datos (límite de conexiones de Supabase, un reinicio, un
 * pico de red) no puede ser un 500 con una traza en el log. Las tres funciones que
 * leen Postgres devuelven un `PublicRead<T>`:
 *
 * ```ts
 * const { status, data } = await getStandings();
 * // status === "ok"       -> data es Standings (data.rows son las filas)
 * // status === "degraded" -> data es null; hay que decirlo, no pintar un vacío
 * ```
 *
 * `data` es `null` y **no** una lista vacía a propósito: una lista vacía la leería
 * la pantalla como "no hay participantes" o "no hay partidas en juego", que es una
 * afirmación falsa. Con `null` quien pinte está obligado a distinguir "no hay
 * nada" de "no lo hemos podido saber", que es justo lo que se le pide. El motivo
 * del fallo no viene en el objeto: esto se serializa al navegador dentro del
 * *payload* de RSC, así que el detalle se queda en el log del servidor, con el
 * prefijo `[db]`.
 *
 * Para las **herramientas de `scripts/`**, que sí deben abortar cuando la base no
 * responde, está `unwrapRead()` de `@/lib/db-errors`.
 *
 * No hace falta cachear nada más: son decenas de filas con índices pensados para
 * estas consultas, y el cuello de botella del sitio no es la base de datos sino la
 * cadencia con la que AoE4World publica los resultados.
 */

/**
 * Las divisiones (`DIVISIONS`, `DivisionId`, `divisionFromRankLevel`) viven en
 * `src/lib/divisions.ts`, que también las usa el motor de objetivos; se
 * reexportan aquí para no romper a la UI que ya las importaba de este archivo.
 */

/**
 * Un objetivo especial que un participante posee ahora mismo, ya resuelto.
 *
 * `label`, `group`, `kind`, `description` y `metric` vienen del catálogo de
 * `objectives.ts`; `points` y `count` salen del **desglose** de esa fila, que es
 * donde el motor guarda lo que se cobró de verdad: `imparable` reparte 1 punto por
 * día con tope y `victorias`, `pointsPerWin` por victoria, así que el precio del
 * catálogo (el tope del primero, el precio por unidad del segundo) no es lo que el
 * jugador se llevó. `count` es el número de repeticiones —días, victorias o 1— y es
 * lo que permite pintar `2 x Imparable +2`.
 *
 * Una fila escrita antes de que el desglose guardara ese detalle no lo trae: se cae
 * entonces al precio del catálogo y a una repetición, que es lo máximo que aquella
 * fila permite afirmar.
 *
 * `id`, `group` y `metric` son exactamente los tres campos que necesita
 * `ObjectiveIcon` para elegir su glifo, así que un objetivo de la clasificación
 * se puede pintar con el mismo icono que su tarjeta en `/objetivos`. `kind` es lo
 * que decide a qué columna del desglose van sus puntos: los logros al de puntos
 * permanentes y las competiciones al de temporales (ver `StandingRow`).
 */
export type StandingObjective = {
  /** Id estable del objetivo (`loco-por-ganar`, `rey-1v1`, `lider-…`). */
  id: string;
  label: string;
  group: ObjectiveGroup;
  /** Forma de cobrarlo, tal cual está en el catálogo. */
  kind: ObjectiveKind;
  /** La regla en una frase, tal cual está en el catálogo. */
  description: string;
  /** Métrica que lo decide: de aquí sale el glifo de los grupos sin asset. */
  metric: ObjectiveMetric;
  /** Puntos **cobrados** por esta fila; el precio de catálogo si el desglose no lo trae. */
  points: number;
  /** Repeticiones que ha conseguido: días, victorias o 1 (ver el tipo). */
  count: number;
};

/** Una fila de la clasificación general, en el orden en que la web la muestra. */
export type StandingRow = {
  rank: number;
  profileId: number;
  /** Nombre de display: el que escribió quien se inscribió. */
  name: string;
  /**
   * Nombre oficial de AoE4World, que vive en su propia columna para poder
   * publicarlo debajo del de display sin que uno pise al otro. `null` si el
   * jugador aún no se ha sincronizado, y también si por casualidad coinciden:
   * la interfaz decide si merece la pena pintar el segundo.
   */
  aoe4WorldName: string | null;
  /**
   * `Player.country`: el **rótulo canónico** tal cual está en la lista admitida
   * (`Setting["registration.countries"]`, con `DEFAULT_COUNTRIES` de respaldo),
   * no un código ISO, para que quien lo pinte pueda resolver la bandera sin un
   * diccionario aparte.
   *
   * Llega sin resolver y sin normalizar, igual que en el panel: eso ya lo hizo
   * `parseCountry()` al validarlo. Y es `null` por dos razones que la interfaz
   * tiene que distinguir o no distinguir según el caso: ni el alta de admin lo
   * exige (es opcional) ni las filas anteriores a la columna lo traen. Por eso
   * aquí no se sustituye por un rótulo inventado: `null` significa "no lo
   * sabemos" y lo correcto es no pintar nada.
   */
  country: string | null;
  /**
   * Puntos del torneo (`PlayerScore.total`), no de la ladder. Es la suma exacta de
   * las dos columnas siguientes.
   */
  points: number;
  /**
   * Parte de `points` que aportan los objetivos **permanentes**: los logros
   * (`kind: "achievement"`), que se cobran al cumplirlos y no se pierden.
   *
   * Es el **resto** de `points` tras restar las competiciones, y no la suma de los
   * precios del catálogo: `imparable` reparte 1 punto por día con tope y `victorias`
   * paga por victoria sin tope, así que sus precios de catálogo no son lo que el
   * jugador cobró (ver `splitStandingPoints`). Aquí caen también los ids del desglose
   * que ya no están en el catálogo, que no se pueden atribuir a ninguna competición.
   */
  pointsByAchievements: number;
  /**
   * Parte de `points` que aportan los objetivos **temporales**: las competiciones
   * (`kind: "competition"`), que se deciden al cierre y pueden cambiar de dueño.
   *
   * Salen de sumar el precio de catálogo de las competiciones que el jugador posee,
   * recortado al total de objetivos de la fila. Es lo único del reparto que se
   * calcula en positivo, porque el motor cobra exactamente ese precio; los logros
   * van por resta.
   */
  pointsByCompetitions: number;
  wins: number;
  /** Derrotas (`PlayerScore.matches - wins`). */
  losses: number;
  elo: number | null;
  /** Derivada de `rankLevel`; `null` si no está clasificado. */
  division: DivisionId | null;
  rankLevel: string | null;
  /**
   * Racha **actual del torneo**, firmada: positiva = victorias clasificatorias
   * seguidas, negativa = derrotas seguidas. `null` sin ninguna partida contada
   * (la UI pinta "-"; no se usa `0` porque se pintaría "0"). Sale de
   * `PlayerScore.streak`, no de la racha de la ladder de AoE4World.
   */
  streak: number | null;
  /** Canal para el enlace: el registrado o el extraído de `twitchUrl`. */
  twitchChannel: string | null;
  twitchIsLive: boolean;
  /**
   * Canal de YouTube ya normalizado (handle en minúsculas, sin arroba), o `null`.
   *
   * A diferencia del de Twitch **no hay respaldo**: AoE4World no publica un canal
   * de YouTube en el perfil, así que el valor es el que escribió la persona o el
   * admin, o nada. La normalización es la misma red de seguridad que en Twitch.
   */
  youtubeChannel: string | null;
  /**
   * "En directo" en YouTube. Lo escribe el worker (`src/lib/streams/`) preguntando
   * a la API de YouTube; `false` es también el estado degradado sin
   * `YOUTUBE_API_KEY`, así que **no** significa "no está en directo" sino "no se ha
   * comprobado que lo esté".
   */
  youtubeIsLive: boolean;
  /** Canal de Kick ya normalizado (slug en minúsculas), o `null`. */
  kickChannel: string | null;
  /** "En directo" en Kick, con la misma degradación que `youtubeIsLive`. */
  kickIsLive: boolean;
  /**
   * Tiene una partida **clasificatoria** en curso ahora mismo (`finishedAt IS
   * NULL` y familia del ruleset). Es el mismo criterio que publica
   * `/partidas`: lo que marca aquí sale en la lista, y ni una cosa ni la otra
   * prometen nada que la otra no cumpla.
   */
  isPlaying: boolean;
  avatarUrl: string | null;
  profileUrl: string;
  /**
   * Objetivos especiales que posee, en el orden de presentación del catálogo.
   * Vacío si no posee ninguno: la clasificación no distingue "ninguno" de "no
   * se ha podido leer" porque en ambos casos no hay nada que pintar.
   */
  objectives: StandingObjective[];
};

/**
 * Índice `id -> objetivo` del catálogo, con los puntos del ruleset
 * activo ya aplicados.
 *
 * Se construye en cada llamada (no en el módulo) porque depende de la
 * configuración guardada en `Setting`, que se puede retocar sin desplegar. El
 * orden de inserción es el de presentación del catálogo, y de ahí se apoya
 * `earnedObjectives` para publicar en ese mismo orden.
 *
 * `points` es el precio del **catálogo** y `count` vale 1: esta es la referencia
 * común, no lo que cobró una fila concreta. Para una competición el precio del
 * catálogo **es** lo cobrado (por eso el reparto de `splitStandingPoints` lo usa
 * como base); para un logro, `earnedObjectives` lo sustituye por lo que diga el
 * desglose de esa fila.
 *
 * Los objetivos **desactivados** no entran: el motor tampoco los reparte, así que
 * publicarlos aquí sería enseñar en la ficha de un participante un objetivo que ya
 * no existe (y una fila de `PlayerScore` de antes de desactivarlo podría nombrarlo).
 */
function objectiveLookup(ruleset: ScoringRuleset): Map<string, StandingObjective> {
  const lookup = new Map<string, StandingObjective>();
  const desactivados = new Set(ruleset.disabledObjectives);

  for (const definition of OBJECTIVE_DEFINITIONS) {
    if (desactivados.has(definition.id)) {
      continue;
    }

    lookup.set(definition.id, {
      id: definition.id,
      label: definition.label,
      group: definition.group,
      kind: definition.kind,
      description: definition.description,
      metric: definition.metric,
      // `victorias` no tiene precio propio: vale `pointsPerWin`, igual que en el
      // motor (`computeObjectives`). En el resto, los puntos del ruleset.
      points:
        definition.id === VICTORIAS_ID
          ? ruleset.pointsPerWin
          : (ruleset.objectives[definition.id] ?? definition.points),
      count: 1,
    });
  }

  return lookup;
}

/**
 * La sección `objectives` del desglose, o `null` si no se puede leer.
 *
 * Factoriza la comprobación que comparten `earnedObjectives` y
 * `earnedObjectivesPoints`: el JSON lo escribe el motor de `scoring.ts` y su
 * forma depende de la versión de las reglas que produjo la fila, así que se
 * valida en un único sitio y con el mismo criterio en los dos lectores.
 */
function objectivesSection(breakdown: unknown): Record<string, unknown> | null {
  return isRecord(breakdown) && isRecord(breakdown.objectives) ? breakdown.objectives : null;
}

/**
 * Los ids del `earned` legibles y sin repetir, o `null` si el desglose no los trae
 * como lista.
 *
 * El `null` no es una lista vacía: distingue "esta fila no dice qué cobró" de
 * "dice que no cobró nada", y el reparto de puntos necesita distinguirlos (ver
 * `splitStandingPoints`).
 */
function earnedIds(breakdown: unknown): Set<string> | null {
  const section = objectivesSection(breakdown);

  if (section === null || !Array.isArray(section.earned)) {
    return null;
  }

  return new Set(section.earned.filter((id): id is string => typeof id === "string"));
}

/**
 * Los objetivos poseídos por una fila de la clasificación, con **lo que cobró**.
 *
 * `breakdown` es JSON y lo escribe el motor de `scoring.ts`: se valida en lugar
 * de confiar, porque su forma depende de la versión de las reglas que produjo
 * la fila. Se recorre el catálogo y no la lista guardada, con lo que un id
 * desconocido o repetido no puede colarse en la salida y el orden es siempre el
 * de presentación.
 *
 * El importe y las repeticiones salen de `awards`: es lo que hace que un jugador con
 * tres días de `imparable` publique 3 y no el tope de 14 del catálogo. Una fila
 * anterior a `awards` no trae ese detalle y se publica a precio de catálogo con una
 * repetición, que es lo más que aquella fila permite afirmar.
 *
 * Es `export` como `splitStandingPoints`, y por el mismo motivo: es la parte pura de
 * una fila de la clasificación y así se puede comprobar sin base de datos.
 */
export function earnedObjectives(
  breakdown: unknown,
  lookup: ReadonlyMap<string, StandingObjective>,
): StandingObjective[] {
  const owned = earnedIds(breakdown);

  if (owned === null) {
    return [];
  }

  const awards = readObjectiveAwards(breakdown);
  const objectives: StandingObjective[] = [];

  for (const [id, definition] of lookup) {
    if (!owned.has(id)) {
      continue;
    }

    const award = awards?.[id];

    objectives.push(
      award === undefined ? definition : { ...definition, points: award.points, count: award.count },
    );
  }

  return objectives;
}

/**
 * Los puntos que aportan los objetivos poseídos, tal como los guardó el motor.
 *
 * Se leen de `breakdown.objectives.points` y no sumando los `points` de
 * `objectives`, a propósito: la fila publica el reparto en dos columnas y la suma
 * tiene que cuadrar **siempre**. Con esta lectura, un desglose ausente o mal formado
 * vale 0, y entonces no se atribuye nada a las competiciones y el total entero va a
 * los logros, con lo que la identidad se conserva; sumando los objetivos publicados,
 * en cambio, un desglose antiguo o recortado dejaría las columnas sin sumar el total.
 *
 * Es la referencia del reparto de `splitStandingPoints`: lo que guardó el motor
 * manda sobre lo que valgan hoy los precios del catálogo.
 */
function earnedObjectivesPoints(breakdown: unknown): number {
  const section = objectivesSection(breakdown);
  const points = section === null ? undefined : section.points;

  return typeof points === "number" && Number.isFinite(points) ? points : 0;
}

/** El reparto de `StandingRow.points` en sus dos columnas. */
export type StandingPoints = {
  pointsByAchievements: number;
  pointsByCompetitions: number;
};

/**
 * Reparte `total` entre las dos columnas de la clasificación.
 *
 * Todo punto de un jugador sale de sus objetivos, así que el reparto es el de la
 * **forma de cobro**: los logros (`kind: "achievement"`) se cobran al cumplirlos y no
 * se pierden, y las competiciones (`kind: "competition"`) se deciden al cierre y
 * pueden cambiar de dueño. Las victorias clasificatorias entran en los logros, porque
 * son el objetivo `victorias`. Es la parte pura de `presentStandings()` y por eso vive
 * aparte, para poder comprobar el reparto sin base de datos.
 *
 * ## Por qué las competiciones se calculan y los logros son el resto
 *
 * El desglose guarda el total de puntos de objetivos y los ids que se cobraron, así
 * que uno de los dos tipos hay que reconstruirlo y el otro sale por resta. El que se
 * puede reconstruir es la competición: su precio es fijo en el catálogo
 * (`objectiveLookup` le aplica el ruleset activo) y el motor cobra exactamente ese
 * precio. El de un logro no siempre es fijo: `imparable` reparte 1 punto por día con
 * tope y `victorias` paga por victoria, de modo que sumar precios de logros se
 * quedaría con puntos que aquella fila no cobró. Los logros son, por tanto, el
 * **resto** del total, que sí es exacto.
 *
 * El reparto, en orden:
 *
 * 1. Las competiciones que el jugador posee, con el **importe real** que guardó el
 *    desglose (`awards`) o, en una fila anterior a `awards`, a precio de catálogo: en
 *    una competición el motor cobra exactamente el precio del catálogo, así que el
 *    respaldo es fiel.
 * 2. Recortadas al total de objetivos de la fila: con una fila de una versión
 *    anterior del ruleset los precios de entonces no son los de ahora y la suma
 *    puede pasarse del total.
 * 3. Los logros, el **resto hasta `total`**.
 *
 * Los ids del `earned` que ya no están en el catálogo (un objetivo desactivado, una
 * fila vieja) no se pueden atribuir a ninguna competición, así que caen del lado de
 * los logros. Y si el `earned` no es una lista legible no hay nada que atribuir, así
 * que no hay competiciones y todo el total va a los logros.
 *
 * `pointsByAchievements + pointsByCompetitions` es **siempre** `total`, incluso con el
 * desglose ausente, mal formado o de otra versión de las reglas.
 */
export function splitStandingPoints(
  total: number,
  breakdown: unknown,
  lookup: ReadonlyMap<string, StandingObjective>,
): StandingPoints {
  const objectivesPoints = earnedObjectivesPoints(breakdown);
  const owned = earnedIds(breakdown);

  if (owned === null) {
    return { pointsByAchievements: total, pointsByCompetitions: 0 };
  }

  const awards = readObjectiveAwards(breakdown);
  let competitionsPoints = 0;

  for (const id of owned) {
    const objective = lookup.get(id);

    if (objective === undefined || objective.kind !== "competition") {
      continue;
    }

    competitionsPoints += awards?.[id]?.points ?? objective.points;
  }

  // El recorte nunca sube la columna por encima del total de objetivos, que es el
  // que cuadra con el total de la fila.
  competitionsPoints = Math.max(0, Math.min(competitionsPoints, objectivesPoints));

  return {
    pointsByCompetitions: competitionsPoints,
    pointsByAchievements: total - competitionsPoints,
  };
}

/**
 * De qué versión de reglas salen las filas que publica `getStandings()`.
 *
 * `ruleSetVersion` es la versión con la que se calcularon las filas publicadas: la
 * activa, o la anterior más alta cuando la activa todavía no tiene filas. Si no
 * hay filas que publicar, es la activa (la versión que se consultó).
 * `pendingRuleSetVersion` es la activa sin recalcular **solo** en ese segundo caso
 * —la UI lo usa para avisar de que la tabla es de la versión anterior—, y `null`
 * cuando las filas son de la activa.
 */
export type StandingsVersion = {
  ruleSetVersion: number;
  pendingRuleSetVersion: number | null;
};

/**
 * La clasificación publicada: las filas y de qué versión de reglas son.
 *
 * `rows` vacío no significa "no hay versión anterior": significa que no hay filas
 * que publicar ni en la versión activa ni en ninguna anterior. La UI distingue
 * "vacío" de "otra versión" por `pendingRuleSetVersion`.
 */
export type Standings = StandingsVersion & {
  rows: StandingRow[];
};

/**
 * Decide de qué versión se publican las filas: la activa, o la anterior más alta
 * cuando la activa aún no se ha recalculado.
 *
 * Es la parte pura de `getStandings()` y por eso vive aparte, para poder comprobar
 * los tres casos sin base de datos. No consulta nada: quien llama ya sabe cuántas
 * filas tiene la versión activa y cuál es la anterior con filas.
 *
 * `previousRuleSetVersion` se **ignora** si la versión activa tiene filas: la
 * clasificación nunca mezcla versiones ni prefiere una anterior cuando la activa
 * está calculada.
 */
export function resolveStandingsVersion(
  activeRuleSetVersion: number,
  activeRowCount: number,
  previousRuleSetVersion: number | null,
): StandingsVersion {
  if (activeRowCount > 0) {
    return { ruleSetVersion: activeRuleSetVersion, pendingRuleSetVersion: null };
  }

  if (previousRuleSetVersion !== null) {
    return {
      ruleSetVersion: previousRuleSetVersion,
      pendingRuleSetVersion: activeRuleSetVersion,
    };
  }

  return { ruleSetVersion: activeRuleSetVersion, pendingRuleSetVersion: null };
}

/**
 * Clasificación de la versión de reglas activa, de la primera posición a la
 * última, con respaldo a la **anterior más alta** que tenga filas.
 *
 * Aparecen **todos** los jugadores aprobados: un aprobado que aún no ha jugado
 * ninguna clasificatoria sale con todo a cero y comparte el último puesto con los
 * demás que tampoco hayan jugado. Un `PENDING` o un `REJECTED` no tiene fila y no
 * aparece.
 *
 * ## Por qué hay respaldo
 *
 * `PlayerScore` está particionada por `ruleSetVersion` y cada recálculo escribe
 * **solo** la versión activa (`RULESET_VERSION`). Cuando se sube la versión y
 * todavía no ha corrido el motor —un despliegue a medias, una *preview* contra una
 * base donde solo ha calculado la versión anterior— consultar la activa devolvería
 * cero filas y la web diría "0 participantes", que no es verdad: hay una
 * clasificación calculada, solo que con las reglas de antes.
 *
 * Con la versión activa **vacía** se publican entonces las filas de la versión
 * anterior más alta que tenga alguna (`pendingRuleSetVersion` pasa a ser la
 * activa, para que quien pinte pueda avisar de que la tabla es de otra versión).
 * Si tampoco hay anterior, la lista sale vacía y sin aviso: el estado vacío de la
 * pantalla ya lo explica. La clasificación **nunca** mezcla versiones: o todas las
 * filas de la activa, o todas las de una única anterior.
 *
 * Tres consultas planas, ninguna por fila: la de partidas en directo sirve para
 * marcar `isPlaying` sin N+1 y la del ruleset (una clave de `Setting`) trae los
 * puntos reales de cada objetivo, por si se han retocado sin desplegar. Esa misma
 * lectura del ruleset da la lista de familias con la que se filtran las partidas
 * en directo, así que no hay una segunda definición de qué es una partida del
 * torneo: quien retoca `modes` sin desplegar mueve las dos pantallas a la vez.
 * La consulta de respaldo —un `max(ruleSetVersion)` y, si lo hay, la misma
 * consulta de filas— solo se lanza cuando la activa devuelve cero filas, así que
 * el caso normal sigue costando exactamente lo de antes.
 *
 * Con la base de datos caída devuelve `{ status: "degraded", data: null }` en vez
 * de propagar el error: la portada del torneo tiene que seguir contestando.
 */
export async function getStandings(): Promise<PublicRead<Standings>> {
  return readFromDatabase("public/getStandings", loadStandings);
}

/**
 * Las columnas de `PlayerScore` que publica la clasificación.
 *
 * Se declara fuera de la consulta para no repetir la lista de campos entre la
 * lectura de la versión activa y la de respaldo, que son la misma consulta con
 * distinto `ruleSetVersion`.
 */
const STANDING_SELECT = {
  rank: true,
  total: true,
  wins: true,
  // No sale en `StandingRow`, pero hace falta aquí para calcular `losses`.
  matches: true,
  // La racha del torneo, que es la que pinta la columna "Racha".
  streak: true,
  // Solo se lee la sección `objectives` de este JSON (`earned` y `points`).
  // Prisma no permite pedir una parte de una columna `Json`, así que entra
  // entero: son un puñado de ids por fila, no un documento grande.
  breakdown: true,
  player: {
    select: {
      id: true,
      profileId: true,
      name: true,
      aoe4WorldName: true,
      country: true,
      twitchChannel: true,
      twitchUrl: true,
      twitchIsLive: true,
      youtubeChannel: true,
      youtubeIsLive: true,
      kickChannel: true,
      kickIsLive: true,
      elo: true,
      rankLevel: true,
      avatarUrl: true,
    },
  },
} satisfies Prisma.PlayerScoreSelect;

type StandingSource = Prisma.PlayerScoreGetPayload<{ select: typeof STANDING_SELECT }>;

/**
 * Las filas de `PlayerScore` de una versión, en el orden de presentación.
 *
 * `rank` solo no basta: dos filas empatadas comparten puesto, así que dentro de
 * un puesto el orden sería el que decidiera el plan de la consulta (y podría
 * bailar entre lecturas, o al paginar). `profileId` ascendente es el mismo
 * desempate de presentación que cierra `compareStandings`, así que el orden de la
 * consulta y el del motor coinciden.
 */
async function readStandingRows(ruleSetVersion: number): Promise<StandingSource[]> {
  return db.playerScore.findMany({
    where: { ruleSetVersion },
    orderBy: [{ rank: "asc" }, { player: { profileId: "asc" } }],
    select: STANDING_SELECT,
  });
}

/**
 * La versión de reglas anterior más alta **que tenga filas**, o `null` si no hay
 * ninguna.
 *
 * Se pregunta por el máximo de la columna y no se traen filas para decidir: lo
 * único que hace falta es el número, y el índice `(ruleSetVersion, rank)` resuelve
 * el máximo sin recorrer la tabla.
 */
async function previousRuleSetVersion(): Promise<number | null> {
  const highest = await db.playerScore.aggregate({
    where: { ruleSetVersion: { lt: RULESET_VERSION } },
    _max: { ruleSetVersion: true },
  });

  return highest._max.ruleSetVersion;
}

async function loadStandings(): Promise<Standings> {
  // La consulta de partidas en curso necesita la lista de familias del ruleset,
  // así que espera a esa lectura; las dos consultas grandes (clasificación y
  // partidas) siguen yendo en paralelo entre sí, que es lo que evita un viaje
  // extra a la base de datos.
  const rulesetPromise = readRuleset();

  const [activeRows, liveRows, ruleset] = await Promise.all([
    readStandingRows(RULESET_VERSION),
    // Mismo criterio que `getLiveMatches`: una partida sin resolver de una
    // familia que puntúa y de un jugador aprobado. Un cruce 2v2 deja dos filas
    // con el mismo `gameId`, pero a efectos de "está jugando" basta con el
    // conjunto de jugadores. Que sea **el mismo** criterio y no uno parecido es
    // lo que mantiene el "en partida" del home honesto: lo que marca aquí tiene
    // que salir en `/partidas`, cuya lista cuenta las partidas y no los jugadores.
    rulesetPromise.then((active) =>
      db.match.findMany({
        where: {
          ...rankedModesWhere(active.modes),
          finishedAt: null,
          player: { status: PlayerStatus.APPROVED },
        },
        select: { playerId: true },
      }),
    ),
    rulesetPromise,
  ]);

  // La versión de respaldo solo se busca cuando la activa no tiene filas; con
  // filas, `resolveStandingsVersion` la ignora y aquí ni se ha llegado a mirar.
  const version = resolveStandingsVersion(
    RULESET_VERSION,
    activeRows.length,
    activeRows.length > 0 ? null : await previousRuleSetVersion(),
  );

  const rows =
    version.ruleSetVersion === RULESET_VERSION
      ? activeRows
      : await readStandingRows(version.ruleSetVersion);

  return {
    ...version,
    rows: presentStandings(rows, ruleset, new Set(liveRows.map((row) => row.playerId))),
  };
}

/**
 * Los campos de directo de un `Player` tal y como los devuelve la consulta.
 *
 * Es la parte común del `select` de la clasificación (`STANDING_SELECT`) y del
 * padrón de aprobados de `/partidas`: las dos pantallas resuelven el canal
 * **canónico** con las mismas funciones y la misma regla de respaldo, así que la
 * forma de entrada se declara una sola vez y `resolvePlayerStreams()` la convierte
 * en lo que publican los dos tipos.
 */
export type PlayerStreamSource = {
  /** Lo que escribió el admin en el panel; puede ser el nombre suelto o una URL. */
  twitchChannel: string | null;
  /** El `twitchUrl` que publica AoE4World en el perfil. Respaldo, no alternativa. */
  twitchUrl: string | null;
  twitchIsLive: boolean;
  youtubeChannel: string | null;
  youtubeIsLive: boolean;
  kickChannel: string | null;
  kickIsLive: boolean;
};

/**
 * Canal canónico y estado de directo de un jugador, por plataforma.
 *
 * Es la forma que comparten la clasificación (`StandingRow`) y las partidas en
 * juego (`LiveMatchParticipant`): los seis campos que la interfaz ya sabe pintar
 * con `ChannelLinks` y con los que arma el enlace del visor multi-stream.
 */
export type PlayerStreams = {
  twitchChannel: string | null;
  twitchIsLive: boolean;
  youtubeChannel: string | null;
  youtubeIsLive: boolean;
  kickChannel: string | null;
  kickIsLive: boolean;
};

/**
 * Resuelve los canales de directo de un jugador **igual** en toda la web.
 *
 * El canal del panel es el primero; si no hay (o no es válido), se toma el que
 * AoE4World publica en el perfil. `normalizeTwitchChannel` acepta tanto el nombre
 * suelto como la URL completa. YouTube y Kick no tienen respaldo: AoE4World no
 * publica ninguno de los dos, así que el canal es solo el que escribió la persona
 * o el admin, y la normalización es la red de seguridad para lo que ya está
 * guardado (por ejemplo una fila anterior al parser).
 *
 * Vive en un único sitio, y es `export` igual que `resolveStandingsVersion`, por
 * dos motivos: una misma persona no puede salir con canal en la clasificación y
 * sin él en `/partidas`, y la parte pura —de dónde sale cada canal— se puede
 * comprobar sin base de datos.
 */
export function resolvePlayerStreams(player: PlayerStreamSource): PlayerStreams {
  const registered =
    player.twitchChannel === null ? null : normalizeTwitchChannel(player.twitchChannel);
  const fromProfile = player.twitchUrl === null ? null : normalizeTwitchChannel(player.twitchUrl);

  return {
    twitchChannel: registered ?? fromProfile,
    twitchIsLive: player.twitchIsLive,
    youtubeChannel: normalizeYoutubeChannel(player.youtubeChannel),
    youtubeIsLive: player.youtubeIsLive,
    kickChannel: normalizeKickChannel(player.kickChannel),
    kickIsLive: player.kickIsLive,
  };
}

/**
 * Convierte las filas de `PlayerScore` en las de la clasificación pública.
 *
 * `ruleset` es el **activo** aunque las filas sean de una versión anterior: es del
 * que salen los puntos de cada objetivo y la lista de objetivos desactivados, y lo
 * que se quiere enseñar de una fila antigua es qué objetivos posee, con los
 * nombres y glifos del catálogo de ahora.
 */
function presentStandings(
  rows: readonly StandingSource[],
  ruleset: ScoringRuleset,
  playing: ReadonlySet<string>,
): StandingRow[] {
  const lookup = objectiveLookup(ruleset);

  return rows.map((row) => {
    // El total se parte en dos columnas: los puntos de un objetivo se atribuyen a
    // competiciones o a logros, y la suma de las dos es siempre `points`, incluso si
    // el desglose no cuadra (entonces no hay competiciones y todo va a logros).
    const { pointsByAchievements, pointsByCompetitions } = splitStandingPoints(
      row.total,
      row.breakdown,
      lookup,
    );

    return {
      rank: row.rank,
      profileId: row.player.profileId,
      name: row.player.name,
      aoe4WorldName: row.player.aoe4WorldName,
      country: row.player.country,
      points: row.total,
      pointsByAchievements,
      pointsByCompetitions,
      wins: row.wins,
      losses: row.matches - row.wins,
      elo: row.player.elo,
      division: divisionFromRankLevel(row.player.rankLevel),
      rankLevel: row.player.rankLevel,
      streak: row.streak,
      ...resolvePlayerStreams(row.player),
      isPlaying: playing.has(row.player.id),
      avatarUrl: row.player.avatarUrl,
      profileUrl: aoe4WorldProfileUrl(row.player.profileId),
      objectives: earnedObjectives(row.breakdown, lookup),
    };
  });
}

/**
 * Identidad de un participante en su ficha pública. Solo lo que el encabezado
 * necesita para presentarlo; el `profileId` es el que ya viaja en los enlaces a
 * AoE4World y el que identifica al jugador en la URL de la ficha.
 */
export type ParticipantIdentity = {
  profileId: number;
  /** Nombre de display, el que escribió quien se inscribió. */
  name: string;
  /** `Player.avatarUrl`; `null` si no hay foto y la UI dibuja un monograma. */
  avatarUrl: string | null;
  profileUrl: string;
  /**
   * División del jugador, derivada de `rankLevel`; `null` si no está
   * clasificado. Se resuelve con `divisionFromRankLevel()`, igual que en
   * `getStandings`, para que la cabecera pueda pintar su emblema.
   */
  division: DivisionId | null;
  /**
   * `Player.rankLevel` en crudo (`"gold_2"`), tal cual lo publica AoE4World.
   * `null` si no está clasificado. Se publica sin traducir para que la
   * subdivisión (el escalón dentro de la división) siga disponible.
   */
  rankLevel: string | null;
};

/**
 * El avance de un participante en **un** objetivo del torneo.
 *
 * No es el ranking del objetivo (eso es `ObjectiveOption.ranking`) sino la
 * proyección de ese ranking sobre un único jugador: qué valor tiene hoy, qué
 * puesto ocupa entre los aspirantes y cuánto le falta para el primero.
 *
 * `value` y `matches` salen de la entrada del participante en el ranking y son
 * `0` cuando no aparece en él: `ranking` solo lleva a quien tiene al menos una
 * partida dentro del objetivo, así que un cero es la verdad ("no ha jugado nada
 * que cuente para este objetivo") y no un valor inventado.
 */
export type ParticipantObjective = {
  id: string;
  group: ObjectiveGroup;
  kind: ObjectiveKind;
  label: string;
  description: string;
  metric: ObjectiveMetric;
  /**
   * Puntos **cobrados** por este participante si lo tiene, y si no, el precio del
   * objetivo con las reglas vigentes: el del ruleset en una competición (que es lo
   * que cobraría) o el valor por unidad en `victorias` (`pointsPerWin` por victoria).
   *
   * Un logro repetible no cobra el precio de la tarjeta: `imparable` reparte 1 punto
   * por día con tope y `victorias` paga por victoria. Aquí va lo que se llevó de
   * verdad, con `count` diciendo cuántas veces.
   */
  points: number;
  /** Repeticiones que ha conseguido: días, victorias o 1 (ver el tipo). */
  count: number;
  /** Cabeza de familia del objetivo (`ObjectiveOption.parent`). */
  parent: string | null;
  /** Valor actual en la métrica del objetivo (`0` si no disputa el objetivo). */
  value: number;
  /** Partidas de las que sale `value`; `0` si no disputa el objetivo. */
  matches: number;
  /** Detalle del objetivo; `null` si no aporta nada. */
  detail: ObjectiveDetail | null;
  /**
   * Los mapas del pool que le faltan y cuántas partidas le faltan en cada uno, solo
   * en `por-tierra-y-agua` (`null` en el resto de objetivos).
   *
   * Es lo que pinta la ficha en vez del pool entero: "Faltan 3 mapas · 1 × X, 2 × Y,
   * 3 × Z". El umbral por mapa no se publica; los mapas completos, tampoco.
   */
  mapGaps: ObjectiveMapGap[] | null;
  /**
   * Posición 1-based entre los aspirantes, o `null` si no está en el ranking
   * del objetivo (ver `objectiveStanding`).
   */
  position: number | null;
  /**
   * Distancia al primero, en la unidad de la métrica, o `null` si no está en el
   * ranking.
   */
  distance: number | null;
  /**
   * Ya lo cobra el participante: posee la competición, o ha completado el logro.
   * Es el check que pinta la ficha.
   */
  achieved: boolean;
  /**
   * Poseedor actual del objetivo en una **competición**, o `null` si nadie
   * cumple. En un logro es siempre `null` (lo cobra cualquiera que cumpla: ver
   * `beneficiaries`).
   */
  holder: ObjectiveContender | null;
  /** Quién ha completado un logro, con sus puntos; vacío en las competiciones. */
  beneficiaries: ObjectiveBeneficiary[];
  /** Umbral del logro, para la barra de avance; `null` en las competiciones. */
  target: ObjectiveTarget | null;
  /**
   * **Todos** los contendientes del objetivo, ordenados por la cadena de
   * desempate. Es la **misma referencia** que el `ranking` del `ObjectiveOption`
   * del que sale, para reutilizar `ObjectiveRankingDialog` sin pedir nada aparte.
   */
  ranking: ObjectiveContender[];
};

/**
 * La ficha pública de objetivos de un participante: quién es y cómo va en cada
 * objetivo del torneo.
 *
 * `options` va en el orden del catálogo, el mismo que publica `/objetivos`, para
 * que la ficha se lea en el mismo orden que la pantalla de objetivos.
 */
export type ParticipantObjectives = {
  player: ParticipantIdentity;
  /**
   * Pool de mapas activo, copiado tal cual de la vista de objetivos (que lo saca de
   * `Setting`). La ficha lo necesita para explicar `por-tierra-y-agua` sin volver a
   * leer la configuración.
   */
  mapPool: string[];
  options: ParticipantObjective[];
};

/**
 * Avance de **un participante** en los objetivos, para su ficha pública.
 *
 * Reutiliza exactamente la misma vista que `/objetivos` (`loadObjectiveView()`,
 * que sale del snapshot guardado o, si no lo hay, del cómputo en vivo) en vez de
 * recalcular nada: el avance de un jugador tiene que salir del mismo ranking que
 * ve el resto del sitio, o la ficha podría contradecir a la clasificación del
 * objetivo.
 *
 * Devuelve `null` —dentro de `PublicRead`, así que `{ status: "ok", data: null }`—
 * cuando no hay ningún participante **aprobado** con ese `profileId`; la página
 * lo traduce a `notFound()`. Es a propósito que el "no existe" no se mezcle con
 * el "no lo hemos podido leer": este último es `status: "degraded"`, que la
 * página tiene que distinguir para no decir que un jugador no existe cuando lo
 * que pasa es que la base no responde.
 *
 * Lee en cada llamada, igual que `getStandings` y `getObjectives`, así que la
 * página que la use tiene que ser dinámica.
 *
 * Va envuelta en `cache()` de React: la página la llama dos veces dentro de la
 * misma petición —una para `generateMetadata` y otra para el render— y sin esto
 * cada llamada volvería a leer la base. La firma pública no cambia; el memo es
 * por petición, no entre peticiones, así que la lectura sigue siendo fresca.
 */
export const getParticipantObjectives = cache(
  async (profileId: number): Promise<PublicRead<ParticipantObjectives | null>> => {
    return readFromDatabase("public/getParticipantObjectives", () =>
      loadParticipantObjectives(profileId),
    );
  },
);

async function loadParticipantObjectives(
  profileId: number,
): Promise<ParticipantObjectives | null> {
  // La identidad del jugador y la vista de objetivos (snapshot o cómputo) son
  // independientes entre sí, así que van en paralelo.
  const [player, view] = await Promise.all([
    db.player.findUnique({
      where: { profileId },
      select: { profileId: true, name: true, avatarUrl: true, status: true, rankLevel: true },
    }),
    loadObjectiveView(),
  ]);

  // Solo los aprobados tienen ficha pública: un `PENDING` o un `REJECTED` no
  // sale en la clasificación, así que publicar su avance sería abrir una puerta
  // lateral a datos que el sitio no enseña en ningún otro sitio.
  if (player === null || player.status !== PlayerStatus.APPROVED) {
    return null;
  }

  return {
    player: {
      profileId: player.profileId,
      name: player.name,
      avatarUrl: player.avatarUrl,
      profileUrl: aoe4WorldProfileUrl(player.profileId),
      division: divisionFromRankLevel(player.rankLevel),
      rankLevel: player.rankLevel,
    },
    mapPool: [...view.mapPool],
    options: view.options.map((option) => participantObjective(option, profileId)),
  };
}

/**
 * Proyecta el ranking de un objetivo sobre un participante concreto.
 *
 * La entrada del jugador en el ranking es la fuente de `value`, `matches`,
 * `detail` y `mapGaps` de su avance; si no está, esos cuatro van a cero/null y la
 * posición y la distancia las resuelve `objectiveStanding` (que es la parte pura).
 *
 * `points` y `count` dicen lo que **este** jugador cobra, no el precio de la tarjeta:
 * en un logro repetible son los del beneficiario (`imparable` por días, `victorias`
 * por victorias) y en lo demás, el precio del objetivo con una repetición. Así la
 * ficha no puede enseñar el tope de `imparable` como si fuera lo cobrado.
 *
 * `holder`, `beneficiaries` y `ranking` se copian tal cual del `ObjectiveOption`
 * —`ranking` y `beneficiaries` por referencia, sin clonar— para que el diálogo de
 * clasificación del objetivo se pueda reutilizar desde la ficha sin pedir los
 * datos por otra vía.
 *
 * Es `export` como `splitStandingPoints`: es la parte pura de la ficha y así se puede
 * comprobar sin base de datos.
 */
export function participantObjective(
  option: ObjectiveOption,
  profileId: number,
): ParticipantObjective {
  const entry = option.ranking.find((contender) => contender.profileId === profileId) ?? null;
  const { position, distance } = objectiveStanding(option.ranking, profileId);
  const holder = option.holder !== null && option.holder.profileId === profileId ? option.holder : null;
  const beneficiary =
    option.kind === "achievement"
      ? (option.beneficiaries.find((value) => value.profileId === profileId) ?? null)
      : null;
  const achieved = option.kind === "competition" ? holder !== null : beneficiary !== null;

  return {
    id: option.id,
    group: option.group,
    kind: option.kind,
    label: option.label,
    description: option.description,
    metric: option.metric,
    points: beneficiary?.points ?? option.points,
    count: beneficiary?.count ?? 1,
    parent: option.parent,
    value: entry?.value ?? 0,
    matches: entry?.matches ?? 0,
    detail: entry?.detail ?? null,
    mapGaps: entry?.mapGaps ?? null,
    position,
    distance,
    achieved,
    holder: option.holder,
    beneficiaries: option.beneficiaries,
    target: option.target,
    ranking: option.ranking,
  };
}

/**
 * Un jugador de una partida en juego, sea del torneo o no.
 *
 * La alineación se resuelve **aquí** y no en la interfaz: la partida se pinta
 * una vez con la lista completa de quien está jugando, y cada nombre una sola
 * vez dentro de ella, aunque dos participantes de la liga compartan partida.
 */
export type LiveMatchParticipant = {
  /**
   * `null` si la API no publicó un id utilizable. Como es lo único que enlaza
   * con AoE4World, en ese caso tampoco hay `profileUrl`.
   */
  profileId: number | null;
  /**
   * Para los participantes de la liga manda el nombre del panel de admin, no el
   * que publica la API: es el mismo que ya ve el lector en la clasificación.
   * Para el resto, el de la API, o `""` si no vino ninguno.
   */
  name: string;
  /** Id de civilización de AoE4World: el que cruza con el catálogo de `civs.ts`. */
  civ: string | null;
  country: string | null;
  /** Está aprobado en el torneo. Es lo que decide si se pinta su división. */
  isLeaguePlayer: boolean;
  /** Derivada de `Player.rankLevel`; `null` si no es de la liga o no está clasificado. */
  division: DivisionId | null;
  profileUrl: string | null;
  /** Solo de la liga: dentro de `teams` la API no publica avatar. */
  avatarUrl: string | null;
  /**
   * Canales de directo del participante, con el canal canónico y si está
   * emitiendo ahora mismo, resueltos con `resolvePlayerStreams` —los mismos seis
   * campos que publica la clasificación—.
   *
   * Un rival que no es de la liga no tiene fila de `Player` y por tanto ningún
   * canal: los seis salen `null`/`false`. La interfaz pinta el icono enlazando a
   * la retransmisión con `twitchChannelUrl`/`youtubeChannelUrl`/`kickChannelUrl`,
   * decide si enseña solo los que están en directo y arma el enlace del visor
   * multi-stream con esos canales.
   */
  twitchChannel: string | null;
  twitchIsLive: boolean;
  youtubeChannel: string | null;
  youtubeIsLive: boolean;
  kickChannel: string | null;
  kickIsLive: boolean;
  /**
   * Equipo, contando desde 1 en el orden en que la API mandó los equipos. Es
   * `null` **solo** en el degradado sin `rawJson`: las columnas no guardan de
   * qué equipo era cada jugador, y suponerlo sería pintar un dato falso.
   */
  team: number | null;
};

/** Una partida en curso, ya agrupada: una entrada por partida, no por jugador. */
export type LiveMatch = {
  /** Identificador estable de la partida (el `gameId` de la API). */
  gameId: string;
  /** Nombre del mapa tal cual lo publica la API; la imagen la resuelve la UI. */
  map: string | null;
  /** Familia de ladder resuelta (`rm_solo` / `rm_team`); `null` si no hubo referencia. */
  mode: string | null;
  /** Literal de AoE4World (`rm_solo`, `rm_2v2`...), sin traducir. */
  leaderboard: string;
  /**
   * Tamaño legible ("1vs1", "2vs2", "Por equipos"). Sale de los equipos de la
   * alineación y solo si la partida tiene dos bandos del mismo tamaño; si no se
   * puede asegurar, de `describeMode` sobre `mode` y `leaderboard`.
   */
  format: string;
  startedAt: Date;
  /** Duración publicada; `null` mientras la partida no ha acabado. */
  durationSeconds: number | null;
  /** Segundos desde el inicio en el momento de leer: el reloj de una tarjeta viva. */
  elapsedSeconds: number;
  /** Alineación completa, sin duplicados y en orden de equipos y de la API. */
  participants: LiveMatchParticipant[];
  /** Cuántos de `participants` son del torneo, para el distintivo de la tarjeta. */
  leaguePlayerCount: number;
};

/**
 * Un jugador aprobado indexado por `profileId`: quién es, de qué división es y
 * cuáles son sus canales de directo.
 *
 * Los campos de canal se resuelven una vez, al construir el mapa, con
 * `resolvePlayerStreams`: así `toParticipant` no normaliza nada por jugador y el
 * canal de un participante sale igual aquí que en la clasificación.
 */
type LeaguePlayerMeta = PlayerStreams & {
  name: string;
  rankLevel: string | null;
  avatarUrl: string | null;
};

/**
 * Los canales de quien **no** es de la liga: ninguno.
 *
 * Un rival no tiene fila de `Player`, así que no hay nada que resolver. Se declara
 * una sola vez para no repetir seis `null`/`false` en cada sitio donde un lado de
 * la partida se convierte en participante.
 */
const NO_STREAMS: PlayerStreams = {
  twitchChannel: null,
  twitchIsLive: false,
  youtubeChannel: null,
  youtubeIsLive: false,
  kickChannel: null,
  kickIsLive: false,
};

/** Un lado de la partida leído de `rawJson.teams` o reconstruido con las columnas. */
type RosterSide = {
  profileId: number | null;
  name: string;
  country: string | null;
  civilization: string | null;
  /** 1-based, o `null` cuando el equipo no se puede saber. */
  team: number | null;
};

/**
 * Una fila de `Match` tal y como la lee esta pantalla.
 *
 * Se declara el `select` fuera de la consulta para no repetir la lista de
 * campos en la función y en el tipo que reciben los helpers.
 */
const LIVE_MATCH_SELECT = {
  gameId: true,
  map: true,
  mode: true,
  leaderboard: true,
  startedAt: true,
  durationSeconds: true,
  // La alineación completa solo vive aquí: las columnas guardan un jugador y
  // un rival. Entra entero porque Prisma no permite pedir una parte de un `Json`,
  // y son unos pocos juegos en curso, no un histórico.
  rawJson: true,
  civ: true,
  opponentProfileId: true,
  opponentName: true,
  opponentCiv: true,
  player: { select: { profileId: true, name: true } },
} satisfies Prisma.MatchSelect;

type LiveMatchSource = Prisma.MatchGetPayload<{ select: typeof LIVE_MATCH_SELECT }>;

/**
 * La alineación que publica la API en `rawJson.teams`, validada.
 *
 * `rawJson` es el payload literal de AoE4World y no una fuente de fiar: se
 * comprueba con `isRecord` y se delega en `parseGamePlayer`, que es el mismo
 * lector que usa el worker en la frontera de la API y acepta las dos formas en
 * que la API envía cada jugador (envuelto en `{ player: {...} }` en el listado
 * y plano en el detalle).
 *
 * Se respeta el orden de la API: `teams[0]` es el primer equipo y, dentro de
 * él, el orden es el que la API quiere mostrar.
 */
function readRoster(rawJson: unknown): RosterSide[] {
  if (!isRecord(rawJson) || !Array.isArray(rawJson.teams)) {
    return [];
  }

  const roster: RosterSide[] = [];

  rawJson.teams.forEach((team, teamIndex) => {
    if (!Array.isArray(team)) {
      return;
    }

    for (const entry of team) {
      const side = parseGamePlayer(entry);

      if (side === null) {
        continue;
      }

      roster.push({
        profileId: side.profileId,
        name: side.name ?? "",
        country: side.country,
        civilization: side.civilization,
        team: teamIndex + 1,
      });
    }
  });

  return roster;
}

/**
 * Alineación con las columnas, para cuando `rawJson.teams` no se puede leer.
 *
 * `Match` solo guarda **un** jugador y **un** rival (el primero del equipo
 * contrario), así que de un 2v2 esto no recupera a todo el mundo: es un
 * degradado deliberado, no una reconstrucción. Los equipos son desconocidos y
 * por eso `team` sale a `null`. Aun así, es preferible a una tarjeta sin
 * nombres.
 */
function rosterFromColumns(rows: readonly LiveMatchSource[]): RosterSide[] {
  const roster: RosterSide[] = [];

  for (const row of rows) {
    roster.push({
      profileId: row.player.profileId,
      name: row.player.name,
      country: null,
      civilization: row.civ,
      team: null,
    });

    if (row.opponentProfileId === null && row.opponentName === null) {
      continue;
    }

    roster.push({
      profileId: row.opponentProfileId,
      name: row.opponentName ?? "",
      country: null,
      civilization: row.opponentCiv,
      team: null,
    });
  }

  return roster;
}

/**
 * Clave de deduplicación dentro de una partida.
 *
 * Un `profileId` ausente no puede servir de clave: colgaría a todos los
 * jugadores sin id en la misma entrada y la tarjeta perdería nombres. Se cae al
 * nombre, que es lo único que queda por distinguir a un rival sin perfil.
 */
function participantKey(profileId: number | null, name: string): string {
  return profileId === null ? `name:${name}` : `profile:${profileId}`;
}

function toParticipant(
  side: RosterSide,
  league: ReadonlyMap<number, LeaguePlayerMeta>,
): LiveMatchParticipant {
  const leaguePlayer = side.profileId === null ? undefined : league.get(side.profileId);

  // Quien no es de la liga no tiene canales, así que cae en `NO_STREAMS`, que lee
  // exactamente como una fila de `Player` sin ninguno.
  const streams = leaguePlayer ?? NO_STREAMS;

  return {
    profileId: side.profileId,
    name: leaguePlayer?.name ?? side.name,
    civ: side.civilization,
    country: side.country,
    isLeaguePlayer: leaguePlayer !== undefined,
    division: leaguePlayer === undefined ? null : divisionFromRankLevel(leaguePlayer.rankLevel),
    profileUrl: side.profileId === null ? null : aoe4WorldProfileUrl(side.profileId),
    avatarUrl: leaguePlayer?.avatarUrl ?? null,
    twitchChannel: streams.twitchChannel,
    twitchIsLive: streams.twitchIsLive,
    youtubeChannel: streams.youtubeChannel,
    youtubeIsLive: streams.youtubeIsLive,
    kickChannel: streams.kickChannel,
    kickIsLive: streams.kickIsLive,
    team: side.team,
  };
}

/**
 * La alineación de una partida: todos sus jugadores, cada uno una sola vez.
 *
 * Se recorren **todas** las filas de la partida, no solo la primera. Las filas
 * de un mismo `gameId` guardan el mismo payload, así que en el caso normal la
 * primera ya trae a todo el mundo y las demás solo repiten; recorrerlas todas y
 * deduplicar hace que, si una fila viniera con `teams` incompleto, la partida
 * salga igual de entera. Gana la primera aparición de cada jugador, que es la
 * que respeta el orden de equipos de la API.
 */
function liveRoster(
  rows: readonly LiveMatchSource[],
  league: ReadonlyMap<number, LeaguePlayerMeta>,
): LiveMatchParticipant[] {
  const seen = new Set<string>();
  const participants: LiveMatchParticipant[] = [];

  const add = (side: RosterSide) => {
    const key = participantKey(side.profileId, side.name);

    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    participants.push(toParticipant(side, league));
  };

  for (const row of rows) {
    for (const side of readRoster(row.rawJson)) {
      add(side);
    }
  }

  if (participants.length === 0) {
    for (const side of rosterFromColumns(rows)) {
      add(side);
    }
  }

  return participants;
}

/**
 * El tipo de partida, resuelto con la alineación como fuente preferente.
 *
 * `describeMode` va primero a `leaderboard`, y un 2v2 puede venir publicado como
 * `rm_team`, que no dice el tamaño. Como aquí ya está la alineación completa, se
 * cuentan los jugadores de cada equipo y el tamaño sale de ahí; `describeMode`
 * queda como respaldo para lo que no se puede asegurar (equipos desiguales, más
 * de dos bandos o partida reconstruida desde las columnas, donde no se sabe de
 * qué equipo era cada jugador).
 */
function matchFormat(
  participants: readonly LiveMatchParticipant[],
  mode: string | null,
  leaderboard: string,
): string {
  const sizes = new Map<number, number>();

  for (const participant of participants) {
    if (participant.team === null) {
      continue;
    }

    sizes.set(participant.team, (sizes.get(participant.team) ?? 0) + 1);
  }

  return describeTeamSize([...sizes.values()]) ?? describeMode(mode, leaderboard);
}

/**
 * Partidas en directo: las clasificatorias que la API todavía no ha resuelto
 * (`finishedAt IS NULL`).
 *
 * Sale **una entrada por partida**, no por jugador. `Match` tiene la unicidad
 * `(playerId, gameId)` porque el torneo es individual y dos participantes de la
 * liga pueden jugar la misma partida, cada uno con su resultado y sus puntos:
 * aquí eso se agrupa por `gameId` y la alineación se monta desde `rawJson`, de
 * forma que un 1v1 entre dos jugadores de la liga es una sola tarjeta con dos
 * nombres y no dos tarjetas ni un nombre repetido.
 *
 * Dos consultas planas y ninguna por fila: las partidas en curso y el padrón de
 * jugadores aprobados, que es lo que permite marcar `isLeaguePlayer`, resolver la
 * división y publicar los canales de directo sin preguntar a la base de datos por
 * cada nombre.
 *
 * Se filtra por la **familia de ladder**, con la lista que vive en el ruleset
 * (`rankedModesWhere()`, la misma que usa el motor) y no por la regla entera: una
 * partida en curso no cumple por definición las otras tres condiciones —no tiene
 * `result` ni `finishedAt`—, así que `rankedMatchWhere()` dejaría la pantalla
 * vacía. Es un filtro de **presentación**, no de importación: el worker sigue
 * guardando en `Match` todo lo que juega un participante, quick match y FFA
 * incluidos, porque el histórico entero es lo que permite recalcular sin volver
 * a pedirle todo a la API. Lo que no sale es una partida que el torneo no puntúa,
 * que es exactamente lo que promete el copy de la página. Y si esa lectura del
 * ruleset falla, la pantalla se degrada entera como la clasificación, en vez de
 * enseñar partidas sin filtrar.
 *
 * Si aparece una partida sin resolver dentro de más de una hora, es normal: el
 * worker borra las abandonadas de forma perezosa, en su siguiente pasada. No es
 * una partida colgada.
 *
 * Con la base de datos caída devuelve `{ status: "degraded", data: null }`.
 */
export async function getLiveMatches(): Promise<PublicRead<LiveMatch[]>> {
  return readFromDatabase("public/getLiveMatches", loadLiveMatches);
}

async function loadLiveMatches(): Promise<LiveMatch[]> {
  const now = new Date();

  // El filtro de modo sale del ruleset vivo, así que la consulta de partidas
  // espera a esa lectura; las dos consultas de esta pantalla siguen yendo en
  // paralelo entre sí.
  const rulesetPromise = readRuleset();

  const [rows, leagueRows] = await Promise.all([
    rulesetPromise.then((ruleset) =>
      db.match.findMany({
        where: {
          ...rankedModesWhere(ruleset.modes),
          finishedAt: null,
          player: { status: PlayerStatus.APPROVED },
        },
        orderBy: { startedAt: "desc" },
        select: LIVE_MATCH_SELECT,
      }),
    ),
    db.player.findMany({
      where: { status: PlayerStatus.APPROVED },
      select: {
        profileId: true,
        name: true,
        rankLevel: true,
        avatarUrl: true,
        // Los canales de directo, para que la tarjeta pueda pintar el icono del
        // que está emitiendo y armar el enlace del visor multi-stream. Son las
        // mismas columnas que lee la clasificación, resueltas con la misma
        // función, para que un canal no salga aquí y no allí.
        twitchChannel: true,
        twitchUrl: true,
        twitchIsLive: true,
        youtubeChannel: true,
        youtubeIsLive: true,
        kickChannel: true,
        kickIsLive: true,
      },
    }),
  ]);

  const league = new Map<number, LeaguePlayerMeta>(
    leagueRows.map((row) => [
      row.profileId,
      {
        name: row.name,
        rankLevel: row.rankLevel,
        avatarUrl: row.avatarUrl,
        ...resolvePlayerStreams(row),
      },
    ]),
  );

  // `Map` conserva el orden de inserción, así que las partidas salen en el mismo
  // `startedAt desc` que trajo la consulta. Las filas de una partida comparten
  // `startedAt`, de modo que agrupar no altera ese orden.
  const byGame = new Map<string, LiveMatchSource[]>();

  for (const row of rows) {
    const group = byGame.get(row.gameId);

    if (group === undefined) {
      byGame.set(row.gameId, [row]);
    } else {
      group.push(row);
    }
  }

  const matches: LiveMatch[] = [];

  for (const [gameId, group] of byGame) {
    const [first] = group;
    const participants = liveRoster(group, league);
    let leaguePlayerCount = 0;

    for (const participant of participants) {
      if (participant.isLeaguePlayer) {
        leaguePlayerCount += 1;
      }
    }

    matches.push({
      gameId,
      map: first.map,
      mode: first.mode,
      leaderboard: first.leaderboard,
      format: matchFormat(participants, first.mode, first.leaderboard),
      startedAt: first.startedAt,
      durationSeconds: first.durationSeconds,
      // Un reloj de servidor adelantado daría negativo; a cero es más honesto
      // que un "-3 s" en pantalla.
      elapsedSeconds: Math.max(0, Math.round((now.getTime() - first.startedAt.getTime()) / 1000)),
      participants,
      leaguePlayerCount,
    });
  }

  return matches;
}

/** Un jugador del torneo con canal de Twitch, para incrustar el stream. */
export type TwitchChannelRow = {
  profileId: number;
  name: string;
  /** Nombre del canal ya normalizado, listo para `https://twitch.tv/<canal>`. */
  twitchChannel: string;
};

/**
 * Canales de Twitch de los jugadores aprobados, ordenados por nombre.
 *
 * `Player.twitchChannel` lo rellena el admin y el panel lo valida como nombre de
 * canal, así que lo normal es que ya venga limpio; la normalización de aquí es
 * solo una red de seguridad para los datos ya guardados, y es la misma de
 * `src/lib/stream-channels.ts` que usa la clasificación, para que un canal no
 * pueda salir como enlace en un sitio y como `null` en otro.
 *
 * No se deduplica: si dos jugadores apuntan al mismo canal saldrán dos filas. Si
 * la pantalla pinta una tarjeta por canal, quitar el duplicado es cosa de la
 * interfaz, no de la consulta.
 */
export async function getTwitchChannels(): Promise<TwitchChannelRow[]> {
  const rows = await db.player.findMany({
    where: { status: PlayerStatus.APPROVED, twitchChannel: { not: null } },
    orderBy: { name: "asc" },
    select: { profileId: true, name: true, twitchChannel: true },
  });

  const channels: TwitchChannelRow[] = [];

  for (const row of rows) {
    const channel = row.twitchChannel === null ? null : normalizeTwitchChannel(row.twitchChannel);

    if (channel === null) {
      console.warn(
        `[public] Jugador ${row.profileId} (${row.name}): "${row.twitchChannel}" no es un canal de Twitch válido, se omite.`,
      );
      continue;
    }

    channels.push({ profileId: row.profileId, name: row.name, twitchChannel: channel });
  }

  return channels;
}

/**
 * La ventana del torneo, tal cual está configurada en el ruleset activo.
 *
 * Es una lectura **ligera** a propósito: `getObjectives()` también publica la
 * ventana, pero arrastra el cálculo de todos los objetivos. Las pantallas que solo
 * necesitan el periodo —`/puntuacion` y el contador de la portada— no tienen por
 * qué pagar ese cálculo.
 *
 * `from` y `to` son instantes ISO-8601 UTC y `to` puede ser `null` (ventana
 * abierta por la derecha). Con la base caída devuelve
 * `{ status: "degraded", data: null }`, y quien pinte decide si enseña el periodo
 * o se queda con el texto genérico sin fechas.
 */
export type TournamentWindow = { from: string; to: string | null };

export async function getTournamentWindow(): Promise<PublicRead<TournamentWindow>> {
  return readFromDatabase("public/getTournamentWindow", async () => {
    const ruleset = await readRuleset();

    return { ...ruleset.window };
  });
}

/**
 * La hora en que terminó la última pasada **registrada** del sincronizador.
 *
 * Es una lectura ligera de `Setting["sync.lastRun"]`, como `getTournamentWindow()`:
 * la portada la usa para decir «Actualizado a las …» sin arrastrar el cálculo de los
 * objetivos. Publica el `finishedAt` de la última pasada **aunque haya salido a
 * medias**: lo que promete la frase es cuándo se tocaron los datos por última vez,
 * no si esa pasada salió entera. Para «¿desde cuándo está roto?» está
 * `lastSuccessAt`, que responde a la otra pregunta y se enseña en el aviso de
 * `/admin` (`getSyncHealth()`), no aquí.
 *
 * `{ status: "ok", data: null }` cuando nunca se ha escrito una pasada, que es un
 * caso distinto de `degraded`: quien pinte tiene que poder distinguir "todavía no ha
 * corrido" de "no lo hemos podido saber", y con `degraded` no debe pintar una hora
 * inventada.
 */
export async function getLastSyncFinishedAt(): Promise<PublicRead<string | null>> {
  return readFromDatabase("public/getLastSyncFinishedAt", async () => {
    const trace = await readSyncRunTrace();

    return trace?.finishedAt ?? null;
  });
}

/**
 * La campaña de donaciones activa, para el banner del layout público.
 *
 * Es una lectura ligera de `Setting["donations.matcherino"]`, como
 * `getTournamentWindow()`: no arrastra el cálculo de nada. El banner solo se pinta
 * cuando `status` es `"ok"` y `data.enabled` es `true`; con la base caída llega
 * `{ status: "degraded", data: null }` y el banner simplemente no se pinta, que es
 * la misma cara que "no hay campaña publicada". `data.url` viene ya validada (solo
 * `http`/`https`), así que se puede poner en un `href` sin comprobarla otra vez.
 *
 * Va envuelta en `cache()` de React: la lee el layout de `(public)`, que envuelve
 * todas las páginas públicas, y así una misma petición no repite la consulta si
 * algún día la necesitaran también la página y su cabecera. El memo es por
 * petición, no entre peticiones, así que la lectura sigue siendo fresca.
 */
export const getMatcherinoDonations = cache(
  async (): Promise<PublicRead<MatcherinoDonations>> => {
    return readFromDatabase("public/getMatcherinoDonations", () => readMatcherinoDonations());
  },
);

/**
 * La configuración de la edición: nombre, premio base, retransmisión y marca.
 *
 * Es una lectura ligera de `Setting["edition.config"]`, como
 * `getTournamentWindow()`: no arrastra el cálculo de nada. Con la base caída
 * devuelve `{ status: "degraded", data: null }` y quien pinte decide qué hacer —
 * el nombre de la edición o un premio no pueden inventarse—; lo que **no** hace es
 * publicar la configuración por defecto, porque "no hay nada configurado" y "no lo
 * hemos podido leer" son cosas distintas.
 *
 * Va envuelta en `cache()` de React: la lee el layout público (la marca) y la
 * portada (el premio), y así una misma petición no repite la consulta.
 */
export const getEditionConfig = cache(async (): Promise<PublicRead<EditionConfig>> => {
  return readFromDatabase("public/getEditionConfig", () => readEditionConfig());
});

/* -------------------------------------------------------------------------- */
/* Historial público de ganancias de puntos                                    */
/* -------------------------------------------------------------------------- */

/**
 * Los filtros de `/historial`, tal como llegan de `searchParams`.
 *
 * Dos, y los dos sobre las **dos** clases de fila del feed (victorias y objetivos):
 *
 * - `jugador`: el `profileId` de AoE4World, que es el id público del participante —el
 *   mismo de `/detalle-jugador/[profileId]`—, **no** el `Player.id` del panel. Un valor que no
 *   sea un número se trata como ausencia de filtro, nunca como un filtro sin resultados:
 *   una URL manipulada tiene que verse como "sin filtrar" y no como "este jugador no
 *   tiene ninguna ganancia", que sería una afirmación falsa.
 * - `from` / `to`: el mismo rango de fechas que el panel, con los mismos bordes
 *   (ver `dateRangeWhere()`), aplicado a `Match.startedAt` y a `ObjectiveEvent.achievedAt`.
 *   Ninguno de los dos separa las dos clases: el filtro es un rango de fechas, no "fechas
 *   de partidas".
 *
 * `page` y `pageSize` son la paginación, acotada como en el panel. No hay `sort`: el feed
 * público se lee siempre de lo más reciente a lo más antiguo, y el orden no se elige
 * desde la URL.
 */
export type PointHistoryQuery = {
  jugador?: QueryParam;
  from?: QueryParam;
  to?: QueryParam;
  page?: QueryParam;
  pageSize?: QueryParam;
};

/**
 * Los filtros de `/historial`, ya validados.
 *
 * Se resuelven en un sitio y se reparten entre las dos consultas del feed, y por eso son
 * un tipo y no dos valores sueltos: es lo que hace imposible que las dos mitades del
 * merge se filtren por cosas distintas.
 */
export type PointHistoryFilters = {
  /** `Player.profileId`, o `null` si no hay filtro (o el valor no se entiende). */
  profileId: number | null;
  /** Rango sobre `Match.startedAt` y, con los mismos límites, sobre `achievedAt`. */
  rango: DateRange;
};

/**
 * El filtro de participante de la URL, ya validado.
 *
 * `Player.profileId` de AoE4World es un entero positivo de siete u ocho cifras; el
 * catálogo de perfiles es de la API, así que la forma que se admite es un número decimal
 * sin signo y sin ceros a la izquierda. Lo que no encaje se trata como **ausencia de
 * filtro**, igual que el `playerId` mal formado del panel y por el mismo motivo.
 *
 * Exportado para su test: es una función pura y es justo donde se decide qué hace una
 * URL manipulada.
 */
export function readProfileIdFilter(value: QueryParam): number | null {
  const raw = readSingleParam(value);

  if (raw === null || !/^[1-9]\d{0,9}$/.test(raw)) {
    return null;
  }

  const profileId = Number(raw);

  return Number.isSafeInteger(profileId) ? profileId : null;
}

/**
 * Los filtros de `/historial`, ya validados y listos para sus dos consultas.
 *
 * Exportado para su test, como `readProfileIdFilter`: las dos mitades del feed tienen que
 * leer la misma URL de la misma manera.
 */
export function readPointHistoryFilters(query: PointHistoryQuery): PointHistoryFilters {
  return {
    profileId: readProfileIdFilter(query.jugador),
    rango: dateRangeWhere(query.from, query.to),
  };
}

/**
 * El objetivo de una fila del feed público, ya resuelto para pintar.
 *
 * Etiqueta, grupo y métrica salen del **catálogo** (`OBJECTIVE_DEFINITIONS`), y son
 * exactamente los tres campos que necesita `ObjectiveIcon` para elegir su glifo: un
 * objetivo del historial se pinta con el mismo icono que su tarjeta en `/objetivos` y que
 * en la clasificación.
 *
 * `points` y `count` son lo que **cobró ese jugador**, no el precio de catálogo: el
 * importe de un logro repetible no es el de la tarjeta (`imparable` reparte 1 punto por
 * día con tope y `victorias` paga por victoria), y publicar el tope como si fuera lo
 * cobrado sería el error que ya se corrigió en la clasificación. Es el mismo lector que
 * el panel (`resolveObjective()` con el desglose del jugador), así que las dos pantallas
 * no pueden dar dos cifras del mismo hito.
 *
 * En una **competición** el importe es el de la tarjeta con una repetición, siempre: un
 * premio *winner-takes-all* no depende de lo que sume el jugador, así que la ganancia y
 * la pérdida de un mismo cambio llevan la misma cifra y `count` es 1.
 */
export type PointHistoryObjective = {
  /** `ObjectiveEvent.objectiveId`: id estable del objetivo (`lider-japanese`…). */
  id: string;
  label: string;
  group: ObjectiveGroup;
  /** Métrica que lo decide; con `id` y `group`, lo que elige el glifo. */
  metric: ObjectiveMetric;
  /** Puntos que vale la fila (ver el tipo). */
  points: number;
  /** Repeticiones cobradas: días, victorias o 1 (ver `StandingObjective`). */
  count: number;
  /**
   * `null` cuando la fila es un **objetivo cumplido** (un logro). En un **cambio de
   * poseedor de una competición**, qué le ha pasado a ese jugador: `GAINED` pasa a
   * poseerla, `LOST` deja de poseerla.
   *
   * Es el discriminante que la interfaz necesita para elegir el verbo y el signo
   * (`+points` con `GAINED`, `-points` con `LOST`). Los puntos de la fila son
   * **informativos** —una pérdida no resta nada de la clasificación—, así que el signo
   * es una decisión de quien pinta, no un dato que venga resuelto.
   */
  lead: ObjectiveLeadKind | null;
};

/**
 * Una fila del feed público de `/historial`: **una victoria clasificatoria, un objetivo
 * cumplido o un cambio de poseedor de una competición**.
 *
 * ## Las tres clases se distinguen por `objective`
 *
 * `null` = fila de partida; no `null` con `objective.lead` a `null` = se cumplió un logro;
 * no `null` con `objective.lead` informado = alguien pasó a poseer un objetivo de
 * competición (`GAINED`) o dejó de poseerlo (`LOST`). Es el mismo discriminante y la misma
 * decisión que en el feed del panel (`AdminMatchHistoryRow`), y por el mismo motivo: un
 * `kind` aparte que nadie mantiene en sincronía con `objective` es una forma de que las
 * clases de fila se contradigan.
 *
 * Un **cambio de poseedor** de una competición también es un objetivo, y no una cuarta
 * clase: la fila describe lo que le ha pasado a un jugador con un objetivo del catálogo,
 * igual que un logro, y solo se distingue por `objective.lead`. Los puntos que lleva son
 * **informativos** (el signo lo decide quien pinta), a diferencia de los de una victoria o
 * de un logro, que sí se suman.
 *
 * Los campos de partida (`gameId`, `opponentName`, `mode`, `leaderboard`, `map`,
 * `teamSize`, `revertedAt`) son `null` en una fila de objetivo porque **no existen ahí**,
 * no porque falten datos.
 *
 * ## Qué no sale de aquí
 *
 * `Match.id` (el cuid interno del panel), `rawJson` y todo lo de `AdminAction` se quedan
 * fuera: esta lectura es la puerta de una pantalla pública y no publica nada que no se
 * vaya a pintar. La identidad de la partida es su `gameId` de AoE4World, que ya es público.
 *
 * ## Qué significa una fila con `revertedAt`
 *
 * Es una ganancia **rechazada por la organización**: la partida se marcó como revertida y
 * no cuenta para la clasificación. La fila sigue aquí a propósito (el panel la enseña por
 * el mismo motivo: sin la fila no habría nada que deshacer), viaja con su marca para que
 * la interfaz la tache, y **no** se debe sumar a nada. Puede traer `points: 0` —una
 * victoria que se revirtió antes de que el motor la puntuara, o cuyos puntos se han
 * puesto a cero al revertirla— o sus puntos originales; lo que decide que no cuenta es
 * `revertedAt`, no el número.
 *
 * El filtro de la consulta deja fuera las victorias que **nunca** fueron una ganancia
 * (fuera de la ventana, antes del alta del jugador, con el equipo desequilibrado…): esas
 * tienen `points = 0` y `revertedAt = null`, y no salen.
 */
export type PointHistoryRow = {
  /**
   * Clave estable de la fila, única en todo el feed: `match:<gameId>:<profileId>` en una
   * victoria, `objective:<id>:<profileId>` en un logro y
   * `lead:<id>:<lead>:<profileId>:<at>` en un cambio de poseedor.
   *
   * Se compone en vez de publicar el cuid interno de `Match`, y sirve para las dos cosas
   * que necesita una fila en una lista paginada: la `key` de React y el **desempate
   * final** del orden (ver `comparePointHistory()`). Lleva el `profileId` porque la
   * unicidad del modelo es por jugador y partida: en un 2v2 con dos participantes de la
   * liga hay dos filas de la misma partida y cada una es una ganancia distinta.
   *
   * En un **cambio de poseedor** la clave lleva además el `lead` y el `at`: un mismo
   * jugador puede ganar y perder la misma competición en momentos distintos, y las dos
   * filas de un mismo cambio —la pérdida y la ganancia— comparten objetivo e instante y
   * solo se separan por el `lead`, así que sin él las dos chocarían en la `key` de React.
   */
  id: string;
  /**
   * La fecha de la fila, y por lo que se ordena y se filtra: `Match.startedAt` en una
   * victoria, `ObjectiveEvent.achievedAt` en un logro (el fin del torneo en los que se
   * resuelven en caliente, que no se registran hasta que termina) y `ObjectiveLeadEvent.at`
   * en un cambio de poseedor (el instante del recálculo que lo detectó).
   */
  startedAt: Date;
  /** Nombre de display del jugador, el mismo que ve en la clasificación. */
  playerName: string;
  /** `Player.profileId`: el id con el que se enlaza su ficha en `/detalle-jugador/[profileId]`. */
  playerProfileId: number;
  /** Puntos que aporta la fila: los de la partida o los que el jugador cobró por el objetivo. */
  points: number;
  /** El objetivo cumplido, o `null` si la fila es una victoria. Ver el tipo. */
  objective: PointHistoryObjective | null;

  /* ------------------------------- Solo victorias ----------------------------- */

  /** `gameId` de AoE4World; `null` en una fila de objetivo. */
  gameId: string | null;
  opponentName: string | null;
  /** Familia de ladder resuelta (`rm_solo` / `rm_team`); `null` en un objetivo. */
  mode: string | null;
  /** Literal de AoE4World (`rm_solo`, `rm_2v2`…); el copy puede necesitarlo. */
  leaderboard: string | null;
  map: string | null;
  /**
   * Tamaño real del partido («1vs1», «2vs2», «3vs3»…), leído de `rawJson.teams` y solo si
   * la partida tiene dos bandos del mismo tamaño.
   *
   * No se puede sacar de `mode`/`leaderboard`: un ranked por equipos llega con
   * `leaderboard: "rm_team"`, que no dice cuántos juegan. `null` cuando el payload no lo
   * permite (y también en una fila de objetivo), y entonces la interfaz cae en
   * `describeMode`.
   */
  teamSize: string | null;
  /** Instante del revert, o `null` si la ganancia cuenta (o si la fila no es de partida). */
  revertedAt: Date | null;
};

/**
 * Una página del feed público de `/historial`.
 *
 * `total` son las filas del feed con el filtro puesto, de las dos clases, y es de donde
 * sale `pageCount`. `page` llega **acotada** a `[1, pageCount]`, igual que en el panel: una
 * URL que pide la 7 con un filtro que solo tiene dos páginas devuelve la última con filas.
 */
export type PointHistory = {
  rows: PointHistoryRow[];
  total: number;
  page: number;
  pageSize: number;
  /** Páginas que hay con este filtro; `0` si no hay ninguna fila. */
  pageCount: number;
};

/**
 * El orden del feed público: fecha descendente, la victoria antes que el objetivo, y el id
 * de la clase, el signo del liderazgo y el `profileId` como desempates.
 *
 * ## Por qué es un orden total
 *
 * Es lo que necesita la paginación: sin un desempate único, dos filas del mismo instante
 * pueden salir en cualquier orden entre sí y una página puede repetir o perder filas de la
 * anterior. Y aquí el desempate **tiene que llegar a ser único**, porque los empates no son
 * teóricos: todos los logros se registran con `achievedAt` = fin del torneo, así que el día
 * del cierre hay muchas filas —varios jugadores por el mismo objetivo— con el mismo
 * instante exacto. Y un cambio de poseedor escribe **dos filas** con el instante idéntico
 * por diseño.
 *
 * ## Y por qué tiene que decir lo mismo que las consultas
 *
 * El merge de las fuentes solo es una ventana real del feed si cada fuente llega ya ordenada
 * como este comparador las ordena (`historyFeedWindows()` cuenta con ello). Por eso el desempate
 * es la misma terna por la que ordenan los tres `orderBy`: el id de la clase
 * (`gameId`/`objectiveId`, que en Postgres se ordena como texto), el `lead` (solo en las
 * competiciones) y, si dos filas comparten clase y signo —la misma partida para dos
 * jugadores, el mismo logro para dos beneficiarios, dos cambios distintos del mismo
 * jugador—, el `profileId` del jugador.
 *
 * El `lead` se compara como el enum: la **ganancia antes que la pérdida** en descendente
 * (`OBJECTIVE_LEAD_RANK`, ver `src/lib/objective-leads.ts`), que es el orden de declaración
 * de `ObjectiveLeadKind` y el que aplica el `orderBy` de la consulta. Así las dos filas de
 * un cambio salen ganancia primero, que es el orden en que se narran ("ahora lidera" antes
 * que "ya no lidera").
 *
 * Los dos primeros criterios (fecha y clase) son los de `compareFeedInstants()`, que es lo
 * que comparte con el panel; lo que cambia es solo el desempate, porque las claves de las
 * filas no son las mismas.
 *
 * Exportado para su test: es una función pura y en la que se apoya que dos páginas
 * consecutivas no repitan ni pierdan filas.
 */
export function comparePointHistory(a: PointHistoryRow, b: PointHistoryRow): number {
  const porFechaYClase = compareFeedInstants(a, b);

  if (porFechaYClase !== 0) {
    return porFechaYClase;
  }

  const porClase = compareTextDesc(pointHistoryClassId(a), pointHistoryClassId(b));

  if (porClase !== 0) {
    return porClase;
  }

  const porLiderazgo =
    a.objective?.lead != null && b.objective?.lead != null
      ? OBJECTIVE_LEAD_RANK[b.objective.lead] - OBJECTIVE_LEAD_RANK[a.objective.lead]
      : 0;

  if (porLiderazgo !== 0) {
    return porLiderazgo;
  }

  return b.playerProfileId - a.playerProfileId;
}

/**
 * El id de la clase de una fila: el `gameId` de la victoria o el id del objetivo.
 *
 * En una fila de partida el `gameId` no puede ser `null` (es lo que compone su `id`); el
 * `?? ""` es solo para que el tipo —que lo declara opcional en las filas de objetivo— no
 * obligue a un `!` que mentiría más.
 */
function pointHistoryClassId(row: PointHistoryRow): string {
  return row.objective === null ? (row.gameId ?? "") : row.objective.id;
}

/** Comparación de dos textos en descendente, con la convención de `compareFeedInstants()`. */
function compareTextDesc(a: string, b: string): number {
  return a < b ? 1 : a > b ? -1 : 0;
}

/**
 * El historial público de ganancias de puntos: **victorias clasificatorias, objetivos
 * cumplidos y cambios de poseedor de competiciones**, mezclados en un solo feed, paginados
 * en servidor y de lo más reciente a lo más antiguo.
 *
 * Es el feed de `/admin/historial` con otra cara: las mismas clases de fila (victorias
 * clasificatorias, objetivos cumplidos y cambios de poseedor), los mismos filtros de
 * jugador y fechas y la misma paginación en servidor, pero solo con las ganancias —el panel
 * enseña el recorrido entero, con las partidas de 0 puntos a la vista— y solo de
 * participantes aprobados. No hay acciones del panel (revertir y restaurar son de
 * `/admin`), ni filtro de resultado, ni selector de orden.
 *
 * ## Qué es una ganancia
 *
 * - **Una victoria clasificatoria** que aporta puntos: `result = WIN` y `points > 0`,
 *   dentro de `classificatoryWhere()` (familia del ruleset y ventana). El corte de
 *   inscripción y la condición de equipo **no** se pueden añadir a un `where` que abarca a
 *   todos los jugadores, y no hace falta: ya están codificados en `Match.points`, porque el
 *   motor solo puntúa lo que pasa las cinco condiciones (`rankedMatchSql()`). Una victoria
 *   que nunca puntuó —fuera de la ventana, antes del alta, con el equipo desequilibrado— se
 *   queda con `points = 0`: no es una ganancia y no sale.
 * - **Una ganancia rechazada**: una victoria con `revertedAt` informado. Entra aunque sus
 *   puntos sean 0 (una revertida no puntúa, y `Match.points` se pone a cero al recalcular),
 *   y viaja con la marca para que la interfaz la tache. Es la decisión que ya tomó el
 *   panel: el historial **cuenta** lo que se rechazó en vez de esconderlo.
 * - **Un objetivo cumplido** (`ObjectiveEvent`): el hito ya ocurrió, así que no hay nada
 *   que rechazar y no lleva marca. Los puntos son los que **cobró** ese jugador, con el
 *   mismo lector que el panel.
 * - **Un cambio de poseedor de una competición** (`ObjectiveLeadEvent`): una `GAINED` para
 *   quien pasa a liderarla y una `LOST` para quien la suelta, con el mismo instante. Los
 *   puntos de la fila son el premio del catálogo y son **informativos**: ni la ganancia ni
 *   la pérdida suman nada a la clasificación, y el signo lo decide quien pinta a partir de
 *   `objective.lead`.
 *
 * ## Y por qué no vale cualquier fila
 *
 * El feed solo publica a participantes **aprobados**, la misma regla que la clasificación,
 * `/partidas` y la ficha de objetivos: quien no está en el torneo no tiene presencia
 * pública, y sus partidas no están en ninguna tabla pública. En `Match` el filtro hay que
 * ponerlo explícitamente, porque `Match.points` no depende del estado del jugador (el
 * motor puntúa igual una victoria de alguien a quien después se le rechazó la solicitud) y
 * sin él saldrían ganancias de gente que la web no enseña en ningún otro sitio.
 *
 * Los cambios de poseedor llevan además el filtro de **cohorte**: solo los de la edición
 * activa (`editionFrom` = `window.from` de la ventana que se está usando), para que una
 * edición nueva no arrastre los liderazgos de la anterior (ver `ObjectiveLeadEvent`).
 *
 * ## El merge, y por qué el coste depende de la página
 *
 * Las tres fuentes —victorias, logros y liderazgos— se cuentan primero, en paralelo. Con
 * esos totales, `historyFeedWindows()` calcula la ventana de cada una que puede contener
 * la página y las tres se piden en paralelo; `historyFeedPage()` las mezcla y recorta. El
 * trabajo por petición depende de la página, no del histórico entero.
 *
 * Los `where` de logros y liderazgos filtran por `objectiveId` contra el catálogo para que
 * el recuento que decide la ventana y las filas que se publican cuenten lo mismo: una fila
 * manual con un id que no existe no puede descuadrar la página.
 *
 * ## Cómo se lee
 *
 * En cada llamada, sin caché: un lector no puede ver un historial viejo. Eso hace que la
 * página que la use tenga que ser **dinámica** (ver el docblock de cabecera del módulo).
 * Con la base de datos caída devuelve `{ status: "degraded", data: null }` en vez de
 * propagar el error, y `data` es `null` y no una lista vacía para que la pantalla no pueda
 * confundir "no hay ganancias" con "no lo hemos podido leer".
 */
export async function getPointHistory(
  query: PointHistoryQuery = {},
): Promise<PublicRead<PointHistory>> {
  return readFromDatabase("public/getPointHistory", () => loadPointHistory(query));
}

/**
 * Las columnas de `Match` que publica el feed, y las de `ObjectiveEvent`.
 *
 * Se declaran fuera de las consultas para no repetir la lista de campos, y son las que
 * necesita cada fila y **ninguna más**: de `Match` no entra ni el `id` interno.
 */
const POINT_HISTORY_MATCH_SELECT = {
  gameId: true,
  startedAt: true,
  opponentName: true,
  points: true,
  mode: true,
  leaderboard: true,
  map: true,
  revertedAt: true,
  // El tamaño del partido sale de `rawJson.teams`; Prisma no deja pedir una parte del
  // JSON, y se lee solo para resolverlo aquí, sin publicarlo.
  rawJson: true,
  player: { select: { name: true, profileId: true } },
} satisfies Prisma.MatchSelect;

const POINT_HISTORY_OBJECTIVE_SELECT = {
  objectiveId: true,
  achievedAt: true,
  playerId: true,
  player: { select: { name: true, profileId: true } },
} satisfies Prisma.ObjectiveEventSelect;

type PointHistoryMatchSource = Prisma.MatchGetPayload<{
  select: typeof POINT_HISTORY_MATCH_SELECT;
}>;

/**
 * El orden de las **victorias** del feed, en `orderBy` de Prisma.
 *
 * Tiene que ser el mismo orden que devuelve `comparePointHistory()` recortado a la clase
 * de las victorias, porque el merge compara las dos mitades: si la consulta las trajera en
 * otro orden, la página dejaría de ser una ventana del feed real. De ahí que el desempate
 * sea la misma pareja de antes: `gameId` y el `profileId` del jugador, que entre las dos
 * son únicas (`@@unique([playerId, gameId])`).
 */
const POINT_HISTORY_MATCH_ORDER_BY: Prisma.MatchOrderByWithRelationInput[] = [
  { startedAt: "desc" },
  { gameId: "desc" },
  { player: { profileId: "desc" } },
];

/**
 * El orden de los **objetivos**, en `orderBy` de Prisma.
 *
 * Es el mismo criterio, con la clave de su clase: `objectiveId` y el `profileId` del
 * beneficiario. El desempate por jugador no es decorativo: el día del cierre del torneo
 * todos los eventos comparten `achievedAt`, y un logro lo cobran varios jugadores a la vez,
 * así que sin él las filas de la consulta no estarían en el orden del comparador y el
 * merge podría repetir o perder alguna.
 */
const POINT_HISTORY_OBJECTIVE_ORDER_BY: Prisma.ObjectiveEventOrderByWithRelationInput[] = [
  { achievedAt: "desc" },
  { objectiveId: "desc" },
  { player: { profileId: "desc" } },
];

/** Una victoria del feed, ya en la forma que publica la pantalla. */
function pointHistoryMatchRow(row: PointHistoryMatchSource): PointHistoryRow {
  const profileId = row.player.profileId;

  return {
    // El `profileId` entra en la clave porque en un 2v2 con dos participantes de la liga
    // hay dos filas de la misma partida, una por jugador.
    id: `match:${row.gameId}:${profileId}`,
    startedAt: row.startedAt,
    playerName: row.player.name,
    playerProfileId: profileId,
    points: row.points,
    objective: null,
    gameId: row.gameId,
    opponentName: row.opponentName,
    mode: row.mode,
    leaderboard: row.leaderboard,
    map: row.map,
    // El tamaño se resuelve aquí y no en la interfaz, igual que en el panel: `rawJson` es
    // el payload literal de la API y no debe salir del DAL.
    teamSize: describeTeamSize(teamSizesFromRawJson(row.rawJson)),
    revertedAt: row.revertedAt,
  };
}

/**
 * Los objetivos cumplidos de una **ventana** del feed, ya en filas.
 *
 * La consulta pide solo la ventana que calcula `historyFeedWindows()`: el trabajo por
 * petición depende de la página y no del histórico entero (ver `historyFeedWindows()`).
 *
 * Una fila cuyo `objectiveId` no está en el catálogo se descarta con un aviso en el log:
 * el `where` ya la filtra, así que solo llegaría aquí si el catálogo cambiara entre el
 * recuento y la consulta, y una fila de hito sin etiqueta no dice nada.
 */
async function pointHistoryObjectives(
  where: Prisma.ObjectiveEventWhereInput,
  ruleset: ScoringRuleset,
  window: HistoryFeedWindow,
): Promise<PointHistoryRow[]> {
  const filas = await db.objectiveEvent.findMany({
    where,
    orderBy: POINT_HISTORY_OBJECTIVE_ORDER_BY,
    skip: window.skip,
    take: window.take,
    select: POINT_HISTORY_OBJECTIVE_SELECT,
  });

  // El importe real y las repeticiones de cada jugador, en una consulta para todos: el
  // mismo lector que usa el panel, para que las dos pantallas no puedan dar dos cifras
  // distintas del mismo objetivo.
  const awards = await playerObjectiveAwards(filas.map((fila) => fila.playerId));
  const rows: PointHistoryRow[] = [];

  for (const fila of filas) {
    const objetivo = resolveObjective(
      fila.objectiveId,
      ruleset,
      awards.get(fila.playerId) ?? null,
    );

    if (objetivo === null) {
      console.warn(
        `[public] Objetivo "${fila.objectiveId}": no está en el catálogo, su evento no se muestra.`,
      );
      continue;
    }

    rows.push({
      // Con el `profileId` por el mismo motivo que las partidas: un logro lo cobran varios
      // jugadores y cada uno es una ganancia.
      id: `objective:${objetivo.id}:${fila.player.profileId}`,
      startedAt: fila.achievedAt,
      playerName: fila.player.name,
      playerProfileId: fila.player.profileId,
      points: objetivo.points,
      objective: {
        id: objetivo.id,
        label: objetivo.label,
        group: objetivo.group,
        metric: objetivo.metric,
        points: objetivo.points,
        count: objetivo.count,
        // Un logro no se posee: no hay cambio de poseedor que contar.
        lead: null,
      },
      // Un objetivo no tiene rival, formato, mapa ni resultado: `null` es "no aplica", no
      // "faltan datos". Y no lleva marca de revert: un hito no se rechaza.
      gameId: null,
      opponentName: null,
      mode: null,
      leaderboard: null,
      map: null,
      teamSize: null,
      revertedAt: null,
    });
  }

  return rows;
}

/** Las columnas de `ObjectiveLeadEvent` que publica el feed. */
const POINT_HISTORY_LEAD_SELECT = {
  objectiveId: true,
  at: true,
  kind: true,
  player: { select: { name: true, profileId: true } },
} satisfies Prisma.ObjectiveLeadEventSelect;

/**
 * El orden de los **cambios de poseedor**, en `orderBy` de Prisma.
 *
 * Es el mismo criterio por el que ordena `comparePointHistory()` recortado a esta clase:
 * `at`, `objectiveId` y el `kind` —cuyo enum está declarado para que `desc` deje la
 * ganancia delante (ver `ObjectiveLeadKind`)— y, como último desempate, el `profileId` del
 * jugador. El `kind` es imprescindible aquí y no un adorno: las dos filas de un cambio
 * comparten `at` y `objectiveId`, así que sin él la consulta no estaría en el orden del
 * comparador y el merge podría repetir o perder una de las dos.
 */
const POINT_HISTORY_LEAD_ORDER_BY: Prisma.ObjectiveLeadEventOrderByWithRelationInput[] = [
  { at: "desc" },
  { objectiveId: "desc" },
  { kind: "desc" },
  { player: { profileId: "desc" } },
];

/**
 * Los cambios de poseedor de una **ventana** del feed, ya en filas.
 *
 * Pide solo la ventana que calcula `historyFeedWindows()`, igual que los logros (ver
 * `pointHistoryObjectives`), y los puntos son el **premio del catálogo**, sin desglose de
 * jugador: en una competición el importe no depende de lo que sume el jugador, así que la
 * ganancia y la pérdida del mismo cambio llevan la misma cifra y no hace falta la consulta
 * de `awards`.
 *
 * Una fila cuyo `objectiveId` no está en el catálogo se descarta con un aviso en el log,
 * igual que en los logros.
 */
async function pointHistoryLeads(
  where: Prisma.ObjectiveLeadEventWhereInput,
  ruleset: ScoringRuleset,
  window: HistoryFeedWindow,
): Promise<PointHistoryRow[]> {
  const filas = await db.objectiveLeadEvent.findMany({
    where,
    orderBy: POINT_HISTORY_LEAD_ORDER_BY,
    skip: window.skip,
    take: window.take,
    select: POINT_HISTORY_LEAD_SELECT,
  });

  const rows: PointHistoryRow[] = [];

  for (const fila of filas) {
    const objetivo = resolveObjective(fila.objectiveId, ruleset);

    if (objetivo === null) {
      console.warn(
        `[public] Objetivo "${fila.objectiveId}": no está en el catálogo, su liderazgo no se muestra.`,
      );
      continue;
    }

    rows.push({
      // El `kind` y el `at` entran en la clave: las dos filas de un cambio comparten
      // objetivo y jugador pueden repetirse en instantes distintos.
      id: `lead:${objetivo.id}:${fila.kind}:${fila.player.profileId}:${fila.at.getTime()}`,
      startedAt: fila.at,
      playerName: fila.player.name,
      playerProfileId: fila.player.profileId,
      points: objetivo.points,
      objective: {
        id: objetivo.id,
        label: objetivo.label,
        group: objetivo.group,
        metric: objetivo.metric,
        points: objetivo.points,
        count: objetivo.count,
        lead: fila.kind,
      },
      // Igual que en un logro: una competición no tiene rival, formato, mapa ni resultado.
      gameId: null,
      opponentName: null,
      mode: null,
      leaderboard: null,
      map: null,
      teamSize: null,
      revertedAt: null,
    });
  }

  return rows;
}

/**
 * Arma la página del feed público, ya con el merge y el recorte hechos.
 *
 * Las tres clases de fila salen de la misma pasada y el merge las mezcla: las partidas por
 * `Match`, los logros por `ObjectiveEvent` y los cambios de poseedor por
 * `ObjectiveLeadEvent`. Primero se cuentan las tres fuentes y después se pide solo la
 * ventana de cada una que puede contener la página (ver `historyFeedWindows()`).
 */
async function loadPointHistory(query: PointHistoryQuery): Promise<PointHistory> {
  const page = readBoundedInt(query.page, { min: 1, max: 100_000, fallback: 1 });
  const pageSize = readBoundedInt(query.pageSize, {
    min: 1,
    max: MAX_PAGE_SIZE,
    fallback: DEFAULT_PAGE_SIZE,
  });

  const ruleset = await readRuleset();
  const { profileId, rango } = readPointHistoryFilters(query);
  const editionFrom = windowBounds(ruleset.window).from;

  // Los filtros se suman, no se eligen: `where` es una conjunción, así que aprobado +
  // jugador + fechas + "es una ganancia" se combinan solos.
  //
  // El `null` del corte de inscripción es deliberado y es la excepción de este módulo,
  // como en el panel: la consulta abarca a todos los jugadores y un `where` de Prisma no
  // compara dos columnas. Lo que puntúa lo dice `Match.points`, que ya lleva aplicado ese
  // corte y la condición de equipo (ver el docblock de `getPointHistory`).
  //
  // El rango del filtro va en `AND` y no suelto sobre `startedAt`, aunque en el panel sí
  // vaya suelto: allí el filtro de fechas **sustituye** los límites de la ventana (para eso
  // el panel lista el recorrido entero, con las partidas de 0 puntos incluidas), y aquí eso
  // sería un error, porque una ganancia fuera de la ventana no es una ganancia. En `AND`, la
  // ventana del ruleset sigue siendo un suelo y un techo, y el filtro de quien mira solo
  // puede recortar por dentro.
  const partidasWhere: Prisma.MatchWhereInput = {
    ...classificatoryWhere(ruleset.modes, ruleset.window, null),
    // `classificatoryWhere` ya exige `result not null`; aquí además tiene que ser victoria.
    result: MatchResult.WIN,
    // Una ganancia es una victoria que suma o una que se rechazó y queda marcada. Las que
    // nunca puntuaron no llegan: tienen `points = 0` y no están revertidas.
    OR: [{ points: { gt: 0 } }, { revertedAt: { not: null } }],
    player: { status: PlayerStatus.APPROVED, ...(profileId === null ? {} : { profileId }) },
    ...(hasDateBounds(rango) ? { AND: [{ startedAt: rango }] } : {}),
  };

  const eventosWhere: Prisma.ObjectiveEventWhereInput = {
    objectiveId: { in: [...OBJECTIVE_IDS] },
    player: { status: PlayerStatus.APPROVED, ...(profileId === null ? {} : { profileId }) },
    ...(hasDateBounds(rango) ? { achievedAt: rango } : {}),
  };

  // Los liderazgos llevan el filtro de **cohorte**, que ninguna otra clase tiene: solo los
  // de la edición activa (ver `ObjectiveLeadEvent`). El filtro de fechas va sobre `at`, la
  // fecha del cambio, y no sobre el fin del torneo.
  const liderazgosWhere: Prisma.ObjectiveLeadEventWhereInput = {
    editionFrom,
    objectiveId: { in: [...OBJECTIVE_IDS] },
    player: { status: PlayerStatus.APPROVED, ...(profileId === null ? {} : { profileId }) },
    ...(hasDateBounds(rango) ? { at: rango } : {}),
  };

  return paginate(async (wanted) => {
    const skip = (wanted - 1) * pageSize;

    // Los tres recuentos deciden la ventana de cada fuente y son independientes entre sí.
    const [totalPartidas, totalEventos, totalLiderazgos] = await Promise.all([
      db.match.count({ where: partidasWhere }),
      db.objectiveEvent.count({ where: eventosWhere }),
      db.objectiveLeadEvent.count({ where: liderazgosWhere }),
    ]);

    const { windows, offset } = historyFeedWindows(skip, pageSize, [
      totalPartidas,
      totalEventos,
      totalLiderazgos,
    ]);

    // Las tres ventanas, en paralelo. Cada consulta pide solo lo que puede caer en la
    // página; el orden dentro de cada fuente es el del comparador.
    const [partidas, eventos, liderazgos] = await Promise.all([
      db.match.findMany({
        where: partidasWhere,
        orderBy: POINT_HISTORY_MATCH_ORDER_BY,
        skip: windows[0].skip,
        take: windows[0].take,
        select: POINT_HISTORY_MATCH_SELECT,
      }),
      pointHistoryObjectives(eventosWhere, ruleset, windows[1]),
      pointHistoryLeads(liderazgosWhere, ruleset, windows[2]),
    ]);

    return {
      total: totalPartidas + totalEventos + totalLiderazgos,
      rows: historyFeedPage(
        [partidas.map(pointHistoryMatchRow), eventos, liderazgos],
        {
          offset,
          pageSize,
          compare: comparePointHistory,
        },
      ),
    };
  }, { page, pageSize });
}
