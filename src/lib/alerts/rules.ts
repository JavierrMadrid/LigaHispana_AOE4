import type { Prisma } from "@/generated/prisma/client";
import { isRecord } from "@/lib/json";

/**
 * Umbrales y frases de las alertas de comportamiento. **Módulo puro**: no toca
 * la base de datos ni sale a la red, para que `computePlayerAlerts()` y
 * `rules.test.ts` (vía `npm test`) se puedan comprobar con secuencias sintéticas.
 *
 * ## Las tres piezas
 *
 * | Pieza | Qué es |
 * |---|---|
 * | `AlertsRuleset` | los umbrales, versionados en `Setting["alerts.ruleset"]` |
 * | `alertSummary()` | la frase en español que se escribe en `Alert.summary` |
 * | `alertDedupeKey()` | la clave que hace la evaluación idempotente |
 *
 * ## Qué NO vive aquí
 *
 * - **Qué cuenta como partida clasificatoria**: está en
 *   `src/lib/ranked-match.ts`. Aquí no se filtra nada.
 * - **La ventana y los modos**: también. El ruleset de alertas tiene solo
 *   umbrales, así que quien evalúa recibe el alcance del ruleset de **puntuación**
 *   aparte. Duplicarlos aquí sería tener dos verdades sobre qué se está midiendo.
 * - **El cálculo**: en `compute.ts`.
 *
 * ## Por qué las frases se escriben aquí y no en el informe
 *
 * Igual que en `AdminAction`: `Alert.summary` se pinta tal cual. Si el modelo de
 * cada frase viviera en el informe, un nombre con comillas o un número en
 * cualquiera de los dos sitios acabarían dando textos distintos, y el rastro
 * mentiría. Aquí no entra el nombre del jugador (la fila ya es de ese jugador y
 * el panel hace el `join`): un nombre guardado se quedaría congelado el día que
 * alguien se renombre, y eso sí que sería mentir.
 *
 * ## El sujeto de una regla
 *
 * Dos reglas hablan de **alguien**: R2 del rival (`opponentProfileId`) y R3 del
 * compañero (`profileId` de `rawJson.teams`). Las demás hablan del jugador, y su
 * sujeto es `null`. El sujeto se identifica por `profileId` y no por nombre,
 * porque el nombre cambia y el `profileId` no; y puede ser de alguien que no está
 * en la liga, que es lo normal en un torneo individual.
 *
 * ## Las dos reglas retiradas
 *
 * `TEAMMATE_ELO_GAP` (R4) y `LOW_DIVISION_TEAM_GAME` (R5) **ya no se calculan**:
 * su caso exacto (un equipo desequilibrado) dejó de ser un aviso y pasó a ser una
 * condición de puntuación —una partida por equipos con un compañero a dos escalones
 * o más **no cuenta**; ver `src/lib/ranked-match.ts`—. Lo que se queda es su
 * **etiqueta y su frase**, porque hay filas históricas del enum que el panel y el
 * informe siguen pintando: el valor del enum y `ALERT_RULE_LABELS` y
 * `alertSummary()` no se pueden borrar sin dejar esas filas sin texto.
 */

export { SUBDIVISION_RANK_LEVELS, type SubdivisionRankLevel } from "@/lib/divisions";

/* -------------------------------------------------------------------------- */
/* Ruleset                                                                     */
/* -------------------------------------------------------------------------- */

/** Clave de `Setting` donde vive el ruleset de alertas. */
export const ALERTS_RULESET_KEY = "alerts.ruleset";

/**
 * Versión de la forma de las reglas de alertas. La fija **el código**, como
 * `RULESET_VERSION` en el motor de puntos: cambiar un umbral no requiere
 * despliegue (es una reconfiguración de `Setting`), pero cambiar la estructura
 * del documento sí, y para eso sube esta constante.
 */
export const ALERTS_RULESET_VERSION = 1;

/** Texto de producto: lo fija el código y describe qué se está vigilando. */
export const ALERTS_RULE_LABEL = "Alertas de comportamiento sobre partidas clasificatorias";

/**
 * Reglas que miran una racha de partidas consecutivas.
 *
 * Los dos últimos valores son **legado**: el motor ya no los calcula (ver el
 * docblock del módulo) y se quedan solo porque hay filas de `Alert` escritas con
 * ellos que el panel y el informe siguen leyendo.
 */
export type StreakAlertRule =
  | "SHORT_MATCH_STREAK"
  | "REPEATED_OPPONENT_STREAK"
  | "REPEATED_TEAMMATE_STREAK"
  | "TEAMMATE_ELO_GAP"
  | "LOW_DIVISION_TEAM_GAME";

/** Reglas que miran un acumulado sobre toda la ventana. */
export type TotalAlertRule =
  "SHORT_MATCH_TOTAL" | "REPEATED_OPPONENT_TOTAL" | "REPEATED_TEAMMATE_TOTAL";

