import "server-only";

import { Prisma } from "@/generated/prisma/client";
import { MatchResult } from "@/generated/prisma/enums";
import {
  ADMIN_ACT_KIND_LABELS,
  adminActState,
  type AdminActDetail,
  type AdminActKind,
  type AdminActMatchCandidate,
  type AdminActPlayer,
  type AdminActRow,
  type AdminActTargetCandidate,
} from "@/lib/admin-acts";
import {
  type AdminPage,
  type AdminQueryParam,
  readPlayerIdFilter,
} from "@/lib/admin";
import { countsWithoutRevertMark, type MatchForScoring } from "@/lib/admin-revert";
import { readDivisionCutoffs } from "@/lib/alerts/settings";
import { civilizationName } from "@/lib/civs";
import { db } from "@/lib/db";
import { readFromDatabase, type PublicRead } from "@/lib/db-errors";
import { describeMode, describeTeamSize, teamSizesFromRawJson } from "@/lib/format";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  paginate,
  readBoundedInt,
  readSingleParam,
} from "@/lib/query-params";
import { rankedMatchWhere } from "@/lib/ranked-match";
import { readRuleset } from "@/lib/scoring";

/**
 * Lecturas del listado y del detalle de actuaciones administrativas.
 *
 * Sigue el mismo contrato que `src/lib/admin.ts`: `PublicRead<T>`, `select` cerrado,
 * paginación en servidor y filtros que se validan antes de tocar la base. La
 * información privada **solo** se selecciona en `getAdminAct()`; el listado no la
 * lleva ni deja de llevar, porque no la pide.
 *
 * Las etiquetas de civilización y de formato se resuelven aquí y no en la interfaz:
 * `rawJson` y el catálogo de civs no tienen por qué salir del servidor, y dos
 * pantallas no deberían poder pintar la misma partida de dos maneras.
 */

/** Columnas de `AdminAct` que lleva una fila del listado (sin `privateInfo`). */
const ADMIN_ACT_ROW_SELECT = {
  id: true,
  kind: true,
  summary: true,
  playerId: true,
  playerName: true,
  profileId: true,
  publicReason: true,
  matchCount: true,
  actorEmail: true,
  createdAt: true,
  revertedAt: true,
  reversedByActId: true,
} satisfies Prisma.AdminActSelect;

/** Columnas de `AdminAct` que lleva una actuación objetivo de reversión. */
const ADMIN_ACT_TARGET_SELECT = {
  id: true,
  kind: true,
  summary: true,
  publicReason: true,
  matchCount: true,
  createdAt: true,
  actorEmail: true,
} satisfies Prisma.AdminActSelect;

/** Datos de una partida vinculada a una actuación. */
const ADMIN_ACT_MATCH_SELECT = {
  id: true,
  gameId: true,
  startedAt: true,
  finishedAt: true,
  civ: true,
  opponentName: true,
  mode: true,
  map: true,
  leaderboard: true,
  points: true,
  result: true,
  rawJson: true,
} satisfies Prisma.MatchSelect;

type AdminActRowRecord = Prisma.AdminActGetPayload<{ select: typeof ADMIN_ACT_ROW_SELECT }>;
type AdminActTargetRecord = Prisma.AdminActGetPayload<{ select: typeof ADMIN_ACT_TARGET_SELECT }>;
type AdminActMatchRecord = Prisma.MatchGetPayload<{ select: typeof ADMIN_ACT_MATCH_SELECT }>;

/** El `kind` de Prisma es asignable a la unión local; el `as` deja constancia. */
function toKind(kind: AdminActRowRecord["kind"]): AdminActKind {
  return kind;
}

