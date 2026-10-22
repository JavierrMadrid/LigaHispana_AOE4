import "./load-env.mjs";

import { PlayerStatus } from "@/generated/prisma/enums";
import { readDivisionCutoffs } from "@/lib/alerts/settings";
import {
  createAoe4WorldClient,
  DEFAULT_LEADERBOARD,
  LEADERBOARD_MAX_PROFILE_IDS,
  type Aoe4WorldClient,
} from "@/lib/aoe4world/client";
import {
  Aoe4WorldError,
  Aoe4WorldNotFoundError,
  createAoe4WorldHttpClient,
  type Aoe4WorldHttpClient,
} from "@/lib/aoe4world/http";
import { normalizeGame, type NormalizedMatch } from "@/lib/aoe4world/normalize";
import type { Aoe4WorldGame, Aoe4WorldGamesPage } from "@/lib/aoe4world/types";
import type { LadderCutoffsTable } from "@/lib/alerts/division-cutoffs";
import { db } from "@/lib/db";
import { isRecord } from "@/lib/json";
import {
  countsAsRanked,
  windowWhere,
  type ScoringWindow,
  type TeamTierContext,
} from "@/lib/ranked-match";
import { readRuleset, recomputeScores, type ScoringRuleset } from "@/lib/scoring";
import { readSyncRunTrace, type SyncRunTrace } from "@/lib/settings";
import { countTournamentMatches } from "@/lib/aoe4world/sync";

/**
 * Medidas de la migración al endpoint masivo de AoE4World (F0 de la issue 123).
 *
 * No es un test: necesita red y base de datos. Mide lo que decide los
 * presupuestos de las fases siguientes (N, M de ladder, Σ de páginas por
 * jugador, paridad contra `/players/:id/games`, semántica de `updated_at` y
 * trampas del envelope masivo) y deja el rastro del sincronizador a la vista.
 *
 * Por defecto **solo lee**. `--recalc` es la única excepción y avisa antes de
 * escribir: ejecuta `recomputeScores()`, que es idempotente.
 *
 *   npm run verify:aoe4world -- --sample 10
 *   npm run verify:aoe4world -- --all
 *   npm run verify:aoe4world -- --sample 5 --no-parity
 *   npm run verify:aoe4world -- --recalc
 */

const DEFAULT_SAMPLE = 10;
const PAGE_SIZE = 50;
const MAX_PAGES_PER_PLAYER = 40;
const UPDATED_AT_MARGIN_MINUTES = 2;
const UPDATED_AT_LATE_MINUTES = 5;
const UPDATED_AT_VERY_LATE_MINUTES = 15;
const FAILURES_SHOWN = 5;

const USAGE = [
  "Uso: npm run verify:aoe4world -- [--sample N] [--all] [--no-parity] [--recalc]",
  "  --sample N   jugadores de la muestra para páginas y paridad (por defecto 10)",
  "  --all        mide todos los aprobados en lugar de la muestra",
  "  --no-parity  omite la comparación con la base de datos",
  "  --recalc     ejecuta recomputeScores() (escribe; idempotente)",
].join("\n");

type Options = {
  sample: number;
  all: boolean;
  parity: boolean;
  recalc: boolean;
};

type ApprovedPlayer = {
  id: string;
  profileId: number;
  name: string;
  registeredAt: Date | null;
};

type FetchedPlayerGames = {
  player: ApprovedPlayer;
  games: Aoe4WorldGame[];
  pages: number;
  truncated: boolean;
  error: string | null;
  notFound: boolean;
};

type LadderMeasurement = {
  batches: number;
  seen: number;
  missing: number;
};

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : `Error desconocido: ${String(error)}`;
}

/** El cuerpo del error de la API, sin la URL que precede al detalle. */
function errorDetail(message: string): string {
  const marker = message.lastIndexOf(": ");

  return marker === -1 ? message : message.slice(marker + 2);
}

function progress(message: string): void {
  process.stderr.write(`[verify:aoe4world] ${message}\n`);
}

function round(value: number, decimals = 1): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);

  if (minutes < 1) {
    return `${Math.max(0, Math.round(ms / 1000))} s`;
  }

  if (minutes < 120) {
    return `${minutes} min`;
  }

  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;

  if (hours < 48) {
    return restMinutes === 0 ? `${hours} h` : `${hours} h ${restMinutes} min`;
  }

  const days = Math.floor(hours / 24);
  const restHours = hours % 24;

  return restHours === 0 ? `${days} d` : `${days} d ${restHours} h`;
}

function formatAge(iso: string | null, now: Date): string {
  if (iso === null) {
    return "—";
  }

  const date = new Date(iso);

  if (Number.isNaN(date.getTime())) {
    return `ilegible (${iso})`;
  }

  const age = now.getTime() - date.getTime();

  return age < 0 ? `${iso} (en el futuro)` : `${iso} (hace ${formatDuration(age)})`;
}

