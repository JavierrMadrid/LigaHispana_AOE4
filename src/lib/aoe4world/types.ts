/**
 * Tipos del JSON que devuelve la API de AoE4World (`/api/v0`).
 *
 * Son nuestros, no los de la API: la respuesta llega como `unknown` y se valida
 * en `parse.ts` antes de convertirse en estos tipos. Así, si la API añade,
 * cambia o quita un campo, el error aparece en un solo sitio y no se propaga
 * como un `any` disfrazado.
 */

export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/**
 * JSON que Prisma acepta como *entrada*: igual que `JsonValue` pero sin `null`
 * en la raíz, que es lo que guarda la API en `rawJson` (siempre un objeto).
 */
export type JsonInput = Exclude<JsonValue, null>;

export type Aoe4WorldGameResult = "win" | "loss";

export type Aoe4WorldPlayer = {
  profileId: number;
  name: string;
  steamId: string | null;
  siteUrl: string | null;
  country: string | null;
  avatars: {
    small: string | null;
    medium: string | null;
    full: string | null;
  };
};

export type Aoe4WorldGamePlayer = {
  profileId: number | null;
  name: string | null;
  country: string | null;
  /** `null` en partidas en curso: el resultado todavía no existe. */
  result: Aoe4WorldGameResult | null;
  civilization: string | null;
  civilizationRandomized: boolean;
  rating: number | null;
  mmr: number | null;
};

export type Aoe4WorldGame = {
  gameId: number;
  startedAt: Date;
  /** `null` mientras la partida no está procesada. */
  durationSeconds: number | null;
  map: string | null;
  mapId: number | null;
  /** Ladder (`rm_solo`, `qm_1v1`, ...). */
  leaderboard: string | null;
  /** Tipo de partida (`rm_1v1`, `rm_2v2`, ...). */
  kind: string | null;
  /** `processed` cuando la API ya tiene el resultado definitivo. */
  state: string | null;
  ongoing: boolean;
  justFinished: boolean;
  averageMmr: number | null;
  /** Equipos tal cual: `teams[0]` es el primero, con un jugador por entrada. */
  teams: Aoe4WorldGamePlayer[][];
  /** La partida completa, sin tocar, para que F3 pueda recalcular. */
  raw: JsonInput;
};

export type Aoe4WorldGamesPage = {
  page: number;
  perPage: number;
  totalCount: number;
  count: number;
  nextPage: number | null;
  games: Aoe4WorldGame[];
};

export type Aoe4WorldLeaderboardEntry = {
  profileId: number;
  name: string;
  country: string | null;
  rating: number | null;
  rank: number | null;
  rankLevel: string | null;
  /**
   * Racha **firmada** (comprobado contra la API: conviven `-1` y `20`):
   * positiva = victorias seguidas, negativa = derrotas. `null` cuando el
   * jugador no tiene partidas en la ladder.
   */
  streak: number | null;
  gamesCount: number | null;
  winsCount: number | null;
  lossesCount: number | null;
  twitchUrl: string | null;
  twitchIsLive: boolean;
  avatars: Aoe4WorldPlayer["avatars"];
  lastGameAt: Date | null;
};

export type Aoe4WorldLeaderboard = {
  key: string;
  name: string;
  season: number | null;
  players: Aoe4WorldLeaderboardEntry[];
  totalCount: number;
};

export type Aoe4WorldAutocompleteResult = {
  query: string;
  leaderboard: string;
  players: Aoe4WorldPlayer[];
};

/** Ladder *ranked* 1v1: valor por defecto histórico del schema. */
export const DEFAULT_LEADERBOARD = "rm_solo";
