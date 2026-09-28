import "server-only";

import { db } from "@/lib/db";
import type { DivisionId } from "@/lib/divisions";
import { isRecord } from "@/lib/json";
import { normalizeTwitchChannel } from "@/lib/twitch";
import { playerSyncKey, writePlayerSyncState } from "@/lib/settings";

/**
 * Manifiesto de los jugadores que la simulación ha dado de alta, y todo lo que
 * hace falta para **deshacerla**.
 *
 * La simulación usa jugadores reales de AoE4World, así que no hay un rango de
 * `profileId` reservado que marque las filas como en el mock: la única forma de
 * saber qué filas son nuestras es tener **su lista escrita**, con la identidad que
 * se usó al crearlas. Eso es lo que guarda `Setting["simulation.roster"]`.
 *
 * Sin ese manifiesto, `simulate:clean` no puede borrar nada con seguridad, y esa
 * es exactamente la situación en la que está la base de datos de producción: en un
 * mes, lo que haya en `Player` serán participantes de verdad.
 */

/** Clave del manifiesto en `Setting`. */
export const SIMULATION_ROSTER_KEY = "simulation.roster";

/**
 * Versión del formato del manifiesto. Si algún día cambia la forma, subirla hace
 * que `readSimulationRoster` rechace lo viejo en vez de interpretarlo a medias.
 */
export const SIMULATION_ROSTER_VERSION = 1;

/**
 * Margen que se le resta al inicio de la ventana del torneo para sembrar el
 * cursor. Es el mismo solape que aplica el worker (`SYNC_OVERLAP_MINUTES`): sin
 * él, una partida empezada un minuto antes del arranque se quedaría fuera y no
 * volvería a pedirse nunca, porque el cursor solo avanza.
 */
export const SIMULATION_CURSOR_LEAD_MINUTES = 60;

/** Un jugador dado de alta por la simulación. */
export type SimulationRosterEntry = {
  profileId: number;
  /** Nombre con el que se creó la fila: es lo que se compara antes de borrar. */
  name: string;
  division: DivisionId;
  rankLevel: string | null;
  rating: number | null;
  ladderRank: number | null;
  twitchChannel: string | null;
  /** Partidas de ladder que tenía en la ventana de selección, acotadas al objetivo. */
  recentRankedGames: number;
  selectedAt: string;
  /**
   * `true` si es el elegido vigente de su división.
   *
   * Los que quedaron en `false` son los que eligieron una ejecución anterior y
   * esta ya no: **no se borran de aquí** (siguen en la base de datos hasta que se
   * limpie), pero se conservan para que la limpieza pueda verificarlos también y
   * no deje jugadores de la simulación colgando.
   */
  current: boolean;
};

/** La simulación completa, tal y como se puede deshacer. */
export type SimulationRoster = {
  version: number;
  /** Cuándo se escribió por última vez. */
  updatedAt: string;
  leaderboard: string;
  minRecentRankedGames: number;
  recentWindowDays: number;
  /** Inicio de la ventana del torneo (hace 3 semanas en el lanzamiento). */
  tournamentStart: string;
  /** Fin previsto del torneo (dentro de 1 semana en el lanzamiento). */
  tournamentEnd: string;
  entries: SimulationRosterEntry[];
};

function readEntries(value: unknown): SimulationRosterEntry[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const entries: SimulationRosterEntry[] = [];

  for (const item of value) {
    if (
      !isRecord(item) ||
      typeof item.profileId !== "number" ||
      !Number.isInteger(item.profileId) ||
      item.profileId <= 0 ||
      typeof item.name !== "string" ||
      item.name.trim() === ""
    ) {
      return null;
    }

    entries.push(item as unknown as SimulationRosterEntry);
  }

  return entries;
}

/**
 * Lee el manifiesto, o `null` si no hay ninguno o no se puede entender.
 *
 * Un manifiesto corrupto devuelve `null` a propósito: quien llama tiene que
 * distinguir "no se ha simulado nunca" de "hay algo escrito que no entiendo", y
 * en los dos casos lo seguro es no borrar.
 */
