import "./load-env.mjs";

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { Client } from "pg";
import { localDatabaseConfig, parsePublicHomepage, parsePublicMatches, validateSnapshot } from "./public-snapshot.mjs";

const SOURCE = "https://laligahispana.es/";
const FIXTURE = new URL("./fixtures/public-homepage.json", import.meta.url);
const PREFIX = "live-snapshot-";

async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`No se pudo leer la página pública (${response.status}).`);
  const html = await response.text();
  if (html.length > 2_000_000) throw new Error("La respuesta pública supera el tamaño previsto.");
  return html;
}

async function importSnapshot(snapshot, config) {
  const db = new Client(config);
  await db.connect();
  try {
    await db.query("BEGIN");
    const existing = await db.query('SELECT id, "profileId" FROM "Player"');
    if (existing.rows.some((row) => row.id !== `${PREFIX}${row.profileId}`)) {
      throw new Error("La base contiene jugadores ajenos a esta captura; usa una base local dedicada.");
    }
    const profileIds = snapshot.rows.map((row) => row.profileId);
    await db.query('DELETE FROM "Player" WHERE NOT ("profileId" = ANY($1::int[]))', [profileIds]);
    await db.query('DELETE FROM "Match" WHERE id LIKE $1', [`${PREFIX}match-%`]);
    for (const row of snapshot.rows) {
      const id = `${PREFIX}${row.profileId}`;
      await db.query(`
        INSERT INTO "Player" (id, "profileId", name, "aoe4WorldName", country, status,
          "twitchChannel", "twitchIsLive", "youtubeChannel", "youtubeIsLive", "kickChannel",
          "kickIsLive", elo, "rankLevel", "avatarUrl", "updatedAt")
        VALUES ($1, $2, $3, $4, $5, 'APPROVED', $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW())
        ON CONFLICT ("profileId") DO UPDATE SET name = EXCLUDED.name, "aoe4WorldName" = EXCLUDED."aoe4WorldName",
          country = EXCLUDED.country, status = EXCLUDED.status, "twitchChannel" = EXCLUDED."twitchChannel",
          "twitchIsLive" = EXCLUDED."twitchIsLive", "youtubeChannel" = EXCLUDED."youtubeChannel",
          "youtubeIsLive" = EXCLUDED."youtubeIsLive", "kickChannel" = EXCLUDED."kickChannel",
          "kickIsLive" = EXCLUDED."kickIsLive", elo = EXCLUDED.elo, "rankLevel" = EXCLUDED."rankLevel",
          "avatarUrl" = EXCLUDED."avatarUrl", "updatedAt" = NOW()`,
      [id, row.profileId, row.name, row.aoe4WorldName, row.country, row.twitchChannel, row.twitchIsLive,
        row.youtubeChannel, row.youtubeIsLive, row.kickChannel, row.kickIsLive, row.elo, row.rankLevel, row.avatarUrl]);
      await db.query(`
        INSERT INTO "PlayerScore" ("playerId", "ruleSetVersion", rank, total, wins, matches, streak, breakdown, "computedAt")
        VALUES ($1, 3, $2, $3, $4, $5, $6, $7::jsonb, $8)
        ON CONFLICT ("playerId", "ruleSetVersion") DO UPDATE SET rank = EXCLUDED.rank, total = EXCLUDED.total,
          wins = EXCLUDED.wins, matches = EXCLUDED.matches, streak = EXCLUDED.streak,
          breakdown = EXCLUDED.breakdown, "computedAt" = EXCLUDED."computedAt"`,
      [id, row.rank, row.points, row.wins, row.wins + row.losses, row.streak,
        JSON.stringify({ objectives: { points: row.pointsByObjectives, earned: row.objectives.map((objective) => objective.id) } }),
        snapshot.publicSyncFinishedAt ?? snapshot.capturedAt]);
    }
    for (const match of snapshot.matches) {
      const teams = Array.from({ length: Math.max(...match.participants.map((player) => player.team)) }, () => []);
      for (const player of match.participants) {
        teams[player.team - 1].push({ profile_id: player.profileId, name: player.name, country: player.country, civilization: player.civ });
      }
      for (const player of match.participants.filter((item) => item.isLeaguePlayer)) {
        const opponent = match.participants.find((item) => item.team !== player.team);
        await db.query(`
          INSERT INTO "Match" (id, "gameId", "playerId", "opponentProfileId", "opponentName", civ,
            "opponentCiv", map, leaderboard, mode, "startedAt", "durationSeconds", "rawJson")
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)`,
        [`${PREFIX}match-${match.gameId}-${player.profileId}`, match.gameId, `${PREFIX}${player.profileId}`,
          opponent?.profileId ?? null, opponent?.name ?? null, player.civ, opponent?.civ ?? null,
          match.map, match.leaderboard, match.mode, match.startedAt, match.durationSeconds,
          JSON.stringify({ teams, snapshotSource: `${SOURCE}partidas` })]);
      }
    }
    const objectives = Object.fromEntries(snapshot.rows.flatMap((row) => row.objectives.map((objective) => [objective.id, objective.points])));
    await db.query(`
      INSERT INTO "Setting" (key, value, "updatedAt") VALUES ('scoring.ruleset', $1::jsonb, NOW())
      ON CONFLICT (key) DO UPDATE SET value = "Setting".value || EXCLUDED.value, "updatedAt" = NOW()`,
    [JSON.stringify({ version: 3, window: snapshot.window, objectives })]);
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    await db.end();
  }
}

async function main() {
  const args = new Set(process.argv.slice(2));
  if ([...args].some((arg) => !["--fetch", "--dry-run"].includes(arg))) {
    throw new Error("Uso: node scripts/refresh-public-snapshot.mjs [--fetch] [--dry-run]");
  }
  const config = localDatabaseConfig(process.env.DATABASE_URL, process.env.NODE_ENV);
  let snapshot;
  if (args.has("--fetch")) {
    const [homepage, matches] = await Promise.all([download(SOURCE), download(`${SOURCE}partidas`)]);
    snapshot = {
      source: SOURCE,
      matchesSource: `${SOURCE}partidas`,
      capturedAt: new Date().toISOString(),
      ...parsePublicHomepage(homepage),
      matches: parsePublicMatches(matches),
    };
  } else {
    snapshot = JSON.parse(await readFile(FIXTURE, "utf8"));
  }
  validateSnapshot(snapshot);
  if (!args.has("--dry-run")) {
    await importSnapshot(snapshot, config);
    if (args.has("--fetch")) {
      await mkdir(new URL("./fixtures/", import.meta.url), { recursive: true });
      await writeFile(FIXTURE, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    }
  }
  console.log(`${args.has("--dry-run") ? "Captura validada" : "Captura importada"}: ${snapshot.rows.length} participantes, ${snapshot.matches.length} partidas en curso.`);
  console.log(`Capturada: ${snapshot.capturedAt}; actualización pública: ${snapshot.publicSyncFinishedAt ?? "no publicada"}.`);
  console.log(snapshot.rows.slice(0, 4).map((row) => `${row.rank}. ${row.name}: ${row.points} puntos`).join("\n"));
}

main().catch((error) => {
  console.error(error.code ? `No se pudo completar la importación local (${error.code}).` : error.message);
  process.exitCode = 1;
});
