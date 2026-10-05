import "server-only";

import { getAoe4WorldConfig, type Aoe4WorldConfig } from "@/lib/aoe4world/env";
import { runWithDeadline } from "@/lib/aoe4world/http";
import { isProcessedState, parseGame } from "@/lib/aoe4world/parse";
import { DEFAULT_LEADERBOARD } from "@/lib/aoe4world/types";
import { countsWithinWindow, type ScoringWindow } from "@/lib/ranked-match";

/**
 * ¿Tiene el participante **abierto** el historial de partidas en el juego?
 *
 * ## El problema
 *
 * En Age of Empires IV hay un toggle "Share History" (menú principal -> retrato ->
 * Match History) y el FAQ de AoE4World dice que los *game summaries* de un jugador
 * solo existen si ese toggle está en "Public". Con el historial cerrado, sus partidas
 * dejan de publicarse: el jugador sigue jugando y no las apuntamos, y la clasificación
 * se queda corta sin que nada lo diga. **La API no expone ningún campo que lo diga**,
 * así que el dato hay que buscarlo fuera de la API.
 *
 * ## De dónde sale
 *
 * De una ruta del **sitio**, que sí lo tiene:
 *
 * ```
 * HEAD https://aoe4world.com/players/{profileId}/games/{gameId}
 *   200 -> la partida tiene summary -> el historial está público
 *   404 -> no lo tiene
 * ```
 *
 * Comprobado contra producción el 2026-10-05:
 *
 * - `HEAD` funciona y devuelve **0 bytes**: solo el código de respuesta.
 * - No hace falta el parámetro `sig`.
 * - El slug solo importa por su **prefijo numérico**: `/players/21050396` y
 *   `/players/21050396-` valen, y `/players/2105039` (un dígito menos) ya da 404.
 *   Como nosotros tenemos el `profileId`, la URL se compone con el número pelado.
 * - Casos de referencia: el jugador `7328774` tiene el historial **cerrado** y las 6
 *   partidas suyas `processed` dan 404; el `21050396` lo tiene **abierto** y da 200.
 *
 * ## El requisito que manda sobre todo lo demás
 *
 * **Un `404` es una respuesta válida y significa "cerrado". Un timeout, un 5xx o un
 * error de red NO.** Confundir los dos publicaría una acusación que no se sabe: el
 * `false` de `Player.historyPublic` dice "esta persona tiene el historial cerrado", y
 * es una afirmación que solo puede salir de una respuesta.
 *
 * Por eso `probeGameSummary()` **nunca lanza** y nunca devuelve un `closed` que no
 * venga de un 404: todo lo demás es `unknown`, y de un `unknown` no se escribe nada.
 * Quien llama decide si reintenta en la siguiente pasada o espera a que venza la
 * caché.
 *
 * ## Por qué 3 partidas y solo `processed`
 *
 * Dos motivos, y los dos son "esta partida no habría dicho nada":
 *
 * - Una partida en curso (`state: "new"`) y una con el replay invalidado tras una
 *   actualización del juego (`state: "invalid"`, que le ocurre a alrededor del 5 % de
 *   las partidas de jugadores normales) dan **404 con el historial abierto**. Con una
 *   sola partida, ese falso negativo sería la regla entera.
 * - Por eso se sondea la **más reciente que se sepa resuelta**, no la última: la
 *   información de una partida antigua no mejora al confirmar que las nuevas ya no
 *   se ven.
 *
 * Con 3 y exigiendo **las tres** en 404, un `invalid` suelto no puede producir una
 * alarma, y tres partidas invalidas seguidas ya son una señal lo bastante fuerte como
 * para que la organización mire. Un 200 basta para cancelar: es una respuesta
 * positiva y no hay nada que seguir buscando.
 *
 * ## Qué sale de aquí y qué no
 *
 * Todo lo de este módulo es o una **función pura** (selección de candidatas, plazo de
 * caché, veredicto, URL) o una función con `fetch` inyectable, para que
 * `history-visibility.test.ts` lo compruebe entero sin red ni temporizadores reales.
 *
 * ## El modo mock no cubre este sondeo
 *
 * `AOE4WORLD_MOCK` sustituye la **API** por las fixtures de `src/lib/aoe4world/mock/`,
 * y aquí no hay nada que sustituir: el summary no viene de la API sino del sitio, y
 * una fixture tendría que inventarse el dato que justamente se está midiendo.
 *
 * Por eso `probeHistoryVisibility()` con el mock activo **no sale a la red** y
 * devuelve `unknown` con el motivo en `warnings`. Si saliera, preguntaría por los
 * `profileId` de la simulación (que no existen) y todos responderían 404: la
 * simulación del torneo publicaría una acusación de "historial cerrado" a un jugador
 * inventado. Es el mismo criterio que ya se aplica en `src/lib/streams/refresh.ts`
 * con `YOUTUBE_API_KEY`: lo que no se puede comprobar bien, no se comprueba y se
 * avisa.
 *
 * ## Lo que NO hace (y hará la parte 2 del trabajo)
 *
 * No escribe en `Player` y no dispara alertas. Da el veredicto y las partidas sobre
 * las que se ha basado; de escribir (`historyPublic` + `historyCheckedAt`) y de
 * avisar se encarga el motor de alertas, que es quien sabe cuándo tocar la base.
 */