export async function readSimulationRoster(): Promise<SimulationRoster | null> {
  const setting = await db.setting.findUnique({ where: { key: SIMULATION_ROSTER_KEY } });

  if (setting === null) {
    return null;
  }

  const value: unknown = setting.value;

  if (
    !isRecord(value) ||
    value.version !== SIMULATION_ROSTER_VERSION ||
    typeof value.tournamentStart !== "string" ||
    typeof value.tournamentEnd !== "string"
  ) {
    console.warn(
      `[simulación] La clave "${SIMULATION_ROSTER_KEY}" existe pero no tiene la versión ` +
        `${SIMULATION_ROSTER_VERSION}; se trata como si no hubiera manifiesto.`,
    );
    return null;
  }

  const entries = readEntries(value.entries);

  if (entries === null) {
    console.warn(
      `[simulación] La clave "${SIMULATION_ROSTER_KEY}" tiene una lista de jugadores ilegible; ` +
        "se trata como si no hubiera manifiesto.",
    );
    return null;
  }

  return value as unknown as SimulationRoster;
}

export async function writeSimulationRoster(roster: SimulationRoster): Promise<void> {
  await db.setting.upsert({
    where: { key: SIMULATION_ROSTER_KEY },
    create: { key: SIMULATION_ROSTER_KEY, value: roster },
    update: { value: roster },
  });
}

/**
 * Prepara el manifiesto de una ejecución: los jugadores anteriores dejan de ser
 * los vigentes y los nuevos entran como tales.
 *
 * Si un jugador ya estaba en el manifiesto se conserva su `selectedAt`: la fecha
 * que importa para auditar es la de la **primera** vez que la simulación lo dio
 * de alta, no la de la última ejecución.
 */
export function mergeRosterEntries(
  previous: SimulationRoster | null,
  picks: readonly {
    profileId: number;
    name: string;
    division: DivisionId;
    rankLevel: string | null;
    rating: number | null;
    ladderRank: number | null;
    twitchChannel: string | null;
    recentRankedGames: number;
  }[],
  selectedAt: string,
): SimulationRosterEntry[] {
  const previousByProfileId = new Map(
    (previous?.entries ?? []).map((entry) => [entry.profileId, entry]),
  );
  const retired = (previous?.entries ?? []).map((entry) => ({ ...entry, current: false }));

  const current: SimulationRosterEntry[] = picks.map((pick) => ({
    profileId: pick.profileId,
    name: pick.name,
    division: pick.division,
    rankLevel: pick.rankLevel,
    rating: pick.rating,
    ladderRank: pick.ladderRank,
    twitchChannel: pick.twitchChannel,
    recentRankedGames: pick.recentRankedGames,
    selectedAt: previousByProfileId.get(pick.profileId)?.selectedAt ?? selectedAt,
    current: true,
  }));

  const currentProfileIds = new Set(current.map((entry) => entry.profileId));

  return [
    ...current,
    ...retired.filter((entry) => !currentProfileIds.has(entry.profileId)),
  ];
}

export type UpsertPlayersResult = {
  created: number;
  updated: number;
};

/**
 * Da de alta a los jugadores como `APPROVED`.
 *
 * `APPROVED` y no `PENDING` porque `getStandings` y `getLiveMatches` filtran por
 * estado y el objetivo de la simulación es que la web muestre un torneo, no una
 * cola de revisión.
 *
 * Elo, división, racha y avatar **no** se rellenan aquí: los deja
 * `syncLadderSnapshot`, que es quien ya lo hace bien para todos los jugadores
 * aprobados, y repetirlo aquí sería una segunda copia de esa lógica.
 */
export async function upsertSimulationPlayers(
  entries: readonly SimulationRosterEntry[],
): Promise<UpsertPlayersResult> {
  const result: UpsertPlayersResult = { created: 0, updated: 0 };

  for (const entry of entries) {
    if (entry.current === false) {
      continue;
    }

    const twitchChannel = normalizeTwitchChannel(entry.twitchChannel);
    const existing = await db.player.findUnique({
      where: { profileId: entry.profileId },
      select: { id: true },
    });

    await db.player.upsert({
      where: { profileId: entry.profileId },
      create: {
        profileId: entry.profileId,
        name: entry.name,
        twitchChannel,
        status: "APPROVED",
      },
      update: {
        name: entry.name,
        twitchChannel,
        status: "APPROVED",
      },
    });

    if (existing === null) {
      result.created += 1;
    } else {
      result.updated += 1;
    }
  }

  return result;
}

