export const PUBLIC_SNAPSHOT_SOURCE = "https://laligahispana.es/";

const PLAYER_FIELDS = [
  "rank", "profileId", "name", "aoe4WorldName", "country", "points", "pointsByAchievements",
  "pointsByCompetitions", "wins", "losses", "elo", "division", "rankLevel", "streak",
  "twitchChannel", "twitchIsLive", "youtubeChannel", "youtubeIsLive", "kickChannel",
  "kickIsLive", "isPlaying", "avatarUrl", "profileUrl", "objectives",
];

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
  if (!standings || !period) throw new Error("La portada no publica clasificación o fechas; no se guardará la captura.");
  const rows = resolveValue(standings.rows, records);
  const legacy = "pointsByWins" in rows[0];
  const fields = legacy ? PLAYER_FIELDS.filter((key) => !["pointsByAchievements", "pointsByCompetitions"].includes(key))
    .concat(["pointsByWins", "pointsByObjectives"]) : PLAYER_FIELDS;
  return {
    format: legacy ? "legacy-v3" : "standings-v1",
    ruleSetVersion: Number.isSafeInteger(standings.ruleSetVersion) ? standings.ruleSetVersion : null,
    rows: rows.map((row) => Object.fromEntries(fields.map((key) => [key, row[key]]))),
    window: { from: period.from, to: period.to },
    publicSyncFinishedAt: sync?.dataUpdatedAt ?? null,
  };
}

export function parsePublicMatches(html) {
  const records = publicRecords(html);
  const value = findValue(records, (item) => Array.isArray(item.matches));
  return value ? resolveValue(value.matches, records) : [];
}

export function snapshotFormat(snapshot) {
  if (["legacy-v3", "standings-v1"].includes(snapshot.format)) return snapshot.format;
  if (snapshot.format === undefined && snapshot.rows?.[0] && "pointsByWins" in snapshot.rows[0]) return "legacy-v3";
  throw new Error("Formato de captura desconocido; no se convierte una captura histórica a las reglas actuales.");
}

export function validateSnapshot(snapshot) {
  const fail = () => { throw new Error("Captura pública inválida o incoherente; no se guardará."); };
  const integer = (value) => Number.isSafeInteger(value) && value >= 0;
  const date = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));
  if (snapshot.source !== PUBLIC_SNAPSHOT_SOURCE || !date(snapshot.capturedAt)
    || !date(snapshot.window?.from) || (snapshot.window.to !== null && !date(snapshot.window.to))
    || !Array.isArray(snapshot.rows) || snapshot.rows.length === 0
    || !Array.isArray(snapshot.matches)) fail();
  if (snapshot.publicSyncFinishedAt !== null && !date(snapshot.publicSyncFinishedAt)) fail();
  const format = snapshotFormat(snapshot);
  if (format === "standings-v1" && snapshot.ruleSetVersion !== null
    && (!integer(snapshot.ruleSetVersion) || snapshot.ruleSetVersion === 0)) fail();
  const ids = new Set();
  for (const row of snapshot.rows) {
    const accumulated = format === "legacy-v3" ? row.pointsByWins : row.pointsByAchievements;
    const leadership = format === "legacy-v3" ? row.pointsByObjectives : row.pointsByCompetitions;
    if (!integer(row.profileId) || row.profileId === 0 || ids.has(row.profileId)
      || !integer(row.rank) || row.rank === 0
      || typeof row.name !== "string" || !row.name.trim()
      || ![row.points, accumulated, leadership, row.wins, row.losses].every(integer)
      || row.points !== accumulated + leadership
      || (row.elo !== null && !integer(row.elo))
      || (row.streak !== null && !Number.isSafeInteger(row.streak))
      || ![row.twitchIsLive, row.youtubeIsLive, row.kickIsLive, row.isPlaying].every((value) => typeof value === "boolean")
      || !Array.isArray(row.objectives) || row.objectives.some((objective) =>
        typeof objective.id !== "string" || !objective.id || !integer(objective.points)
        || (format === "standings-v1" && (
          !["achievement", "competition"].includes(objective.kind)
          || typeof objective.description !== "string" || typeof objective.metric !== "string"
          || !integer(objective.count) || objective.count === 0
        )))) fail();
    for (const key of ["aoe4WorldName", "country", "division", "rankLevel", "twitchChannel", "youtubeChannel", "kickChannel", "avatarUrl"]) {
      if (row[key] !== null && typeof row[key] !== "string") fail();
    }
    ids.add(row.profileId);
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