/* -------------------------------------------------------------------------- */
/* Constantes                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Cuántas partidas se sondean como máximo, y por qué hacen falta tres.
 *
 * Ver la cabecera: `new` e `invalid` dan 404 con el historial abierto, así que el
 * corte no puede ser de una. Tres es el mínimo con el que un falso negativo aislado
 * no puede producir una alarma.
 */
export const HISTORY_PROBE_GAMES = 3;

/**
 * Cuánto se cachea el veredicto, en horas. **12 h** es la decisión ya tomada: el
 * worker corre cada ~5 minutos, así que comprobar en cada pasada serían tres
 * peticiones por jugador cada cinco minutos para no aprender nada nuevo.
 *
 * Es caché y no "una comprobación por partida nueva" porque el dato es lento: a
 * alguien le da por abrir el historial en el menú y eso tarda días, no minutos.
 */
export const HISTORY_CHECK_TTL_HOURS = 12;

/** El plazo de la caché en milisegundos, que es como se compara. */
export const HISTORY_CHECK_TTL_MS = HISTORY_CHECK_TTL_HOURS * 3_600_000;

/**
 * Margen entre `Player.ladderLastGameAt` y la partida más reciente que somos
 * capaces de ver.
 *
 * **Medido el 2026-10-05 sobre 136 jugadores de `rm_solo`: entre 1 y 71 minutos.**
 * El `last_game_at` de la ladder va por delante del `startedAt` de la última partida
 * importada, porque la ladder se actualiza en tiempo real al empezar la partida y la
 * fila se publica después.
 *
 * Por eso el margen es un poco más del máximo observado (75 min): un `last_game_at`
 * que cae **dentro** de este margen no demuestra que falte ninguna partida, solo que
 * la que está empezando todavía no se ha publicado. Comparar sin margen daría
 * "nos faltan partidas" a todos los jugadores que acaban de jugar, que es lo
 * contrario de una alarma.
 */
export const LADDER_PUBLICATION_LAG_MINUTES = 75;

/** El mismo margen en milisegundos, que es como se compara con un `Date`. */
export const LADDER_PUBLICATION_LAG_MS = LADDER_PUBLICATION_LAG_MINUTES * 60_000;