/**
 * Reglas que miran un **estado**, no una secuencia.
 *
 * No tienen racha ni acumulado: se comprueba una cosa (el historial de partidas del
 * jugador, la ladder por delante de lo que nos llega, si su cuenta de Discord está en
 * el servidor, si tiene algún canal de directo, si quedaron partidas sin resumen que
 * revisar) y, mientras siga siendo cierto, el mismo hecho. Las tres primeras se
 * evalúan en `src/lib/history-checks.ts` y `src/lib/discord/check.ts`, desde el
 * worker del sincronizador, porque no leen `Match` sino columnas de `Player`, una
 * ruta del sitio de AoE4World y la API de Discord; la del canal y la del resumen sin
 * revisar las evalúa `computePlayerAlerts()` (`src/lib/alerts/compute.ts`), que ya
 * lee las clasificatorias de cada aprobado en cada pasada.
 *
 * Su `dedupeKey` es estable por (regla, tipo, jugador) —sin partida ancla ni número—,
 * porque si no, reevaluarlas cada 10 minutos insertaría una fila nueva cada 12 horas
 * para siempre. Ver el docblock de `alertDedupeKey()`.
 *
 * `NO_STREAM_CHANNEL` es la única **condicional**: solo se evalúa si la edición
 * declara la retransmisión obligatoria (`Setting["edition.config"]`). Apagarla no
 * borra las alertas ya escritas: `Alert` es *append-only*.
 *
 * `SUMMARY_NOT_REVIEWED` es el respaldo del perfil privado: `HISTORY_NOT_PUBLIC`
 * afirma que el historial está cerrado **porque el sondeo lo confirmó**, y esta
 * avisa de lo contrario, de las partidas que se intentaron leer y nunca dieron una
 * respuesta concluyente. Son dos hechos distintos y por eso son dos reglas.
 */
export type StateAlertRule =
  | "HISTORY_NOT_PUBLIC"
  | "MISSING_LADDER_MATCHES"
  | "DISCORD_NOT_IN_GUILD"
  | "NO_STREAM_CHANNEL"
  | "SUMMARY_NOT_REVIEWED";

/**
 * Reglas que miran **una partida concreta** y se disparan por partida.
 *
 * Las tres salen del interior de la partida (`Match.summaryAnomalies`, leído del
 * resumen): no creó aldeanos en el arranque, la puntuación militar estuvo sin subir
 * una ventana seguida, o no recolectó recursos una ventana seguida. Su clave de
 * dedupe lleva la partida ancla, así que hay **una alerta por partida y regla**; con
 * la clave de estado, una sola fila taparía todos los hallazgos del jugador.
 */
export type MatchAlertRule = "NO_VILLAGERS_FIRST_MINUTES" | "NO_MILITARY_GAP" | "NO_RESOURCES_GAP";

export type AlertsRuleName = StreakAlertRule | TotalAlertRule | StateAlertRule | MatchAlertRule;

export type AlertKindName =
  | "STREAK_CLOSED"
  | "STREAK_AT_TOURNAMENT_END"
  | "TOTAL_REACHED"
  | "STATE_DETECTED"
  | "MATCH_DETECTED";

/* -------------------------------------------------------------------------- */
/* Las etiquetas                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Cómo se llama cada regla en español, en **un solo sitio**.
 *
 * Vive aquí y no en quien la pinta, por el mismo motivo que `alertSummary()`: si el
 * panel y el informe tuvieran cada uno su texto, bastaría retocar uno para que el
 * mismo comportamiento tuviera dos nombres según por dónde se mirara, y en un informe
 * que se envía a la organización eso es una contradicción, no un detalle de estilo.
 *
 * El `satisfies Record<AlertsRuleName, string>` hace que una regla nueva no pueda
 * entrar sin decidir aquí su etiqueta, igual que el `switch` de `alertSummary()`
 * obliga a decidir su frase. La diferencia entre las dos es que la etiqueta **no**
 * lleva el nombre del jugador ni ningún número: describe la regla, no el hallazgo.
 *
 * Las dos entradas marcadas como legado son las de las reglas retiradas: se quedan
 * porque hay filas históricas de `Alert` con esos valores y el panel las pinta con
 * esta etiqueta.
 */
