const relative = new Intl.RelativeTimeFormat("es-ES", {
  style: "narrow",
  numeric: "auto",
});

const absoluteTime = new Intl.DateTimeFormat("es-ES", {
  dateStyle: "medium",
  timeStyle: "short",
});

const absoluteDay = new Intl.DateTimeFormat("es-ES", {
  day: "numeric",
  month: "long",
});

/**
 * Cuánto pasó desde `date`, en castellano y en corto: "ahora mismo",
 * "hace 12 min", "ayer", "hace 3 días".
 *
 * A partir de una semana la distancia deja de importar y se da la fecha, que es
 * lo único que el lector puede situar. La referencia es el momento de la
 * respuesta del servidor, así que el resultado cambia con cada `force-dynamic`.
 */
export function formatRelativeTime(date: Date, now: Date = new Date()): string {
  // Positivo hacia el pasado. Si `date` está en el futuro por un desajuste de
  // reloj sale negativo y cae en "ahora mismo", que es lo que hay que mostrar.
  const elapsedSeconds = Math.round((now.getTime() - date.getTime()) / 1000);

  if (elapsedSeconds < 60) {
    return "ahora mismo";
  }

  const minutes = Math.round(elapsedSeconds / 60);
  const hours = Math.round(minutes / 60);
  const days = Math.round(hours / 24);

  if (hours < 1) {
    return relative.format(-minutes, "minute");
  }

  if (days < 7) {
    return relative.format(-hours, "hour");
  }

  return absoluteDay.format(date);
}

/** Fecha y hora legibles, para el `title` de los `<time>`. */
export function formatAbsoluteTime(date: Date): string {
  return absoluteTime.format(date);
}

// Los límites de la ventana son instantes UTC (`from`/`to` son medianoche UTC), así
// que se formatean en UTC y no en la zona del proceso: si no, el día que se pinta
// dependería de dónde corra el Worker y no de lo que la organización configuró.
const windowDay = new Intl.DateTimeFormat("es-ES", {
  day: "numeric",
  month: "long",
  timeZone: "UTC",
});