function toRow(act: AdminActRowRecord): AdminActRow {
  return {
    id: act.id,
    kind: toKind(act.kind),
    kindLabel: ADMIN_ACT_KIND_LABELS[act.kind],
    summary: act.summary,
    playerId: act.playerId,
    playerName: act.playerName,
    profileId: act.profileId,
    publicReason: act.publicReason,
    matchCount: act.matchCount,
    actorEmail: act.actorEmail,
    createdAt: act.createdAt.toISOString(),
    revertedAt: act.revertedAt === null ? null : act.revertedAt.toISOString(),
    reversedByActId: act.reversedByActId,
    state: adminActState(act.kind, act.revertedAt),
  };
}

function toTarget(act: AdminActTargetRecord): AdminActTargetCandidate {
  return {
    id: act.id,
    kind: toKind(act.kind),
    kindLabel: ADMIN_ACT_KIND_LABELS[act.kind],
    summary: act.summary,
    publicReason: act.publicReason,
    matchCount: act.matchCount,
    createdAt: act.createdAt.toISOString(),
    actorEmail: act.actorEmail,
  };
}

/**
 * Una partida, con el formato y la civilización ya resueltos.
 *
 * Los puntos son los que la partida aportaría **con el ruleset activo**, no
 * `Match.points` (que el recálculo deja a cero en una partida anulada): es lo que se
 * recupera si se revierte la actuación, y lo que la persona viene a comparar al
 * elegir qué anular.
 */
function toMatchCandidate(match: AdminActMatchRecord, pointsPerWin: number): AdminActMatchCandidate {
  return {
    id: match.id,
    gameId: match.gameId,
    startedAt: match.startedAt.toISOString(),
    civ: match.civ,
    civLabel: match.civ === null ? null : civilizationName(match.civ),
    opponentName: match.opponentName,
    mode: match.mode,
    modeLabel: describeTeamSize(teamSizesFromRawJson(match.rawJson)) ??
      describeMode(match.mode, match.leaderboard),
    map: match.map,
    points: match.result === MatchResult.WIN ? pointsPerWin : match.points,
  };
}

/* -------------------------------------------------------------------------- */
/* Listado                                                                     */
/* -------------------------------------------------------------------------- */

/** Filtros del listado, tal como llegan de la URL. */
export type AdminActsQuery = {
  page?: AdminQueryParam;
  pageSize?: AdminQueryParam;
  kind?: AdminQueryParam;
  playerId?: AdminQueryParam;
  state?: AdminQueryParam;
};

/** El estado por el que se filtra el listado. */
export type AdminActsStateFilter = "active" | "reverted" | "final" | "all";

/** Orden del listado: siempre por fecha, lo más reciente primero. */
export type AdminActsSort = { key: "fecha"; dir: "desc" };

const ADMIN_ACTS_SORT: AdminActsSort = { key: "fecha", dir: "desc" };

/**
 * El filtro de estado de la URL.
 *
 * Un valor que no se entiende es **ausencia**: se listan todas, como en el resto de
 * filtros del panel, en vez de dejar la tabla vacía y hacer creer que no hay
 * actuaciones.
 */
function readStateFilter(value: AdminQueryParam): AdminActsStateFilter {
  const raw = readSingleParam(value);

  return raw === "active" || raw === "reverted" || raw === "final" ? raw : "all";
}

/** El filtro de tipo de la URL, validado contra los tres tipos. */
function readKindFilter(value: AdminQueryParam): AdminActKind | null {
  const raw = readSingleParam(value);

  return raw === "BAN" || raw === "MATCH_ANNULMENT" || raw === "REVERSAL" ? raw : null;
}

/** El `where` que corresponde al estado: vigente, revertida o final. */
function stateWhere(state: AdminActsStateFilter): Prisma.AdminActWhereInput {
  switch (state) {
    case "active":
      return { revertedAt: null, kind: { not: "REVERSAL" } };
    case "reverted":
      return { revertedAt: { not: null } };
    case "final":
      return { kind: "REVERSAL" };
    case "all":
      return {};
  }
}