/* -------------------------------------------------------------------------- */
/* Veredicto                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Lo que se ha podido concluir sobre el historial de un jugador.
 *
 * - `public`: alguna de las partidas sondeadas tiene summary. **Positivo**, y basta
 *   uno para cancelar la comprobación.
 * - `closed`: **todas** las partidas sondeadas contestaron 404. Es la única forma
 *   de afirmar "cerrado", y solo con las tres.
 * - `unknown`: no se ha podido comprobar. **Nunca es una acusación**: quien recibe
 *   esto no escribe nada y reintenta más tarde.
 */
export type HistoryVerdict = "public" | "closed" | "unknown";

/** El resultado de sondear **una** partida. */
export type HistoryProbeResult = {
  gameId: string;
  outcome: "public" | "closed" | "unknown";
  /** Por qué no se pudo decidir. Solo con `outcome: "unknown"`. */
  reason: string | null;
};

/** Una partida que se puede sondear, ya filtrada. */
export type HistoryProbeCandidate = {
  gameId: string;
  startedAt: Date;
};

/** Lo que hay que saber de una partida para decidir si es candidata. */
export type HistoryProbeMatch = {
  gameId: string;
  /** Lo que dijo la API, sin resolver: `rm_solo`, `rm_team`, `qm_1v1`... */
  leaderboard: string;
  startedAt: Date;
  /** El payload tal cual; de ahí sale `state` (ver `parseGame`). */
  rawJson: unknown;
};

export type HistoryProbeCandidatesOptions = {
  /** La ventana del torneo: fuera de ella no hay nada que sondear. */
  window: ScoringWindow;
  /** Ladder que cuenta; por defecto la *ranked* 1v1, la del torneo. */
  leaderboard?: string;
  /** Cuántas devolver como máximo; por defecto `HISTORY_PROBE_GAMES`. */
  limit?: number;
};

/**
 * Las partidas que merece la pena sondear, de la más reciente a la más antigua.
 *
 * Son **las `processed` de la ladder pedida y dentro de la ventana del torneo**, y
 * solo las `HISTORY_PROBE_GAMES` más recientes.
 *
 * ## Por qué `state === "processed"` y no "tiene resultado"
 *
 * Porque son dos cosas distintas y solo la primera sirve. Una partida con el replay
 * invalidado tras una actualización del juego (`state: "invalid"`, ~5 % de las
 * partidas de jugadores normales) tiene resultado y está resuelta, y aun así da 404
 * aunque el historial esté abierto: su summary no existe. Igual pasa con las que
 * estaban en curso (`state: "new"`). Si se sondearan, un jugador con el historial
 * perfectamente público aparecería como cerrado.
 *
 * El `state` no hay que pedirlo a nadie: la API lo manda en cada partida, ya se
 * parsea en `parseGame()` (`Aoe4WorldGame.state`) y viaja entero dentro de
 * `Match.rawJson`. Por eso el filtro se hace aquí y no en la consulta.
 *
 * ## El desempate
 *
 * Igual que en el motor de alertas, dos jugadores de la liga que juegan la misma
 * partida tienen el mismo `startedAt`, así que el orden necesita un segundo criterio
 * o la lista de candidatas podría cambiar entre dos llamadas iguales. Se compara con
 * `<`/`>` y **no** con `localeCompare()`: el resultado de ese depende del locale del
 * runtime (el mismo código ordena `"20"` antes que `"3"` con una configuración y al
 * revés con otra), y aquí lo que hace falta es que el orden sea siempre el mismo, no
 * que coincida con el `orderBy` de Postgres.
 *
 * Un `rawJson` ilegible **no lanza**: esa partida no es candidata, y como se
 * descartan por filtro (no por excepción) el resto de la lista sigue siendo válida.
 */
