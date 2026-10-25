import "server-only";

import { revalidatePath } from "next/cache";
import { Prisma } from "@/generated/prisma/client";
import { MatchResult, PlayerStatus } from "@/generated/prisma/enums";
import {
  adminActSummary,
  validateAdminActReasons,
  type AdminActField,
  type AdminActKind,
} from "@/lib/admin-acts";
import { dispatchAdminActNotice, type AdminActNoticeRequest } from "@/lib/admin-act-notice-send";
import { countsWithoutRevertMark, recomputeWithWarning, type MatchForScoring } from "@/lib/admin-revert";
import { reevaluatePlayerAlerts } from "@/lib/alerts/evaluate";
import { readDivisionCutoffs } from "@/lib/alerts/settings";
import { db } from "@/lib/db";
import { logDatabaseFailure } from "@/lib/db-errors";
import { readRuleset } from "@/lib/scoring";

/**
 * La escritura de una actuación administrativa.
 *
 * ## Una acción, una transacción
 *
 * Cada tipo valida lo suyo y escribe **todo** dentro de una transacción: el cambio
 * (estado del jugador o marca de anulación), la actuación y sus vínculos, y la marca
 * sobre las actuaciones revertidas. O se ve el expediente y su efecto, o no se ve
 * nada. Las guardas son `updateMany` condicionados (`status`, `revertedAt`) y se
 * comprueba el número de filas: si otro administrador ha cambiado lo mismo entre la
 * lectura y la escritura, la transacción se deshace entera.
 *
 * ## La reversión es la inversa, no un borrado
 *
 * Revertir una expulsión restaura el `statusBefore` que guardó la actuación; revertir
 * una anulación quita la marca de las partidas vinculadas. La actuación original no se
 * borra: se marca con `revertedAt`, `revertedByEmail` y `reversedByActId`. La
 * reversión es una actuación nueva y **final**: no se puede revertir.
 *
 * ## Después de confirmar
 *
 * El recálculo y la reevaluación de alertas van **después** de la transacción, y un
 * fallo del recálculo **no se compensa**: la actuación ya está aplicada y lo único que
 * se devuelve es un aviso de que la clasificación se pondrá al día en la próxima
 * pasada. El aviso de Discord se lanza siempre, aunque el recálculo falle.
 */

const SAVE_FAILED_MESSAGE = "No se ha podido guardar la actuación. Inténtalo de nuevo en unos minutos.";

/**
 * Un rechazo de negocio: no es un fallo de la base y no se registra como tal.
 *
 * Lleva el campo del formulario al que corresponde cuando lo hay (una razón pública
 * demasiado larga, una selección de partidas vacía), para que la Server Action pueda
 * pintar el error donde toca.
 */
class AdminActRejection extends Error {
  constructor(
    message: string,
    readonly field?: AdminActField,
  ) {
    super(message);
    this.name = "AdminActRejection";
  }
}

export type CreateAdminActInput =
  | {
      kind: "BAN";
      playerId: string;
      publicReason: string;
      privateInfo: string | null;
      actorEmail: string;
    }
  | {
      kind: "MATCH_ANNULMENT";
      playerId: string;
      publicReason: string;
      privateInfo: string | null;
      actorEmail: string;
      matchIds: readonly string[];
    }
  | {
      kind: "REVERSAL";
      playerId: string;
      publicReason: string;
      privateInfo: string | null;
      actorEmail: string;
      targetActIds: readonly string[];
    };

export type CreateAdminActResult =
  | {
      status: "success";
      actId: string;
      /** Mensaje de éxito, con el aviso del recálculo si lo hubo. */
      message: string;
      /** Aviso del recálculo; `null` si la clasificación quedó al día. */
      warning: string | null;
      /** Datos públicos del aviso, para quien quiera reutilizarlos. */
      notice: AdminActNoticeRequest;
    }
  | { status: "error"; message: string; field?: AdminActField };

/** La actuación lista para devolver al servicio que llama. */
type ActOutcome = {
  actId: string;
  kind: AdminActKind;
  playerId: string;
  playerName: string;
  profileId: number;
  discordUserId: string | null;
  discordUsername: string | null;
  matchCount: number;
  targetCount: number;
  targetSummaries: string[];
  message: string;
};

