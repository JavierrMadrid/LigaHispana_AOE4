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
