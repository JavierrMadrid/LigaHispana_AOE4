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
 * Etiqueta del modo de una partida a partir de lo que publica AoE4World.
 *
 * `Match.mode` ya viene resuelto a familia (`rm_solo` / `rm_team`), pero
 * `leaderboard` conserva el tamaño literal (`rm_2v2`, `rm_3v3`...), que es
 * información más precisa para quien está viendo la partida. Si llega un modo
 * que no conocemos se devuelve tal cual, en vez de esconderlo: mejor un código
 * raro que un dato que no cuadra.
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
 * Con la alineación a la vista no hace falta adivinar: si todos los equipos
 * tienen el mismo número de jugadores, ese es el tamaño, y la etiqueta no puede
 * contradecir los nombres que se están pintando. Si no (equipos desiguales por
 * un abandono, un solo bando) se devuelve `null` y quien llama cae en
 * `describeMode`, que en ese caso tampoco tiene nada mejor que decir.
 */
export function describeTeamSize(teamSizes: readonly number[]): string | null {
  if (teamSizes.length < 2) {
    return null;
  }

  const [first, ...rest] = teamSizes;

  if (first === undefined || first < 1 || !rest.every((size) => size === first)) {
    return null;
  }

  // Mismo criterio de etiqueta que `describeMode`: el 1v1 se escribe "1vs1".
  return first === 1 ? "1vs1" : `${first}v${first}`;
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