/** La fila del jugador que necesitan todos los tipos. */
const PLAYER_SELECT = {
  id: true,
  name: true,
  profileId: true,
  status: true,
  registeredAt: true,
  discordUserId: true,
  discordUsername: true,
} satisfies Prisma.PlayerSelect;

type PlayerRow = Prisma.PlayerGetPayload<{ select: typeof PLAYER_SELECT }>;

function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids.map((id) => id.trim()).filter((id) => id !== ""))];
}

/** La fila del jugador o un rechazo legible. */
async function loadPlayer(
  tx: Prisma.TransactionClient,
  playerId: string,
): Promise<PlayerRow> {
  const player = await tx.player.findUnique({ where: { id: playerId }, select: PLAYER_SELECT });

  if (player === null) {
    throw new AdminActRejection("Ese jugador ya no está en el panel.");
  }

  return player;
}

/** Impide una segunda expulsión vigente, sin depender solo del estado. */
async function assertNoActiveBan(tx: Prisma.TransactionClient, playerId: string): Promise<void> {
  const active = await tx.adminAct.count({
    where: { playerId, kind: "BAN", revertedAt: null },
  });

  if (active > 0) {
    throw new AdminActRejection("Ese jugador ya tiene una expulsión vigente. Revierte la anterior para poder expulsarlo otra vez.");
  }
}

/* -------------------------------------------------------------------------- */
/* Expulsión                                                                   */
/* -------------------------------------------------------------------------- */

async function applyBan(
  tx: Prisma.TransactionClient,
  input: Extract<CreateAdminActInput, { kind: "BAN" }>,
  reasons: { publicReason: string; privateInfo: string | null },
): Promise<ActOutcome> {
  const player = await loadPlayer(tx, input.playerId);

  if (player.status === PlayerStatus.BANNED) {
    throw new AdminActRejection("Ese jugador ya está expulsado. Para cambiarlo, revierte la expulsión desde Actuaciones.");
  }

  if (player.status !== PlayerStatus.APPROVED) {
    throw new AdminActRejection("Solo se puede expulsar a un participante aprobado.");
  }

  await assertNoActiveBan(tx, player.id);

  const updated = await tx.player.updateMany({
    where: { id: player.id, status: PlayerStatus.APPROVED },
    data: { status: PlayerStatus.BANNED },
  });

  if (updated.count !== 1) {
    throw new AdminActRejection("El estado del jugador ha cambiado mientras se guardaba la actuación. Inténtalo de nuevo.");
  }

  const act = await tx.adminAct.create({
    data: {
      kind: "BAN",
      playerId: player.id,
      playerName: player.name,
      profileId: player.profileId,
      summary: adminActSummary({ kind: "BAN", playerName: player.name }),
      publicReason: reasons.publicReason,
      privateInfo: reasons.privateInfo,
      actorEmail: input.actorEmail,
      matchCount: 0,
      statusBefore: PlayerStatus.APPROVED,
    },
    select: { id: true },
  });

  return {
    actId: act.id,
    kind: "BAN",
    playerId: player.id,
    playerName: player.name,
    profileId: player.profileId,
    discordUserId: player.discordUserId,
    discordUsername: player.discordUsername,
    matchCount: 0,
    targetCount: 0,
    targetSummaries: [],
    message: `Se ha expulsado a ${player.name} (AoE4World ${player.profileId}).`,
  };
}

/* -------------------------------------------------------------------------- */
/* Anulación de partidas                                                       */
/* -------------------------------------------------------------------------- */

