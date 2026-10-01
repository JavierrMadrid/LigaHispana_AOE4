/**
 * Participantes del torneo simulado.
 *
 * Rango de `profileId` reservado (90 000 001 – 90 000 010): no se solapa con
 * perfiles reales de AoE4World ni con los ids de muestra de
 * `scripts/verify-sync.ts` (9 000 001…), así las dos verificaciones pueden
 * convivir en la misma base sin pisarse.
 *
 * Es la única fuente de verdad de los participantes: la sirve el mock de la API
 * (`/players/:profile_id`) y la lee `scripts/mock-tournament.ts` para crear las
 * filas `Player`. Si se cambia un nombre aquí, cambia en ambos sitios.
 */

export type MockTournamentPlayer = {
  profileId: number;
  name: string;
  country: string;
  /** Canal de Twitch o `null`; lo escribe el script en `Player.twitchChannel`. */
  twitchChannel: string | null;
  /** `twitch_url` que AoE4World publica en el perfil (respaldo de la tabla). */
  twitchUrl: string | null;
  /** `twitch_is_live` en la ladder: 1 o 2 en directo para poder ver el indicador. */
  twitchIsLive: boolean;
  /**
   * Canal de YouTube (handle sin arroba) o `null`; lo escribe el script en
   * `Player.youtubeChannel`.
   *
   * **AoE4World no publica canales de YouTube ni de Kick**, así que a diferencia de
   * `twitchUrl` esto no es parte del payload de la API: es un dato del participante
   * que el mock reparte para que la pantalla se pueda ver completa. Por eso el
   * estado de directo de los dos lo fija también el script (ver `*IsLive`) en lugar
   * de dejarlo a una API externa que la simulación no puede llamar.
   */
  youtubeChannel: string | null;
  kickChannel: string | null;
  /** Alguien en directo en YouTube y alguien en Kick, para ver los tres indicadores. */
  youtubeIsLive: boolean;
  kickIsLive: boolean;
  /** Rating que aparece en las fixtures de partidas **y** en la ladder. */
  rating: number;
  /** `rank_level` de la ladder; el orden coincide con el del rating. */
  rankLevel: string;
  /** Racha firmada: positiva, negativa o `null` (sin ladder), como en la API. */
  streak: number | null;
  /** `avatars.full`. SVG embebido: determinista y sin depender de la red. */
  avatarUrl: string | null;
};

/**
 * Avatar de datos (SVG): al ser una URL `data:` Next/Image lo sirve sin
 * optimizar y la tabla simulada puede dibujarlo sin salir a la red.
 */
function mockAvatar(initials: string, hue: number): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128">` +
    `<rect width="128" height="128" fill="hsl(${hue},45%,32%)"/>` +
    `<text x="64" y="66" font-family="Verdana,sans-serif" font-size="44" fill="#ffffff"` +
    ` text-anchor="middle" dominant-baseline="central">${initials}</text></svg>`;

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export const MOCK_PROFILE_ID_MIN = 90_000_001;

export const MOCK_PROFILE_ID_MAX = 90_000_010;

/**
 * Los diez participantes, repartidos por las seis divisiones (alguno en cada
 * una) y con `rating`, `rank_level` y `streak` coherentes entre sí: el rating
 * sube al mismo tiempo que la división, igual que en la ladder real. También
 * hay rachas positivas, negativas y `null`, y dos jugadores en directo en
 * Twitch (uno de ellos, además, jugando partida).
 *
 * Los canales de YouTube y de Kick se reparten **sparse a propósito**: cada
 * plataforma tiene algunos con canal y la mayoría sin él, y hay uno en directo en
 * cada una. Es la forma de que la pantalla muestre a la vez los tres estados
 * posibles —con canal y apagado, con canal y encendido, y sin canal— sin que
 * ningún jugador tenga los tres a la vez, que es lo raro.
 *
 * Todo fijo: el mock tiene que ser determinista.
 */
