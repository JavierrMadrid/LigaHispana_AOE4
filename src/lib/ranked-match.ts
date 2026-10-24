import "server-only";

import { Prisma } from "@/generated/prisma/client";
import { MatchResult } from "@/generated/prisma/enums";
import { subdivisionForRating, type LadderCutoffsTable } from "@/lib/alerts/division-cutoffs";
import { parseTeamView } from "@/lib/aoe4world/parse";
import { SUBDIVISIONS_PER_DIVISION, divisionTier, subdivisionIndex } from "@/lib/divisions";
import { isRecord } from "@/lib/json";

/**
 * Qué cuenta como partida clasificatoria, y en un solo sitio.
 *
 * Este módulo es la **única definición** de la regla con la que el motor filtra
 * partidas, en sus tres traducciones al mundo real:
 *
 * | Forma | El corte de inscripción | Dónde se usa |
 * |---|---|---|
 * | `countsAsRanked()` (fila a fila, en memoria) | lo pasa quien llama | decisiones y comprobaciones de una partida suelta (`admin/actions.ts`, `verify-sync`) |
 * | `rankedMatchWhere()` (filtro de Prisma) | lo pasa quien llama | consultas de Prisma que ya saben de qué jugador hablan; **no** vale para una que abarque a todos |
 * | `rankedMatchSql()` (predicado SQL) | sale de la fila de `Player` de la propia consulta | consultas que abarcan a todos los jugadores: el `UPDATE` de `Match.points`, el agregado de la clasificación y la carga de `objectives.ts` |
 *
 * Las tres dicen lo mismo por una razón estructural: `scoring.ts` importa de
 * `objectives.ts`, así que la definición **no** puede vivir en ninguno de los dos
 * sin que uno tenga que importar al otro. Aquí no se importa nada del motor, y los
 * tres caminos (y `verify:sync`) consumen estas funciones.
 *
 * ## Las seis condiciones
 *
 * 1. La familia de ladder viene en el ruleset (`rm_solo` / `rm_team` por defecto).
 * 2. La partida está **resuelta** (`result` y `finishedAt` informados): una
 *    partida en curso nunca puntúa, ni en positivo ni en negativo.
 * 3. `startedAt` no es anterior al **corte** (`scoringCutoff()`), que es
 *    `max(window.from, Player.registeredAt)`.
 * 4. `startedAt` es anterior a `window.to`, que es **exclusivo** (esta condición
 *    solo existe si la ventana tiene fin).
 * 5. La partida **no está revertida** (`Match.revertedAt IS NULL`), que es la
 *    marca que pone el panel de admin para que una partida deje de puntuar.
 * 6. En una partida **por equipos**, ningún compañero está a **dos escalones o
 *    más** del jugador (`teammatesWithinTier()`): la partida cuenta solo si el
 *    equipo está equilibrado, y se compara cada compañero con el jugador, nunca
 *    los compañeros entre sí.
 *
 * La **ventana de fechas** no está replicada: sus límites y su semántica salen
 * siempre de `windowBounds()` y `scoringCutoff()`, que es lo que usan
 * `countsWithinWindow()`, `windowWhere()` y `windowMatchSql()`. Lo único que se
 * repite es la lista de condiciones, y cada traducción la tiene escrita en su
 * sitio: **si alguna vez se toca una, hay que tocar las demás**.
 * `verify:sync` lo contrasta contra datos de verdad.
 *
 * ## La sexta condición solo cabe en dos de las tres traducciones
 *
 * Necesita `Match.rawJson` (los compañeros y su rating) y los cortes rating →
 * subdivisión (`Setting["alerts.divisionCutoffs"]`), y un `where` de Prisma no lee
 * ni un JSON ni un `Setting`: compara campos con valores. Por eso **no está** en
 * `rankedMatchWhere()`, que la documenta como lo que es, y sus consumidores
 * filtran después en memoria con `teammatesWithinTier()` —es lo que hacen
 * `alerts/evaluate.ts` y `sync.ts`—. Las otras dos traducciones la llevan
 * completas: el SQL la resuelve sobre el propio `jsonb` (`teammatesWithinTierSql()`)
 * y `countsAsRanked()` con el lector de payload de `aoe4world/parse.ts`.
 *
 * ## La condición de equipos degrada hacia "cuenta"
 *
 * Todo lo que impida demostrar que el equipo está desequilibrado —un payload que
 * no se puede leer, un rating ausente o no numérico, el jugador fuera de `teams`,
 * o no tener los cortes de esa familia— deja la partida **contando**: no se puede
 * acusar a nadie con un dato que no existe. La ausencia de cortes se avisa, además,
 * en el rastro del recálculo (`Setting["scoring.lastRun"]`, ver `recomputeScores()`),
 * porque ahí es un hueco de configuración de todo el torneo, no de una partida.
 *
 * ## Por qué hay dos maneras de decir el corte
 *
 * Porque las tres traducciones no pueden compilarlo igual. Las de SQL llevan la
 * fila de `Player` en la propia consulta, así que lo escriben como columna
 * (`player."registeredAt"`, con el `is null` que hace que `null` cuente desde
 * `window.from`). Las otras dos son consultas de las que **ya se sabe de qué
 * jugador hablan**, así que se les pasa su `registeredAt`: un `where` de Prisma
 * compara un campo con un valor y nunca dos columnas, y una referencia a campo
 * (`prisma.player.fields.registeredAt`) solo vale entre campos del modelo que se
 * está consultando —probado en esta versión: *"Expected a referenced scalar field
 * of model Match, but found a field of model Player"*. Por eso el agregado de la
 * clasificación, que sí abarca a todos los jugadores, es SQL crudo y no un
 * `groupBy`.
 *
 * La quinta condición tiene dos excepciones, y las dos son deliberadas.
 * `classificatoryWhere()` es la misma regla **sin** la marca de revertida, porque
 * el historial del panel tiene que enseñar las revertidas para poder deshacerlas;
 * y el historial del panel le pasa además `registeredAt = null`, porque enseña el
 * recorrido entero de cada participante —con sus 0 puntos a la vista— y no solo lo
 * que le suma. Lo que puntúa lo dicen `Match.points` y la clasificación. La
 * **sexta** sigue la misma regla de producto: una partida de equipo con un
 * compañero a dos escalones **se queda listada** con 0 puntos en
 * `/admin/historial` (`classificatoryWhere()` no puede expresarla, así que ahí
 * tampoco se filtra), porque es el recorrido del jugador igual que una revertida.
 *
 * Y hay un caso al revés, en `rankedModesWhere()`: una consulta que no puede
 * aplicar la regla entera porque su partida **todavía no está resuelta**
 * (`/partidas`) y solo puede quedarse con la familia. Sigue leyendo
 * `ruleset.modes` como las otras, así que no nace una segunda lista de modos que
 * se pueda desincronizar de la que puntúa.
 */