function mdCell(value: string): string {
  return value.replace(/\|/g, "\\|");
}

function parseOptions(argv: readonly string[]): Options {
  let sample = DEFAULT_SAMPLE;
  let all = false;
  let parity = true;
  let recalc = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--all") {
      all = true;
    } else if (argument === "--no-parity") {
      parity = false;
    } else if (argument === "--recalc") {
      recalc = true;
    } else if (argument === "--sample") {
      const raw = argv[index + 1];

      if (raw === undefined) {
        throw new Error("--sample necesita un número.\n\n" + USAGE);
      }

      const parsed = Number(raw);

      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`--sample necesita un entero positivo (recibido: "${raw}").\n\n${USAGE}`);
      }

      sample = parsed;
      index += 1;
    } else {
      throw new Error(`Argumento no reconocido: "${argument}".\n\n${USAGE}`);
    }
  }

  return { sample, all, parity, recalc };
}

function pickSample(players: readonly ApprovedPlayer[], size: number): ApprovedPlayer[] {
  if (size >= players.length) {
    return [...players];
  }

  // Muestreo uniforme y determinista: recorrer el roster en orden de `profileId`
  // y quedarse con los primeros dejaría fuera a media tabla en un torneo grande.
  const step = players.length / size;
  const sample: ApprovedPlayer[] = [];

  for (let index = 0; index < size; index += 1) {
    const player = players[Math.floor(index * step)];

    if (player !== undefined) {
      sample.push(player);
    }
  }

  return sample;
}

async function measureLadder(
  client: Aoe4WorldClient,
  players: readonly ApprovedPlayer[],
): Promise<LadderMeasurement> {
  const measurement: LadderMeasurement = { batches: 0, seen: 0, missing: 0 };

  for (let start = 0; start < players.length; start += LEADERBOARD_MAX_PROFILE_IDS) {
    const ids = players
      .slice(start, start + LEADERBOARD_MAX_PROFILE_IDS)
      .map((player) => player.profileId);

    progress(
      `Ladder: lote ${measurement.batches + 1} (${ids.length} ids, ${start + ids.length}/${players.length}).`,
    );

    const board = await client.getLeaderboard(DEFAULT_LEADERBOARD, ids);
    measurement.batches += 1;

    const present = new Set(board.players.map((entry) => entry.profileId));

    for (const id of ids) {
      if (present.has(id)) {
        measurement.seen += 1;
      } else {
        measurement.missing += 1;
      }
    }
  }

  return measurement;
}

function reportRoster(
  approvedCount: number,
  players: readonly ApprovedPlayer[],
  ladder: LadderMeasurement | null,
  ladderError: string | null,
): void {
  console.log("## 1 · Roster");
  console.log("");
  console.log(`- Aprobados (\`db.player.count\`): **${approvedCount}**`);
  console.log(`- Filas leídas para el informe: ${players.length}`);
  console.log("");

  if (players.length > 0) {
    console.log("| profileId | Nombre | Alta |");
    console.log("|---:|---|---|");

    for (const player of players) {
      const registeredAt = player.registeredAt?.toISOString() ?? "—";
      console.log(`| ${player.profileId} | ${mdCell(player.name)} | ${registeredAt} |`);
    }

    console.log("");
  }

  if (ladder === null) {
    console.log(`- Ladder \`${DEFAULT_LEADERBOARD}\`: **fallo**${ladderError === null ? "" : ` (${ladderError})`}`);
    return;
  }

  const percentage = approvedCount === 0 ? 0 : round((ladder.seen / approvedCount) * 100);

  console.log("### Ladder");
  console.log("");
  console.log(`- Ladder \`${DEFAULT_LEADERBOARD}\`: ${ladder.batches} lotes.`);
  console.log(`- Vistos: **${ladder.seen}** de ${approvedCount} (${percentage} %).`);
  console.log(`- Ausentes: **${ladder.missing}**.`);
  console.log(
    `- La \`M\` que decide el tope de F3 es el número de aprobados que hay que refrescar: **${approvedCount}** (todos entran en el masivo). No son los ausentes (${ladder.missing}): un perfil sin fila en la ladder sigue siendo un jugador que el sincronizador tiene que recorrer.`,
  );
}

