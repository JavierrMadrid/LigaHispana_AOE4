import "server-only";

import { Prisma } from "@/generated/prisma/client";
import { MatchResult } from "@/generated/prisma/enums";
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
 * ## Las cinco condiciones
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
 *
 * La **ventana de fechas** no está replicada: sus límites y su semántica salen
 * siempre de `windowBounds()` y `scoringCutoff()`, que es lo que usan
 * `countsWithinWindow()`, `windowWhere()` y `windowMatchSql()`. Lo único que se
 * repite es la lista de condiciones, y las tres traducciones la tienen escrita en
 * su sitio: **si alguna vez se toca una, hay que tocar las otras dos**.
 * `verify:sync` lo contrasta contra datos de verdad.
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
 * que le suma. Lo que puntúa lo dicen `Match.points` y la clasificación.
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
 * consumidor: el historial de partidas del panel de admin, que tiene que **listar**
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
 * Contraparte exacta de `rankedMatchWhere()` (familia del ruleset, partida resuelta,
 * desde el corte del jugador, antes del final de la ventana y **no revertida**); si
 * se añade una condición, tiene que ir en las dos (y en `countsAsRanked()`).
 */
export function rankedMatchSql(
  matchTable: Prisma.Sql,
  playerTable: Prisma.Sql,
  modes: readonly string[],
  window: ScoringWindow,
): Prisma.Sql {
  const modeList = Prisma.join(modes.map((mode) => Prisma.sql`${mode}`));

  return Prisma.sql`${matchTable}."mode" in (${modeList}) and ${matchTable}."result" is not null and ${matchTable}."finishedAt" is not null and ${matchTable}."revertedAt" is null and ${windowMatchSql(matchTable, playerTable, window)}`;
}

/* -------------------------------------------------------------------------- */
/* La regla, fila a fila                                                       */
/* -------------------------------------------------------------------------- */

/**
 * ¿Cuenta esta partida?
 *
 * Solo si está **resuelta**, es de una familia rankeada, **empezó después del
 * corte** del jugador, **terminó antes de que acabara la ventana** y **no está
 * revertida**. Las cinco condiciones son necesarias:
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
 *
 * ## Por qué `registeredAt` es un parámetro y no parte de `match`
 *
 * Porque es una columna de `Player`, no de `Match`: la fila de la partida no sabe
 * cuándo se inscribió su dueño. Va **fuera** del objeto y es **obligatorio**, para
 * que no quede una forma de llamar a la regla sin decir de qué jugador se trata: un
 * `null` explícito ("corta en `window.from`") es una decisión, y un valor por
 * defecto sería indistinguible de haberse olvidado. Los dos consumidores reales lo
 * tienen a mano —`setMatchReverted()` carga `player.registeredAt` en el mismo
 * `findUnique` que trae el nombre, y `verify-sync` lo lee del jugador de muestra—.
 *
 * Es la traducción en memoria de `rankedMatchWhere()` / `rankedMatchSql()`; las
 * tres leen las mismas condiciones y `verify:sync` las contrasta contra la base
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
  },
  window: ScoringWindow,
  /** `Player.registeredAt` del dueño de la partida, o `null` si no lo tiene. */
  registeredAt: Date | null,
): boolean {
  if (
    match.finishedAt === null ||
    match.result === null ||
    match.revertedAt !== null ||
    !isRankedMode(match.mode)
  ) {
    return false;
  }

  return countsWithinWindow(match.startedAt, window, registeredAt);
}