export const ALERT_RULE_LABELS = {
  SHORT_MATCH_STREAK: "Partidas cortas seguidas",
  SHORT_MATCH_TOTAL: "Partidas cortas en total",
  REPEATED_OPPONENT_STREAK: "Rival repetido, en rachas",
  REPEATED_OPPONENT_TOTAL: "Rival repetido, en total",
  REPEATED_TEAMMATE_STREAK: "Compañero repetido, en rachas",
  REPEATED_TEAMMATE_TOTAL: "Compañero repetido, en total",
  // Legado: regla retirada, solo para filas históricas.
  TEAMMATE_ELO_GAP: "Brecha de elo con un compañero",
  // Legado: regla retirada, solo para filas históricas.
  LOW_DIVISION_TEAM_GAME: "Equipo en una división muy distinta",
  HISTORY_NOT_PUBLIC: "Historial de partidas no público",
  MISSING_LADDER_MATCHES: "Partidas de ladder que no nos llegan",
  DISCORD_NOT_IN_GUILD: "Discord sin estar en el servidor",
  NO_STREAM_CHANNEL: "Participante sin canal de directo",
  SUMMARY_NOT_REVIEWED: "Partidas sin resumen que revisar",
  NO_VILLAGERS_FIRST_MINUTES: "Sin aldeanos en el arranque",
  NO_MILITARY_GAP: "Sin crecimiento militar",
  NO_RESOURCES_GAP: "Sin obtener recursos",
} as const satisfies Record<AlertsRuleName, string>;

/**
 * Cuándo se detectó, en español, con el mismo criterio que `ALERT_RULE_LABELS`: el
 * enum describe el dato y el mapa lo traduce una sola vez.
 *
 * `STATE_DETECTED` no es de la misma familia que los tres primeros: no es una racha
 * ni un acumulado, es un **estado comprobado**. Por eso se traduce como "Estado
 * comprobado" y no como "Racha" o "Acumulado". `MATCH_DETECTED` tampoco: es el
 * hallazgo de **una partida**, y se traduce como "Hallazgo en una partida".
 */
export const ALERT_KIND_LABELS = {
  STREAK_CLOSED: "Racha rota",
  STREAK_AT_TOURNAMENT_END: "Racha cerrada por fin de torneo",
  TOTAL_REACHED: "Acumulado alcanzado",
  STATE_DETECTED: "Estado comprobado",
  MATCH_DETECTED: "Hallazgo en una partida",
} as const satisfies Record<AlertKindName, string>;

export type AlertsThresholds = {
  /** R1: por debajo de estos segundos la partida se considera corta. */
  shortMatchSeconds: number;
  /** R1: partidas cortas seguidas para avisar de la racha. */
  shortMatchStreak: number;
  /** R1: cada cuántas partidas cortas totales se avisa (5, 10, 15…). */
  shortMatchTotalStep: number;
  /** R2: partidas 1v1 seguidas contra el mismo rival para avisar de la racha. */
  repeatedOpponentStreak: number;
  /** R2: cada cuántas partidas contra el mismo rival se avisa (10, 20, 30…). */
  repeatedOpponentTotalStep: number;
  /** R3: partidas de equipo seguidas con el mismo compañero. */
  repeatedTeammateStreak: number;
  /** R3: partidas con el mismo compañero en total, un único aviso al llegar. */
  repeatedTeammateTotal: number;
  /**
   * Segundos del arranque en los que tiene que haber salido el primer aldeano.
   * Si no sale ninguno, la partida avisa (`NO_VILLAGERS_FIRST_MINUTES`).
   */
  noVillagersFirstSeconds: number;
  /** Gracia al principio de la partida en la que el militar puede no crecer. */
  noMilitaryGraceSeconds: number;
  /**
   * Ventana seguida, **después de la gracia**, sin que la puntuación militar haga
   * un máximo nuevo, para avisar (`NO_MILITARY_GAP`).
   */
  noMilitaryGapSeconds: number;
  /**
   * Ventana seguida sin que suba la suma de recursos recolectados, para avisar
   * (`NO_RESOURCES_GAP`).
   */
  noResourcesGapSeconds: number;
};

export type AlertsRuleset = {
  version: number;
  label: string;
  thresholds: AlertsThresholds;
};

/**
 * Los valores con los que se publica el ruleset la primera vez.
 *
 * Son los que acordaron cliente y organización: 3 minutos, rachas de 2 y 3,
 * acumulados cada 5 y cada 10 y 7 partidas con el mismo compañero. Se cambian en
 * `Setting["alerts.ruleset"]` sin desplegar, igual que los puntos por victoria del
 * motor de puntuación.
 *
 * Los cuatro últimos son los del resumen de partida: primer aldeano antes de los 5
 * minutos, 5 minutos de gracia y 5 seguidos sin máximo militar, y 2 seguidos sin
 * recolectar. **No suben `ALERTS_RULESET_VERSION`**: un documento guardado con la
 * versión 1 y solo las siete claves antiguas sigue siendo válido, y las nuevas se
 * completan con estos valores. Subir la versión invalidaría el documento entero —es
 * el criterio de `mergeAlertsRuleset()`— y eso borraría la configuración de la
 * organización para añadir cuatro claves que tienen un valor razonable por defecto.
 */