const windowDayYear = new Intl.DateTimeFormat("es-ES", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

/**
 * El periodo del torneo en una frase, para `/puntuacion`.
 *
 * `to` es opcional en el ruleset (`null` = ventana abierta), y de ahí las dos
 * formas: "Del 15 de septiembre al 15 de octubre de 2026" y "Desde el 15 de
 * septiembre de 2026". Cuando los dos límites caen en el mismo año, el año se dice
 * una sola vez, al final, que es como se lee una fecha en español.
 */
export function formatTournamentWindow(window: { from: string; to: string | null }): string {
  const from = new Date(window.from);

  if (window.to === null) {
    return `Desde el ${windowDayYear.format(from)}`;
  }

  const to = new Date(window.to);

  if (from.getUTCFullYear() === to.getUTCFullYear()) {
    return `Del ${windowDay.format(from)} al ${windowDayYear.format(to)}`;
  }

  return `Del ${windowDayYear.format(from)} al ${windowDayYear.format(to)}`;
}

/**
 * Cuánto queda hasta `to`, desglosado en días, horas y minutos.
 *
 * Se trunca hacia abajo al minuto, nunca se redondea al alza: prometer un minuto
 * que ya no queda es peor que quedarse corto. Devuelve `null` cuando `to` ya pasó
 * (o es justo `now`), que es lo que usa la portada para no pintar un contador a
 * cero.
 *
 * `now` entra por parámetro a propósito: así la función es pura y se puede probar
 * sin temporizadores reales, y el contador decide cuándo recalcular.
 */
export function countdownParts(
  to: Date,
  now: Date,
): { days: number; hours: number; minutes: number } | null {
  if (to.getTime() <= now.getTime()) {
    return null;
  }

  const totalMinutes = Math.floor((to.getTime() - now.getTime()) / 60_000);

  return {
    days: Math.floor(totalMinutes / 1_440),
    hours: Math.floor((totalMinutes % 1_440) / 60),
    minutes: totalMinutes % 60,
  };
}

/**
 * Enlace al perfil de un jugador en AoE4World.
 *
 * El patrón vive aquí para que la clasificación (`StandingRow.profileUrl`) y el
 * detalle de los objetivos (`ObjectiveContender.profileUrl`) no lo repitan y la
 * UI no tenga que montar la URL.
 */
export function aoe4WorldProfileUrl(profileId: number): string {
  return `https://aoe4world.com/players/${profileId}`;
}

/**
 * Enlace a una partida concreta en AoE4World.
 *
 * El patrón vive aquí, junto al del perfil, por el mismo motivo: la UI pasa el
 * `profileId` del jugador y el `gameId` de la partida y no monta la URL. El `gameId`
 * entra como `string` porque el que guarda la fila de `Alert` es un `string` (los ids
 * de AoE4World son largos y no se operan), y no se normaliza en ningún lado: un enlace
 * roto se detecta abriéndolo, no parseándolo.
 */
export function aoe4WorldGameUrl(profileId: number, gameId: string): string {
  return `https://aoe4world.com/players/${profileId}/games/${gameId}`;
}

/**
 * Enlaces a los canales de directo, para que la interfaz no monte ninguna URL.
 *
* Los tres tienen la misma firma y el mismo criterio por una razón concreta: quien
 * pinta un distintivo de canal no debería tener que recordar en qué plataforma la
 * arroba va delante y en cuál no, ni qué subdominio lleva cada una. Las tres
 * reciben ya el canal **canónico** desde el DAL (`normalizeTwitchChannel`,
 * `normalizeYoutubeChannel`, `normalizeKickChannel`), así que aquí solo se compone:
 *
 * - Twitch va sin arroba: `twitch.tv/<canal>`.
 * - YouTube **con** arroba: es la única de las tres donde la URL la lleva, y es lo
 *   que distingue un handle de un nombre de usuario.
 * - Kick con su subdominio `www.`, que es el que redirecciona de forma estable.
 *
 * Las tres usan `https` y ninguna lleva parámetros: son enlaces que abre una
 * persona, no URLs que el proyecto tenga que interpretar.
 *
 * Reciben **el canal canónico**, no una cadena cualquiera, y por eso el parámetro
 * no es nullable: quien no tiene canal no pinta el icono, y en el punto del
 * componente donde se decide eso el valor ya ha sido estrecho a `string`. Es
 * también lo que evita que un `null` llegue a la URL y produzca un enlace a
 * `twitch.tv/null`.
 */
export function twitchChannelUrl(channel: string): string {
  return `https://twitch.tv/${channel}`;
}

/** Enlace al canal de YouTube. El `handle` es el canónico, sin arroba. */
export function youtubeChannelUrl(handle: string): string {
  return `https://www.youtube.com/@${handle}`;
}

/** Enlace al canal de Kick. El `slug` es el canónico, en minúsculas. */
export function kickChannelUrl(slug: string): string {
  return `https://www.kick.com/${slug}`;
}

const LADDER_SIZE = /^rm_(\d)v(\d)$/i;

/**
 * La FFA, reconocida por **familia** y no por igualdad.
 *
 * La API no la publica siempre con el mismo nombre: aparece como `qm_ffa`, como
 * `ffa_ffa` y con variantes que llegan cuando solo viene `kind` (`qm_ffa_nomad`),
 * y las tres son la misma manera de jugar. Por eso el nombre no se compara
 * entero: `ffa` tiene que ser un segmento del valor, con guiones bajos a los
 * lados, para no engancharse a una subcadena cualquiera.
 *
 * Ninguna familia de ladder lleva `ffa` en el nombre, así que esta comprobación
 * no puede quitarle el tamaño a un ranked: `rm_*` se resuelve antes y por otras
 * ramas.
 */
const FFA_FAMILY = /(^|_)ffa(_|$)/;

/** ¿Es este valor el nombre de una familia FFA, con cualquiera de sus variantes? */
function isFfaFamily(value: string | null): boolean {
  return value !== null && FFA_FAMILY.test(value);
}

/**
 * Etiqueta del modo de una partida a partir de lo que publica AoE4World.
 *
 * `Match.mode` ya viene resuelto a familia (`rm_solo` / `rm_team`), pero
 * `leaderboard` conserva el tamaño literal (`rm_2v2`, `rm_3v3`...), que es
 * información más precisa para quien está viendo la partida. Si llega un modo
 * que no conocemos se devuelve tal cual, en vez de esconderlo: mejor un código
 * raro que un dato que no cuadra.
 *
 * La **FFA es la excepción**, y es la única familia no rankeada con etiqueta
 * propia: se reconoce por familia (`FFA_FAMILY`) y se rotula "FFA" en vez de
 * soltar el `qm_ffa` de la API, que no le dice nada a quien está leyendo la
 * partida. Va antes del retorno del literal y solo para esa familia; el resto de
 * lo desconocido (`qm_2v2`, `ew_1v1`, `custom_8v8`…) sigue saliendo tal cual.
 *
 * `leaderboard` admite `null` porque hay filas que no son de una partida: en el
 * historial del panel, una fila de **objetivo cumplido** no tiene ladder. Sin
 * `leaderboard` y sin `mode` no hay nada que describir, y se devuelve el propio
 * `mode` (o una cadena vacía si tampoco lo hay) en lugar de inventar un formato.
 */
export function describeMode(mode: string | null, leaderboard: string | null): string {
  const size = leaderboard?.match(LADDER_SIZE) ?? null;

  if (size !== null) {
    const [, left, right] = size;
    return left === "1" && right === "1" ? "1vs1" : `${left}v${right}`;
  }

  if (mode === "rm_team" || leaderboard === "rm_team") {
    return "Por equipos";
  }

  if (mode === "rm_solo" || leaderboard === "rm_solo") {
    return "1vs1";
  }

  if (isFfaFamily(mode) || isFfaFamily(leaderboard)) {
    return "FFA";
  }

  return leaderboard ?? mode ?? "";
}

/**
 * Tamaño de un partido a partir de cuántos jugadores tiene cada equipo, o `null`
 * si con esa información no se puede asegurar.
 *
 * `describeMode` solo mira `mode` y `leaderboard`, y ahí hay un hueco conocido:
 * la API usa el mismo nombre para ladder y para tipo de partida según el
 * endpoint, así que un ranked 2v2 puede llegar con `leaderboard: "rm_team"` y
 * desde las columnas sale "Por equipos" cuando la partida es un 2v2 de verdad.
 *
 * Con la alineación a la vista no hace falta adivinar: si la partida son **dos
 * bandos del mismo tamaño**, ese es el tamaño y la etiqueta no puede contradecir
 * los nombres que se están pintando.
 *
 * Que sean dos bandos es parte de la condición y no un detalle: `NvN` describe
 * una partida de dos bandos, así que ocho equipos de uno —una FFA— no es un
 * "1vs1" con ocho bandos, es otro formato, y llamarlo 1vs1 mentiría lo mismo
 * que antes. Con más de dos se devuelve `null`, igual que con equipos
 * desiguales por un abandono o con un solo bando, y quien llama cae en
 * `describeMode`, que es donde vive la etiqueta de los formatos que no son de
 * dos bandos.
 */
export function describeTeamSize(teamSizes: readonly number[]): string | null {
  if (teamSizes.length !== 2) {
    return null;
  }

  const [left, right] = teamSizes;

  if (left !== right || left < 1) {
    return null;
  }

  // Mismo criterio de etiqueta que `describeMode`: el 1v1 se escribe "1vs1".
  return left === 1 ? "1vs1" : `${left}v${left}`;
}

/**
 * Cuántos jugadores tiene cada equipo de la partida, leído de `rawJson.teams`.
 *
 * Existe para el historial, que no tiene la alineación a la vista y aun así necesita
 * el tamaño: en las columnas, un ranked 2v2 viene con `leaderboard: "rm_team"`, que no
 * dice cuántos juegan, y la alineación completa solo está en el payload. Es la misma
 * fuente que usa `/partidas`, pero aquí solo hacen falta los recuentos.
 *
 * Devuelve `[]` cuando el payload no permite asegurarlo, y quien llama cae en
 * `describeMode`: una partida vieja o un `rawJson` raro no debe inventar un 2v2.
 */
export function teamSizesFromRawJson(rawJson: unknown): number[] {
  if (typeof rawJson !== "object" || rawJson === null || !("teams" in rawJson)) {
    return [];
  }

  const { teams } = rawJson as { teams: unknown };

  if (!Array.isArray(teams)) {
    return [];
  }

  return teams.filter(Array.isArray).map((team) => (team as unknown[]).length);
}