export const MOCK_TOURNAMENT_PLAYERS: readonly MockTournamentPlayer[] = [
  {
    profileId: 90_000_001,
    name: "Serrano Hernández",
    country: "es",
    twitchChannel: "serrano_hernan",
    twitchUrl: "https://www.twitch.tv/serrano_hernan",
    twitchIsLive: true,
    youtubeChannel: "serranohernan",
    kickChannel: null,
    youtubeIsLive: false,
    kickIsLive: false,
    rating: 845,
    rankLevel: "bronze_2",
    streak: -3,
    avatarUrl: mockAvatar("SH", 15),
  },
  {
    profileId: 90_000_002,
    name: "Doña Urraca",
    country: "es",
    twitchChannel: null,
    twitchUrl: null,
    twitchIsLive: false,
    youtubeChannel: null,
    kickChannel: null,
    youtubeIsLive: false,
    kickIsLive: false,
    rating: 995,
    rankLevel: "silver_2",
    streak: null,
    avatarUrl: null,
  },
  {
    profileId: 90_000_003,
    name: "El Cid Campeador",
    country: "es",
    twitchChannel: "el_cid_campeador",
    twitchUrl: "https://www.twitch.tv/el_cid_campeador",
    twitchIsLive: false,
    // En directo en YouTube: el indicador de la plataforma nueva tiene que poder
    // verse con el torneo simulado, y este jugador no está en directo en Twitch.
    youtubeChannel: "elcidcampeador",
    kickChannel: null,
    youtubeIsLive: true,
    kickIsLive: false,
    rating: 1175,
    rankLevel: "gold_1",
    streak: 2,
    avatarUrl: mockAvatar("EC", 45),
  },
  {
    profileId: 90_000_004,
    name: "Giraldo Sin Miedo",
    country: "pt",
    twitchChannel: null,
    // Sin canal registrado en el panel, pero con Twitch en su perfil de
    // AoE4World: es el caso que ejercita el respaldo de `twitchUrl` en la tabla.
    twitchUrl: "https://www.twitch.tv/giraldo_sin_miedo",
    twitchIsLive: false,
    youtubeChannel: null,
    kickChannel: "giraldo_sin_miedo",
    youtubeIsLive: false,
    kickIsLive: false,
    rating: 1295,
    rankLevel: "gold_3",
    streak: -1,
    avatarUrl: mockAvatar("GS", 60),
  },
  {
    profileId: 90_000_005,
    name: "Leonor de Aragón",
    country: "es",
    twitchChannel: "leonor_aragon",
    twitchUrl: "https://www.twitch.tv/leonor_aragon",
    twitchIsLive: false,
    youtubeChannel: null,
    kickChannel: null,
    youtubeIsLive: false,
    kickIsLive: false,
    rating: 1440,
    rankLevel: "platinum_1",
    streak: 5,
    avatarUrl: mockAvatar("LA", 90),
  },
  {
    profileId: 90_000_006,
    name: "Abenjumar el Negro",
    country: "es",
    twitchChannel: null,
    twitchUrl: null,
    twitchIsLive: false,
    // El único con las dos plataformas a la vez, y ninguna emitiendo: es el caso que
    // enseña que los iconos son independientes y que "tiene canal" no es "está en
    // directo".
    youtubeChannel: "abenhumar",
    kickChannel: "abenhumar",
    youtubeIsLive: false,
    kickIsLive: false,
    rating: 1265,
    rankLevel: "platinum_3",
    streak: null,
    avatarUrl: mockAvatar("AN", 200),
  },
  {
    profileId: 90_000_007,
    name: "Nicolau de Opinel",
    country: "fr",
    twitchChannel: "nicolau_opinel",
    twitchUrl: "https://www.twitch.tv/nicolau_opinel",
    // En directo pero **sin** partida en curso: la tabla tiene que poder
    // mostrar los dos indicadores por separado.
    twitchIsLive: true,
    youtubeChannel: null,
    // En directo en Kick, y además en directo en Twitch sin canal de YouTube: los
    // tres estados juntos en la tabla.
    kickChannel: "nicolaudepinel",
    youtubeIsLive: false,
    kickIsLive: true,
    rating: 1665,
    rankLevel: "diamond_1",
    streak: 8,
    avatarUrl: mockAvatar("NO", 170),
  },
  {
    profileId: 90_000_008,
    name: "Baltasar de Castro",
    country: "es",
    twitchChannel: null,
    twitchUrl: null,
    twitchIsLive: false,
    youtubeChannel: null,
    kickChannel: null,
    youtubeIsLive: false,
    kickIsLive: false,
    rating: 1760,
    rankLevel: "diamond_3",
    streak: -2,
    avatarUrl: null,
  },
  {
    profileId: 90_000_009,
    name: "María la Brava",
    country: "mx",
    twitchChannel: "maria_la_brava",
    twitchUrl: "https://www.twitch.tv/maria_la_brava",
    twitchIsLive: false,
    youtubeChannel: "marialabrava",
    kickChannel: null,
    youtubeIsLive: false,
    kickIsLive: false,
    rating: 1895,
    rankLevel: "conqueror_1",
    streak: 12,
    avatarUrl: mockAvatar("MB", 330),
  },
  {
    profileId: 90_000_010,
    name: "Pedro el Ceremonioso",
    country: "ar",
    twitchChannel: null,
    twitchUrl: null,
    twitchIsLive: false,
    youtubeChannel: null,
    kickChannel: null,
    youtubeIsLive: false,
    kickIsLive: false,
    rating: 2015,
    rankLevel: "conqueror_2",
    streak: 4,
    avatarUrl: mockAvatar("PC", 260),
  },
];