export const DEFAULT_ALERTS_RULESET: AlertsRuleset = {
  version: ALERTS_RULESET_VERSION,
  label: ALERTS_RULE_LABEL,
  thresholds: {
    shortMatchSeconds: 180,
    shortMatchStreak: 2,
    shortMatchTotalStep: 5,
    repeatedOpponentStreak: 3,
    repeatedOpponentTotalStep: 10,
    repeatedTeammateStreak: 3,
    repeatedTeammateTotal: 7,
    noVillagersFirstSeconds: 300,
    noMilitaryGraceSeconds: 300,
    noMilitaryGapSeconds: 300,
    noResourcesGapSeconds: 120,
  },
};

function defaultAlertsRuleset(): AlertsRuleset {
  return {
    ...DEFAULT_ALERTS_RULESET,
    thresholds: { ...DEFAULT_ALERTS_RULESET.thresholds },
  };
}

/** Un entero del ruleset: solo se acepta si es un entero positivo. */
function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

const THRESHOLD_KEYS = [
  "shortMatchSeconds",
  "shortMatchStreak",
  "shortMatchTotalStep",
  "repeatedOpponentStreak",
  "repeatedOpponentTotalStep",
  "repeatedTeammateStreak",
  "repeatedTeammateTotal",
  "noVillagersFirstSeconds",
  "noMilitaryGraceSeconds",
  "noMilitaryGapSeconds",
  "noResourcesGapSeconds",
] as const satisfies readonly (keyof AlertsThresholds)[];

export type AlertsRulesetMergeResult = {
  ruleset: AlertsRuleset;
  /** Ajustes que no se han podido aplicar; se avisa y se queda el valor por defecto. */
  warnings: string[];
};

/**
 * Combina el documento guardado con los valores por defecto. **Nunca lanza.**
 *
 * Mismo criterio que `mergeRuleset()` del motor de puntos, incluida la decisión
 * de que una `version` que no es la del código invalida el documento entero: si
 * el documento describe otra estructura, aplicar "lo que se parezca" sería peor
 * que usar los valores por defecto y decirlo.
 *
 * Un documento de la versión 1 escrito **antes** de las cuatro reglas del resumen
 * (solo las siete claves antiguas) se acepta tal cual: las claves que no vienen se
 * quedan con su valor por defecto. No es "aplicar lo que se parezca", es que faltar
 * una clave no cambia la estructura del documento, solo su contenido.
 */
export function mergeAlertsRuleset(stored: unknown): AlertsRulesetMergeResult {
  const warnings: string[] = [];
  const ruleset = defaultAlertsRuleset();

  if (!isRecord(stored)) {
    warnings.push("el valor no es un objeto; se usan los valores por defecto");
    return { ruleset, warnings };
  }

  const version = positiveInt(stored.version);

  if (version !== ALERTS_RULESET_VERSION) {
    warnings.push(
      `la versión guardada (${String(stored.version)}) no es ${ALERTS_RULESET_VERSION}; se ignoran los umbrales guardados`,
    );
    return { ruleset, warnings };
  }

  if (stored.label !== undefined && stored.label !== ALERTS_RULE_LABEL) {
    warnings.push("label se ignora: el texto lo fija el código (ALERTS_RULE_LABEL)");
  }

  if (stored.thresholds !== undefined) {
    if (isRecord(stored.thresholds)) {
      for (const key of THRESHOLD_KEYS) {
        const raw = stored.thresholds[key];

        if (raw === undefined) {
          continue;
        }

        const parsed = positiveInt(raw);

        if (parsed === null) {
          warnings.push(`thresholds.${key} no es un entero positivo: ${JSON.stringify(raw)}`);
        } else {
          ruleset.thresholds[key] = parsed;
        }
      }
    } else {
      warnings.push("thresholds no es un objeto");
    }
  }

  return { ruleset, warnings };
}

/* -------------------------------------------------------------------------- */
/* Lo que dispara una alerta                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Sujeto de una regla: de quién habla la alerta, o `null` si habla del jugador.
 *
 * `key` es la identidad estable dentro de la evaluación (para el jugador es un
 * centinela fijo) y es lo que va en la `dedupeKey`, así que **no** puede ser el
 * nombre: el nombre de un rival puede cambiar y la clave tiene que ser la misma
 * para que el dedupe funcione.
 */
export type AlertSubject = {
  key: string;
  profileId: number | null;
  name: string | null;
};

/** El sujeto de las reglas que hablan del propio jugador. */
export const SELF_SUBJECT: AlertSubject = { key: "yo", profileId: null, name: null };

/**
 * Los cuatro sitios donde una ficha declara un canal de directo.
 *
 * Son columnas de `Player`: las tres que escribe el panel (o la inscripción) más el
 * `twitchUrl` que publica AoE4World en el perfil, que es el respaldo del canal de
 * Twitch (ver `src/lib/public.ts`).
 */