export function historyProbeCandidates(
  matches: readonly HistoryProbeMatch[],
  options: HistoryProbeCandidatesOptions,
): HistoryProbeCandidate[] {
  const leaderboard = options.leaderboard ?? DEFAULT_LEADERBOARD;
  const limit = options.limit ?? HISTORY_PROBE_GAMES;

  return matches
    .filter((match) => {
      if (match.leaderboard !== leaderboard) {
        return false;
      }

      if (!countsWithinWindow(match.startedAt, options.window)) {
        return false;
      }

      const game = parseGame(match.rawJson);

      return game !== null && isProcessedState(game.state);
    })
    .sort(
      (a, b) =>
        b.startedAt.getTime() - a.startedAt.getTime() ||
        (a.gameId < b.gameId ? -1 : a.gameId > b.gameId ? 1 : 0),
    )
    .slice(0, limit)
    .map((match) => ({ gameId: match.gameId, startedAt: match.startedAt }));
}

/**
 * Qué se puede concluir de las respuestas de las partidas sondeadas.
 *
 * La regla es corta y toda ella mira hacia el lado seguro:
 *
 * 1. **Un solo 200** vale: es una respuesta positiva y no hay nada más que buscar
 *    (por eso el sondeo para en cuanto lo encuentra).
 * 2. **`closed` exige las `HISTORY_PROBE_GAMES` en 404.** Con menos, no se afirma
 *    nada: serían menos pruebas que las que la regla necesita.
 * 3. En cualquier otro caso, `unknown`. Un 5xx o un corte de red en medio de las
 *    tres **no** es un 404, y es justo el caso en el que un motor de alertas podría
 *    acusar a alguien por un fallo de la red de otra persona.
 */
export function historyVerdictFromProbes(results: readonly HistoryProbeResult[]): HistoryVerdict {
  if (results.some((result) => result.outcome === "public")) {
    return "public";
  }

  if (
    results.length >= HISTORY_PROBE_GAMES &&
    results.every((result) => result.outcome === "closed")
  ) {
    return "closed";
  }

  return "unknown";
}

/* -------------------------------------------------------------------------- */
/* Cuándo hay que comprobar                                                    */
/* -------------------------------------------------------------------------- */

/** Por qué no toca comprobar ahora. Texto legible por máquina, no por pantalla. */
export type HistoryCheckSkipReason = "reciente" | "sin-candidatas";

export type HistoryCheckPlan =
  | { action: "check"; candidates: HistoryProbeCandidate[] }
  | { action: "skip"; reason: HistoryCheckSkipReason };

/**
 * ¿Ha vencido la caché de este jugador?
 *
 * Va suelto y no solo dentro de `planHistoryCheck()` porque quien tiene que decidir
 * **a quién** preguntar es el worker, y para eso necesita la respuesta sin las
 * partidas: leer los `rawJson` de las candidatas de los treinta participantes para
 * acabar descartando a veintinueve por la caché sería una consulta por jugador en cada
 * pasada, que es justo lo que la caché existe para evitar. Quien llama preselecciona
 * con esto y luego llama a `planHistoryCheck()`, que usa **esta misma función**, así
 * que las dos no pueden desincronizarse.
 */
export function historyCheckIsDue(
  historyCheckedAt: Date | null,
  now: Date,
  ttlMs: number = HISTORY_CHECK_TTL_MS,
): boolean {
  return historyCheckedAt === null || now.getTime() - historyCheckedAt.getTime() >= ttlMs;
}

export type HistoryCheckInput = {
  /** `Player.historyCheckedAt`: `null` = nunca comprobado. */
  historyCheckedAt: Date | null;
  /** Candidatas ya filtradas por `historyProbeCandidates()`. */
  candidates: readonly HistoryProbeCandidate[];
  now: Date;
  /** Anticipo del plazo de caché; por defecto `HISTORY_CHECK_TTL_MS`. */
  ttlMs?: number;
};