async function fetchPlayerGames(
  client: Aoe4WorldClient,
  player: ApprovedPlayer,
  since: string,
  position: number,
  total: number,
): Promise<FetchedPlayerGames> {
  const games: Aoe4WorldGame[] = [];
  let pages = 0;
  let nextPage: number | null = 1;
  let error: string | null = null;
  let notFound = false;

  progress(`Jugador ${position}/${total} (${player.profileId}): descargando histórico…`);

  try {
    while (nextPage !== null && pages < MAX_PAGES_PER_PLAYER) {
      const page: Aoe4WorldGamesPage = await client.getPlayerGames(player.profileId, {
        page: nextPage,
        limit: PAGE_SIZE,
        since,
      });

      pages += 1;
      games.push(...page.games);

      if (page.games.length === 0) {
        nextPage = null;
      } else {
        nextPage = page.nextPage;
      }

      if (nextPage !== null && pages % 5 === 0) {
        progress(
          `Jugador ${position}/${total} (${player.profileId}): ${pages} páginas, ${games.length} partidas.`,
        );
      }
    }
  } catch (caught) {
    notFound = caught instanceof Aoe4WorldNotFoundError;
    error = toErrorMessage(caught);
  }

  const truncated = nextPage !== null;
  progress(
    `Jugador ${position}/${total} (${player.profileId}): ${pages} páginas, ${games.length} partidas${truncated ? " (tope alcanzado)" : ""}${error === null ? "" : `, error: ${error}`}.`,
  );

  return { player, games, pages, truncated, error, notFound };
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 1) {
    return sorted[middle] ?? null;
  }

  const left = sorted[middle - 1] ?? 0;
  const right = sorted[middle] ?? 0;

  return (left + right) / 2;
}

function minValue(values: readonly number[]): number {
  return values.reduce((min, value) => Math.min(min, value), Number.POSITIVE_INFINITY);
}

function maxValue(values: readonly number[]): number {
  return values.reduce((max, value) => Math.max(max, value), Number.NEGATIVE_INFINITY);
}

function reportPages(
  fetched: readonly FetchedPlayerGames[],
  sampleSize: number,
  approvedCount: number,
  all: boolean,
  window: ScoringWindow,
): void {
  console.log("## 2 · Ventana y páginas por jugador");
  console.log("");
  console.log(`- Ventana: desde \`${window.from}\` hasta \`${window.to ?? "sin fin"}\`.`);
  console.log(
    `- Muestra: ${sampleSize} de ${approvedCount} aprobados${all ? " (todos)" : " (selección uniforme)"}.`,
  );
  console.log("");
  console.log("| Jugador | Páginas | Partidas | Truncado | Error |");
  console.log("|---|---:|---:|---|---|");

  for (const entry of fetched) {
    console.log(
      `| ${entry.player.profileId} | ${entry.pages} | ${entry.games.length} | ${entry.truncated ? "sí" : "no"} | ${entry.error === null ? "—" : mdCell(entry.error)} |`,
    );
  }

  console.log("");

  const pages = fetched.map((entry) => entry.pages);
  const totalPages = pages.reduce((sum, value) => sum + value, 0);
  const maxPages = pages.length === 0 ? 0 : maxValue(pages);
  const mean = pages.length === 0 ? 0 : totalPages / pages.length;
  const notFound = fetched.filter((entry) => entry.notFound).length;
  const otherErrors = fetched.filter((entry) => entry.error !== null && !entry.notFound).length;

  console.log(
    `- Σ páginas de la muestra: **${totalPages}**; media ${round(mean, 2)}; máximo ${maxPages}.`,
  );
  console.log(
    `- Partidas descargadas: ${fetched.reduce((sum, entry) => sum + entry.games.length, 0)}.`,
  );
  console.log(`- Truncados por el tope de ${MAX_PAGES_PER_PLAYER} páginas: ${fetched.filter((entry) => entry.truncated).length}.`);
  console.log(`- Errores: ${notFound} con 404 y ${otherErrors} de otro tipo.`);

  if (!all && fetched.length > 0) {
    const extrapolated = Math.round(mean * approvedCount);
    console.log(
      `- Extrapolación a N=${approvedCount}: **~${extrapolated} páginas** (${mean.toFixed(2)} × ${approvedCount}; es una estimación, no una medición).`,
    );
  } else {
    console.log("- Σ real: no hay extrapolación porque se han medido todos los aprobados.");
  }
}

