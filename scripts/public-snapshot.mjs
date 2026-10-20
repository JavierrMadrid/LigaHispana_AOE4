const PLAYER_FIELDS = [
  "rank", "profileId", "name", "aoe4WorldName", "country", "points", "pointsByWins",
  "pointsByObjectives", "wins", "losses", "elo", "division", "rankLevel", "streak",
  "twitchChannel", "twitchIsLive", "youtubeChannel", "youtubeIsLive", "kickChannel",
  "kickIsLive", "isPlaying", "avatarUrl", "profileUrl", "objectives",
];

export function localDatabaseConfig(connectionString, nodeEnv) {
  if (nodeEnv === "production") throw new Error("La captura pública solo se importa en desarrollo local.");
  let url;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error("DATABASE_URL debe apuntar a PostgreSQL local.");
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
    || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || url.searchParams.has("host") || url.searchParams.has("hostaddr")) {
    throw new Error("Se rechaza DATABASE_URL: solo se admite PostgreSQL en loopback.");
  }
  // Campos explícitos impiden que parámetros de la URL o PGHOST redirijan la conexión.
  return {
    host: url.hostname === "[::1]" ? "::1" : "127.0.0.1",
    port: Number(url.port || 5432),
    database: decodeURIComponent(url.pathname.slice(1)),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    ssl: false,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
  };
}

function publicRecords(html) {
  const records = new Map();
  const chunks = [...html.matchAll(/self\.__next_f\.push\((\[1,"(?:[^"\\]|\\.)*"\])\)/g)]
    .map((match) => JSON.parse(match[1])[1]).join("");
  for (const line of chunks.split("\n")) {
    const match = line.match(/^([0-9a-f]+):(.*)$/);
    if (!match || !/^[\[{]/.test(match[2])) continue;
    try {
      records.set(match[1], JSON.parse(match[2]));
    } catch {
      // Flight también transporta registros de módulos y recursos que no son JSON.
    }
  }
  if (!records.size) throw new Error("No se reconoce el payload público de Next.js.");
  return records;
}

function findValue(records, predicate) {
  function visit(value) {
    if (!value || typeof value !== "object") return undefined;
    if (predicate(value)) return value;
    for (const child of Object.values(value)) {
      const found = visit(child);
      if (found !== undefined) return found;
    }
  }
  for (const record of records.values()) {
    const found = visit(record);
    if (found !== undefined) return found;
  }
}

function resolveValue(value, records, depth = 0) {
  if (depth > 30) throw new Error("Referencia circular o demasiado profunda en la captura pública.");
  if (typeof value === "string") {
    if (value.startsWith("$D")) return value.slice(2);
    if (/^\$[0-9a-f]+:/.test(value)) {
      const [id, ...path] = value.slice(1).split(":");
      let target = records.get(id);
      for (const key of path) {
        target = key === "props" && Array.isArray(target) && target[0] === "$"
          ? target[3] : target?.[key];
      }
      if (target === undefined) throw new Error("Referencia pública sin resolver.");
      return resolveValue(target, records, depth + 1);
    }
    if (value.startsWith("$")) throw new Error("Valor Flight no compatible en los datos públicos.");
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => resolveValue(item, records, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveValue(item, records, depth + 1)]));
  }
  return value;
}

export function parsePublicHomepage(html) {
  const records = publicRecords(html);
  const standings = findValue(records, (value) => Array.isArray(value.rows)
    && value.rows.length > 0 && "profileId" in value.rows[0]);
  const period = findValue(records, (value) => typeof value.from === "string"
    && "to" in value && "serverNow" in value);
  const sync = findValue(records, (value) => "dataUpdatedAt" in value);
  if (!standings || !period) throw new Error("La portada no publica clasificación o fechas; no se importará nada.");
  return {
    rows: resolveValue(standings.rows, records).map((row) =>
      Object.fromEntries(PLAYER_FIELDS.map((key) => [key, row[key]]))),
    window: { from: period.from, to: period.to },
    publicSyncFinishedAt: sync?.dataUpdatedAt ?? null,
  };
}

export function parsePublicMatches(html) {
  const records = publicRecords(html);
  const value = findValue(records, (item) => Array.isArray(item.matches));
  return value ? resolveValue(value.matches, records) : [];
}

export function validateSnapshot(snapshot) {
  const fail = () => { throw new Error("Captura pública inválida o incoherente; no se importará nada."); };
  const integer = (value) => Number.isSafeInteger(value) && value >= 0;
  const date = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));
  if (snapshot.source !== "https://laligahispana.es/" || !date(snapshot.capturedAt)
    || !date(snapshot.window?.from) || (snapshot.window.to !== null && !date(snapshot.window.to))
    || !Array.isArray(snapshot.rows) || snapshot.rows.length === 0
    || !Array.isArray(snapshot.matches)) fail();
  if (snapshot.publicSyncFinishedAt !== null && !date(snapshot.publicSyncFinishedAt)) fail();
  const ids = new Set();
  const ranks = new Set();
  for (const row of snapshot.rows) {
    if (!integer(row.profileId) || row.profileId === 0 || ids.has(row.profileId)
      || !integer(row.rank) || row.rank === 0 || ranks.has(row.rank)
      || typeof row.name !== "string" || !row.name.trim()
      || ![row.points, row.pointsByWins, row.pointsByObjectives, row.wins, row.losses].every(integer)
      || row.points !== row.pointsByWins + row.pointsByObjectives
      || (row.elo !== null && !integer(row.elo))
      || (row.streak !== null && !Number.isSafeInteger(row.streak))
      || ![row.twitchIsLive, row.youtubeIsLive, row.kickIsLive, row.isPlaying].every((value) => typeof value === "boolean")
      || !Array.isArray(row.objectives) || row.objectives.some((objective) =>
        typeof objective.id !== "string" || !objective.id || !integer(objective.points))) fail();
    for (const key of ["aoe4WorldName", "country", "division", "rankLevel", "twitchChannel", "youtubeChannel", "kickChannel", "avatarUrl"]) {
      if (row[key] !== null && typeof row[key] !== "string") fail();
    }
    ids.add(row.profileId);
    ranks.add(row.rank);
  }
  const playing = new Set();
  const games = new Set();
  for (const match of snapshot.matches) {
    if (typeof match.gameId !== "string" || !/^\d+$/.test(match.gameId) || games.has(match.gameId)
      || !date(match.startedAt) || !["rm_solo", "rm_team"].includes(match.mode)
      || typeof match.leaderboard !== "string" || !Array.isArray(match.participants)) fail();
    games.add(match.gameId);
    for (const player of match.participants) {
      if (!Number.isInteger(player.team) || player.team < 1 || player.team > 8) fail();
      if (player.isLeaguePlayer) {
        if (!ids.has(player.profileId)) fail();
        playing.add(player.profileId);
      }
    }
  }
  if (snapshot.rows.some((row) => row.isPlaying !== playing.has(row.profileId))) fail();
  return snapshot;
}