/**
 * Lista las actuaciones, de la más reciente a la más antigua, con filtros por tipo,
 * jugador y estado.
 *
 * Pagina en servidor: la tabla puede crecer con cada expediente y no se manda entera
 * al navegador. **No selecciona `privateInfo`**: la información privada solo se lee
 * en el detalle, que es una pantalla por actuación.
 */
export async function getAdminActs(
  query: AdminActsQuery = {},
): Promise<PublicRead<AdminPage<AdminActRow, AdminActsSort>>> {
  const page = readBoundedInt(query.page, { min: 1, max: 100_000, fallback: 1 });
  const pageSize = readBoundedInt(query.pageSize, {
    min: 1,
    max: MAX_PAGE_SIZE,
    fallback: DEFAULT_PAGE_SIZE,
  });
  const kind = readKindFilter(query.kind);
  const playerId = readPlayerIdFilter(query.playerId);
  const state = readStateFilter(query.state);

  const where: Prisma.AdminActWhereInput = {
    ...stateWhere(state),
    ...(kind === null ? {} : { kind }),
    ...(playerId === null ? {} : { playerId }),
  };

  return readFromDatabase("admin/getAdminActs", async () => {
    const paged = await paginate(
      async (wanted) => {
        const skip = (wanted - 1) * pageSize;
        const [rows, total] = await Promise.all([
          db.adminAct.findMany({
            where,
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            skip,
            take: pageSize,
            select: ADMIN_ACT_ROW_SELECT,
          }),
          db.adminAct.count({ where }),
        ]);

        return { rows: rows.map(toRow), total };
      },
      { page, pageSize },
    );

    return { ...paged, sort: ADMIN_ACTS_SORT };
  });
}

/* -------------------------------------------------------------------------- */
/* Detalle                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * El detalle de una actuación, **con** la información privada.
 *
 * `data === null` significa que la actuación no existe; `status === "degraded"` que la
 * base no ha respondido. Son dos cosas distintas y la pantalla tiene que poder
 * separarlas.
 *
 * En una reversión, `matches` es la unión de las partidas de las actuaciones
 * revertidas (sin repetir) y `targets` son esas actuaciones. En los otros tipos,
 * `targets` está vacío y `matches` son las anuladas por la propia actuación.
 */