async function reportParity(
  fetched: readonly FetchedPlayerGames[],
  ruleset: ScoringRuleset,
  cutoffs: LadderCutoffsTable | null,
  now: Date,
): Promise<void> {
  console.log("## 3 · Paridad de datos");
  console.log("");
  console.log(
    `- Cortes de división: ${cutoffs === null ? "**no hay** (la condición de equipos no puede aplicarse y las partidas cuentan)" : "disponibles"}.`,
  );
  console.log(
    "- La comparación usa la regla única: `normalizeGame()` + `countTournamentMatches()` en la API y `countsAsRanked()` en la base.",
  );
  console.log("");
  console.log("| Jugador | API contables | DB contables | Revertidas | Faltan en DB | Sobran en DB |");
  console.log("|---|---:|---:|---:|---:|---:|");

  const missingIds: string[] = [];
  const extraIds: string[] = [];
  let totalApi = 0;
  let totalDb = 0;
  let totalReverted = 0;
  let totalMissing = 0;
  let totalExtra = 0;

  for (const entry of fetched) {
    if (entry.error !== null) {
      console.log(`| ${entry.player.profileId} | — | — | — | — | — |`);
      continue;
    }

    const context: TeamTierContext = {
      profileId: entry.player.profileId,
      cutoffs,
    };
    const normalized: NormalizedMatch[] = [];

    for (const game of entry.games) {
      const result = normalizeGame(game, entry.player.profileId, now);

      if (result.status === "ok") {
        normalized.push(result.match);
      }
    }

    const apiCounted = new Set<string>();

    for (const match of normalized) {
      if (countTournamentMatches([match], ruleset, entry.player.registeredAt, context) > 0) {
        apiCounted.add(match.gameId);
      }
    }

    const dbRows = await db.match.findMany({
      where: {
        playerId: entry.player.id,
        ...windowWhere(ruleset.window, entry.player.registeredAt),
      },
      select: {
        gameId: true,
        startedAt: true,
        finishedAt: true,
        leaderboard: true,
        mode: true,
        result: true,
        rawJson: true,
        revertedAt: true,
      },
    });

    const dbCounted = new Set<string>();
    const reverted = new Set<string>();

    for (const row of dbRows) {
      if (row.revertedAt !== null) {
        reverted.add(row.gameId);
      }

      if (countsAsRanked(row, ruleset.window, entry.player.registeredAt, context)) {
        dbCounted.add(row.gameId);
      }
    }

    // Una partida revertida desde el panel no es un hueco de datos: la API no
    // puede saberlo y la sigue devolviendo. Se cuenta aparte para no confundirla
    // con una partida que el sincronizador no ha guardado.
    const missing = [...apiCounted].filter(
      (gameId) => !dbCounted.has(gameId) && !reverted.has(gameId),
    );
    const extra = [...dbCounted].filter((gameId) => !apiCounted.has(gameId));

    missingIds.push(...missing);
    extraIds.push(...extra);
    totalApi += apiCounted.size;
    totalDb += dbCounted.size;
    totalReverted += reverted.size;
    totalMissing += missing.length;
    totalExtra += extra.length;

    const suffix = entry.truncated ? " *" : "";
    console.log(
      `| ${entry.player.profileId}${suffix} | ${apiCounted.size} | ${dbCounted.size} | ${reverted.size} | ${missing.length} | ${extra.length} |`,
    );
  }

  console.log("");
  console.log(
    `- Totales: **${totalApi}** contables en la API, **${totalDb}** en la base, **${totalReverted}** revertidas, **${totalMissing}** faltan en la base y **${totalExtra}** sobran.`,
  );

  if (fetched.some((entry) => entry.truncated)) {
    console.log(
      "- `*` marca un jugador cuyo histórico se cortó en el tope de páginas: su comparación es parcial y puede aparecer como «sobran» todo lo que no se llegó a descargar.",
    );
  }

  console.log(
    "- `Revertidas` son partidas que la base tiene en la ventana pero no cuenta porque el panel las marcó con `revertedAt`; la API las sigue devolviendo y no se cuentan como hueco.",
  );

  if (missingIds.length === 0) {
    console.log("- No falta ninguna partida contable en la base.");
  } else {
    console.log(
      `- Muestra de IDs que faltan en la base: ${missingIds.slice(0, 10).map((id) => `\`${id}\``).join(", ")}${missingIds.length > 10 ? "…" : ""}.`,
    );
  }

  if (extraIds.length === 0) {
    console.log("- No sobra ninguna partida contable en la base.");
  } else {
    console.log(
      `- Muestra de IDs que sobran en la base: ${extraIds.slice(0, 10).map((id) => `\`${id}\``).join(", ")}${extraIds.length > 10 ? "…" : ""}.`,
    );
  }
}

function readDateValue(value: unknown): Date | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value > 1e11 ? value : value * 1000;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }

  const timestamp = Date.parse(value);

  return Number.isNaN(timestamp) ? null : new Date(timestamp);
}

function readUpdatedAt(game: Aoe4WorldGame): Date | null {
  if (!isRecord(game.raw)) {
    return null;
  }

  return readDateValue(game.raw["updated_at"]);
}

function reportUpdatedAt(fetched: readonly FetchedPlayerGames[]): void {
  console.log("## 4 · Semántica de `updated_at`");
  console.log("");

  // Una partida de equipo aparece en el histórico de varios jugadores de la
  // muestra; se cuenta una vez para que los porcentajes no dependan del reparto.
  const gamesById = new Map<number, Aoe4WorldGame>();

  for (const entry of fetched) {
    for (const game of entry.games) {
      gamesById.set(game.gameId, game);
    }
  }

  const deltaFromStart: number[] = [];
  const deltaFromEnd: number[] = [];
  let finished = 0;
  let readable = 0;
  let nearEnd = 0;
  let laterThanFive = 0;
  let laterThanFifteen = 0;

  for (const game of gamesById.values()) {
    if (game.ongoing || game.durationSeconds === null) {
      continue;
    }

    finished += 1;
    const updatedAt = readUpdatedAt(game);

    if (updatedAt === null) {
      continue;
    }

    readable += 1;
    const endedAt = new Date(game.startedAt.getTime() + game.durationSeconds * 1000);
    const fromStart = (updatedAt.getTime() - game.startedAt.getTime()) / 60_000;
    const fromEnd = (updatedAt.getTime() - endedAt.getTime()) / 60_000;

    deltaFromStart.push(fromStart);
    deltaFromEnd.push(fromEnd);

    if (Math.abs(fromEnd) <= UPDATED_AT_MARGIN_MINUTES) {
      nearEnd += 1;
    }

    if (fromEnd > UPDATED_AT_LATE_MINUTES) {
      laterThanFive += 1;
    }

    if (fromEnd > UPDATED_AT_VERY_LATE_MINUTES) {
      laterThanFifteen += 1;
    }
  }

  console.log(
    `- Partidas terminadas y deduplicadas por \`gameId\`: **${finished}**; con \`updated_at\` legible: **${readable}**.`,
  );

  if (readable === 0) {
    console.log("- No hay ninguna partida terminada con `updated_at` legible: no se puede concluir nada.");
    return;
  }

  const startMin = minValue(deltaFromStart);
  const startMax = maxValue(deltaFromStart);
  const startMedian = median(deltaFromStart);
  const endMin = minValue(deltaFromEnd);
  const endMax = maxValue(deltaFromEnd);
  const endMedian = median(deltaFromEnd);

  console.log("");
  console.log("| Medida | `updated_at - started_at` | `updated_at - (started_at + duración)` |");
  console.log("|---|---:|---:|");
  console.log(`| Mínimo | ${round(startMin)} min | ${round(endMin)} min |`);
  console.log(`| Mediana | ${startMedian === null ? "—" : `${round(startMedian)} min`} | ${endMedian === null ? "—" : `${round(endMedian)} min`} |`);
  console.log(`| Máximo | ${round(startMax)} min | ${round(endMax)} min |`);
  console.log("");

  const nearPercentage = round((nearEnd / readable) * 100);
  const latePercentage = round((laterThanFive / readable) * 100);

  console.log(
    `- A ±${UPDATED_AT_MARGIN_MINUTES} min del fin: **${nearEnd}** de ${readable} (${nearPercentage} %).`,
  );
  console.log(
    `- Más de ${UPDATED_AT_LATE_MINUTES} min después del fin: **${laterThanFive}** (${latePercentage} %).`,
  );
  console.log(`- Más de ${UPDATED_AT_VERY_LATE_MINUTES} min después del fin: **${laterThanFifteen}**.`);

  if (endMedian === null) {
    console.log("- Conclusión: no hay suficientes datos para decidir.");
  } else if (nearPercentage < 50 && endMedian > UPDATED_AT_MARGIN_MINUTES) {
    console.log(
      `- **Conclusión: \`updated_at\` es la hora del cambio de fila, no la de la partida.** La mediana cae ${round(endMedian)} min después del fin y solo el ${nearPercentage} % queda a ±${UPDATED_AT_MARGIN_MINUTES} min; el ${latePercentage} % supera los ${UPDATED_AT_LATE_MINUTES} min. Usarlo como hora de partida introduciría ese retraso en el cursor.`,
    );
  } else if (nearPercentage >= 50) {
    console.log(
      `- **Conclusión: \`updated_at\` se comporta como la hora del fin de la partida** (${nearPercentage} % a ±${UPDATED_AT_MARGIN_MINUTES} min, mediana ${round(endMedian)} min).`,
    );
  } else {
    console.log(
      `- **Conclusión: el comportamiento es mixto y no permite decidir con esta muestra** (mediana ${round(endMedian)} min, ${nearPercentage} % cerca del fin).`,
    );
  }
}

