import "./load-env.mjs";

import { getAoe4WorldConfig } from "@/lib/aoe4world/env";
import {
  MOCK_EXTERNAL_PLAYERS,
  MOCK_EXTERNAL_PROFILE_IDS,
  MOCK_PROFILE_IDS,
  MOCK_TOURNAMENT_PLAYERS,
} from "@/lib/aoe4world/mock/players";
import { syncApprovedPlayers } from "@/lib/aoe4world/sync";
import { db } from "@/lib/db";
import { unwrapRead } from "@/lib/db-errors";
import { OBJECTIVE_POINTS } from "@/lib/objectives";
import { DIVISIONS, getStandings } from "@/lib/public";
import { DEFAULT_RULESET, RULESET_VERSION } from "@/lib/scoring";
import { playerSyncKey } from "@/lib/settings";

/**
 * Simulación completa del torneo contra el mock de AoE4World.
 *
 *   npm run mock:tournament  # crea/actualiza los 10 participantes y sincroniza
 *   npm run mock:clean       # borra exactamente esos 10 participantes
 *
 * Idempotente: se puede lanzar muchas veces seguidas. El histórico está anclado
 * a una epoch fija (ver `mock/games.ts`) y las partidas en vivo se recalculan en
 * cada petición, así que la segunda pasada no duplica nada, el cursor `since`
 * no se rompe y ninguna partida se borra por abandonada.
 *
 * Los rivales externos de las fixtures (gente de la ladder) **no** se convierten
 * en filas `Player`: solo aparecen como `opponentProfileId` / `opponentName`
 * dentro de las partidas de un participante, igual que en la base real.
 *
 * El interruptor del mock se fuerza aquí mismo: este script nunca debe tocar la
 * API real, ni aunque `.env` no lleve `AOE4WORLD_MOCK`.
 */

process.env.AOE4WORLD_MOCK = "1";

/**
 * Crea o actualiza los diez participantes del torneo simulado.
 *
 * Los canales y el estado de directo de **YouTube y Kick** se escriben aquí, y no
 * los deja el refresco del worker, porque la simulación **no toca ninguna API
 * externa**: eso lo garantiza el `AOE4WORLD_MOCK` de AoE4World y, para estas dos
 * plataformas, el flag `streams` de la llamada al sincronizador (que se apaga justo
 * aquí). Un `false` escrito por el refresco borraría el "en directo" que la
 * simulación acaba de plantar, y un `true` real exigiría llamar a YouTube desde un
 * script de desarrollo.
 *
 * El paso del **historial de partidas** también va apagado (`history: false`) y por
 * el mismo motivo: su ruta no tiene fixtures, así que con el mock activo no sale a
 * la red y no escribe nada. Apagarlo del todo solo evita el aviso; el comportamiento
 * correcto ya está dentro del módulo.
 */
async function ensureMockPlayers(): Promise<void> {
  for (const player of MOCK_TOURNAMENT_PLAYERS) {
    await db.player.upsert({
      where: { profileId: player.profileId },
      create: {
        profileId: player.profileId,
        name: player.name,
        twitchChannel: player.twitchChannel,
        youtubeChannel: player.youtubeChannel,
        kickChannel: player.kickChannel,
        youtubeIsLive: player.youtubeIsLive,
        kickIsLive: player.kickIsLive,
        status: "APPROVED",
      },
      update: {
        name: player.name,
        twitchChannel: player.twitchChannel,
        youtubeChannel: player.youtubeChannel,
        kickChannel: player.kickChannel,
        youtubeIsLive: player.youtubeIsLive,
        kickIsLive: player.kickIsLive,
        status: "APPROVED",
      },
    });
  }
}

/**
 * Comprueba que las filas que se van a borrar son exactamente las del mock.
 *
 * El borrado va por `profileId`, que es un rango reservado, pero un rango por sí
 * solo no es una prueba: si algún día se colara un jugador real con uno de esos
 * ids, `mock:clean` se lo llevaría por delante sin decirlo. Por eso se compara
 * también el nombre (y los tres canales) con la lista del mock, que es su única
 * fuente de verdad. Si algo no cuadra, no se borra nada.
 */