/**
 * Si toca comprobar el historial de este jugador, y de qué partidas.
 *
 * ## Las dos compuertas
 *
 * - **La caché**: 12 h desde `historyCheckedAt`. Sin comprobar nunca, toca. Con la
 *   comprobación hecha hace 12 h, vuelve a tocar; hace una hora, no. El plazo se
 *   puede acortar por parámetro, que es lo que le sirve a quien quiera reintentar
 *   antes tras un `unknown` sin esperar doce horas.
 * - **Las partidas**: hacen falta `HISTORY_PROBE_GAMES` candidatas. Con menos, no
 *   hay con qué comprobar y no se sale a la red: es el caso de un jugador recién
 *   aprobado, y de uno al que solo le importa una partida clasificatoria.
 *
 * Las dos compuertas son "no comprobar" y por eso devuelven `skip`, no un resultado:
 * quien llama no tiene nada que escribir.
 *
 * ## El plazo es de caché, no de obligación
 *
 * Que haya pasado 12 h solo significa "ya se puede volver a mirar". Si el sondeo sale
 * `unknown`, quien llama sigue sin tener nada que escribir: el plazo de aquí no obliga
 * a guardar un `false`.
 */
export function planHistoryCheck(input: HistoryCheckInput): HistoryCheckPlan {
  const ttlMs = input.ttlMs ?? HISTORY_CHECK_TTL_MS;

  if (!historyCheckIsDue(input.historyCheckedAt, input.now, ttlMs)) {
    return { action: "skip", reason: "reciente" };
  }

  if (input.candidates.length < HISTORY_PROBE_GAMES) {
    return { action: "skip", reason: "sin-candidatas" };
  }

  return { action: "check", candidates: [...input.candidates] };
}

/* -------------------------------------------------------------------------- */
/* La regla complementaria: la ladder por delante de lo que nos llega            */
/* -------------------------------------------------------------------------- */

/**
 * Partidas en la ladder a partir de las cuales se puede decir que alguien "juega de
 * verdad" dentro del torneo.
 *
 * Sin este mínimo, la regla complementaria saltaría sola a mitad de torneo con
 * cualquiera que hubiera jugado diez partidas en septiembre y nada más desde entonces:
 * su `last_game_at` es viejo, no tenemos ninguna partida y la comparación daría "nos
 * faltan partidas" sobre un jugador que no está jugando. Diez partidas de ladder son
 * el mínimo que dice "esto es alguien que compite".
 *
 * No sale del ruleset de alertas y a propósito: es un dato de **identificación**
 * (¿es una persona que juega?), no un umbral de comportamiento, y tocarlo exigiría
 * redeployar el motor de alertas entero para mover un número que además no tiene
 * nada de elegible para la organización.
 */
export const MISSING_MATCHES_MIN_GAMES = 10;

/** Por qué la regla complementaria no dice nada de este jugador. */
export type LadderGapSkipReason =
  /** Sin datos de ladder: no ha salido en la respuesta, o no tiene partidas. */
  | "sin-datos"
  /** Juega ranked, pero su última partida es de antes de la ventana. */
  | "fuera-de-ventana"
  /** No llega al mínimo de partidas de ladder. */
  | "pocas-partidas"
  /** Lo que tenemos está dentro del margen de publicación: no se puede afirmar nada. */
  | "dentro-del-margen";

export type LadderGapVerdict =
  /** La ladder registra una partida que no nos ha llegado, más allá del margen. */
  { status: "ahead"; lagMinutes: number } | { status: "ok"; reason: LadderGapSkipReason };

export type LadderGapInput = {
  /** `Player.ladderGamesCount`; `null` = no salió en la respuesta de la ladder. */
  gamesCount: number | null;
  /** `Player.ladderLastGameAt`; `null` = igual que arriba. */
  lastGameAt: Date | null;
  /**
   * Nuestra partida `rm_solo` más reciente **en la ventana**, o `null` si no
   * tenemos ninguna.
   *
   * El filtro es `rm_solo` y no "clasificatoria" a propósito: si el jugador juega
   * `rm_team` y lo que le falta son las de `rm_solo`, comparar contra las de equipos
   * taparía la alarma sola, porque su última partida de equipos sí nos habría llegado.
   *
   * **`null` cambia el sentido de la comparación**: ver el cuerpo de
   * `ladderGapVerdict()`.
   */
  newestOurs: Date | null;
  window: ScoringWindow;
  now: Date;
  /** Mínimo de partidas de ladder; por defecto `MISSING_MATCHES_MIN_GAMES`. */
  minGames?: number;
};