/* -------------------------------------------------------------------------- */
/* Familias de ladder                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Familias de ladder que cuentan como partida clasificatoria.
 *
 * Son las dos ladders *ranked* del modo competitivo: 1v1 y por equipos (2v2, 3v3
 * y 4v4 comparten familia y por eso `Match.mode` las colapsa en `rm_team`).
 * El ruleset puede ampliar la lista sin tocar el schema, y sus dos traducciones a
 * SQL leen `ruleset.modes` en lugar de esta constante.
 */
export const RANKED_MODES = ["rm_solo", "rm_team"] as const;

export type RankedMode = (typeof RANKED_MODES)[number];

export function isRankedMode(mode: string | null): mode is RankedMode {
  return mode === "rm_solo" || mode === "rm_team";
}

/* -------------------------------------------------------------------------- */
/* Ventana de fechas                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Ventana del torneo, en instantes ISO-8601 **con zona explícita** (`Z` o
 * `±hh:mm`).
 *
 * `from` es obligatorio y `to` es **exclusivo**: la partida cuenta si empezó en
 * `[from, to)`. Un `to` de `null` deja la ventana abierta por la derecha, que es
 * lo que permite fijar el fin del torneo más tarde sin tocar código.
 *
 * **Por qué se guarda como texto y no como `Date`.** `window` vive dentro del
 * documento JSON de `Setting`, así que tiene que ser serializable; además el
 * texto es lo que se lee y se corrige a mano desde el panel o con un SQL, y un
 * `Date` ahí no se puede editar. `parseWindow()` es la única puerta de entrada
 * desde configuración y normaliza siempre a ISO-8601 UTC.
 *
 * **Por qué UTC y no "medianoche en Madrid".** El resto del proyecto guarda
 * instantes como ISO-8601 UTC (`since`, `lastSyncedAt`, el `startedAt` que
 * publica AoE4World) y `Match.startedAt` es un `timestamp` sin zona **interpretado
 * en UTC** (ver `objectives.ts`). Escribir "medianoche Europe/Madrid" metería un
 * offset que además cambia con el horario de verano, así que la frontera de la
 * ventana se movería dos veces al año. Con instantes UTC el corte es el mismo los
 * 365 días, sea quien lo lea o lo cambie.
 */
export type ScoringWindow = {
  /** Instante inclusive: la partida cuenta si `startedAt >= from`. */
  from: string;
  /** Instante exclusivo: la partida cuenta si `startedAt < to`; `null` = sin fin. */
  to: string | null;
};

/** La ventana ya traducida a los valores con los que se compara. */
export type ScoringWindowBounds = {
  from: Date;
  to: Date | null;
};

/**
 * La ventana como se compara de verdad.
 *
 * Devuelve los dos límites como `Date`, que es lo que necesitan tanto la
 * comparación en memoria como el filtro de Prisma. No se cachea: se llama una vez
 * por fila o por consulta, y una caché de un valor que además depende del ruleset
 * guardado en la base no compensaría.
 */
export function windowBounds(window: ScoringWindow): ScoringWindowBounds {
  return { from: new Date(window.from), to: window.to === null ? null : new Date(window.to) };
}

/**
 * Desde cuándo puntúan las partidas de **este** jugador: `max(window.from, registeredAt)`.
 *
 * La ventana del torneo es global, pero el corte de cada participante no: a
 * alguien que la organización da de alta a mitad de torneo no le cuentan las
 * partidas que jugó antes de entrar, por muchas que trajera importadas de su
 * histórico. `registeredAt` es el **envío** del alta y no la aprobación, así que
 * apuntarse a tiempo no cuesta partidas aunque la organización mire la solicitud
 * más tarde.
 *
 * `registeredAt === null` devuelve `window.from`, que es lo que le toca a todo el
 * que ya estaba inscrito cuando se añadió la columna: `null` no es "no lo
 * sabemos", es "desde el principio del torneo".
 *
 * Es el mismo `max` que escribe el SQL crudo (`registrationCutoffSql()`) y el
 * que llevan a cabo las dos traducciones que reciben el `registeredAt` de su
 * jugador. Un `window.from` ilegible sale con `NaN` en las dos: `Math.max` lo
 * propaga y la comparación da `false`, que es la dirección segura.
 */
export function scoringCutoff(window: ScoringWindow, registeredAt: Date | null): Date {
  const { from } = windowBounds(window);

  return registeredAt !== null && registeredAt.getTime() > from.getTime() ? registeredAt : from;
}

/**
 * ¿Cae esta partida en el corte y antes del final de la ventana?
 *
 * Es la comprobación en memoria de la ventana **con el corte del jugador**, y la
 * usan `countsAsRanked()`, el motor de alertas y las comprobaciones de
 * `verify:sync`. La traducción a SQL es `windowWhere()` + `windowMatchSql()`.
 *
 * El `registeredAt` es un parámetro **obligatorio** y no opcional a propósito: la
 * regla ahora depende del jugador, así que quien llama tiene que saber el suyo. Un
 * `null` por defecto haría que "se me olvidó" fuera indistinguible de "este
 * jugador no tiene fecha de inscripción", que es justo la divergencia que este
 * módulo existe para impedir. Quien pregunta por una partida sin jugador delante
 * —el sondeo del historial, la regla de la ladder— pasa `null` a propósito, porque
 * ahí lo que se pregunta es qué partidas existen y no cuáles puntúan.
 *
 * Un límite que no se puede leer (una ventana construida a mano con un texto
 * inválido) hace que la comparación sea `false`: el fallo cae hacia "no cuenta",
 * que es la dirección segura, porque repartir puntos que no tocan sería peor que
 * no repartir ninguno.
 */