async function assertRowsAreMock(): Promise<void> {
  const rows = await db.player.findMany({
    where: { profileId: { in: MOCK_PROFILE_IDS } },
    select: {
      profileId: true,
      name: true,
      twitchChannel: true,
      youtubeChannel: true,
      kickChannel: true,
    },
    orderBy: { profileId: "asc" },
  });

  if (rows.length === 0) {
    console.log("No hay jugadores del mock en la base de datos: no hay nada que limpiar.");
    return;
  }

  const esperadoPorId = new Map(
    MOCK_TOURNAMENT_PLAYERS.map((player) => [player.profileId, player]),
  );
  const problemas: string[] = [];

  if (rows.length !== MOCK_PROFILE_IDS.length) {
    problemas.push(
      `se esperaban ${MOCK_PROFILE_IDS.length} jugadores del mock y hay ${rows.length}`,
    );
  }

  for (const row of rows) {
    const esperado = esperadoPorId.get(row.profileId);

    if (esperado === undefined) {
      problemas.push(`${row.profileId} (${row.name}) no está en la lista del mock`);
      continue;
    }

    if (esperado.name !== row.name) {
      problemas.push(
        `${row.profileId}: el nombre "${row.name}" no es el del mock ("${esperado.name}")`,
      );
    }

    if ((esperado.twitchChannel ?? null) !== (row.twitchChannel ?? null)) {
      problemas.push(
        `${row.profileId} (${esperado.name}): el canal "${row.twitchChannel ?? "null"}" no es el del mock ("${esperado.twitchChannel ?? "null"}")`,
      );
    }

    if ((esperado.youtubeChannel ?? null) !== (row.youtubeChannel ?? null)) {
      problemas.push(
        `${row.profileId} (${esperado.name}): el canal de YouTube "${row.youtubeChannel ?? "null"}" no es el del mock ("${esperado.youtubeChannel ?? "null"}")`,
      );
    }

    if ((esperado.kickChannel ?? null) !== (row.kickChannel ?? null)) {
      problemas.push(
        `${row.profileId} (${esperado.name}): el canal de Kick "${row.kickChannel ?? "null"}" no es el del mock ("${esperado.kickChannel ?? "null"}")`,
      );
    }
  }

  if (problemas.length > 0) {
    console.error("");
    for (const problema of problemas) {
      console.error(`ERROR: ${problema}`);
    }
    console.error("No se borra nada: las filas no son las del mock.");
    throw new Error("La limpieza del torneo simulado se ha abortado.");
  }

  console.log(`Verificado: las ${rows.length} filas a borrar son los jugadores del mock.`);
  console.log(`  ${rows.map((row) => `${row.profileId} ${row.name}`).join(", ")}`);
}

async function cleanMockTournament(): Promise<void> {
  await assertRowsAreMock();

  // El borrado es en cascada (Match y PlayerScore cuelgan de Player en el
  // schema); los cursores `Setting` no, así que se borran a mano.
  const players = await db.player.deleteMany({
    where: { profileId: { in: MOCK_PROFILE_IDS } },
  });
  const cursors = await db.setting.deleteMany({
    where: { key: { in: MOCK_PROFILE_IDS.map(playerSyncKey) } },
  });

  console.log("");
  console.log("--- Limpieza del torneo simulado ---");
  console.log(
    `Jugadores borrados: ${players.count} (sus partidas y su clasificación, en cascada)`,
  );
  console.log(`Cursores de sincronización borrados: ${cursors.count}`);
}