export type StreamChannels = {
  twitchChannel: string | null;
  youtubeChannel: string | null;
  kickChannel: string | null;
  twitchUrl: string | null;
};

/**
 * ¿La ficha tiene algún canal de directo declarado? (`NO_STREAM_CHANNEL`)
 *
 * Es puro y se prueba aparte: lo que decide esta regla es una condición de columnas,
 * no una partida. Se pregunta por **todas** las formas a la vez porque el canal puede
 * estar en cualquiera de las cuatro, y un valor que no está vacío cuenta aunque no sea
 * un canal válido —eso lo valida el formulario, no la alerta—: de lo que avisa la
 * regla es de una ficha **sin ningún canal**, no de una con el canal mal escrito.
 */
export function hasStreamChannel(player: StreamChannels): boolean {
  return [player.twitchChannel, player.youtubeChannel, player.kickChannel, player.twitchUrl].some(
    (channel) => typeof channel === "string" && channel.trim() !== "",
  );
}

/**
 * Cómo se resolvió que la cuenta de Discord de un participante no está en el
 * servidor del torneo (`DISCORD_NOT_IN_GUILD`).
 *
 * Va en el `details` y **no** es un valor de `AlertRule`: los dos casos comparten
 * regla, frase y `dedupeKey`, y separarlos en dos reglas llenaría la pestaña de
 * Alertas de lo mismo dos veces con dos textos que hay que mantener en paralelo.
 */
export type DiscordNotInGuildResolvedBy = "discordUserId" | "username";

/**
 * Datos estructurados que van en `Alert.details`, por encima de los comunes.
 *
 * El nombre viene del uso mayoritario —lo que se sabe de la partida que ancla una
 * racha—, pero las reglas de estado no tienen ancla y aportan aquí lo suyo: los
 * `gameId` sondeados y las dos fechas que se compararon.
 */
export type AlertAnchorDetail = {
  /** Duración en segundos, si la partida la trae. */
  durationSeconds?: number;

  /* Reglas de estado: la evidencia con la que se comprobó. */

  /** Partidas sondeadas que no tienen summary (`HISTORY_NOT_PUBLIC`). */
  probedGameIds?: string[];
  /** Partidas sondeadas en total, incluidas las que sí lo tenían. */
  probedCount?: number;
  /** `Player.ladderGamesCount` al comprobar (`MISSING_LADDER_MATCHES`). */
  ladderGamesCount?: number | null;
  /** `Player.ladderLastGameAt`, en ISO-8601 UTC. */
  ladderLastGameAt?: string | null;
  /** Nuestra partida `rm_solo` más reciente en la ventana, en ISO-8601 UTC. */
  newestImportedAt?: string | null;
  /** Minutos que la ladder va por delante de esa partida. */
  lagMinutes?: number;

  /** Evidencia de `DISCORD_NOT_IN_GUILD`, la tercera regla de estado. */

  /**
   * Cómo se resolvió que la cuenta no está en el servidor.
   *
   * La regla es **una sola** para los dos casos y la frase es la misma, así que la
   * diferencia va aquí y no en un enum de regla nuevo:
   *
   * - `discordUserId`: la fila ya tenía la cuenta (por el vínculo OAuth2 de la
   *   inscripción) y el roster —o la consulta por id— ha dicho que esa cuenta no está.
   * - `username`: la fila solo tenía el `@usuario` que escribió la organización al
   *   dar de alta, y **ese `@usuario` no aparece** en la lista de miembros (o aparece
   *   dos veces). Aquí no se sabe de qué cuenta se trata, solo que no se la ha
   *   encontrado.
   *
   * Sin esta clave las dos alertas serían indistinguibles en el informe, y quien
   * mirase «su Discord no está en el servidor» no podría saber si es una cuenta que
   * se ha ido del servidor o un `@usuario` que nunca se ha podido emparejar.
   */
  resolvedBy?: DiscordNotInGuildResolvedBy;
  /** `Player.discordUserId` que se comprobó, o el que se resolvió con el `@usuario`. */
  discordUserId?: string;
  /**
   * `Player.discordUsername` en el momento de la comprobación, que es como lo trae
   * la fila: el nombre global **sin arroba** (`canonicalDiscordUsername()`).
   *
   * Va aunque haya `discordUserId`, porque es el dato que quien tiene que arreglarlo
   * necesita para buscar a esa persona en Discord.
   */
  discordUsername?: string;
  /** `Player.discordCheckedAt` en ISO-8601 UTC: el instante de la comprobación. */
  discordCheckedAt?: string;
  /**
   * Estado HTTP con el que respondió Discord, si hubo respuesta.
   *
   * `null` cuando la comprobación salió del roster y no de una petición por cuenta:
   * es la diferencia entre "la API dijo que no" y "no estaba en la lista que se leyó".
   */
  discordHttpStatus?: number | null;
  /** Miembros que tenía el roster cuando se comprobó, si la comprobación salió de él. */
  discordRosterMembers?: number;

  /* Reglas de partida desde el resumen (`MATCH_DETECTED`). */

  /**
   * Primer instante en que terminó un aldeano, en segundos de partida
   * (`NO_VILLAGERS_FIRST_MINUTES`). `null` = la lista era legible y no había
   * ninguno, que es lo que dispara la regla.
   */
  firstVillagerSeconds?: number | null;
  /** Inicio del tramo sin máximo militar (`NO_MILITARY_GAP`). */
  militaryNoGrowthFromSeconds?: number;
  /** Fin de ese tramo. */
  militaryNoGrowthToSeconds?: number;
  /** Inicio del tramo sin recolectar (`NO_RESOURCES_GAP`). */
  noResourceGainFromSeconds?: number;
  /** Fin de ese tramo. */
  noResourceGainToSeconds?: number;

  /* Evidencia de `SUMMARY_NOT_REVIEWED`. */

  /** Las partidas que quedaron sin revisar, de la más reciente a la más antigua. */
  unreviewedGameIds?: string[];
  /** El intento más reciente de esas partidas, en ISO-8601 UTC. */
  summaryLastAttemptAt?: string;
};

