import "server-only";

import { Prisma } from "@/generated/prisma/client";
import { PlayerStatus } from "@/generated/prisma/enums";
import { parseGamePlayer } from "@/lib/aoe4world/parse";
import { db } from "@/lib/db";
import { readFromDatabase, type PublicRead } from "@/lib/db-errors";
import { divisionFromRankLevel, type DivisionId } from "@/lib/divisions";
import { aoe4WorldProfileUrl, describeMode, describeTeamSize } from "@/lib/format";
import { isRecord } from "@/lib/json";
import {
  OBJECTIVE_DEFINITIONS,
  type ObjectiveGroup,
  type ObjectiveMetric,
} from "@/lib/objectives";
import { rankedModesWhere } from "@/lib/ranked-match";
import { RULESET_VERSION, readRuleset, type ScoringRuleset } from "@/lib/scoring";
import {
  normalizeKickChannel,
  normalizeTwitchChannel,
  normalizeYoutubeChannel,
} from "@/lib/stream-channels";

export { getObjectives } from "@/lib/scoring";
export type {
  ObjectiveContender,
  ObjectiveDefinition,
  ObjectiveDetail,
  ObjectiveGroup,
  ObjectiveMetric,
  ObjectiveOption,
  ObjectiveView,
} from "@/lib/objectives";
export { MASTERIZAR_TODOS_ID, OBJECTIVE_GROUP_LABELS } from "@/lib/objectives";
export { DIVISIONS } from "@/lib/divisions";
export type { Division, DivisionId } from "@/lib/divisions";

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
 * importa `db` directamente, solo estas funciones (las cuatro de abajo más los
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
 * dejaría de moverse sola por mucho que el worker recalcule cada 5 minutos. Lo más
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
 * // status === "ok"       -> data es StandingRow[]
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
 * `label`, `group` y `metric` vienen del catálogo de `objectives.ts`; `points` es
 * el del **ruleset activo** por encima del valor por defecto, que es lo que el
 * jugador se llevó de verdad si alguien ha retocado `Setting` sin desplegar.
 *
 * `id`, `group` y `metric` son exactamente los tres campos que necesita
 * `ObjectiveIcon` para elegir su glifo, así que un objetivo de la clasificación
 * se puede pintar con el mismo icono que su tarjeta en `/objetivos`.
 */
export type StandingObjective = {
  /** Id estable del objetivo (`loco-por-ganar`, `rey-1v1`, `masterizar-…`). */
  id: string;
  label: string;
  group: ObjectiveGroup;
  /** Métrica que lo decide: de aquí sale el glifo de los grupos sin asset. */
  metric: ObjectiveMetric;
  /** Puntos que aporta poseerlo con las reglas vigentes. */
  points: number;
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
   * Puntos del torneo (`PlayerScore.total`), no de la ladder. Es la suma exacta
   * de las dos columnas siguientes.
   */
  points: number;
  /**
   * Parte de `points` que aportan las victorias clasificatorias, sin objetivos.
   *
   * No se calcula multiplicando `wins` por `ruleset.pointsPerWin` sino por resta
   * contra el total (ver `earnedObjectivesPoints`), de modo que
   * `pointsByWins + pointsByObjectives` cuadra con `points` en todas las filas
   * aunque el desglose guardado falte o venga de otra versión de las reglas.
   */
  pointsByWins: number;
  /** Parte de `points` que aportan los objetivos poseídos (`objectives.points`). */
  pointsByObjectives: number;
  wins: number;
  /** Derrotas (`PlayerScore.matches - wins`). */
  losses: number;
  elo: number | null;
  /** Derivada de `rankLevel`; `null` si no está clasificado. */
  division: DivisionId | null;
  rankLevel: string | null;
  /** Racha firmada: positiva = victorias seguidas, negativa = derrotas. */
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
 * Índice `id -> objetivo` de los 38 del catálogo, con los puntos del ruleset
 * activo ya aplicados.
 *
 * Se construye en cada llamada (no en el módulo) porque depende de la
 * configuración guardada en `Setting`, que se puede retocar sin desplegar. El
 * orden de inserción es el de presentación del catálogo, y de ahí se apoya
 * `earnedObjectives` para publicar en ese mismo orden.
 */
function objectiveLookup(ruleset: ScoringRuleset): Map<string, StandingObjective> {
  const lookup = new Map<string, StandingObjective>();

  for (const definition of OBJECTIVE_DEFINITIONS) {
    lookup.set(definition.id, {
      id: definition.id,
      label: definition.label,
      group: definition.group,
      metric: definition.metric,
      points: ruleset.objectives[definition.id] ?? definition.points,
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
 * Los objetivos poseídos por una fila de la clasificación.
 *
 * `breakdown` es JSON y lo escribe el motor de `scoring.ts`: se valida en lugar
 * de confiar, porque su forma depende de la versión de las reglas que produjo
 * la fila. Se recorre el catálogo y no la lista guardada, con lo que un id
 * desconocido o repetido no puede colarse en la salida y el orden es siempre el
 * de presentación.
 */
function earnedObjectives(
  breakdown: unknown,
  lookup: ReadonlyMap<string, StandingObjective>,
): StandingObjective[] {
  const section = objectivesSection(breakdown);

  if (section === null || !Array.isArray(section.earned)) {
    return [];
  }

  const owned = new Set(
    section.earned.filter((id): id is string => typeof id === "string"),
  );
  const objectives: StandingObjective[] = [];

  for (const [id, definition] of lookup) {
    if (owned.has(id)) {
      objectives.push(definition);
    }
  }

  return objectives;
}

/**
 * Los puntos que aportan los objetivos poseídos, tal como los guardó el motor.
 *
 * Se leen de `breakdown.objectives.points` y no sumando los `points` de
 * `objectives`, a propósito: la fila publica el reparto de `points` en dos
 * columnas y la suma tiene que cuadrar **siempre**. Con esta lectura, un
 * desglose ausente o mal formado vale 0, el total entero pasa a `pointsByWins` y
 * la identidad se conserva; sumando los objetivos publicados, en cambio, un
 * desglose antiguo o recortado dejaría las dos columnas sin sumar el total.
 */
function earnedObjectivesPoints(breakdown: unknown): number {
  const section = objectivesSection(breakdown);
  const points = section === null ? undefined : section.points;

  return typeof points === "number" && Number.isFinite(points) ? points : 0;
}

/**
 * Clasificación de la versión de reglas activa, de la primera posición a la
 * última.
 *
 * Solo aparecen los jugadores **aprobados** que tienen al menos una partida
 * clasificatoria resuelta (decisión P-02 del modelo de datos): un aprobado que
 * aún no ha jugado no tiene fila, y por tanto tampoco sitio en la tabla.
 *
 * Tres consultas planas, ninguna por fila: la de partidas en directo sirve para
 * marcar `isPlaying` sin N+1 y la del ruleset (una clave de `Setting`) trae los
 * puntos reales de cada objetivo, por si se han retocado sin desplegar. Esa misma
 * lectura del ruleset da la lista de familias con la que se filtran las partidas
 * en directo, así que no hay una segunda definición de qué es una partida del
 * torneo: quien retoca `modes` sin desplegar mueve las dos pantallas a la vez.
 *
 * Con la base de datos caída devuelve `{ status: "degraded", data: null }` en vez
 * de propagar el error: la portada del torneo tiene que seguir contestando.
 */
export async function getStandings(): Promise<PublicRead<StandingRow[]>> {
  return readFromDatabase("public/getStandings", loadStandings);
}

async function loadStandings(): Promise<StandingRow[]> {
  // La consulta de partidas en curso necesita la lista de familias del ruleset,
  // así que espera a esa lectura; las dos consultas grandes (clasificación y
  // partidas) siguen yendo en paralelo entre sí, que es lo que evita un viaje
  // extra a la base de datos.
  const rulesetPromise = readRuleset();

  const [rows, liveRows, ruleset] = await Promise.all([
    db.playerScore.findMany({
      where: { ruleSetVersion: RULESET_VERSION },
      orderBy: { rank: "asc" },
      select: {
        rank: true,
        total: true,
        wins: true,
        // No sale en `StandingRow`, pero hace falta aquí para calcular `losses`.
        matches: true,
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
            twitchChannel: true,
            twitchUrl: true,
            twitchIsLive: true,
            youtubeChannel: true,
            youtubeIsLive: true,
            kickChannel: true,
            kickIsLive: true,
            elo: true,
            rankLevel: true,
            streak: true,
            avatarUrl: true,
          },
        },
      },
    }),
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

  const playing = new Set(liveRows.map((row) => row.playerId));
  const lookup = objectiveLookup(ruleset);

  return rows.map((row) => {
    // El canal del panel es el primero; si no hay (o no es válido), se toma el
    // que AoE4World publica en el perfil. `normalizeTwitchChannel` acepta tanto
    // el nombre suelto como la URL completa.
    const registered =
      row.player.twitchChannel === null ? null : normalizeTwitchChannel(row.player.twitchChannel);
    const fromProfile =
      row.player.twitchUrl === null ? null : normalizeTwitchChannel(row.player.twitchUrl);

    // YouTube y Kick no tienen respaldo: AoE4World no publica ninguno de los dos, así
    // que el canal es solo el que escribió la persona o el admin, y la
    // normalización es la red de seguridad para lo que ya está guardado (por ejemplo
    // una fila que se guardara antes de que existiera el parser).
    const youtubeChannel = normalizeYoutubeChannel(row.player.youtubeChannel);
    const kickChannel = normalizeKickChannel(row.player.kickChannel);

    // El total se parte en dos columnas. Los puntos de objetivos se leen del
    // desglose y los de victorias salen por resta, nunca al revés: así
    // `pointsByWins + pointsByObjectives` es siempre `points`, incluso si el
    // desglose no cuadra (entonces los objetivos aportan 0 y todo el total
    // cuenta como victorias).
    const pointsByObjectives = earnedObjectivesPoints(row.breakdown);

    return {
      rank: row.rank,
      profileId: row.player.profileId,
      name: row.player.name,
      aoe4WorldName: row.player.aoe4WorldName,
      points: row.total,
      pointsByWins: row.total - pointsByObjectives,
      pointsByObjectives,
      wins: row.wins,
      losses: row.matches - row.wins,
      elo: row.player.elo,
      division: divisionFromRankLevel(row.player.rankLevel),
      rankLevel: row.player.rankLevel,
      streak: row.player.streak,
      twitchChannel: registered ?? fromProfile,
      twitchIsLive: row.player.twitchIsLive,
      youtubeChannel,
      youtubeIsLive: row.player.youtubeIsLive,
      kickChannel,
      kickIsLive: row.player.kickIsLive,
      isPlaying: playing.has(row.player.id),
      avatarUrl: row.player.avatarUrl,
      profileUrl: aoe4WorldProfileUrl(row.player.profileId),
      objectives: earnedObjectives(row.breakdown, lookup),
    };
  });
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

/** Un jugador aprobado indexado por `profileId`: quién es y de qué división es. */
type LeaguePlayerMeta = {
  name: string;
  rankLevel: string | null;
  avatarUrl: string | null;
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

  return {
    profileId: side.profileId,
    name: leaguePlayer?.name ?? side.name,
    civ: side.civilization,
    country: side.country,
    isLeaguePlayer: leaguePlayer !== undefined,
    division: leaguePlayer === undefined ? null : divisionFromRankLevel(leaguePlayer.rankLevel),
    profileUrl: side.profileId === null ? null : aoe4WorldProfileUrl(side.profileId),
    avatarUrl: leaguePlayer?.avatarUrl ?? null,
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
 * jugadores aprobados, que es lo que permite marcar `isLeaguePlayer` y resolver
 * la división sin preguntar a la base de datos por cada nombre.
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
      select: { profileId: true, name: true, rankLevel: true, avatarUrl: true },
    }),
  ]);

  const league = new Map<number, LeaguePlayerMeta>(
    leagueRows.map((row) => [
      row.profileId,
      { name: row.name, rankLevel: row.rankLevel, avatarUrl: row.avatarUrl },
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