export async function getAdminAct(id: string): Promise<PublicRead<AdminActDetail | null>> {
  return readFromDatabase("admin/getAdminAct", async () => {
    const act = await db.adminAct.findUnique({
      where: { id },
      select: {
        ...ADMIN_ACT_ROW_SELECT,
        privateInfo: true,
        statusBefore: true,
        player: { select: { status: true } },
        reversedByAct: { select: { id: true, actorEmail: true, createdAt: true } },
        matches: { select: { match: { select: ADMIN_ACT_MATCH_SELECT } } },
        reverses: {
          select: {
            ...ADMIN_ACT_TARGET_SELECT,
            matches: { select: { match: { select: ADMIN_ACT_MATCH_SELECT } } },
          },
        },
      },
    });

    if (act === null) {
      return null;
    }

    const ruleset = await readRuleset();
    const seen = new Set<string>();
    const matches: AdminActMatchCandidate[] = [];

    if (act.kind === "REVERSAL") {
      for (const target of act.reverses) {
        for (const link of target.matches) {
          if (seen.has(link.match.id)) {
            continue;
          }

          seen.add(link.match.id);
          matches.push(toMatchCandidate(link.match, ruleset.pointsPerWin));
        }
      }
    } else {
      for (const link of act.matches) {
        matches.push(toMatchCandidate(link.match, ruleset.pointsPerWin));
      }
    }

    return {
      ...toRow(act),
      privateInfo: act.privateInfo,
      statusBefore: act.statusBefore,
      playerStatus: act.player?.status ?? null,
      reversedBy:
        act.reversedByAct === null
          ? null
          : {
              actId: act.reversedByAct.id,
              actorEmail: act.reversedByAct.actorEmail,
              createdAt: act.reversedByAct.createdAt.toISOString(),
            },
      matches,
      targets: act.reverses.map(toTarget),
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Candidatos                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Jugadores con actuaciones vigentes, para el desplegable de reversión.
 *
 * Incluye a los `BANNED` a propósito: es justo el estado del que se sale revirtiendo
 * la expulsión. El estado viaja en la fila para que la interfaz pueda explicar qué se
 * va a deshacer sin pedir el detalle de cada actuación.
 */
export async function getAdminActPlayers(): Promise<PublicRead<AdminActPlayer[]>> {
  return readFromDatabase("admin/getAdminActPlayers", async () => {
    const players = await db.player.findMany({
      where: {
        adminActs: { some: { revertedAt: null, kind: { not: "REVERSAL" } } },
      },
      orderBy: [{ name: "asc" }, { profileId: "asc" }],
      select: {
        id: true,
        name: true,
        status: true,
        adminActs: {
          where: { revertedAt: null, kind: { not: "REVERSAL" } },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          select: ADMIN_ACT_TARGET_SELECT,
        },
      },
    });

    return players.map((player) => ({
      id: player.id,
      name: player.name,
      status: player.status,
      activeActs: player.adminActs.map(toTarget),
    }));
  });
}

/**
 * Las victorias del jugador que hoy se pueden anular.
 *
 * No basta con `result = WIN`: la partida tiene que **contar hoy** con el ruleset
 * activo, que es la misma guarda que aplica el servicio antes de escribir. Se usa
 * `rankedMatchWhere()` para el corte de ventana y el estado resuelto, y
 * `countsWithoutRevertMark()` para la condición de equipos, que un `where` de Prisma
 * no puede escribir. Así la lista no ofrece partidas que el servicio rechazaría.
 */
export async function getAdminActMatchCandidates(
  playerId: string,
): Promise<PublicRead<AdminActMatchCandidate[]>> {
  return readFromDatabase("admin/getAdminActMatchCandidates", async () => {
    const player = await db.player.findUnique({
      where: { id: playerId },
      select: { id: true, profileId: true, registeredAt: true },
    });

    if (player === null) {
      return [];
    }

    const [ruleset, cutoffs] = await Promise.all([readRuleset(), readDivisionCutoffs()]);
    const rows = await db.match.findMany({
      where: {
        playerId: player.id,
        // El `WIN` va **después** del spread: `classificatoryWhere()` escribe
        // `result: { not: null }`, y ponerlo antes lo sobrescribía y colaba derrotas.
        ...rankedMatchWhere(ruleset.modes, ruleset.window, player.registeredAt),
        result: MatchResult.WIN,
      },
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      select: ADMIN_ACT_MATCH_SELECT,
    });

    return rows
      .filter((row) => {
        const match: MatchForScoring = {
          id: row.id,
          gameId: row.gameId,
          points: row.points,
          revertedAt: null,
          playerId: player.id,
          mode: row.mode,
          result: row.result,
          startedAt: row.startedAt,
          finishedAt: row.finishedAt,
          registeredAt: player.registeredAt,
          rawJson: row.rawJson,
          playerName: "",
          playerProfileId: player.profileId,
        };

        return countsWithoutRevertMark(match, ruleset, cutoffs);
      })
      .map((row) => toMatchCandidate(row, ruleset.pointsPerWin));
  });
}

/**
 * Las actuaciones vigentes y revertibles de un jugador.
 *
 * Excluye las reversiones (son finales) y las ya revertidas: son exactamente las que
 * el servicio aceptará como objetivo de una nueva reversión.
 */
export async function getAdminActTargetCandidates(
  playerId: string,
): Promise<PublicRead<AdminActTargetCandidate[]>> {
  return readFromDatabase("admin/getAdminActTargetCandidates", async () => {
    const acts = await db.adminAct.findMany({
      where: {
        playerId,
        revertedAt: null,
        kind: { not: "REVERSAL" },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: ADMIN_ACT_TARGET_SELECT,
    });

    return acts.map(toTarget);
  });
}