type RawResult =
  | { ok: true; payload: unknown }
  | { ok: false; status: number | null; message: string };

async function rawGames(
  http: Aoe4WorldHttpClient,
  params: Record<string, string>,
): Promise<RawResult> {
  try {
    const payload = await http.fetchJson("/games", new URLSearchParams(params));
    return { ok: true, payload };
  } catch (error) {
    return {
      ok: false,
      status: error instanceof Aoe4WorldError ? error.status : null,
      message: toErrorMessage(error),
    };
  }
}

function readNumberField(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];

  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readFilters(payload: unknown): Record<string, unknown> | null {
  if (!isRecord(payload)) {
    return null;
  }

  return isRecord(payload["filters"]) ? payload["filters"] : null;
}

function readNotice(payload: unknown): string | null {
  const filters = readFilters(payload);
  const notice = filters?.["_important_notice_"];

  return typeof notice === "string" && notice.trim() !== "" ? notice.trim() : null;
}

function readEchoedIds(payload: unknown): number[] | null {
  const filters = readFilters(payload);
  const value = filters?.["profile_ids"];

  if (Array.isArray(value)) {
    return value.filter((entry): entry is number => typeof entry === "number" && Number.isInteger(entry));
  }

  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => Number(entry.trim()))
      .filter((entry) => Number.isInteger(entry));
  }

  return null;
}