/**
 * ¿La ladder va por delante de lo que somos capaces de ver?
 *
 * ## Por qué hace falta, y por qué va con la otra
 *
 * La comprobación del historial (la de los `HEAD`) solo puede mirar partidas que ya
 * tenemos. Si alguien cerrara su historial **y** sus partidas dejaran de aparecer en la
 * API, no habría ningún `gameId` que sondear y no se comprobaría nada: el agujero
 * sería exacto. Esta regla lo cierra mirando el otro lado —lo que AoE4World **sí**
 * publica de ese jugador, su fila de la ladder— y comparándolo con lo que nosotros
 * tenemos.
 *
 * ## La comparación, y el margen
 *
 * `Player.ladderLastGameAt` va por delante de nuestra partida más reciente porque la
 * ladder se actualiza en tiempo real al empezar la partida y la fila se publica
 * después: de 1 a 71 minutos, medidos (ver `LADDER_PUBLICATION_LAG_MINUTES`). Así que
 * un desfase **dentro** del margen no demuestra nada, y avisar ahí sería avisar de que
 * todos los jugadores que acaban de jugar nos están ocultando partidas.
 *
 * Cuando no tenemos ninguna partida `rm_solo` en la ventana la pregunta es distinta, y
 * por eso el signo también: "la ladder dice que jugó en T; ¿hace ya más que el margen que
 * la publicación nos puede deber?". Es decir, en ese caso la comparación es contra `now`
 * y en la otra dirección —cuánto tiempo lleva la ladder diciendo eso sin que lo
 * tengamos—, que es lo que evita que un jugador al que acabamos de aprobar salte solo
 * porque su primera partida del torneo aún no se ha publicado.
 *
 * ## Las tres guardas antes de comparar
 *
 * Ordenadas de la más barata a la más cara, y las tres existen para no avisar de quien
 * no está jugando: sin datos de ladder no se puede comparar nada; por debajo de
 * `minGames` no es alguien cuya ausencia de partidas sea una señal; y una última
 * partida **fuera de la ventana** es la de antes del torneo, que es exactamente lo que
 * se espera de alguien que todavía no ha entrado a jugar.
 *
 * Puro y sin red: lo lee el worker con los datos que ya trae y lo prueba con fechas
 * escritas a mano en `history-visibility.test.ts`.
 */
export function ladderGapVerdict(input: LadderGapInput): LadderGapVerdict {
  const minGames = input.minGames ?? MISSING_MATCHES_MIN_GAMES;

  if (input.gamesCount === null || input.lastGameAt === null) {
    return { status: "ok", reason: "sin-datos" };
  }

  if (input.gamesCount < minGames) {
    return { status: "ok", reason: "pocas-partidas" };
  }

  if (!countsWithinWindow(input.lastGameAt, input.window)) {
    return { status: "ok", reason: "fuera-de-ventana" };
  }

  // El signo depende de si hay alguna partida nuestra, y no es un detalle:
  // `ladderLastGameAt - newestOurs` con `newestOurs = null` daría un hueco negativo
  // (la ladder es anterior a "ahora") y **nunca** saltaría, que es justo el caso que
  // esta regla existe para cubrir.
  const lagMs =
    input.newestOurs === null
      ? input.now.getTime() - input.lastGameAt.getTime()
      : input.lastGameAt.getTime() - input.newestOurs.getTime();

  if (lagMs <= LADDER_PUBLICATION_LAG_MS) {
    return { status: "ok", reason: "dentro-del-margen" };
  }

  return { status: "ahead", lagMinutes: Math.round(lagMs / 60_000) };
}