/**
 * Siembra el cursor de sincronización de cada jugador en el inicio del torneo.
 *
 * ## Por qué hay que sembrarlo
 *
 * El worker guarda por jugador hasta qué fecha le ha pedido partidas a la API, y
 * con el cursor a `null` recorre **el histórico entero**: hasta
 * `AOE4WORLD_SYNC_MAX_PAGES` (10) × 50 partidas por jugador y pasada, y las
 * vuelve a pedir en cada ejecución posterior porque el cursor queda detrás de la
 * fecha de la última partida que vio. Para seis jugadores de ladder real eso son
 * miles de partidas por encima de la ventana del torneo, y ninguna suma puntos:
 * el torneo empieza dentro de tres semanas.
 *
 * Sembrando el cursor en el arranque del torneo el backfill pide exactamente por
 * la ventana del torneo, y a partir de ahí el cursor avanza solo con el ritmo
 * normal del worker, así que la simulación **sigue creciendo** con cada pasada
 * real del cron.
 *
 * ## Por qué nunca retrocede
 *
 * Si ya hay un cursor y es más reciente que el arranque, se deja como está:
 * repetir el script no puede hacer perder partidas ya importadas. Solo se adelanta
 * cuando el cursor guardado es anterior a la ventana del torneo, que es el caso
 * del primer lanzamiento.
 */
export async function seedSyncCursors(
  entries: readonly SimulationRosterEntry[],
  tournamentStart: Date,
  nowIso: string,
): Promise<{ seeded: number; kept: number }> {
  const since = new Date(
    tournamentStart.getTime() - SIMULATION_CURSOR_LEAD_MINUTES * 60_000,
  );
  const result = { seeded: 0, kept: 0 };

  for (const entry of entries) {
    if (entry.current === false) {
      continue;
    }

    const setting = await db.setting.findUnique({
      where: { key: playerSyncKey(entry.profileId) },
      select: { value: true },
    });

    if (setting !== null && isRecord(setting.value) && typeof setting.value.since === "string") {
      const stored = new Date(setting.value.since);

      if (!Number.isNaN(stored.getTime()) && stored >= since) {
        result.kept += 1;
        continue;
      }
    }

    await writePlayerSyncState(entry.profileId, {
      since: since.toISOString(),
      maxStartedAt: since.toISOString(),
      lastSyncedAt: nowIso,
      historyTruncated: false,
      abandonedCount: 0,
      abandonedGameIds: [],
      lastAbandonedAt: null,
    });

    result.seeded += 1;
  }

  return result;
}

export type RosterInspection = {
  /** Filas de `Player` que hay con los `profileId` del manifiesto. */
  rows: { profileId: number; name: string; twitchChannel: string | null }[];
  /** Algo no cuadra: no se debe borrar nada. */
  problems: string[];
  /** Algo raro pero no bloqueante: se informa y se sigue. */
  warnings: string[];
};

/**
 * Comprueba que las filas que se van a borrar son exactamente las que escribió la
 * simulación.
 *
 * El `profileId` viene del manifiesto, así que el borrado nunca va a ciegas ni
 * por rango de ids; pero un manifiesto no es prueba suficiente por sí solo: si
 * alguien ha editado el nombre de un jugador en el panel de admin, ese jugador ya
 * no es el que dio de alta la simulación y hay que decirlo en vez de borrarlo.
 *
 * La comparación de la división es **aviso** y no error: la ladder se mueve sola
 * (los jugadores suben y bajan de rango), así que que uno haya cambiado de
 * división es lo normal y no significa que la fila sea de otro.
 */