export function countsWithinWindow(
  startedAt: Date,
  window: ScoringWindow,
  registeredAt: Date | null,
): boolean {
  const { to } = windowBounds(window);
  const at = startedAt.getTime();

  return (
    at >= scoringCutoff(window, registeredAt).getTime() && (to === null || at < to.getTime())
  );
}

/**
 * Un instante escrito con zona explícita.
 *
 * Se rechaza a propósito lo que `Date.parse` admitiría sin más: `"2026-09-15"` lo
 * interpreta como UTC, pero `"2026-09-15T00:00:00"` (sin zona) lo interpreta como
 * hora **local**, así que un `Setting` escrito a mano acabaría aplicando un offset
 * distinto según desde dónde se mire. Con el patrón de abajo solo entra lo que no
 * admite interpretación: un instante, con su zona.
 *
 * Se exporta para que el DAL de admin lea los filtros de fecha de la URL con
 * **el mismo criterio** que el ruleset: un parámetro de la query es entrada no
 * confiable, y no puede traerse un instante con una zona distinta según desde qué
 * sitio se mire.
 */
const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

export function readInstant(value: unknown): Date | null {
  if (typeof value !== "string" || !INSTANT_PATTERN.test(value)) {
    return null;
  }

  const ms = Date.parse(value);

  return Number.isNaN(ms) ? null : new Date(ms);
}

export type ParsedWindow = {
  /** La ventana a usar: la guardada si vale, la de por defecto si no. */
  window: ScoringWindow;
  /**
   * Avisos para el log. Puede haber alguno aunque la ventana sí se aplique (por
   * ejemplo, un `to` que no viene), y también cuando se descarta entera.
   */
  warnings: string[];
};

/**
 * Valida el `window` guardado en `Setting` y devuelve la ventana a usar.
 *
 * Nunca lanza: una ventana inútil se descarta y se cae al valor por defecto, que
 * es lo que evita que un documento retocado a mano tumbe el arranque del motor.
 * Los avisos los imprime `mergeRuleset`.
 *
 * Reglas, en orden:
 *
 * - `window` tiene que ser un objeto.
 * - `from` es obligatorio y tiene que ser un instante con zona explícita.
 * - `to` puede ser `null` (ventana abierta) o un instante. **Si la clave no
 *   viene**, se hereda el `to` del documento por defecto y se avisa: abrir la
 *   ventana hay que pedirlo escribiendo `null`, no por efecto de olvidarse.
 * - Si `to <= from` la ventana no puntuaría ninguna partida, así que se descarta
 *   entera: es un error de configuración, no una decisión.
 */
export function parseWindow(value: unknown, fallback: ScoringWindow): ParsedWindow {
  const fallbackWindow = (): ScoringWindow => ({ ...fallback });

  if (!isRecord(value)) {
    return { window: fallbackWindow(), warnings: ["window no es un objeto"] };
  }

  const from = readInstant(value.from);

  if (from === null) {
    return {
      window: fallbackWindow(),
      warnings: [`window.from no es un instante ISO-8601 con zona: ${JSON.stringify(value.from)}`],
    };
  }

  const warnings: string[] = [];
  const defaultTo = fallbackWindow().to;
  let to: Date | null;

  if (value.to === null) {
    to = null;
  } else if (value.to === undefined) {
    to = defaultTo === null ? null : new Date(defaultTo);

    if (to !== null) {
      warnings.push("window.to no viene: se usa el del documento por defecto; escribe null para abrirla");
    }
  } else {
    const parsed = readInstant(value.to);

    if (parsed === null) {
      warnings.push(`window.to no es un instante ISO-8601 con zona: ${JSON.stringify(value.to)}`);
      to = defaultTo === null ? null : new Date(defaultTo);
    } else {
      to = parsed;
    }
  }

  if (to !== null && to.getTime() <= from.getTime()) {
    return {
      window: fallbackWindow(),
      warnings: [
        ...warnings,
        "window.from es posterior o igual a window.to: la ventana no puntuaría nada; se usa la de por defecto",
      ],
    };
  }

  return {
    window: { from: from.toISOString(), to: to === null ? null : to.toISOString() },
    warnings,
  };
}

/* -------------------------------------------------------------------------- */
/* Ventana escrita a mano en el panel                                          */
/* -------------------------------------------------------------------------- */

/**
 * La zona con la que la organización lee el torneo.
 *
 * Es la misma que usan `objectives.ts` (el día natural de una partida) y
 * `alerts/report.ts` (las fechas del informe), y la única que aparece en el panel.
 */
const MADRID_TIME_ZONE = "Europe/Madrid";

/**
 * Un valor de un `<input type="datetime-local">`: `YYYY-MM-DDTHH:mm`, con segundos
 * opcionales. **Sin zona**, que es justo lo que manda el control del navegador.
 */
const LOCAL_INSTANT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/** Las partes del calendario de Madrid que se leen de un instante. */
type MadridPart = "year" | "month" | "day" | "hour" | "minute" | "second";

/**
 * El instante, descompuesto en el reloj de pared de Madrid.
 *
 * `hourCycle: "h23"` evita el `24` de medianoche que algunos entornos dan con
 * `hour12: false`; `en-CA` numera con dos dígitos en todos los campos.
 */