async function applyAnnulment(
  tx: Prisma.TransactionClient,
  input: Extract<CreateAdminActInput, { kind: "MATCH_ANNULMENT" }>,
  reasons: { publicReason: string; privateInfo: string | null },
  now: Date,
): Promise<ActOutcome> {
  const player = await loadPlayer(tx, input.playerId);
  const ids = uniqueIds(input.matchIds);

  if (player.status !== PlayerStatus.APPROVED) {
    throw new AdminActRejection("Solo se pueden anular partidas de un participante aprobado.");
  }

  if (ids.length === 0) {
    throw new AdminActRejection("Selecciona al menos una partida ganada para anular.", "matchIds");
  }

  const [ruleset, cutoffs] = await Promise.all([readRuleset(tx), readDivisionCutoffs(tx)]);
  const rows = await tx.match.findMany({
    where: { id: { in: ids }, playerId: player.id },
    select: {
      id: true,
      gameId: true,
      points: true,
      revertedAt: true,
      playerId: true,
      mode: true,
      result: true,
      startedAt: true,
      finishedAt: true,
      rawJson: true,
    },
  });

  if (rows.length !== ids.length) {
    throw new AdminActRejection("Alguna de las partidas seleccionadas ya no existe o no es de ese jugador.", "matchIds");
  }

  const validas = rows.every((row) => {
    const match: MatchForScoring = {
      id: row.id,
      gameId: row.gameId,
      points: row.points,
      revertedAt: row.revertedAt,
      playerId: row.playerId,
      mode: row.mode,
      result: row.result,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      registeredAt: player.registeredAt,
      rawJson: row.rawJson,
      playerName: player.name,
      playerProfileId: player.profileId,
    };

    return (
      row.result === MatchResult.WIN &&
      row.revertedAt === null &&
      countsWithoutRevertMark(match, ruleset, cutoffs)
    );
  });

  if (!validas) {
    throw new AdminActRejection(
      "Solo se pueden anular partidas ganadas que hoy puntúan. Revisa la selección.",
      "matchIds",
    );
  }

  const updated = await tx.match.updateMany({
    where: {
      id: { in: ids },
      playerId: player.id,
      result: MatchResult.WIN,
      revertedAt: null,
    },
    data: { revertedAt: now },
  });

  if (updated.count !== ids.length) {
    throw new AdminActRejection("Alguna de las partidas ha cambiado mientras se guardaba la actuación. Inténtalo de nuevo.");
  }

  const act = await tx.adminAct.create({
    data: {
      kind: "MATCH_ANNULMENT",
      playerId: player.id,
      playerName: player.name,
      profileId: player.profileId,
      summary: adminActSummary({
        kind: "MATCH_ANNULMENT",
        playerName: player.name,
        matchCount: ids.length,
      }),
      publicReason: reasons.publicReason,
      privateInfo: reasons.privateInfo,
      actorEmail: input.actorEmail,
      matchCount: ids.length,
      matches: { createMany: { data: ids.map((matchId) => ({ matchId })) } },
    },
    select: { id: true },
  });

  return {
    actId: act.id,
    kind: "MATCH_ANNULMENT",
    playerId: player.id,
    playerName: player.name,
    profileId: player.profileId,
    discordUserId: player.discordUserId,
    discordUsername: player.discordUsername,
    matchCount: ids.length,
    targetCount: 0,
    targetSummaries: [],
    message:
      ids.length === 1
        ? `Se ha anulado 1 partida de ${player.name} (AoE4World ${player.profileId}).`
        : `Se han anulado ${ids.length} partidas de ${player.name} (AoE4World ${player.profileId}).`,
  };
}

/* -------------------------------------------------------------------------- */
/* Reversión                                                                   */
/* -------------------------------------------------------------------------- */

type ReversalTarget = {
  id: string;
  kind: AdminActKind;
  summary: string;
  playerId: string | null;
  revertedAt: Date | null;
  statusBefore: PlayerStatus | null;
  matches: { matchId: string }[];
};