export type AlertTriggerInput = {
  rule: AlertsRuleName;
  kind: AlertKindName;
  playerId: string;
  /** `profileId` del jugador, para el `details` (estable aunque se renombre). */
  playerProfileId: number;
  subject: AlertSubject;
  count: number;
  threshold: number;
  anchorGameId: string | null;
  anchorStartedAt: Date | null;
  /** Familia de ladder de la partida ancla (`Match.mode`), cuando la tiene. */
  anchorLadder?: string | null;
  /**
   * Ventana del torneo, **solo para las reglas que miran partidas**.
   *
   * Es opcional, y no por descuido: `DISCORD_NOT_IN_GUILD` se evalúa contra la API
   * de Discord y no tiene nada que ver con fechas de partidas, así que escribir una
   * ventana en su `details` afirmaría un alcance que no tiene —"esto se comprobó
   * dentro del torneo"— y quien leyera el informe se llevaría una conclusión
   * falsa. Las reglas de partidas la pasan todas, y el `details` sale igual que
   * siempre (`alertDetails()` solo la escribe cuando viene).
   */
  window?: { from: string; to: string | null };
  detail?: AlertAnchorDetail;
};

/** Una alerta tal y como la va a escribir el evaluador. */
export type TriggeredAlert = {
  rule: AlertsRuleName;
  kind: AlertKindName;
  playerId: string;
  subjectProfileId: number | null;
  subjectName: string | null;
  count: number;
  threshold: number;
  anchorGameId: string | null;
  dedupeKey: string;
  summary: string;
  details: Prisma.InputJsonObject;
};

/**
 * La clave que hace idempotente la evaluación.
 *
 * Con `createMany({ skipDuplicates: true })` sobre este único índice único, el
 * evaluador inserta "solo lo nuevo" sin leer antes lo que ya hay. Los
 * ingredientes:
 *
 * - **regla y tipo**: R1 de racha y R1 de total son hechos distintos, y una
 *   racha que se cierra y una que se cierra por fin de torneo también.
 * - **jugador y sujeto**: el mismo hecho de dos jugadores son dos alertas, y el
 *   mismo hecho con dos rivales distintos también. El sujeto va por su `key`
 *   estable, no por su nombre.
 * - **el remate**: la partida que cierra la racha, o el número que se ha
 *   cruzado. Es lo que distingue "la racha de 3 partidas cerradas por la
 *   partida X" de "la racha de 3 partidas cerradas por la partida Y", y es lo que
 *   hace que reevaluar los mismos datos no produzca nada nuevo.
 *
 * ## La excepción: las reglas de estado no llevan remate
 *
 * Un estado **no tiene remate**: no hay tramo que cerrar ni número que cruzar, y
 * su corrección es que la condición deje de cumplirse (el jugador abre el
 * historial, la ladder vuelve a coincidir con lo que nos llega). Por eso
 * `STATE_DETECTED` mete `estado` en el sitio del remate y **se queda solo con
 * (regla, tipo, jugador, sujeto)**: una alerta por jugador y por hecho.
 *
 * Es la decisión de la que depende que estas reglas no llenen la tabla. Las dos
 * se reevalúan **cada 10 minutos** (la del historial con una caché de 12 h), así
 * que una clave con la partida sondeada o con los minutos de desfase insertaría
 * una fila nueva cada vez que cambiara el número, y en la práctica una alarma
 * cada 12 horas para siempre por jugador. Sin `anchorGameId` ni `count` en la
 * clave, la segunda pasada inserta 0 filas y la alerta sigue siendo la que se
 * escribió la primera vez. `rules.test.ts` lo fija con una prueba explícita,
 * porque es una propiedad que se rompe sin que nada falle.
 *
 * ## `MATCH_DETECTED` es lo contrario
 *
 * Un hallazgo dentro de una partida **sí** tiene remate y su remate es la partida:
 * `MATCH_DETECTED` cae en la rama `partida:<anchorGameId>`, así que hay una fila
 * por partida y regla —si el jugador tuvo tres partidas sin aldeanos, son tres
 * alertas— y reevaluarlas no duplica ninguna. Con la clave de estado, la primera
 * partida taparía todas las demás.
 *
 * El prefijo de versión existe para que un cambio en la forma de la clave no
 * choque con lo ya escrito: si algún día la clave cambia de ingredientes, sube
 * el prefijo y se vuelve a evaluar desde cero en lugar de saltarse filas.
 */