export async function inspectSimulationRoster(
  roster: SimulationRoster,
): Promise<RosterInspection> {
  const profileIds = roster.entries.map((entry) => entry.profileId);
  const rows = await db.player.findMany({
    where: { profileId: { in: profileIds } },
    select: { profileId: true, name: true, twitchChannel: true },
    orderBy: { profileId: "asc" },
  });
  const problems: string[] = [];
  const warnings: string[] = [];
  const expectedByProfileId = new Map(
    roster.entries.map((entry) => [entry.profileId, entry]),
  );

  if (rows.length !== profileIds.length) {
    problems.push(
      `el manifiesto tiene ${profileIds.length} jugadores y en la base de datos hay ${rows.length}`,
    );
  }

  for (const row of rows) {
    const expected = expectedByProfileId.get(row.profileId);

    if (expected === undefined) {
      problems.push(`${row.profileId} (${row.name}) no aparece en el manifiesto`);
      continue;
    }

    if (expected.name !== row.name) {
      problems.push(
        `${row.profileId}: el nombre "${row.name}" no es el que escribió la simulación ("${expected.name}")`,
      );
    }
  }

  for (const entry of roster.entries) {
    if (entry.current === false) {
      warnings.push(
        `${entry.profileId} (${entry.name}) quedó como elegido de una ejecución anterior; ` +
          "está en el manifiesto y se borrará con la limpieza",
      );
    }
  }

  const fueraDeVentana = await db.match.aggregate({
    where: {
      player: { profileId: { in: profileIds } },
      OR: [
        { startedAt: { lt: new Date(roster.tournamentStart) } },
        { startedAt: { gt: new Date(roster.tournamentEnd) } },
      ],
    },
    _count: true,
  });

  if (fueraDeVentana._count > 0) {
    warnings.push(
      `${fueraDeVentana._count} partida(s) de estos jugadores caen fuera de la ventana del torneo ` +
        `(${roster.tournamentStart} — ${roster.tournamentEnd}); el borrado en cascada se las lleva por delante`,
    );
  }

  return { rows, problems, warnings };
}

export type CleanResult = {
  /**
   * `false` si no había manifiesto o si la verificación abortó: en ese caso no
   * se ha borrado nada y quien llama tiene que decirlo.
   */
  executed: boolean;
  dryRun: boolean;
  playersDeleted: number;
  cursorsDeleted: number;
};

/**
 * Retira **solo** los jugadores de la simulación.
 *
 * Va por los `profileId` del manifiesto, y solo después de comprobar que las
 * filas son las que se escribieron (mismo nombre). Las partidas y las
 * puntuaciones se van en cascada por el schema; los cursores `Setting` no cuelgan
 * de nadie, así que se borran aparte, igual que el propio manifiesto.
 *
 * `dryRun` hace la verificación entera y no borra nada: es la forma de ver qué
 * se llevaría por delante antes de hacerlo, que en una base de datos que es la de
 * producción no es un detalle.
 */
export async function cleanSimulationRoster(
  options: { dryRun?: boolean } = {},
): Promise<CleanResult> {
  const dryRun = options.dryRun ?? false;
  const roster = await readSimulationRoster();

  if (roster === null) {
    return { executed: false, dryRun, playersDeleted: 0, cursorsDeleted: 0 };
  }

  const profileIds = roster.entries.map((entry) => entry.profileId);
  const inspection = await inspectSimulationRoster(roster);

  for (const warning of inspection.warnings) {
    console.warn(`  AVISO: ${warning}`);
  }

  if (inspection.problems.length > 0) {
    for (const problem of inspection.problems) {
      console.error(`  ERROR: ${problem}`);
    }

    throw new Error(
      "La limpieza se ha abortado: las filas de la base de datos no son las de la simulación.",
    );
  }

  if (dryRun) {
    return {
      executed: false,
      dryRun: true,
      playersDeleted: 0,
      cursorsDeleted: 0,
    };
  }

  const players = await db.player.deleteMany({ where: { profileId: { in: profileIds } } });
  const cursors = await db.setting.deleteMany({
    where: { key: { in: [...profileIds.map(playerSyncKey), SIMULATION_ROSTER_KEY] } },
  });

  return {
    executed: true,
    dryRun: false,
    playersDeleted: players.count,
    cursorsDeleted: cursors.count,
  };
}