async function applyReversal(
  tx: Prisma.TransactionClient,
  input: Extract<CreateAdminActInput, { kind: "REVERSAL" }>,
  reasons: { publicReason: string; privateInfo: string | null },
  now: Date,
): Promise<ActOutcome> {
  const player = await loadPlayer(tx, input.playerId);
  const ids = uniqueIds(input.targetActIds);

  if (ids.length === 0) {
    throw new AdminActRejection("Selecciona al menos una actuación vigente para revertir.", "targetActIds");
  }

  const targets = await tx.adminAct.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      kind: true,
      summary: true,
      playerId: true,
      revertedAt: true,
      statusBefore: true,
      matches: { select: { matchId: true } },
    },
  });

  if (targets.length !== ids.length) {
    throw new AdminActRejection("Alguna de las actuaciones seleccionadas ya no existe.", "targetActIds");
  }

  for (const target of targets as ReversalTarget[]) {
    if (target.playerId !== player.id) {
      throw new AdminActRejection("Todas las actuaciones tienen que ser del mismo jugador.", "targetActIds");
    }

    if (target.revertedAt !== null) {
      throw new AdminActRejection("Alguna de las actuaciones seleccionadas ya estaba revertida.", "targetActIds");
    }

    if (target.kind === "REVERSAL") {
      throw new AdminActRejection("Una reversión no se puede revertir: es final.", "targetActIds");
    }
  }

  const banTargets = targets.filter((target) => target.kind === "BAN");

  if (banTargets.length > 1) {
    throw new AdminActRejection("Un jugador no puede tener dos expulsiones vigentes.", "targetActIds");
  }

  const banTarget = banTargets[0];

  if (banTarget !== undefined) {
    if (banTarget.statusBefore === null) {
      throw new AdminActRejection(
        "La expulsión no guarda el estado al que hay que volver, así que no se puede revertir.",
        "targetActIds",
      );
    }

    const restored = await tx.player.updateMany({
      where: { id: player.id, status: PlayerStatus.BANNED },
      data: { status: banTarget.statusBefore },
    });

    if (restored.count !== 1) {
      throw new AdminActRejection(
        "El jugador ya no está expulsado, así que la actuación ya no está vigente. Actualiza la lista.",
        "targetActIds",
      );
    }
  }

  const matchIds = uniqueIds(
    targets
      .filter((target) => target.kind === "MATCH_ANNULMENT")
      .flatMap((target) => target.matches.map((link) => link.matchId)),
  );

  if (matchIds.length > 0) {
    const restoredMatches = await tx.match.updateMany({
      where: { id: { in: matchIds }, revertedAt: { not: null } },
      data: { revertedAt: null },
    });

    if (restoredMatches.count !== matchIds.length) {
      throw new AdminActRejection(
        "Alguna de las partidas ya no estaba anulada, así que la actuación ya no está vigente. Actualiza la lista.",
        "targetActIds",
      );
    }
  }

  const act = await tx.adminAct.create({
    data: {
      kind: "REVERSAL",
      playerId: player.id,
      playerName: player.name,
      profileId: player.profileId,
      summary: adminActSummary({
        kind: "REVERSAL",
        playerName: player.name,
        matchCount: matchIds.length,
        targetCount: targets.length,
      }),
      publicReason: reasons.publicReason,
      privateInfo: reasons.privateInfo,
      actorEmail: input.actorEmail,
      matchCount: matchIds.length,
    },
    select: { id: true },
  });

  const marked = await tx.adminAct.updateMany({
    where: { id: { in: ids }, revertedAt: null, kind: { not: "REVERSAL" } },
    data: {
      revertedAt: now,
      revertedByEmail: input.actorEmail,
      reversedByActId: act.id,
    },
  });

  if (marked.count !== ids.length) {
    throw new AdminActRejection(
      "Alguna de las actuaciones ha cambiado mientras se guardaba la reversión. Inténtalo de nuevo.",
      "targetActIds",
    );
  }

  const actuaciones =
    targets.length === 1 ? "1 actuación" : `${targets.length} actuaciones`;

  return {
    actId: act.id,
    kind: "REVERSAL",
    playerId: player.id,
    playerName: player.name,
    profileId: player.profileId,
    discordUserId: player.discordUserId,
    discordUsername: player.discordUsername,
    matchCount: matchIds.length,
    targetCount: targets.length,
    targetSummaries: targets.map((target) => target.summary),
    message: `Se ha revertido ${actuaciones} de ${player.name} (AoE4World ${player.profileId}). Esta reversión es final.`,
  };
}

/* -------------------------------------------------------------------------- */
/* La operación                                                                */
/* -------------------------------------------------------------------------- */