/** Los cinco canales de Twitch registrados arriba son los que poblarán el indicante de Twitch de la clasificación. */
export const MOCK_PROFILE_IDS: number[] = MOCK_TOURNAMENT_PLAYERS.map(
  (player) => player.profileId,
);

/**
 * Rivales externos: gente de la ladder con la que un participante se cruza en
 * una partida clasificatoria **sin que por eso entre en la liga**.
 *
 * Rango de `profileId` reservado aparte (92 000 001 – 92 000 010): no se solapa con
 * los participantes (90 000 001–010), ni con los ids de muestra de
 * `scripts/verify-sync.ts` (9 000 001…), ni con los `gameId` del mock
 * (9 100 001…). Nunca se convierten en filas `Player`: solo aparecen como
 * `Match.opponentProfileId` / `Match.opponentName`, que es exactamente como se
 * representa en la web a un rival al que no conocemos.
 *
 * El rating sigue de cerca al del participante con el que cruzan (el `k` juega
 * contra el externo `k`), para que los cruces de la ladder simulada no parezcan
 * partidas de 600 puntos de diferencia.
 */
export type MockExternalPlayer = {
  profileId: number;
  name: string;
  country: string;
  /** Rating que aparece en las fixtures de partidas. */
  rating: number;
};

export const MOCK_EXTERNAL_PROFILE_ID_MIN = 92_000_001;

export const MOCK_EXTERNAL_PROFILE_ID_MAX = 92_000_010;

export const MOCK_EXTERNAL_PLAYERS: readonly MockExternalPlayer[] = [
  {
    profileId: 92_000_001,
    name: "Brazo de Plata",
    country: "es",
    rating: 815,
  },
  {
    profileId: 92_000_002,
    name: "Trotamundos",
    country: "es",
    rating: 965,
  },
  {
    profileId: 92_000_003,
    name: "Lady Isabelle",
    country: "fr",
    rating: 1145,
  },
  {
    profileId: 92_000_004,
    name: "Hans el Arquero",
    country: "de",
    rating: 1265,
  },
  {
    profileId: 92_000_005,
    name: "Giuseppe Borgia",
    country: "it",
    rating: 1410,
  },
  {
    profileId: 92_000_006,
    name: "Boris el Leñador",
    country: "ru",
    rating: 1505,
  },
  {
    profileId: 92_000_007,
    name: "Aitana de Lisboa",
    country: "pt",
    rating: 1865,
  },
  {
    profileId: 92_000_008,
    name: "Mateo el Zurdo",
    country: "ar",
    rating: 1730,
  },
  {
    profileId: 92_000_009,
    name: "Kim Jun-Pyo",
    country: "kr",
    rating: 1865,
  },
  {
    profileId: 92_000_010,
    name: "Ottavio Fiori",
    country: "it",
    rating: 1985,
  },
];

export const MOCK_EXTERNAL_PROFILE_IDS: number[] = MOCK_EXTERNAL_PLAYERS.map(
  (player) => player.profileId,
);

/**
 * Todo el mundo que conoce el mock: participantes y externos juntos. Es con lo
 * que responden `GET /players/:profile_id` y el `autocomplete`, de forma que
 * preguntar por un rival de la ladder no devuelva un 404 irreal.
 */
export const MOCK_DIRECTORY_PLAYERS: readonly (MockTournamentPlayer | MockExternalPlayer)[] = [
  ...MOCK_TOURNAMENT_PLAYERS,
  ...MOCK_EXTERNAL_PLAYERS,
];

export function findMockPlayer(
  profileId: number,
): MockTournamentPlayer | MockExternalPlayer | undefined {
  return MOCK_DIRECTORY_PLAYERS.find((player) => player.profileId === profileId);
}
