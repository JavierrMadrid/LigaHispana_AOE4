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

const LADDER_SIZE = /^rm_(\d)v(\d)$/i;

/**
 * Etiqueta del modo de una partida a partir de lo que publica AoE4World.
 *
 * `Match.mode` ya viene resuelto a familia (`rm_solo` / `rm_team`), pero
 * `leaderboard` conserva el tamaño literal (`rm_2v2`, `rm_3v3`...), que es
 * información más precisa para quien está viendo la partida. Si llega un modo
 * que no conocemos se devuelve tal cual, en vez de esconderlo: mejor un código
 * raro que un dato que no cuadra.
 */
export function describeMode(mode: string | null, leaderboard: string): string {
  const size = leaderboard.match(LADDER_SIZE);

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

  return leaderboard;
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