export function alertDedupeKey(input: {
  rule: AlertsRuleName;
  kind: AlertKindName;
  playerId: string;
  subjectKey: string;
  anchorGameId: string | null;
  count: number;
}): string {
  const remate =
    input.kind === "STATE_DETECTED"
      ? "estado"
      : input.kind === "TOTAL_REACHED"
        ? `total:${input.count}`
        : `partida:${input.anchorGameId ?? "-"}`;

  return [
    `v${ALERTS_RULESET_VERSION}`,
    input.rule,
    input.kind,
    input.playerId,
    input.subjectKey,
    remate,
  ].join("|");
}

/* -------------------------------------------------------------------------- */
/* Las frases                                                                  */
/* -------------------------------------------------------------------------- */

/** `1 partida` y `3 partidas`: el plural no es un detalle de estilo en un informe. */
export function partidas(count: number): string {
  return count === 1 ? "1 partida" : `${count} partidas`;
}

/**
 * Segundos en minutos, como se lee en un informe: "5 minutos", "1,5 minutos".
 *
 * Se redondea a un decimal y con **coma** porque el texto está en español, y solo
 * se quita el decimal cuando es exacto: "5 minutos" y no "5,0 minutos". Los
 * umbrales del ruleset son segundos y quien los retoca puede poner 330, así que la
 * frase no puede asumir que son múltiplos de 60.
 */
export function minutos(seconds: number): string {
  const value = seconds / 60;
  const text = Number.isInteger(value) ? String(value) : value.toFixed(1).replace(".", ",");

  return `${text} ${value === 1 ? "minuto" : "minutos"}`;
}

/**
 * La frase de una alerta, en la forma en que se pinta.
 *
 * El `switch` es exhaustivo sobre las reglas y no tiene `default`: si mañana
 * aparece una regla nueva, el compilador obliga a decidir aquí su frase en vez
 * de dejar que salga una por defecto que valdría para todo.
 */
