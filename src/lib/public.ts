import "server-only";

import { PlayerStatus } from "@/generated/prisma/enums";
import { db } from "@/lib/db";
import { MVP_RULESET_VERSION } from "@/lib/scoring";

/**
 * Capa de lectura de las páginas públicas.
 *
 * Es la **única** puerta de entrada a la base de datos para el frontend: la UI no
 * importa `db` directamente, solo estas tres funciones. Cada una devuelve
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
 * No hace falta cachear nada más: son decenas de filas con índices pensados para
 * estas consultas, y el cuello de botella del sitio no es la base de datos sino la
 * cadencia con la que AoE4World publica los resultados.
 */

/**
 * Divisiones de la ladder, en el orden en que las pinta la interfaz.
 *
 * `rankLevel` llega de AoE4World como string libre (`"gold_2"`, `"bronze_1"`),
 * así que la correspondencia vive **aquí**, en datos: la UI solo recibe el
 * `DivisionId` ya resuelto y esta lista para pintar los botones de filtro.
 * Los prefijos son los que usa la API y se comparan antes del guion, de forma
 * que cualquier tier (`gold_1`, `gold_2`, `gold_3`) cae en la misma división.
 */
export type DivisionId = "bronce" | "plata" | "oro" | "platino" | "diamante" | "conquistador";

export type Division = {
  id: DivisionId;
  /** Etiqueta tal y como se escribe en español. */
  label: string;
  /** Prefijo de `rank_level` en AoE4World (`"gold_2"` → `"gold"`). */
  rankLevelPrefix: string;
};

export const DIVISIONS: Division[] = [
  { id: "bronce", label: "Bronce", rankLevelPrefix: "bronze" },
  { id: "plata", label: "Plata", rankLevelPrefix: "silver" },
  { id: "oro", label: "Oro", rankLevelPrefix: "gold" },
  { id: "platino", label: "Platino", rankLevelPrefix: "platinum" },
  { id: "diamante", label: "Diamante", rankLevelPrefix: "diamond" },
  { id: "conquistador", label: "Conquistador", rankLevelPrefix: "conqueror" },
];

/**
 * División de una ladder, o `null` si no está clasificado (`rankLevel` vacío)
 * o si el string no corresponde a ninguna división conocida.
 */
function divisionFromRankLevel(rankLevel: string | null): DivisionId | null {
  if (rankLevel === null) {
    return null;
  }

  const normalized = rankLevel.trim().toLowerCase();

  if (normalized === "") {
    return null;
  }

  for (const division of DIVISIONS) {
    const prefix = division.rankLevelPrefix;

    if (normalized === prefix || normalized.startsWith(`${prefix}_`)) {
      return division.id;
    }
  }

  return null;
}

/** Una fila de la clasificación general, en el orden en que la web la muestra. */
export type StandingRow = {
  rank: number;
  profileId: number;
  name: string;
  /** Puntos del torneo (`PlayerScore.total`), no de la ladder. */
  points: number;
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
  /** Tiene una partida con `finishedAt IS NULL` ahora mismo. */
  isPlaying: boolean;
  avatarUrl: string | null;
  profileUrl: string;
};

/**
 * Clasificación de la versión de reglas activa, de la primera posición a la
 * última.
 *
 * Solo aparecen los jugadores **aprobados** que tienen al menos una partida
 * clasificatoria resuelta (decisión P-02 del modelo de datos): un aprobado que
 * aún no ha jugado no tiene fila, y por tanto tampoco sitio en la tabla.
 *
 * Dos consultas planas, ninguna por fila: la de partidas en directo sirve para
 * marcar `isPlaying` sin N+1.
 */