/** Revalida las pantallas que cambian con una actuación. */
function revalidateAdminActPaths(actId: string): void {
  revalidatePath("/admin");
  revalidatePath("/admin/actuaciones");
  revalidatePath(`/admin/actuaciones/${actId}`);
  revalidatePath("/admin/historial");
  revalidatePath("/admin/jugadores");
  // Las páginas públicas son `force-dynamic`, pero revalidar el layout y la portada
  // es lo que invalida cualquier vista que se hubiera servido desde caché.
  revalidatePath("/");
  revalidatePath("/historial");
  revalidatePath("/partidas");
  revalidatePath("/objetivos");
  revalidatePath("/puntuacion");
  revalidatePath("/(public)", "layout");
}

/**
 * Crea y aplica una actuación. Devuelve el mensaje y el aviso del recálculo.
 *
 * No comprueba permisos: eso lo hace la Server Action (`requireAdmin()` y, para las
 * reversiones, `requireSuperadmin()`) antes de llamar. Aquí se valida la **entrada**
 * otra vez porque esta función es la última puerta antes de escribir.
 */
export async function createAdminActRecord(
  input: CreateAdminActInput,
): Promise<CreateAdminActResult> {
  const playerId = input.playerId.trim();

  if (playerId === "") {
    return { status: "error", message: "No se ha podido saber sobre qué jugador va la actuación.", field: "playerId" };
  }

  const reasons = validateAdminActReasons({
    publicReason: input.publicReason,
    privateInfo: input.privateInfo,
  });

  if (!reasons.ok) {
    return { status: "error", message: reasons.error, field: reasons.field };
  }

  const now = new Date();
  let outcome: ActOutcome;

  try {
    outcome = await db.$transaction(async (tx) => {
      switch (input.kind) {
        case "BAN":
          return applyBan(tx, { ...input, playerId }, reasons);
        case "MATCH_ANNULMENT":
          return applyAnnulment(tx, { ...input, playerId }, reasons, now);
        case "REVERSAL":
          return applyReversal(tx, { ...input, playerId }, reasons, now);
      }
    });
  } catch (error) {
    if (error instanceof AdminActRejection) {
      return { status: "error", message: error.message, field: error.field };
    }

    logDatabaseFailure(`admin/createAdminAct/${input.kind}`, error);

    return { status: "error", message: SAVE_FAILED_MESSAGE };
  }

  // La actuación ya está confirmada. A partir de aquí nada puede deshacerla: ni el
  // recálculo (que puede fallar y se avisa) ni las alertas ni Discord.
  const warning = await recomputeWithWarning(`admin/createAdminAct/${input.kind}`);

  await reevaluatePlayerAlerts(outcome.playerId);

  // La actuación ya está confirmada: un fallo al invalidar la caché de Next no puede
  // convertir en error algo que sí se ha aplicado. En una petición normal no falla;
  // fuera de ella (scripts, tareas de mantenimiento) sí, y ahí solo procede dejarlo en
  // el log. La siguiente lectura vuelve a pedir los datos.
  try {
    revalidateAdminActPaths(outcome.actId);
  } catch (error) {
    console.warn(
      `[admin-act] No se han podido revalidar las rutas de la actuación ${outcome.actId}: ` +
        (error instanceof Error ? error.message : String(error)),
    );
  }

  const notice: AdminActNoticeRequest = {
    kind: outcome.kind,
    player: {
      name: outcome.playerName,
      discordUserId: outcome.discordUserId,
      discordUsername: outcome.discordUsername,
    },
    publicReason: reasons.publicReason,
    matchCount: outcome.matchCount,
    targetCount: outcome.targetCount,
    targetSummaries: outcome.targetSummaries,
  };

  // El aviso va **siempre**, aunque el recálculo haya fallado: la actuación está
  // aplicada y la persona tiene que saberlo.
  dispatchAdminActNotice(notice);

  return {
    status: "success",
    actId: outcome.actId,
    message: warning === "" ? outcome.message : `${outcome.message} ${warning}`,
    warning: warning === "" ? null : warning,
    notice,
  };
}