function payloadLine(payload: unknown): string {
  if (!isRecord(payload)) {
    return "cuerpo no reconocible";
  }

  const games = Array.isArray(payload["games"]) ? payload["games"] : [];
  const keys = Object.keys(payload).sort().join(", ");

  return [
    `claves: ${keys}`,
    `per_page: ${readNumberField(payload, "per_page") ?? "—"}`,
    `count: ${readNumberField(payload, "count") ?? games.length}`,
    `next_page: ${readNumberField(payload, "next_page") ?? "null"}`,
    `total_count: ${"total_count" in payload ? String(payload["total_count"]) : "ausente"}`,
  ].join("; ");
}

async function collectTrapIds(
  client: Aoe4WorldClient,
  players: readonly ApprovedPlayer[],
  needed: number,
): Promise<number[]> {
  if (players.length >= needed) {
    return players.slice(0, needed).map((player) => player.profileId);
  }

  const ids = new Set<number>();
  let page: number | null = 1;

  while (ids.size < needed && page !== null && page <= 3) {
    progress(`Trampas: leyendo la ladder para reunir ${needed} ids (página ${page}).`);
    const result = await client.getLadderPage(DEFAULT_LEADERBOARD, { page, perPage: PAGE_SIZE });

    for (const entry of result.players) {
      ids.add(entry.profileId);
    }

    page = result.nextPage;
  }

  return [...ids];
}