async function runMockTournament(): Promise<void> {
  const config = getAoe4WorldConfig();

  if (!config.mock) {
    console.error("ERROR: AOE4WORLD_MOCK no está activo; este script no debe tocar la API real.");
    process.exitCode = 1;
    return;
  }

  console.log("Mock AoE4World activo: las peticiones no salen a la red.");

  await ensureMockPlayers();

  // Solo los participantes simulados: una base con otros jugadores aprobados
  // no se toca ni se les pide nada al mock. `streams: false` y `history: false` por
  // lo que dice el docblock de `ensureMockPlayers()`: la detección de YouTube y Kick
  // queda apagada y sus canales se quedan como los que ha plantado este script, y el
  // sondeo del historial no sale a la red.
  const summary = await syncApprovedPlayers({
    profileIds: MOCK_PROFILE_IDS,
    streams: false,
    history: false,
  });

  // "Partidas en directo" se cuenta por `gameId` distinto, igual que hace la
  // web: una 1v1 entre participantes genera dos filas `Match` (una por jugador)
  // y una contra un rival externo solo genera la del participante, pero cada una
  // es una sola partida.
  const liveRows = await db.match.findMany({
    where: { finishedAt: null, player: { profileId: { in: MOCK_PROFILE_IDS } } },
    select: { gameId: true, player: { select: { profileId: true } } },
  });
  const liveGameIds = new Set(liveRows.map((row) => row.gameId));
  const liveProfileIds = new Set(liveRows.map((row) => row.player.profileId));
  const rowsByLiveGame = new Map<string, number>();

  for (const row of liveRows) {
    rowsByLiveGame.set(row.gameId, (rowsByLiveGame.get(row.gameId) ?? 0) + 1);
  }

  // Un directo con una única fila es, por construcción, un cruce con un rival
  // externo (los de la liga siempre dejan dos).
  const liveAgainstExternal = [...rowsByLiveGame.values()].filter((count) => count === 1).length;

  const externalNameById = new Map(
    MOCK_EXTERNAL_PLAYERS.map((player) => [player.profileId, player.name]),
  );

  // Los externos solo pueden aparecer como rival: el participante es siempre el
  // dueño de la fila, así que la consulta va por `opponentProfileId`.
  const externalRows = await db.match.findMany({
    where: {
      opponentProfileId: { in: MOCK_EXTERNAL_PROFILE_IDS },
      player: { profileId: { in: MOCK_PROFILE_IDS } },
    },
    select: {
      finishedAt: true,
      opponentProfileId: true,
      opponentName: true,
      player: { select: { profileId: true } },
    },
  });

  const externalFinishedByPlayer = new Map<number, number>();
  let externalNamesCoherent = true;

  for (const row of externalRows) {
    if (row.finishedAt !== null) {
      const profileId = row.player.profileId;
      externalFinishedByPlayer.set(profileId, (externalFinishedByPlayer.get(profileId) ?? 0) + 1);
    }

    const expectedName =
      row.opponentProfileId === null ? undefined : externalNameById.get(row.opponentProfileId);

    if (expectedName === undefined || row.opponentName !== expectedName) {
      externalNamesCoherent = false;
    }
  }

  const externalLiveTotal = externalRows.filter((row) => row.finishedAt === null).length;
  const externalFinishedTotal = externalRows.length - externalLiveTotal;

  // `unwrapRead` para que un corte de la base no se confunda con un torneo
  // simulado que no ha sincronizado a nadie.
  const standings = unwrapRead(await getStandings(), "mock:tournament").filter((row) =>
    MOCK_PROFILE_IDS.includes(row.profileId),
  );

  console.log("");
  console.log("--- Torneo simulado (mock AoE4World) ---");
  console.log(`Jugadores sincronizados: ${summary.playersTotal}`);

  for (const player of summary.players) {
    const detail =
      player.status === "ok"
        ? [
            `${player.gamesSeen} partidas vistas`,
            `${player.matchesInserted} nuevas`,
            player.matchesUpdated > 0 ? `${player.matchesUpdated} actualizadas` : null,
            player.matchesAbandoned > 0 ? `${player.matchesAbandoned} abandonadas` : null,
          ]
            .filter((value): value is string => value !== null)
            .join(", ")
        : `${player.status.toUpperCase()} — ${player.error ?? ""}`;

    console.log(`- ${player.profileId} ${player.name}: ${detail}`);
  }

  console.log(`Partidas insertadas: ${summary.newMatches}`);
  console.log(
    `Partidas en directo detectadas: ${liveGameIds.size} (${liveRows.length} filas del torneo: 2 por cruce entre participantes, 1 por cruce con externo)`,
  );
  console.log(
    `Partidas contra rivales externos: ${externalFinishedTotal} terminadas y ${externalLiveTotal} en directo`,
  );
  console.log(`Peticiones al mock: ${summary.apiRequests}`);
  console.log(
    `Ladder: ${summary.ladder.batches} llamada(s) a /leaderboards, ` +
      `${summary.ladder.playersUpdated} jugador(es) actualizados, ` +
      `${summary.ladder.playersMissing} ausentes de la respuesta` +
      (summary.ladder.error === null ? "" : ` — ERROR: ${summary.ladder.error}`),
  );
  console.log("");
  console.log("Clasificación:");

  for (const row of standings) {
    const flags = [
      row.isPlaying ? "jugando" : null,
      row.twitchIsLive ? "en directo en Twitch" : null,
      row.youtubeIsLive ? "en directo en YouTube" : null,
      row.kickIsLive ? "en directo en Kick" : null,
    ]
      .filter((value): value is string => value !== null)
      .join(", ");

    const canales = [
      row.twitchChannel === null ? null : `twitch:${row.twitchChannel}`,
      row.youtubeChannel === null ? null : `youtube:${row.youtubeChannel}`,
      row.kickChannel === null ? null : `kick:${row.kickChannel}`,
    ]
      .filter((value): value is string => value !== null)
      .join(" ");

    console.log(
      `  ${row.rank}. ${row.name} — ${row.points} ${row.points === 1 ? "punto" : "puntos"} ` +
        `(${row.wins}V/${row.losses}D) | elo ${row.elo ?? "s/l"} ` +
        `| ${row.division ?? "sin división"} (${row.rankLevel ?? "-"}) ` +
        `| racha ${row.streak ?? "n/a"} | ${flags === "" ? "sin indicadores" : flags} ` +
        `| ${canales === "" ? "sin canales" : canales}`,
    );
  }

  const problems: string[] = [];

  if (summary.playersFailed > 0) {
    problems.push(`${summary.playersFailed} jugadores con error (ver detalle de arriba)`);
  }

  if (summary.scoringError !== null) {
    problems.push(`la clasificación no se ha recalculado: ${summary.scoringError}`);
  }

  if (liveGameIds.size !== 3) {
    problems.push(`se esperaban 3 partidas en directo y hay ${liveGameIds.size}`);
  }

  if (liveAgainstExternal < 1) {
    problems.push("ninguna de las 3 partidas en directo es contra un rival externo");
  }

  const participantsWithoutExternal = MOCK_PROFILE_IDS.filter(
    (profileId) => (externalFinishedByPlayer.get(profileId) ?? 0) < 2,
  );

  if (participantsWithoutExternal.length > 0) {
    problems.push(
      `participantes con menos de dos partidas terminadas contra rivales externos: ${participantsWithoutExternal.join(", ")}`,
    );
  }

  if (!externalNamesCoherent) {
    problems.push("hay un rival externo cuyo `opponentName` no coincide con la lista de externos");
  }

  if (standings.length !== MOCK_TOURNAMENT_PLAYERS.length) {
    problems.push(
      `la clasificación tiene ${standings.length} jugadores y se esperaban ${MOCK_TOURNAMENT_PLAYERS.length}`,
    );
  }

  // La clasificación de la v2 se compone de dos sumas que tienen que cuadrar:
  // las victorias por `pointsPerWin` y los puntos de los objetivos ganados.
  const scores = await db.playerScore.findMany({
    where: { ruleSetVersion: RULESET_VERSION, player: { profileId: { in: MOCK_PROFILE_IDS } } },
    select: {
      total: true,
      wins: true,
      breakdown: true,
      player: { select: { profileId: true } },
    },
  });

  const conObjetivos = scores.filter((score) => {
    const breakdown = score.breakdown as { objectives?: { points?: number } } | null;
    return (breakdown?.objectives?.points ?? 0) > 0;
  });

  const desglosesIncoherentes = scores.filter((score) => {
    const breakdown = score.breakdown as {
      byMode?: Record<string, { points?: number }>;
      objectives?: { points?: number; earned?: string[] };
    } | null;

    const objectives = breakdown?.objectives ?? { points: 0, earned: [] };
    const objectivesPoints = objectives.points ?? 0;
    const earned = objectives.earned ?? [];
    const sumados = earned.reduce(
      (sum, id) => sum + (OBJECTIVE_POINTS[id] ?? -1),
      0,
    );
    const porModos = Object.values(breakdown?.byMode ?? {}).reduce(
      (sum, mode) => sum + (mode.points ?? 0),
      0,
    );

    return (
      sumados !== objectivesPoints ||
      porModos !== score.total - objectivesPoints ||
      score.total !== score.wins * DEFAULT_RULESET.pointsPerWin + objectivesPoints
    );
  });

  if (desglosesIncoherentes.length > 0) {
    problems.push(
      `desgloses de puntuación que no cuadran: ${desglosesIncoherentes
        .map((score) => score.player.profileId)
        .join(", ")}`,
    );
  }

  if (scores.length === MOCK_PROFILE_IDS.length && conObjetivos.length === 0) {
    problems.push("ningún participante suma puntos de objetivos en la v2");
  }

  if (standings.length > 0) {
    const totales = standings.map((row) => row.points);

    if (totales.some((total, index) => index > 0 && total > totales[index - 1])) {
      problems.push("los totales de la clasificación no salen en orden descendente");
    }

    const distintos = new Set(totales).size;

    if (distintos < 3) {
      problems.push(`se esperaban al menos 3 totales distintos y hay ${distintos}`);
    }
  }

  // Comprobaciones de la ladder (elo, división, racha, Twitch y partido en curso).
  if (summary.ladder.error !== null) {
    problems.push(`la instantánea de la ladder ha fallado: ${summary.ladder.error}`);
  }

  const sinElo = standings.filter((row) => row.elo === null).map((row) => row.profileId);

  if (sinElo.length > 0) {
    problems.push(`participantes sin elo después del sync: ${sinElo.join(", ")}`);
  }

  const divisiones = new Set(standings.map((row) => row.division));

  if (divisiones.size !== DIVISIONS.length) {
    problems.push(
      `las fixtures deben cubrir las ${DIVISIONS.length} divisiones y la clasificación tiene ${divisiones.size}`,
    );
  }

  const hayPositiva = standings.some((row) => (row.streak ?? 0) > 0);
  const hayNegativa = standings.some((row) => (row.streak ?? 0) < 0);
  const hayNula = standings.some((row) => row.streak === null);

  if (!hayPositiva || !hayNegativa || !hayNula) {
    problems.push("las rachas deben incluir valores positivos, negativos y null");
  }

  if (!standings.some((row) => row.twitchIsLive)) {
    problems.push("ningún participante sale como en directo en Twitch");
  }

  // Los canales de las dos plataformas nuevas, y su estado de directo. Se comprueba
  // contra lo publicado por el DAL, no contra la lista del mock: lo que importa es
  // que lo que el script plantó llega entero a la clasificación, con el handle
  // canónico y con el icono de directo donde toca.
  for (const plataforma of ["youtube", "kick"] as const) {
    const conCanal = standings.filter((row) => row[`${plataforma}Channel`] !== null);

    if (conCanal.length === 0) {
      problems.push(`ningún participante tiene canal de ${plataforma}`);
    }

    if (!standings.some((row) => row[`${plataforma}IsLive`])) {
      problems.push(`ningún participante sale como en directo en ${plataforma}`);
    }

    const desajustados = conCanal.filter(
      (row) => row[`${plataforma}Channel`] !== MOCK_TOURNAMENT_PLAYERS.find(
        (player) => player.profileId === row.profileId,
      )?.[`${plataforma}Channel`],
    );

    if (desajustados.length > 0) {
      problems.push(
        `el canal de ${plataforma} no llega a la clasificación como lo plantó el mock: ${desajustados
          .map((row) => row.profileId)
          .join(", ")}`,
      );
    }
  }

  if (!standings.some((row) => row.avatarUrl !== null)) {
    problems.push("ningún participante tiene avatar");
  }

  const desajusteJugando = standings
    .filter((row) => row.isPlaying !== liveProfileIds.has(row.profileId))
    .map((row) => row.profileId);

  if (desajusteJugando.length > 0) {
    problems.push(
      `isPlaying no coincide con las partidas en vivo: ${desajusteJugando.join(", ")}`,
    );
  }

  // Respaldo del canal: sin `twitchChannel` registrado, la tabla enlaza el que
  // AoE4World publica en el perfil.
  const conRespaldo = MOCK_TOURNAMENT_PLAYERS.find(
    (player) => player.twitchChannel === null && player.twitchUrl !== null,
  );

  if (conRespaldo !== undefined && conRespaldo.twitchUrl !== null) {
    const esperado = new URL(conRespaldo.twitchUrl).pathname.replace(/^\/+/, "").toLowerCase();
    const fila = standings.find((row) => row.profileId === conRespaldo.profileId);

    if (fila !== undefined && fila.twitchChannel !== esperado) {
      problems.push(
        `el respaldo de twitchUrl no funciona: ${fila.twitchChannel ?? "null"} en vez de ${esperado}`,
      );
    }
  }

  if (problems.length > 0) {
    console.error("");

    for (const problem of problems) {
      console.error(`ERROR: ${problem}`);
    }

    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  if (process.argv.slice(2).includes("--clean")) {
    await cleanMockTournament();
    return;
  }

  await runMockTournament();
}

void main();