const MADRID_PARTS = new Intl.DateTimeFormat("en-CA", {
  timeZone: MADRID_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/** Las partes de Madrid de un instante, ya como números. */
function madridParts(utcMs: number): Record<MadridPart, number> {
  const parts = MADRID_PARTS.formatToParts(new Date(utcMs));
  const part = (type: MadridPart): number =>
    Number(parts.find((entry) => entry.type === type)?.value);

  return {
    year: part("year"),
    month: part("month"),
    day: part("day"),
    hour: part("hour"),
    minute: part("minute"),
    second: part("second"),
  };
}

/**
 * El desfase de Madrid respecto a UTC en un instante dado, en milisegundos.
 *
 * El proyecto no arrastra ninguna dependencia de zonas horarias, así que el
 * desfase sale de `Intl`: se formatea el instante en el calendario de Madrid, se
 * reconstruye ese reloj de pared como si fuera UTC y la diferencia es el desfase.
 * Cambia dos veces al año, en los cambios de hora, y por eso se calcula **por
 * instante** en vez de una sola vez.
 */
function madridOffsetMs(utcMs: number): number {
  const { year, month, day, hour, minute, second } = madridParts(utcMs);

  return Date.UTC(year, month - 1, day, hour, minute, second) - utcMs;
}

/**
 * Un reloj de pared de Madrid, en milisegundos "ingenuos" (como si fuera UTC), a
 * instante UTC.
 *
 * El desfase de Madrid depende del instante, así que se resuelve en dos pasadas:
 * la primera con el desfase del propio reloj de pared, y la segunda con el del
 * instante que sale de la primera. La segunda pasada es la que acierta en los dos
 * cambios de hora, donde el desfase de partida no es el definitivo.
 *
 * **Criterio en las horas del cambio de hora**, que es lo único que esta función
 * tiene que decidir por su cuenta:
 *
 * - **Ambiguas** (el domingo de octubre, la franja de 02:00 a 03:00 ocurre dos
 *   veces): se toma la **segunda**, la del horario de invierno. La primera pasada
 *   ya cae ahí.
 * - **Inexistentes** (el domingo de marzo, la franja de 02:00 a 03:00 no ocurre):
 *   se toma el instante **justo después del salto**, una hora más tarde de lo
 *   escrito. La segunda pasada es la que lo desplaza.
 *
 * Los dos casos son deterministas y están probados. Un `datetime-local` que caiga
 * en el hueco no se puede rechazar sin inventarse una regla, y esta es la que
 * menos sorprende al mirar el reloj de Madrid.
 */
function madridLocalToUtc(naiveMs: number): number {
  const firstOffset = madridOffsetMs(naiveMs);
  const firstGuess = naiveMs - firstOffset;
  const secondOffset = madridOffsetMs(firstGuess);

  return secondOffset === firstOffset ? firstGuess : naiveMs - secondOffset;
}

/**
 * Un instante escrito a mano para la ventana, normalizado a ISO-8601 UTC.
 *
 * Es la puerta de entrada del panel, y acepta las dos formas que puede haber en
 * un formulario:
 *
 * - Un instante ISO-8601 **con zona** (lo que hoy guarda `Setting`): se valida con
 *   `readInstant()` y se normaliza, sin reinterpretar nada.
 * - Un `datetime-local` (`YYYY-MM-DDTHH:mm`, con segundos opcionales), que es lo
 *   que manda un `<input type="datetime-local">` y **no lleva zona**: se interpreta
 *   en `Europe/Madrid`, la zona con la que la organización lee el torneo (ver
 *   `madridLocalToUtc()` para las horas del cambio de hora).
 *
 * Devuelve `null` si el texto no es ninguna de las dos cosas o no es una fecha real
 * (mes 13, 31 de febrero, hora 25): el llamante decide qué mensaje enseñar. El
 * resultado es siempre ISO-8601 UTC, así que sigue siendo válido para
 * `parseWindow()` y para `Setting`.
 */
export function parseMadridLocalInstant(value: string): string | null {
  const instant = readInstant(value);

  if (instant !== null) {
    return instant.toISOString();
  }

  const match = LOCAL_INSTANT_PATTERN.exec(value);

  if (match === null) {
    return null;
  }

  const [, year, month, day, hour, minute, second] = match;
  const naive = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    second === undefined ? 0 : Number(second),
  );
  const check = new Date(naive);

  // Un componente fuera de rango (mes 13, 31 de febrero, hora 25) hace que
  // `Date.UTC` ruede al siguiente campo: si algo rodó, no era una fecha.
  if (
    check.getUTCFullYear() !== Number(year) ||
    check.getUTCMonth() !== Number(month) - 1 ||
    check.getUTCDate() !== Number(day) ||
    check.getUTCHours() !== Number(hour) ||
    check.getUTCMinutes() !== Number(minute)
  ) {
    return null;
  }

  return new Date(madridLocalToUtc(naive)).toISOString();
}

/**
 * El inverso de `parseMadridLocalInstant()`: un instante, al `datetime-local` de
 * Madrid.
 *
 * Es lo que prefila el campo del panel, y por eso devuelve `YYYY-MM-DDTHH:mm`
 * **sin zona** y **sin segundos**: el valor exacto que espera un
 * `<input type="datetime-local">`. Solo acepta un instante ISO-8601 con zona (lo
 * que hay guardado); cualquier otra cosa devuelve `null` para que el campo se
 * pinte vacío en vez de con un texto inventado.
 */
export function formatMadridLocalInstant(iso: string): string | null {
  const instant = readInstant(iso);

  if (instant === null) {
    return null;
  }

  const { year, month, day, hour, minute } = madridParts(instant.getTime());
  const two = (value: number): string => String(value).padStart(2, "0");

  return `${year}-${two(month)}-${two(day)}T${two(hour)}:${two(minute)}`;
}

/* -------------------------------------------------------------------------- */
/* La condición de equipos                                                     */
/* -------------------------------------------------------------------------- */

/**
 * El escalón máximo que puede separar al jugador de cada compañero.
 *
 * `1` significa "un escalón o menos": dos o más (en cualquiera de los dos
 * sentidos) dejan la partida fuera. Es la única magnitud de la condición que no
 * sale de configuración, y por eso vive en una constante que usan **las dos**
 * traducciones que pueden aplicarla, en vez de repetirse en el SQL y en el JS.
 */
const MAX_TEAMMATE_TIER_DISTANCE = 1;

/**
 * Lo que hace falta para aplicar la condición de equipos a las partidas de **un**
 * jugador: quién es (para localizarlo dentro de `Match.rawJson`) y los cortes
 * rating → subdivisión de la familia de la partida.
 *
 * Va en un objeto y no en dos parámetros sueltos porque las dos cosas viajan
 * juntas desde el mismo sitio (el jugador del que se está hablando y lo que hay
 * cacheado) y porque el sitio donde se olvida una es justo donde se olvidaría la
 * otra.
 */
export type TeamTierContext = {
  /** `Player.profileId` del dueño de la partida. */
  profileId: number;
  /**
   * Cortes rating → subdivisión por familia de ladder, o `null` si no hay ninguno
   * cacheado. `null` **no** es un error: la partida cuenta (ver el docblock del
   * módulo) y el aviso de esa falta lo da el recálculo.
   */
  cutoffs: LadderCutoffsTable | null;
};

/**
 * ¿Ningún compañero está a dos escalones o más del jugador?
 *
 * Es la condición de equipos en memoria, y la comparten `countsAsRanked()` (la
 * comprobación de una partida suelta) y el filtro del motor de alertas
 * (`alerts/evaluate.ts`), que tiene que ver exactamente las partidas que puntúan.
 * Por eso está exportada y no enterrada en `countsAsRanked()`: el motor de alertas
 * no puede reimplementarla sin arriesgarse a discrepar del de puntos.
 *
 * | Qué falta | Qué hace |
 * |---|---|
 * | Sin cortes cacheados, o sin los de esta familia | `true`: no se puede demostrar la infracción |
 * | `rawJson` ilegible, o el jugador no está en ningún equipo | `true` |
 * | Sin rating del jugador, o sin rating del compañero | `true` |
 *
 * Se compara **cada compañero con el jugador** y nunca los compañeros entre sí, y
 * el escalón ignora el subrango: `gold_3` y `gold_1` son el mismo escalón, así que
 * un compañero en oro siempre está a cero escalones sea cual sea su subrango.
 *
 * La familia se busca por `mode` (`Match.mode` ya viene resuelto a `rm_team` para
 * 2v2/3v3/4v4) y no por el literal de `leaderboard`: los cortes se cachean por
 * familia, así que un `rm_3v3` indexado por su literal se quedaría sin cortes.
 *
 * Una partida de 1v1 no tiene compañeros, así que la condición se cumple sola sin
 * necesidad de comprobar el modo.
 */
export function teammatesWithinTier(
  rawJson: unknown,
  mode: string | null,
  context: TeamTierContext,
): boolean {
  const ladder = context.cutoffs === null || mode === null ? undefined : context.cutoffs[mode];

  if (ladder === undefined) {
    return true;
  }

  const team = parseTeamView(rawJson, context.profileId);

  if (team === null || team.self === null || team.self.rating === null) {
    return true;
  }

  const propia = subdivisionForRating(ladder, team.self.rating);

  if (propia === null) {
    return true;
  }

  const escalonPropio = divisionTier(propia.index);

  return team.teammates.every((mate) => {
    if (mate.rating === null) {
      return true;
    }

    const suya = subdivisionForRating(ladder, mate.rating);

    return (
      suya === null ||
      Math.abs(divisionTier(suya.index) - escalonPropio) <= MAX_TEAMMATE_TIER_DISTANCE
    );
  });
}

/** Un corte de una familia, ya reducido a lo que el predicado SQL necesita. */
type SqlCutoff = {
  /** Índice del catálogo de subdivisiones (`subdivisionIndex()`), 0 = `conqueror_3`. */
  index: number;
  minRating: number;
};

/**
 * Los cortes cacheados, resueltos a `{ index, minRating }` por familia.
 *
 * El `index` es el del catálogo (`subdivisionIndex()`), **no** la posición en la
 * lista: así el SQL y `subdivisionForRating()` cuentan el mismo escalón aunque el
 * documento guardado viniera con huecos. Las filas cuyo `rankLevel` no resuelve
 * —que `readCutoffsTable()` ya descarta al leer, así que aquí no debería haber
 * ninguna— se caen; con menos cortes, el peor caso es que la partida cuente.
 */
function sqlCutoffs(cutoffs: LadderCutoffsTable): Record<string, SqlCutoff[]> {
  const byLadder: Record<string, SqlCutoff[]> = {};

  for (const [ladder, entry] of Object.entries(cutoffs)) {
    const rows = entry.cutoffs.flatMap((cutoff) => {
      const index = subdivisionIndex(cutoff.rankLevel);

      return index === null ? [] : [{ index, minRating: cutoff.minRating }];
    });

    if (rows.length > 0) {
      byLadder[ladder] = rows;
    }
  }

  return byLadder;
}

/** El objeto `jsonb` de `rawJson` del jugador de la fila `alias`, con las dos formas que acepta `parse.ts`. */
function gamePlayerSql(alias: string): Prisma.Sql {
  return Prisma.sql`coalesce(${Prisma.raw(alias)} -> 'player', ${Prisma.raw(alias)})`;
}

/** El escalón al que cae `rating` con los cortes `ladder`, como expresión SQL. */
function tierSql(rating: Prisma.Sql, ladder: Prisma.Sql): Prisma.Sql {
  // Réplica de `subdivisionForRating()` + `divisionTier()`: el corte **más fuerte**
  // cuyo `minRating` no supera el rating y, si ninguno lo alcanza (un rating por
  // debajo del último corte), el más débil. El `coalesce` es ese recorte.
  return Prisma.sql`(
    coalesce(
      (select min((c ->> 'index')::int) from jsonb_array_elements(${ladder}) as c
        where (c ->> 'minRating')::numeric <= ${rating}),
      (select max((c ->> 'index')::int) from jsonb_array_elements(${ladder}) as c)
    ) / ${SUBDIVISIONS_PER_DIVISION}
  )`;
}

/**
 * La condición de equipos como predicado SQL, sobre `Match.rawJson`.
 *
 * Localiza el equipo que contiene a `playerTable."profileId"`, compara el escalón
 * de **cada** compañero con el del jugador y devuelve el predicado que los excluye
 * si alguno dista más de `MAX_TEAMMATE_TIER_DISTANCE`.
 *
 * Todo está escrito para que lo que no se puede leer **no excluya**:
 *
 * - `jsonb_typeof(...) = 'array'` en los dos niveles de `teams` (un payload con
 *   `teams: "esto no es una lista"` no puede reventar la consulta) y `coalesce(f,
 *   '[]'::jsonb)` para que un equipo que no es una lista no aporte jugadores.
 * - La forma de cada jugador se acepta envuelta en `player` o plana, igual que
 *   `parse.ts`; un elemento que no sea objeto deja `->>` en `null` sin error.
 * - Solo se compara un rating con `jsonb_typeof(...) = 'number'`, así que un
 *   `rating: null`, ausente o de texto **no** participa en la comparación.
 * - El propio jugador se identifica por `profile_id` como texto (nunca se castea a
 *   número, que reventaría con un payload raro) y los elementos sin `profile_id`
 *   cuentan como compañeros: no saber quién es no es motivo para excluir.
 * - La caché se busca por la familia de la partida (`mode`); si esa familia no está
 *   o la partida no tiene familia, **cuenta**: el `or` del principio del predicado
 *   es la degradación, y por eso no puede escribirse al revés.
 * - Si el jugador no está en ningún equipo, o no tiene rating, tampoco se excluye.
 * - Sin cortes cacheados (o sin los de la familia de esta partida) el predicado es
 *   `null` (no se añade nada a la consulta) y la partida cuenta.
 *
 * Un partido de 1v1 tiene un jugador por equipo, así que no tiene compañeros y la
 * condición se cumple sola: no hace falta comprobar el modo.
 */
function teammatesWithinTierSql(
  matchTable: Prisma.Sql,
  playerTable: Prisma.Sql,
  cutoffs: LadderCutoffsTable | null,
): Prisma.Sql | null {
  const byLadder = cutoffs === null ? {} : sqlCutoffs(cutoffs);

  if (Object.keys(byLadder).length === 0) {
    return null;
  }

  const ladder = Prisma.sql`(${JSON.stringify(byLadder)}::jsonb -> ${matchTable}."mode")`;
  const teams = Prisma.sql`case when jsonb_typeof(${matchTable}."rawJson" -> 'teams') = 'array' then ${matchTable}."rawJson" -> 'teams' else '[]'::jsonb end`;
  const team = Prisma.sql`case when jsonb_typeof(team) = 'array' then team else '[]'::jsonb end`;
  const profileId = Prisma.sql`${playerTable}."profileId"::text`;

  return Prisma.sql`(
    ${ladder} is null or not exists (
      select 1
      from jsonb_array_elements(${teams}) as team
      cross join lateral (
        select (${gamePlayerSql("j")} ->> 'rating')::numeric as "selfRating"
        from jsonb_array_elements(${team}) as j
        where jsonb_typeof(${gamePlayerSql("j")} -> 'rating') = 'number'
          and ${gamePlayerSql("j")} ->> 'profile_id' = ${profileId}
        limit 1
      ) as self
      where self."selfRating" is not null and exists (
        select 1
        from jsonb_array_elements(${team}) as j
        where jsonb_typeof(${gamePlayerSql("j")} -> 'rating') = 'number'
          and ${gamePlayerSql("j")} ->> 'profile_id' is distinct from ${profileId}
          and abs(
            ${tierSql(Prisma.sql`(${gamePlayerSql("j")} ->> 'rating')::numeric`, ladder)}
            - ${tierSql(Prisma.sql`self."selfRating"`, ladder)}
          ) > ${MAX_TEAMMATE_TIER_DISTANCE}
      )
    )
  )`;
}

/* -------------------------------------------------------------------------- */
/* Traducciones a la base de datos                                             */
/* -------------------------------------------------------------------------- */

/**
 * El filtro de ventana **con el corte del jugador** como `where` de Prisma.
 *
 * `gte`/`lt` sobre `Match.startedAt` (columna `timestamp`), y con eso el índice
 * `@@index([mode, startedAt])` cubre la consulta: `mode` es igualdad y `startedAt`
 * es rango, que es el orden que aprovecha un índice en Postgres.
 *
 * `registeredAt` es **obligatorio** y es el de un solo jugador. Es lo único que se
 * puede hacer aquí: el `where` de Prisma compara un campo con un valor y nunca dos
 * columnas, y una referencia a campo solo vale entre campos del modelo que se
 * consulta. Para una consulta que abarque a todos los jugadores está
 * `rankedMatchSql()`, que sí lleva la fila de `Player` delante.
 */
export function windowWhere(
  window: ScoringWindow,
  registeredAt: Date | null,
): Prisma.MatchWhereInput {
  const { to } = windowBounds(window);
  const desde = scoringCutoff(window, registeredAt);

  return {
    startedAt: to === null ? { gte: desde } : { gte: desde, lt: to },
  };
}

/**
 * El mismo filtro como predicado SQL, sobre las referencias de fila que se le pasen.
 *
 * `Match.startedAt` y `Player.registeredAt` son `timestamp` **sin zona** que Prisma
 * guarda en UTC, así que el límite del torneo se manda como texto UTC sin zona y
 * con el cast explícito (`'2026-09-15 00:00:00.000'::timestamp`). El cast es lo que
 * quita la zona del medio: pasar un literal a `timestamptz` y de ahí a `timestamp`
 * **sí** depende de la zona de la sesión, y está medido en esta base de datos (con
 * la sesión en `America/Bogota`, `'2026-09-15T00:00:00Z'::timestamptz::timestamp`
 * devuelve `2026-09-14 19:00`). Como `timestamp` no tiene zona, castear el texto
 * directamente no deja sitio a ninguna conversión y el corte es el mismo en
 * cualquier sesión. `registeredAt` no lleva cast por lo mismo: ya es un
 * `timestamp` sin zona. Es lo mismo que hace `objectives.ts` con
 * `at time zone 'UTC'`, pero al revés.
 */
function windowMatchSql(
  matchTable: Prisma.Sql,
  playerTable: Prisma.Sql,
  window: ScoringWindow,
): Prisma.Sql {
  const { from, to } = windowBounds(window);
  const lower = Prisma.sql`${utcTimestamp(from)}::timestamp`;
  const dentro =
    to === null
      ? Prisma.sql`${matchTable}."startedAt" >= ${lower}`
      : Prisma.sql`${matchTable}."startedAt" >= ${lower} and ${matchTable}."startedAt" < ${utcTimestamp(to)}::timestamp`;

  return Prisma.sql`${dentro} and ${registrationCutoffSql(matchTable, playerTable)}`;
}

/**
 * El corte de inscripción en SQL: `startedAt >= registeredAt`, o nada si es `null`.
 *
 * Es el `max(window.from, registeredAt)` de `scoringCutoff()`, y por eso **no**
 * usa `GREATEST`: `GREATEST` ignora los `NULL` (devuelve el mayor de los que no lo
 * son), así que funcionaría, pero se leería como un accidente en vez de como la
 * decisión de que `null` significa "desde el principio de la ventana". Escrito con
 * el `is null` explícito, el `null` es lo que dice el schema.
 */
function registrationCutoffSql(matchTable: Prisma.Sql, playerTable: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(${playerTable}."registeredAt" is null or ${matchTable}."startedAt" >= ${playerTable}."registeredAt")`;
}

/** Reloj de pared UTC, `YYYY-MM-DD HH:MM:SS.mmm`, tal y como lo guarda Postgres. */
function utcTimestamp(value: Date): string {
  return value.toISOString().replace("T", " ").replace("Z", "");
}

/**
 * Solo la primera de las cinco condiciones: la familia de ladder del ruleset.
 *
 * Existe para las consultas que **no pueden** usar la regla entera, y hay una
 * sola: `/partidas` lista partidas en curso, y una partida en curso nunca cumple
 * las otras (por definición no tiene `result` ni `finishedAt`), así que
 * `rankedMatchWhere()` las dejaría todas fuera — justo lo contrario de lo que
 * quiere esa pantalla. Con esto se publica lo que el torneo considera partida,
 * sin que el filtro tenga que mentir sobre su estado.
 *
 * La lista sale siempre de `ruleset.modes`, igual que en las otras tres
 * formas: nadie filtra por `RANKED_MODES` a pelo. Y no es una sexta condición,
 * de modo que no la deben usar las consultas del motor: para puntuar, la regla
 * son las cinco.
 */
export function rankedModesWhere(modes: readonly string[]): Prisma.MatchWhereInput {
  return { mode: { in: [...modes] } };
}

/**
 * Las condiciones de partida clasificatoria **sin** la marca de revertida.
 *
 * Es el filtro de `rankedMatchWhere()` menos una condición, y existe para un solo
 * consumidor: el historial de puntos del panel de admin, que tiene que **listar**
 * las revertidas (marcándolas, para que se vea que no puntúan) en vez de esconderlas.
 * Que el listado historialice en vez de borrar es una decisión de producto: sin la
 * fila no habría nada que deshacer, y el worker de sync la volvería a importar
 * igual.
 *
 * Por eso no es un `options: { includeReverted }`: una bandera que alguien pueda
 * olvidar es peor que una función con un nombre que dice lo que hace. Aquí el
 * "olvido" no puede existir, porque lo único que se puede pedir con esta función
 * es la regla sin la marca.
 *
 * `registeredAt` va como en `rankedMatchWhere()` y con el mismo sentido: es el
 * `registeredAt` del jugador del que trata la consulta, y el historial del panel
 * le pasa `null` a propósito (ver el docblock de cabecera).
 *
 * No incluye el estado del jugador: eso lo pone quien consulta, porque la carga de
 * objetivos filtra por el `join` con `Player` y el agregado por un `player.status`.
 *
 * Tampoco incluye la condición de equipos, por lo mismo que `rankedMatchWhere()`:
 * no cabe en un `where` de Prisma. Su único consumidor es el historial del panel,
 * que **debe** listarlas con 0 puntos (es el recorrido del jugador, ver el
 * docblock del módulo), así que aquí no falta nada.
 */
export function classificatoryWhere(
  modes: readonly string[],
  window: ScoringWindow,
  registeredAt: Date | null,
): Prisma.MatchWhereInput {
  return {
    ...rankedModesWhere(modes),
    result: { not: null },
    finishedAt: { not: null },
    ...windowWhere(window, registeredAt),
  };
}

/**
 * El filtro completo de partida clasificatoria, como `where` de Prisma.
 *
 * Es `classificatoryWhere()` más la marca de revertida: una partida con
 * `revertedAt` informado **no** es clasificatoria para el motor, por mucho que lo
 * fuera antes de que el admin la marcara.
 *
 * `registeredAt` es el del **único** jugador del que trata la consulta y es
 * obligatorio: un `where` de Prisma no compara dos columnas, así que una consulta
 * que abarque a todos los jugadores no puede aplicar el corte aquí y tiene que
 * usar `rankedMatchSql()`, que lleva la fila de `Player` delante.
 *
 * ## Y tampoco puede expresar la condición de equipos
 *
 * Es el filtro de las cinco condiciones que un `where` **sí** puede escribir. La
 * sexta necesita leer `Match.rawJson` (los compañeros y su rating) y
 * `Setting["alerts.divisionCutoffs"]` (los cortes rating → subdivisión), y un
 * `where` de Prisma compara campos con valores: no abre un `Json` ni conoce un
 * `Setting`. Por eso no está aquí, y quien la necesita —el motor de puntos, que va
 * por SQL, y sus consumidores de Prisma— la aplica **después**, en memoria, con
 * `teammatesWithinTier()`. Es el caso de `alerts/evaluate.ts` (filtra las
 * candidatas antes de dárselas al motor de alertas) y de `sync.ts` (cuenta las que
 * entran a contar).
 *
 * El sitio donde este `where` **cuenta** en vez de listar es la baja de un
 * jugador (`admin/actions.ts`), y ahí la cuenta sale de más en una partida de
 * equipo desequilibrada. Es asumido: es un dato informativo del rastro, no lo que
 * puntúa (`Match.points`) ni lo que publica la clasificación.
 */
export function rankedMatchWhere(
  modes: readonly string[],
  window: ScoringWindow,
  registeredAt: Date | null,
): Prisma.MatchWhereInput {
  return {
    ...classificatoryWhere(modes, window, registeredAt),
    revertedAt: null,
  };
}

/**
 * El filtro completo de partida clasificatoria, como predicado SQL.
 *
 * `matchTable` y `playerTable` son las referencias de fila en la consulta, como
 * fragmentos `Prisma.Sql` y no como texto: así no hay ninguna cadena que se
 * interpole sin escapar. `playerTable` es **obligatoria** porque el corte de
 * inscripción sale de la fila del jugador: quien llama tiene que haber hecho el
 * `join` con `Player`, y como la clave foránea no admite nulos, un `join`
 * interior no pierde ni una partida.
 *
 * `cutoffs` son los cortes rating → subdivisión por familia y hacen falta para la
 * **sexta** condición (`teammatesWithinTierSql()`), que se resuelve sobre el
 * propio `jsonb`. Con `null` esa condición no se añade a la consulta y la partida
 * cuenta: no se puede demostrar la infracción (ver el docblock del módulo).
 *
 * Contraparte exacta de `rankedMatchWhere()` **salvo por la sexta condición**, que
 * el `where` de Prisma no puede escribir: aquí van familia del ruleset, partida
 * resuelta, corte de inscripción, final de la ventana, marca de revertida y los
 * compañeros del escalón. Si se añade una condición, tiene que ir en las dos (y en
 * `countsAsRanked()`).
 */
export function rankedMatchSql(
  matchTable: Prisma.Sql,
  playerTable: Prisma.Sql,
  modes: readonly string[],
  window: ScoringWindow,
  cutoffs: LadderCutoffsTable | null,
): Prisma.Sql {
  const modeList = Prisma.join(modes.map((mode) => Prisma.sql`${mode}`));
  const base = Prisma.sql`${matchTable}."mode" in (${modeList}) and ${matchTable}."result" is not null and ${matchTable}."finishedAt" is not null and ${matchTable}."revertedAt" is null and ${windowMatchSql(matchTable, playerTable, window)}`;
  const tiers = teammatesWithinTierSql(matchTable, playerTable, cutoffs);

  // Sin cortes no se añade nada: la consulta sale exactamente como salía antes de
  // que existiera la condición de equipos, en vez de con un `and true` decorativo.
  return tiers === null ? base : Prisma.sql`${base} and ${tiers}`;
}

/* -------------------------------------------------------------------------- */
/* La regla, fila a fila                                                       */
/* -------------------------------------------------------------------------- */

/**
 * ¿Cuenta esta partida?
 *
 * Solo si está **resuelta**, es de una familia rankeada, **empezó después del
 * corte** del jugador, **terminó antes de que acabara la ventana**, **no está
 * revertida** y, en una partida por equipos, **ningún compañero está a dos
 * escalones o más** del jugador. Las seis condiciones son necesarias:
 *
 * - El modo tiene que ser de una familia rankeada: una custom, un `ew_*` o un
 *   `ffa_*` sirven para practicar, no puntúan.
 * - `finishedAt === null` significa "en curso": la API todavía no ha publicado el
 *   desenlace, y una partida sin resolver nunca puntúa ni en positivo ni en
 *   negativo. `result === null` dice lo mismo por el otro lado.
 * - El corte va sobre `startedAt` y no sobre `finishedAt` porque lo que decide es
 *   **cuándo se jugó**, no cuándo se publicó el resultado: una partida empezada el
 *   último día del torneo puede terminar después y sigue contando.
 * - `revertedAt !== null` significa que el panel de admin la ha marcado: la fila
 *   sigue ahí (por eso el worker la puede reimportar y por eso se puede
 *   deshacer), pero para el torneo no cuenta ni a favor ni en contra.
 * - En equipos, la condición es la de `teammatesWithinTier()`: si no se puede
 *   demostrar que el equipo está desequilibrado, la partida **cuenta**.
 *
 * ## Por qué `registeredAt` es un parámetro y no parte de `match`
 *
 * Porque es una columna de `Player`, no de `Match`: la fila de la partida no sabe
 * cuándo se inscribió su dueño. Va **fuera** del objeto y es **obligatorio**, para
 * que no quede una forma de llamar a la regla sin decir de qué jugador se trata: un
 * `null` explícito ("corta en `window.from`") es una decisión, y un valor por
 * defecto sería indistinguible de haberse olvidado. Los dos consumidores reales lo
 * tienen a mano —`getAdminActMatchCandidates()` carga `player.registeredAt` en la misma
 * lectura que trae las partidas, y `verify-sync` lo lee del jugador de muestra—.
 *
 * ## Por qué el contexto de equipos también es obligatorio
 *
 * `rawJson` va dentro de `match` porque es una columna suya, pero se acepta
 * ausente: una partida sin payload es una partida que cuenta, que es la
 * degradación acordada. `context` (el `profileId` del dueño y los cortes) va en su
 * propio objeto y sin valor por defecto por el mismo motivo que `registeredAt`: un
 * "se me olvidó" tiene que ser imposible de escribir, y los tres consumidores
 * reales (`sync.ts`, `admin/actions.ts` y `verify-sync`) lo tienen delante.
 *
 * Es la traducción en memoria de `rankedMatchWhere()` / `rankedMatchSql()`; las
 * tres leen las mismas condiciones **salvo la de equipos**, que `rankedMatchWhere()`
 * no puede escribir (ver su docblock), y `verify:sync` las contrasta contra la base
 * de datos.
 */
export function countsAsRanked(
  match: {
    mode: string | null;
    result: MatchResult | null;
    startedAt: Date;
    finishedAt: Date | null;
    /** Instante del revert, o `null` si la partida cuenta. */
    revertedAt: Date | null;
    /**
     * El payload con el que llegó la partida (`Match.rawJson`), del que sale el
     * equipo del jugador. Se acepta ausente a propósito: sin payload no se puede
     * demostrar que el equipo esté desequilibrado y la partida cuenta.
     */
    rawJson?: unknown;
  },
  window: ScoringWindow,
  /** `Player.registeredAt` del dueño de la partida, o `null` si no lo tiene. */
  registeredAt: Date | null,
  /** Quién es el jugador y qué cortes hay cacheados para la condición de equipos. */
  context: TeamTierContext,
): boolean {
  if (
    match.finishedAt === null ||
    match.result === null ||
    match.revertedAt !== null ||
    !isRankedMode(match.mode)
  ) {
    return false;
  }

  if (!countsWithinWindow(match.startedAt, window, registeredAt)) {
    return false;
  }

  return teammatesWithinTier(match.rawJson, match.mode, context);
}