async function reportTraps(
  http: Aoe4WorldHttpClient,
  client: Aoe4WorldClient,
  players: readonly ApprovedPlayer[],
  sample: readonly ApprovedPlayer[],
): Promise<void> {
  console.log("## 5 · Trampas de la API");
  console.log("");

  const profileId = sample[0]?.profileId ?? players[0]?.profileId ?? null;

  if (profileId === null) {
    console.log("- Sin ningún aprobado: no hay id con el que probar el endpoint masivo.");
    return;
  }

  const now = new Date();
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

  console.log("### Envelope del masivo (`GET /games`)");
  console.log("");

  const baseParams: Record<string, string> = {
    profile_ids: String(profileId),
    order: "updated_at",
    updated_since: oneDayAgo,
    page: "1",
  };

  const plain = await rawGames(http, baseParams);

  if (plain.ok) {
    console.log(`- Sin \`per_page\`: HTTP 200; ${payloadLine(plain.payload)}.`);
  } else {
    console.log(`- Sin \`per_page\`: fallo${plain.status === null ? "" : ` (HTTP ${plain.status})`}: ${plain.message}`);
  }

  const withPerPage = await rawGames(http, { ...baseParams, per_page: "5" });

  if (withPerPage.ok) {
    console.log(`- Con \`per_page=5\`: HTTP 200; ${payloadLine(withPerPage.payload)}.`);
    const record = isRecord(withPerPage.payload) ? withPerPage.payload : {};
    const perPage = readNumberField(record, "per_page");
    const count = readNumberField(record, "count");
    const nextPage = readNumberField(record, "next_page");

    if (perPage !== null && perPage > 5) {
      console.log(
        `- **\`per_page\` se ignora**: se pidieron 5 y la respuesta declara ${perPage}. El tamaño efectivo es el que manda.`,
      );
    } else {
      console.log(`- \`per_page\` parece respetarse (respuesta: ${perPage ?? "sin dato"}).`);
    }

    if (nextPage !== null) {
      console.log(
        `- \`next_page\` = ${nextPage} con count = ${count ?? "sin dato"}: ${nextPage === 2 ? "coherente con una página 1 no final" : "no coincide con la página siguiente esperada (2)"}.`,
      );
    } else {
      console.log(
        `- \`next_page\` = null con count = ${count ?? "sin dato"}: coherente si la página se ha cerrado.`,
      );
    }
  } else {
    console.log(`- Con \`per_page=5\`: fallo${withPerPage.status === null ? "" : ` (HTTP ${withPerPage.status})`}: ${withPerPage.message}`);
  }

  console.log("");
  console.log("### `updated_since` antiguo");
  console.log("");
  console.log("| Ventana | HTTP | `_important_notice_` | Partidas |");
  console.log("|---|---:|---|---:|");

  for (const days of [30, 60, 90]) {
    const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
    const result = await rawGames(http, { ...baseParams, updated_since: since });

    if (result.ok) {
      const record = isRecord(result.payload) ? result.payload : {};
      const games = Array.isArray(record["games"]) ? record["games"] : [];
      const notice = readNotice(result.payload);
      console.log(
        `| ${days} días | 200 | ${notice === null ? "—" : mdCell(notice)} | ${games.length} |`,
      );
    } else {
      console.log(
        `| ${days} días | ${result.status ?? "—"} | ${mdCell(result.message)} | — |`,
      );
    }
  }

  console.log("");
  console.log("### Límite de ids");
  console.log("");

  let trapIds: number[];

  try {
    trapIds = await collectTrapIds(client, players, 60);
  } catch (error) {
    console.log(`- No se pudieron reunir ids de la ladder: ${toErrorMessage(error)}`);
    trapIds = players.map((player) => player.profileId);
  }

  console.log("| Ids enviados | HTTP | Ecoados | Recorta |");
  console.log("|---:|---:|---:|---|");

  for (const count of [51, 60]) {
    if (trapIds.length < count) {
      console.log(`| ${count} | — | — | no hay suficientes ids disponibles (${trapIds.length}) |`);
      continue;
    }

    const sent = trapIds.slice(0, count);
    const result = await rawGames(http, { ...baseParams, profile_ids: sent.join(",") });

    if (!result.ok) {
      console.log(
        `| ${count} | ${result.status ?? "—"} | — | no se pudo comprobar: ${mdCell(errorDetail(result.message)).slice(0, 300)} |`,
      );
      continue;
    }

    const echoed = readEchoedIds(result.payload);

    if (echoed === null) {
      console.log(`| ${count} | 200 | sin \`filters.profile_ids\` | no se puede comparar |`);
      continue;
    }

    const same =
      echoed.length === sent.length && echoed.every((id, index) => id === sent[index]);

    console.log(
      `| ${count} | 200 | ${echoed.length} | ${same ? "no: los ecos todos" : `sí (enviados ${sent.length}, ecoados ${echoed.length})`} |`,
    );
  }

  console.log("");
  console.log("### Tope de páginas");
  console.log("");
  console.log("| Página | HTTP | Resumen / error |");
  console.log("|---:|---:|---|");

  const wideSince = "2000-01-01T00:00:00.000Z";
  const pageIds = trapIds.slice(0, LEADERBOARD_MAX_PROFILE_IDS);

  if (pageIds.length < LEADERBOARD_MAX_PROFILE_IDS) {
    console.log(
      `- No hay ${LEADERBOARD_MAX_PROFILE_IDS} ids para el lote: se prueban las páginas con ${pageIds.length}.`,
    );
  }

  for (const page of [19, 20, 21]) {
    const result = await rawGames(http, {
      profile_ids: pageIds.join(","),
      order: "updated_at",
      updated_since: wideSince,
      page: String(page),
    });

    if (result.ok) {
      console.log(`| ${page} | 200 | ${payloadLine(result.payload)} |`);
    } else {
      console.log(
        `| ${page} | ${result.status ?? "—"} | ${mdCell(errorDetail(result.message)).slice(0, 300)} |`,
      );
    }
  }
}

function reportTrace(trace: SyncRunTrace | null, now: Date): void {
  console.log("## 6 · Rastro del sincronizador");
  console.log("");

  if (trace === null) {
    console.log("- No hay rastro (`Setting[\"sync.lastRun\"]` vacío o ilegible).");
    return;
  }

  console.log(`- \`startedAt\`: ${trace.startedAt}`);
  console.log(`- \`finishedAt\`: ${formatAge(trace.finishedAt, now)}`);
  console.log(`- \`lastSuccessAt\`: ${formatAge(trace.lastSuccessAt, now)}`);
  console.log(`- Duración: ${trace.durationMs} ms`);
  console.log(
    `- Jugadores: total ${trace.playersTotal}, ok ${trace.playersOk}, fallidos ${trace.playersFailed}, cancelados ${trace.playersCancelled}.`,
  );
  console.log(
    `- Partidas nuevas: ${trace.newMatches}; actualizadas: ${trace.updatedMatches}; resueltas por refetch: ${trace.resolvedByRefetch}; abandonadas: ${trace.abandonedMatches}.`,
  );
  console.log(
    `- Partidas descartadas: ${trace.skippedGames}; en directo: ${trace.liveMatches}.`,
  );
  console.log(
    `- Llamadas a la API: ${trace.apiRequests} (reintentos: ${trace.apiRetries}; 429: ${trace.rateLimitResponses}; pausas: ${trace.rateLimitPausesMs} ms).`,
  );
  console.log(`- \`ladderError\`: ${trace.ladderError ?? "—"}`);
  console.log(`- \`scoringError\`: ${trace.scoringError ?? "—"}`);
  console.log(`- Fallos: ${trace.failures.length} listados (la pasada declara ${trace.playersFailed}).`);

  if (trace.failures.length > 0) {
    console.log("");
    console.log("| profileId | Nombre | Estado | Error |");
    console.log("|---:|---|---|---|");

    for (const failure of trace.failures.slice(0, FAILURES_SHOWN)) {
      console.log(
        `| ${failure.profileId} | ${mdCell(failure.name)} | ${mdCell(failure.status)} | ${mdCell(failure.error).slice(0, 200)} |`,
      );
    }
  }
}