/* -------------------------------------------------------------------------- */
/* La llamada al sitio                                                          */
/* -------------------------------------------------------------------------- */

/**
 * La URL del summary de una partida.
 *
 * Con el `profileId` pelado, que es lo que acepta la ruta: el slug de la web admite
 * cualquier cosa detrás del prefijo numérico (`21050396-` funciona), pero un
 * `profileId` truncado da 404 y se leería como "historial cerrado", así que solo se
 * admite el número entero.
 */
export function gameSummaryUrl(apiBase: string, profileId: number, gameId: string): string {
  return `${apiBase.replace(/\/+$/, "")}/players/${profileId}/games/${gameId}`;
}

export type HistoryProbeOptions = {
  /** Base del sitio; la misma que usa el cliente de la API (`AOE4WORLD_API_BASE`). */
  apiBase: string;
  /**
   * `User-Agent` del cliente de AoE4World, **sin cambiarlo**: la documentación de
   * AoE4World pide que las peticiones se identifiquen, y aquí manda el mismo
   * identificador de siempre en vez de uno de navegador: el Worker no es un
   * navegador y no tiene por qué parecerlo.
   */
  userAgent: string;
  /** Plazo por petición, el del cliente. */
  timeoutMs: number;
  /** Plazo global de la pasada del worker. */
  signal?: AbortSignal;
  /** `fetch` inyectable, para comprobarlo con una respuesta falsa. */
  fetch?: typeof globalThis.fetch;
};

/** Un `gameId` que no sea un entero daría un 404 que se leería como "cerrado". */
const NUMERIC_GAME_ID = /^\d+$/;

/**
 * Sondea **una** partida. Nunca lanza y nunca confunde un fallo con un `closed`.
 *
 * Los tres desenlaces. Solo uno de ellos —el `404`— afirma nada, y es el único que
 * quien llama puede escribir en `Player.historyPublic`:
 *
 * | Respuesta | Resultado |
 * |---|---|
 * | `200` | `public`: hay summary |
 * | `404` | `closed`: no lo hay |
 * | cualquier otra cosa, un timeout, un error de red o una cancelación | `unknown`, con su motivo |
 *
 * Un `5xx` es el caso que más importa: si se leyera como "cerrado", bastaría con que
 * AoE4World tuviera un rato malo para que el torneo publicara una acusación contra
 * un jugador cuyo historial está abierto.
 *
 * Un `gameId` que no sea numérico devuelve `unknown` **sin salir a la red**: la ruta
 * también responde 404 a un id que no existe, y ese 404 no significa nada.
 */