export function alertSummary(input: AlertTriggerInput): string {
  const cierre = input.kind === "STREAK_AT_TOURNAMENT_END" ? " al cerrar el torneo" : "";

  switch (input.rule) {
    case "SHORT_MATCH_STREAK":
      return `${partidas(input.count)} cortas seguidas${cierre}`;
    case "SHORT_MATCH_TOTAL":
      return `${partidas(input.count)} cortas en total`;
    case "REPEATED_OPPONENT_STREAK":
      return `${partidas(input.count)} seguidas contra ${input.subject.name ?? "el mismo rival"}${cierre}`;
    case "REPEATED_OPPONENT_TOTAL":
      return `${partidas(input.count)} contra ${input.subject.name ?? "el mismo rival"} en total`;
    case "REPEATED_TEAMMATE_STREAK":
      return `${partidas(input.count)} de equipo seguidas con ${
        input.subject.name ?? "el mismo compañero"
      }${cierre}`;
    case "REPEATED_TEAMMATE_TOTAL":
      return `${partidas(input.count)} de equipo con ${input.subject.name ?? "el mismo compañero"} en total`;
    // Las dos frases siguientes son de reglas retiradas (ver el docblock del
    // módulo). Se quedan por las filas históricas, y sin el detalle que las
    // acompañaba —`eloGap` y `steps`, que ya no existen— dicen su forma genérica.
    case "TEAMMATE_ELO_GAP":
      return `${partidas(input.count)} de equipo con un compañero muy por encima o por debajo${cierre}`;
    case "LOW_DIVISION_TEAM_GAME":
      return `${partidas(input.count)} de equipos en una división muy distinta a la suya${cierre}`;
    // Las dos de estado van al final y sin `cierre`: no son un tramo que se cierre,
    // son algo que se ha comprobado. Las frases dicen **qué se ha comprobado**, nunca
    // por qué: el equipo de Alerts no sabe si el jugador cambió el ajuste, si se le
    // olvidó, si la API dejó de publicar su historial o si el problema es nuestro, y
    // escribir una causa sería escribirla inventada. Y no hay nada que acusar: la
    // transparencia del torneo (poder consultar cualquier partida de un participante)
    // se cumple abriendo el toggle, que es un ajuste del juego.
    case "HISTORY_NOT_PUBLIC":
      return "Su historial de partidas no es público";
    case "MISSING_LADDER_MATCHES":
      return "La ladder registra partidas que no nos llegan";
    // La tercera de estado (F12). Como las otras dos, la frase dice **qué se ha
    // comprobado** y no por qué: la cuenta puede no estar porque la persona no se ha
    // unido, porque el bot no pudo meterla o porque la comprobación no se ha podido
    // hacer, y el equipo de Alertas no puede distinguir eso desde aquí.
    case "DISCORD_NOT_IN_GUILD":
      return "Su Discord no está en el servidor del torneo";
    // La cuarta de estado, y la única que solo se comprueba si la edición la pide.
    // Como las otras tres, dice **qué se ha comprobado** y no por qué: no consta
    // ningún canal, y si es un olvido o una decisión no se sabe desde aquí.
    case "NO_STREAM_CHANNEL":
      return "Su ficha no tiene ningún canal de directo";
    // Las cuatro siguientes son las del resumen. Las tres primeras describen **lo
    // que se vio dentro de una partida**, sin adjetivos y sin causa: "no hizo
    // aldeanos" es un hecho del resumen, no una acusación, y la revisión decide qué
    // significa. La del final es de estado y dice lo que no se pudo hacer.
    case "NO_VILLAGERS_FIRST_MINUTES":
      return `No hizo ningún aldeano en los primeros ${minutos(input.threshold)}.`;
    case "NO_MILITARY_GAP":
      return `Pasó ${minutos(input.count)} seguidos sin progreso militar.`;
    case "NO_RESOURCES_GAP":
      return `Pasó ${minutos(input.count)} seguidos sin obtener recursos.`;
    case "SUMMARY_NOT_REVIEWED":
      return input.count === 1
        ? "1 partida no se ha podido revisar por falta de resumen"
        : `${input.count} partidas no se han podido revisar por falta de resumen`;
  }
}

/**
 * Los mismos datos, estructurados, en `Alert.details`.
 *
 * No se lee para pintar el informe (eso es `summary`): es para el que tenga que
 * mirar por qué una partida concreta sale marcada. Lleva identificadores y no
 * solo frases, y **no lleva datos que ya no sean ciertos**: el nombre del
 * sujeto va en su propia columna, y el del jugador tampoco (el panel lo saca de
 * `Player`, que es donde vive y donde puede estar actualizado).
 *
 * La ventana del torneo va solo si quien dispara la trae: `DISCORD_NOT_IN_GUILD`
 * se comprueba contra la API de Discord y no tiene fechas, así que en esa fila no se
 * escriben `windowFrom` ni `windowTo`, porque una ventana que no aplica es una
 * afirmación que alguien acabaría creyendo.
 */
export function alertDetails(input: AlertTriggerInput): Prisma.InputJsonObject {
  const detail = input.detail ?? {};

  return {
    rule: input.rule,
    kind: input.kind,
    playerProfileId: input.playerProfileId,
    count: input.count,
    threshold: input.threshold,
    ...(input.subject.profileId === null ? {} : { subjectProfileId: input.subject.profileId }),
    ...(input.anchorGameId === null ? {} : { anchorGameId: input.anchorGameId }),
    ...(input.anchorStartedAt === null
      ? {}
      : { anchorStartedAt: input.anchorStartedAt.toISOString() }),
    ...(input.anchorLadder === undefined || input.anchorLadder === null
      ? {}
      : { anchorLadder: input.anchorLadder }),
    ...(input.window === undefined
      ? {}
      : {
          windowFrom: input.window.from,
          ...(input.window.to === null ? {} : { windowTo: input.window.to }),
        }),
    ...detail,
  };
}

/** Monta la alerta completa: clave, frase y detalles, siempre del mismo tirón. */
export function buildTriggeredAlert(input: AlertTriggerInput): TriggeredAlert {
  return {
    rule: input.rule,
    kind: input.kind,
    playerId: input.playerId,
    subjectProfileId: input.subject.profileId,
    subjectName: input.subject.name,
    count: input.count,
    threshold: input.threshold,
    anchorGameId: input.anchorGameId,
    dedupeKey: alertDedupeKey({
      rule: input.rule,
      kind: input.kind,
      playerId: input.playerId,
      subjectKey: input.subject.key,
      anchorGameId: input.anchorGameId,
      count: input.count,
    }),
    summary: alertSummary(input),
    details: alertDetails(input),
  };
}