async function reportRecalc(): Promise<void> {
  console.log("## 7 · Recálculo");
  console.log("");
  progress("--recalc: escribiendo en la base con recomputeScores() (idempotente)…");

  const result = await recomputeScores();

  console.log("- **Aviso**: `--recalc` ejecuta `recomputeScores()` y escribe en la base; la escritura es idempotente.");
  console.log(`- Versión de reglas: ${result.ruleSetVersion}`);
  console.log(`- \`durationMs\`: ${result.durationMs} ms`);
  console.log(`- \`matchesUpdated\`: ${result.matchesUpdated}`);
  console.log(`- \`playersRanked\`: ${result.playersRanked}`);
  console.log(`- \`playersUnranked\`: ${result.playersUnranked}`);
  console.log(`- \`totalPoints\`: ${result.totalPoints}`);
  console.log(`- \`objectivesPoints\`: ${result.objectivesPoints}`);
  console.log(`- \`eventsPoints\`: ${result.eventsPoints}`);

  if (result.warnings.length > 0) {
    console.log(`- Avisos: ${result.warnings.join(" | ")}`);
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const now = new Date();

  progress("Leyendo roster, ruleset, cortes y rastro…");

  const [approvedCount, players, ruleset, cutoffs, trace] = await Promise.all([
    db.player.count({ where: { status: PlayerStatus.APPROVED } }),
    db.player.findMany({
      where: { status: PlayerStatus.APPROVED },
      select: { id: true, profileId: true, name: true, registeredAt: true },
      orderBy: { profileId: "asc" },
    }),
    readRuleset(),
    readDivisionCutoffs(),
    readSyncRunTrace(),
  ]);

  const sample = options.all ? [...players] : pickSample(players, options.sample);

  console.log("# Medidas de AoE4World (F0)");
  console.log("");
  console.log(`- Fecha: ${now.toISOString()}`);
  console.log(
    `- Opciones: muestra ${options.all ? "completa" : options.sample}, paridad ${options.parity ? "sí" : "no"}, recálculo ${options.recalc ? "sí" : "no"}.`,
  );
  console.log("");

  let ladder: LadderMeasurement | null = null;
  let ladderError: string | null = null;

  if (players.length > 0) {
    try {
      ladder = await measureLadder(client, players);
    } catch (error) {
      ladderError = toErrorMessage(error);
      progress(`Ladder: fallo (${ladderError}).`);
    }
  }

  reportRoster(approvedCount, players, ladder, ladderError);
  console.log("");

  const fetched: FetchedPlayerGames[] = [];

  for (let index = 0; index < sample.length; index += 1) {
    const player = sample[index];

    if (player === undefined) {
      continue;
    }

    fetched.push(
      await fetchPlayerGames(client, player, ruleset.window.from, index + 1, sample.length),
    );
  }

  reportPages(fetched, sample.length, approvedCount, options.all, ruleset.window);
  console.log("");

  if (options.parity) {
    if (fetched.length === 0) {
      console.log("## 3 · Paridad de datos");
      console.log("");
      console.log("- Sin jugadores en la muestra: no hay nada que comparar.");
      console.log("");
    } else {
      await reportParity(fetched, ruleset, cutoffs, now);
      console.log("");
    }
  } else {
    console.log("## 3 · Paridad de datos");
    console.log("");
    console.log("- Omitida por `--no-parity`.");
    console.log("");
  }

  reportUpdatedAt(fetched);
  console.log("");
  await reportTraps(httpClient, client, players, sample);
  console.log("");
  reportTrace(trace, now);
  console.log("");

  if (options.recalc) {
    await reportRecalc();
    console.log("");
  } else {
    console.log("## 7 · Recálculo");
    console.log("");
    console.log("- Omitido (añade `--recalc` para ejecutar `recomputeScores()`; escribe en la base de forma idempotente).");
    console.log("");
  }

  const stats = client.stats;
  console.log("## Peticiones a AoE4World");
  console.log("");
  console.log(
    `- ${stats.requests} peticiones, ${stats.retries} reintentos, ${stats.rateLimitResponses} respuestas 429, ${stats.rateLimitPausesMs} ms de pausa.`,
  );
}

const httpClient = createAoe4WorldHttpClient();
const client = createAoe4WorldClient(httpClient);

void main().catch((error: unknown) => {
  progress(`Fallo: ${toErrorMessage(error)}`);
  process.exitCode = 1;
});