export async function probeGameSummary(
  profileId: number,
  gameId: string,
  options: HistoryProbeOptions,
): Promise<HistoryProbeResult> {
  if (!NUMERIC_GAME_ID.test(gameId)) {
    return {
      gameId,
      outcome: "unknown",
      reason: `gameId "${gameId}" no es un entero: no se pregunta nada porque su 404 no significaría nada`,
    };
  }

  const url = gameSummaryUrl(options.apiBase, profileId, gameId);
  const doFetch = options.fetch ?? globalThis.fetch;

  try {
    const outcome = await runWithDeadline(options.timeoutMs, options.signal, (signal) =>
      doFetch(url, {
        method: "HEAD",
        headers: { "User-Agent": options.userAgent },
        signal,
        // Un summary cacheado por el runtime sería un "historial público" de hace
        // una hora: justo lo que este sondeo existe para no contar.
        cache: "no-store",
      }),
    );

    if (outcome.kind === "failed") {
      // `timedOut` y `cancelled` son los dos hechos que importan; el resto es un
      // fallo de red, que tampoco es un `closed`.
      const reason = outcome.timedOut
        ? `AoE4World no respondió a ${url} en ${options.timeoutMs} ms`
        : outcome.cancelled
          ? `cancelado antes de responder ${url}`
          : `fallo al pedir ${url}: ${
              outcome.error instanceof Error ? outcome.error.message : String(outcome.error)
            }`;

      return { gameId, outcome: "unknown", reason };
    }

    const status = outcome.value.status;

    if (status === 200) {
      return { gameId, outcome: "public", reason: null };
    }

    if (status === 404) {
      return { gameId, outcome: "closed", reason: null };
    }

    // `2xx` que no es 200 y `3xx` también caen aquí: no son ni "lo tengo" ni "no lo
    // tengo", así que no se pueden convertir en un veredicto.
    return {
      gameId,
      outcome: "unknown",
      reason: `AoE4World respondió ${status} a ${url}, que no es ni 200 ni 404`,
    };
  } catch (error) {
    return {
      gameId,
      outcome: "unknown",
      reason: `fallo al pedir ${url}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export type HistoryVisibilityInput = {
  profileId: number;
  /** Candidatas de `historyProbeCandidates()`. */
  candidates: readonly HistoryProbeCandidate[];
  config?: Aoe4WorldConfig;
  signal?: AbortSignal;
  /** `fetch` inyectable, para comprobarlo con una respuesta falsa. */
  fetch?: typeof globalThis.fetch;
};

export type HistoryVisibilityResult = {
  verdict: HistoryVerdict;
  /** Lo que se llegó a preguntar, en orden. */
  probes: HistoryProbeResult[];
  /** Motivos de lo que no se pudo comprobar, para el rastro de la pasada. */
  warnings: string[];
};

/**
 * Sondea las candidatas de un jugador, una a una, y devuelve el veredicto.
 *
 * **Para en cuanto una responde 200**: un solo summary público demuestra que el
 * historial está abierto y las demás llamadas serían gasto sin información.
 *
 * Sale del `planHistoryCheck()` quien llama, que es quien sabe si toca (caché de 12 h
 * y al menos tres candidatas) y de dónde ha sacado las partidas. Aquí solo se sondea,
 * y **como mucho `HISTORY_PROBE_GAMES`**: quien pase más no gasta más, porque a
 * partir de la tercera el veredicto ya no cambia.
 *
 * **No escribe nada.** Devuelve el veredicto y los motivos, y de escribir
 * `Player.historyPublic` / `historyCheckedAt` se encarga el motor de alertas, que es
 * quien sabe qué pasa cuando no hay nada que escribir.
 */
export async function probeHistoryVisibility(
  input: HistoryVisibilityInput,
): Promise<HistoryVisibilityResult> {
  const config = input.config ?? getAoe4WorldConfig();

  // Ver la cabecera: con el mock activo no hay fixtures para esta ruta y salir a la
  // red daría 404 para todo, es decir, acusaciones contra jugadores que no existen.
  if (config.mock) {
    return {
      verdict: "unknown",
      probes: [],
      warnings: [
        "AOE4WORLD_MOCK está activo: el sondeo del historial no sale a la red (el summary no viene de la API) y no se escribe nada",
      ],
    };
  }

  const probes: HistoryProbeResult[] = [];
  const warnings: string[] = [];

  for (const candidate of input.candidates.slice(0, HISTORY_PROBE_GAMES)) {
    if (input.signal?.aborted === true) {
      warnings.push("la comprobación se ha cortado: el plazo global de la pasada se agotó");

      break;
    }

    const probe = await probeGameSummary(input.profileId, candidate.gameId, {
      apiBase: config.apiBase,
      userAgent: config.userAgent,
      timeoutMs: config.timeoutMs,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
    });

    probes.push(probe);

    if (probe.outcome === "unknown" && probe.reason !== null) {
      warnings.push(`partida ${candidate.gameId}: ${probe.reason}`);
    }

    if (probe.outcome === "public") {
      break;
    }
  }

  return { verdict: historyVerdictFromProbes(probes), probes, warnings };
}