export async function getStandings(): Promise<StandingRow[]> {
  const [rows, liveRows] = await Promise.all([
    db.playerScore.findMany({
      where: { ruleSetVersion: MVP_RULESET_VERSION },
      orderBy: { rank: "asc" },
      select: {
        rank: true,
        total: true,
        wins: true,
        // No sale en `StandingRow`, pero hace falta aquí para calcular `losses`.
        matches: true,
        player: {
          select: {
            id: true,
            profileId: true,
            name: true,
            twitchChannel: true,
            twitchUrl: true,
            twitchIsLive: true,
            elo: true,
            rankLevel: true,
            streak: true,
            avatarUrl: true,
          },
        },
      },
    }),
    // Mismo criterio que `getLiveMatches`: una partida sin resolver de un
    // jugador aprobado. Un cruce 2v2 deja dos filas con el mismo `gameId`, pero
    // a efectos de "está jugando" basta con el conjunto de jugadores.
    db.match.findMany({
      where: { finishedAt: null, player: { status: PlayerStatus.APPROVED } },
      select: { playerId: true },
    }),
  ]);

  const playing = new Set(liveRows.map((row) => row.playerId));

  return rows.map((row) => {
    // El canal del panel es el primero; si no hay (o no es válido), se toma el
    // que AoE4World publica en el perfil. `normalizeTwitchChannel` acepta tanto
    // el nombre suelto como la URL completa.
    const registered =
      row.player.twitchChannel === null ? null : normalizeTwitchChannel(row.player.twitchChannel);
    const fromProfile =
      row.player.twitchUrl === null ? null : normalizeTwitchChannel(row.player.twitchUrl);

    return {
      rank: row.rank,
      profileId: row.player.profileId,
      name: row.player.name,
      points: row.total,
      wins: row.wins,
      losses: row.matches - row.wins,
      elo: row.player.elo,
      division: divisionFromRankLevel(row.player.rankLevel),
      rankLevel: row.player.rankLevel,
      streak: row.player.streak,
      twitchChannel: registered ?? fromProfile,
      twitchIsLive: row.player.twitchIsLive,
      isPlaying: playing.has(row.player.id),
      avatarUrl: row.player.avatarUrl,
      profileUrl: `https://aoe4world.com/players/${row.player.profileId}`,
    };
  });
}

/** Una partida en curso de un jugador del torneo, lista para pintar. */
export type LiveMatchRow = {
  id: string;
  gameId: string;
  playerName: string;
  playerProfileId: number;
  opponentName: string | null;
  map: string | null;
  mode: string | null;
  leaderboard: string;
  civ: string | null;
  opponentCiv: string | null;
  startedAt: Date;
};

/**
 * Partidas en directo: las que la API todavía no ha resuelto (`finishedAt IS NULL`).
 *
 * No se filtra por modo a propósito: en directo interesa todo lo que esté jugando
 * alguien del torneo, tanto ranked 1v1 como partidas por equipos.
 *
 * Si aparece una fila con `finishedAt = null` dentro de más de una hora, es
 * normal: el worker borra las partidas abandonadas de forma perezosa, en su
 * siguiente pasada. No es una partida colgada.
 */
export async function getLiveMatches(): Promise<LiveMatchRow[]> {
  const rows = await db.match.findMany({
    where: { finishedAt: null, player: { status: PlayerStatus.APPROVED } },
    orderBy: { startedAt: "desc" },
    select: {
      id: true,
      gameId: true,
      opponentName: true,
      map: true,
      mode: true,
      leaderboard: true,
      civ: true,
      opponentCiv: true,
      startedAt: true,
      player: { select: { name: true, profileId: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    gameId: row.gameId,
    playerName: row.player.name,
    playerProfileId: row.player.profileId,
    opponentName: row.opponentName,
    map: row.map,
    mode: row.mode,
    leaderboard: row.leaderboard,
    civ: row.civ,
    opponentCiv: row.opponentCiv,
    startedAt: row.startedAt,
  }));
}

/** Un jugador del torneo con canal de Twitch, para incrustar el stream. */
export type TwitchChannelRow = {
  profileId: number;
  name: string;
  /** Nombre del canal ya normalizado, listo para `https://twitch.tv/<canal>`. */
  twitchChannel: string;
};

/** El panel de admin guarda el nombre del canal, no la URL. Si aparece una, se recorta. */
const TWITCH_CHANNEL_PATTERN = /^[a-z0-9_]{3,25}$/;

function normalizeTwitchChannel(value: string): string | null {
  const trimmed = value.trim().toLowerCase();

  if (TWITCH_CHANNEL_PATTERN.test(trimmed)) {
    return trimmed;
  }

  // Acepta `https://twitch.tv/canal`, con `www.`, sin esquema o con parámetros
  // añadidos, por si algún día alguien pega un enlace en lugar del nombre.
  const fromUrl = trimmed.match(/^(?:https?:\/\/)?(?:www\.)?twitch\.tv\/([^/?#]+)/);

  if (fromUrl !== null) {
    const channel = fromUrl[1].replace(/^@/, "");
    return TWITCH_CHANNEL_PATTERN.test(channel) ? channel : null;
  }

  return null;
}

/**
 * Canales de Twitch de los jugadores aprobados, ordenados por nombre.
 *
 * `Player.twitchChannel` lo rellena el admin y el panel lo valida como nombre de
 * canal, así que lo normal es que ya venga limpio; la normalización de aquí es
 * solo una red de seguridad para los datos ya guardados.
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
