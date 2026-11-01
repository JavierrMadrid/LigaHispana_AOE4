import "server-only";

import { Prisma } from "@/generated/prisma/client";
import { AdminActionType, MatchResult, PlayerStatus } from "@/generated/prisma/enums";
import type { LadderCutoffsTable } from "@/lib/alerts/division-cutoffs";
import { reevaluatePlayerAlerts } from "@/lib/alerts/evaluate";
import { readDivisionCutoffs } from "@/lib/alerts/settings";
import { recordAdminAction } from "@/lib/admin-actions";
import { readCountries } from "@/lib/countries";
import { db } from "@/lib/db";
import { logDatabaseFailure } from "@/lib/db-errors";
import { isRecord } from "@/lib/json";
import {
  camposQueCambian,
  parsePlayerField,
  PLAYER_FIELD_LABELS,
  PLAYER_FIELDS,
  type CamposEditables,
  type PlayerField,
} from "@/lib/player-fields";
import { countsAsRanked, type TeamTierContext } from "@/lib/ranked-match";
import { readRuleset, recomputeScores, type ScoringRuleset } from "@/lib/scoring";
import { deletePlayerSyncState } from "@/lib/settings";

/**
 * Deshacer lo que se hizo en el panel.
 *
 * ## Qué es una reversión
 *
 * Es una **acción compensatoria**, no un borrado del rastro. Se deshace el cambio, se
 * marca la acción original (`AdminAction.revertedAt` / `revertedByEmail`) y se escribe
 * una fila nueva `ACTION_REVERTED` que dice quién deshizo qué, con el resumen de la
 * acción revertida ya redactado. Las tres cosas van en la **misma transacción**: o se
 * deshace el cambio y queda anotado, o no pasa nada. El recálculo de la clasificación
 * va después, como en las acciones que mueven puntos.
 *
 * La marca en la original es lo que hace que el historial siga contando la verdad: la
 * fila de "Aprobación de X" no desaparece ni se edita, solo queda dicho que ya no está
 * vigente. Y una acción ya marcada **no se revierte dos veces**.
 *
 * ## Quién puede, y qué
 *
 * Solo el superadministrador (`requireSuperadmin()` en la Server Action, que es quien
 * tiene el usuario para firmar el rastro). Aquí no se comprueba el permiso: este módulo
 * es la operación, no la puerta.
 *
 * Solo se deshacen los tipos de `REVERTIBLE`. Los que dejan el dato fuera —la baja
 * destructiva que ya no se ofrece en el panel, o cualquier otro que borrase la fila— no
 * pueden deshacerse porque el dato ya no está; la gestión de admins tampoco, porque su
 * baja ya tiene su propia acción reversible; y una configuración se cambia publicando
 * otra, que deja su propio rastro.
 *
 * ## Por qué un fallo del recálculo no deshace la reversión
 *
 * La clasificación se recalcula después de confirmar el cambio, y si falla se **avisa**
 * en vez de compensar. Es el mismo criterio que el de una actuación administrativa
 * (`createAdminActRecord`): lo que se ha deshecho
 * está escrito y es coherente consigo mismo, y la clasificación que se queda es la
 * anterior, que la próxima pasada del sincronizador vuelve a poner al día —el recálculo
 * es lo último que hace cada pasada—. Compensar aquí obligaría a deshacer la marca de
 * la original y borrar la fila `ACTION_REVERTED` para dejar un estado que el cron
 * arregla solo.
 *
 * ## Lo que comparte con las acciones que ya deshacían algo
 *
 * `countsWithoutRevertMark()`, `deletePlayerCascade()` y `recomputeWithWarning()` viven
 * aquí porque las necesitan varias operaciones: deshacer un alta y la actuación de
 * anulación (`createAdminActRecord()`), entre otras. La reversión y las acciones de
 * siempre tienen que hacer **exactamente lo mismo**, y la alternativa era una segunda
 * copia de cada regla.
 */

/* -------------------------------------------------------------------------- */
/* Qué se puede deshacer                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Los tipos de `AdminAction` que el panel puede deshacer.
 *
 * El `Record` es exhaustivo sobre el enum **a propósito**: un tipo nuevo obliga a
 * decidir aquí si se puede deshacer, en vez de quedar fuera de la lista por descuido y
 * aparecer en la interfaz con un botón que no lleva a ninguna parte.
 *
 * | Tipo | ¿Se deshace? | Qué hace |
 * |---|---|---|
 * | `PLAYER_CREATED` | Sí | Borra al jugador y todo lo suyo. **No se puede rehacer.** |
 * | `PLAYER_EDITED` | Sí | Devuelve los valores anteriores, validados otra vez. |
 * | `PLAYER_APPROVED` / `PLAYER_REJECTED` | Sí | Devuelve el estado que tenía el jugador. |
 * | `MATCH_POINTS_REVERTED` / `MATCH_POINTS_RESTORED` | Sí | Quita o vuelve a poner la marca de la partida. |
 * | `PLAYER_REMOVED` | No | Tipo histórico (la baja destructiva ya no existe) y el dato ya no está: no hay nada que restaurar. |
 * | `ADMIN_ADDED`, `ADMIN_DEACTIVATED`, `ADMIN_REACTIVATED` | No | La baja de un admin ya se deshace con `reactivateAdmin`, y quién puede entrar no se reescribe desde el historial. |
 * | `ACTION_REVERTED` | No | Una reversión no se revierte: para volver atrás está la acción que se deshizo. |
 * | `CONFIG_CHANGED` | No | La configuración se cambia publicando otra, que es otra acción con su propio rastro. |
 */
const REVERTIBLE: Record<AdminActionType, boolean> = {
  PLAYER_CREATED: true,
  PLAYER_EDITED: true,
  PLAYER_APPROVED: true,
  PLAYER_REJECTED: true,
  MATCH_POINTS_REVERTED: true,
  MATCH_POINTS_RESTORED: true,
  PLAYER_REMOVED: false,
  ADMIN_ADDED: false,
  ADMIN_DEACTIVATED: false,
  ADMIN_REACTIVATED: false,
  ACTION_REVERTED: false,
  CONFIG_CHANGED: false,
};

/**
 * ¿El panel puede deshacer una acción de este tipo?
 *
 * Es pura y la comparten la operación, la interfaz (para decidir si pinta el botón) y
 * su test, así que la regla de qué se deshace no se puede leer de dos maneras.
 */
export function isRevertibleActionType(type: AdminActionType): boolean {
  return REVERTIBLE[type];
}

/* -------------------------------------------------------------------------- */
/* Piezas compartidas                                                          */
/* -------------------------------------------------------------------------- */

/**
 * La partida tal y como la necesitan las dos operaciones que tocan su marca de
 * revertida: el revert del panel y la reversión de una acción de puntos.
 *
 * `registeredAt` sale en la fila plana y no como `player.registeredAt` porque
 * `countsAsRanked()` lo toma como un dato más de la partida y no como una relación.
 */
export type MatchForScoring = {
  id: string;
  gameId: string;
  points: number;
  revertedAt: Date | null;
  /** `Player.id` de la fila afectada: las alertas se reevalúan por id, no por `profileId`. */
  playerId: string;
  /** Lo que `countsAsRanked()` necesita para decidir si la partida cuenta. */
  mode: string | null;
  result: MatchResult | null;
  startedAt: Date;
  finishedAt: Date | null;
  /** `Player.registeredAt` del dueño, o `null` si no lo tiene: el corte de la regla. */
  registeredAt: Date | null;
  /** El payload de la partida: sin él no se puede ver si un compañero estaba a dos escalones. */
  rawJson: unknown;
  playerName: string;
  playerProfileId: number;
};

/**
 * ¿La partida cuenta con las reglas actuales si se le **quita** la marca de revertida?
 *
 * Es la misma pregunta que se hace el motor, con la misma función, y la respuesta es la
 * misma en los dos sentidos de la marca: solo tiene sentido tocarla en una partida que
 * cuenta. Al revertir, porque es lo que se le quita; al restaurar o al deshacer, porque
 * es lo que vuelve.
 *
 * Se pregunta siempre con `revertedAt: null`, que es lo que deja la decisión en las
 * otras cinco condiciones de la regla. Sin esta guarda, un `FormData` hecho a mano —o
 * una acción de hace un mes, con la ventana ya movida— podría dejar marcada para
 * siempre una partida que nunca llegó a puntuar, y el panel enseñaría "revertida" en
 * algo que en realidad nunca contó.
 *
 * Los cortes de división y el ruleset los lee **quien llama**, una vez por operación:
 * son dos lecturas de `Setting` que no cambian entre dos comprobaciones seguidas.
 */
export function countsWithoutRevertMark(
  match: MatchForScoring,
  ruleset: Pick<ScoringRuleset, "window">,
  cutoffs: LadderCutoffsTable | null,
): boolean {
  const context: TeamTierContext = { profileId: match.playerProfileId, cutoffs };

  return countsAsRanked({ ...match, revertedAt: null }, ruleset.window, match.registeredAt, context);
}

/**
 * Borra a un jugador con todo lo suyo y con su cursor de sincronización.
 *
 * La usa deshacer un alta, que es el **único** camino que queda para borrar un
 * jugador desde el panel: la baja destructiva (`deletePlayer`) se retiró en la issue
 * 167 y retirar a un aprobado es una actuación de expulsión.
 *
 * - El borrado de `Player` arrastra en cascada sus partidas, sus filas de clasificación
 *   y sus objetivos.
 * - El **cursor de sincronización** (`Setting["aoe4world.sync.player.<profileId>"]`) no
 *   cae con la cascada —vive en `Setting`, sin FK al jugador— y por eso se borra en la
 *   misma transacción: dejar el cursor huérfano hacía que un alta posterior del mismo
 *   perfil creyera que ya tenía el histórico y solo pidiera partidas desde esa fecha,
 *   importando cero.
 *
 * Recibe el cliente para participar en la transacción de quien llama: o se va el
 * jugador con su cursor y su rastro, o no se va nada.
 */
export async function deletePlayerCascade(
  player: { id: string; profileId: number },
  client: Prisma.TransactionClient,
): Promise<void> {
  await client.player.delete({ where: { id: player.id } });
  await deletePlayerSyncState(player.profileId, client);
}

/**
 * Recalcula la clasificación y devuelve el aviso si no lo ha conseguido.
 *
 * **No lanza**, porque cuando se llama el cambio ya está escrito y propagar el error
 * dejaría a quien lo pidió creyendo que no se aplicó nada cuando sí. El texto va vacío
 * cuando todo fue bien, y quien lo recibe lo añade al mensaje de éxito: el cambio está
 * hecho y lo único pendiente es que la clasificación se ponga al día sola.
 */
export async function recomputeWithWarning(scope: string): Promise<string> {
  try {
    await recomputeScores();

    return "";
  } catch (error) {
    logDatabaseFailure(`${scope}/recompute`, error);

    return "La clasificación se recalculará sola en la próxima pasada del sincronizador.";
  }
}

/* -------------------------------------------------------------------------- */
/* La operación                                                                */
/* -------------------------------------------------------------------------- */

export type RevertAdminActionResult = {
  status: "success" | "error";
  message: string;
};

const MISSING_ACTION_ERROR = "No se ha podido saber qué acción hay que deshacer.";

const NOT_REVERTIBLE_ERROR = "Esa acción no se puede deshacer desde el panel.";

const ALREADY_REVERTED_ERROR = "Esa acción ya se había deshecho.";

const MISSING_TARGET_ERROR =
  "Esa acción no apunta a ninguna fila, así que no hay nada que deshacer.";

const REVERT_FAILED_ERROR =
  "No se ha podido deshacer la acción. Inténtalo de nuevo en unos minutos.";

/**
 * La acción tal y como la necesita la reversión: lo justo para saber qué se deshace.
 *
 * `details` llega sin tipo porque la columna es `Json` y su forma cambia con el `type`:
 * lo escribe la acción original, que puede ser de otra versión del código, y quien lo
 * lee lo valida en vez de fiarse del tipo.
 */
type RevertibleAction = {
  id: string;
  type: AdminActionType;
  targetId: string | null;
  details: unknown;
  summary: string;
  revertedAt: Date | null;
};

/**
 * La acción se ha revertido entre la lectura y la escritura.
 *
 * Es la única carrera real de esta operación —dos superadmins pulsando a la vez— y se
 * resuelve dentro de la transacción con un `updateMany` condicionado: si la marca ya
 * estaba puesta, no se toca nada y la transacción se deshace entera.
 *
 * Lleva mensaje y `name` propios para que, si algún día llegara al log por una vía que
 * no la espera, se lea qué pasó en vez de un `Error` pelado.
 */
class AlreadyRevertedError extends Error {
  constructor() {
    super("La acción ya se había deshecho.");

    this.name = "AlreadyRevertedError";
  }
}

/** Lo que devuelve una rama cuando sí ha deshecho algo. */
type BranchOutcome = {
  /** Qué ha cambiado, para el mensaje de éxito. Se lee detrás del resumen de la original. */
  consequence: string;
  /** ¿Hay que recalcular la clasificación? */
  recompute: boolean;
  /** Jugador cuyas alertas hay que reevaluar, si la rama ha movido sus partidas. */
  reevaluatePlayerId?: string;
};

type BranchResult = ({ ok: true } & BranchOutcome) | { ok: false; message: string };

/**
 * Deshace una acción del historial y devuelve qué ha pasado, en español.
 *
 * El orden es el de cualquier lectura del panel: primero lo que se puede comprobar sin
 * escribir —existe, se puede deshacer, no se ha deshecho ya— y después el cambio, con
 * sus validaciones, que dependen del tipo. Todo lo que falla por la base se registra y
 * sale con el mensaje de siempre, sin enseñar el error.
 */
export async function revertAdminAction(
  actionId: string,
  actorEmail: string,
): Promise<RevertAdminActionResult> {
  const id = actionId.trim();

  if (id === "") {
    return { status: "error", message: MISSING_ACTION_ERROR };
  }

  let action: RevertibleAction | null;

  try {
    action = await db.adminAction.findUnique({
      where: { id },
      select: { id: true, type: true, targetId: true, details: true, summary: true, revertedAt: true },
    });
  } catch (error) {
    logDatabaseFailure("admin/revertAdminAction/leer", error);

    return { status: "error", message: REVERT_FAILED_ERROR };
  }

  if (action === null) {
    return { status: "error", message: "Esa acción ya no está en el historial." };
  }

  if (action.revertedAt !== null) {
    return { status: "error", message: ALREADY_REVERTED_ERROR };
  }

  if (!isRevertibleActionType(action.type)) {
    return { status: "error", message: NOT_REVERTIBLE_ERROR };
  }

  let outcome: BranchResult;

  try {
    outcome = await revertByType(action, actorEmail);
  } catch (error) {
    if (error instanceof AlreadyRevertedError) {
      return { status: "error", message: ALREADY_REVERTED_ERROR };
    }

    logDatabaseFailure("admin/revertAdminAction", error);

    return { status: "error", message: REVERT_FAILED_ERROR };
  }

  if (!outcome.ok) {
    return { status: "error", message: outcome.message };
  }

  const aviso = outcome.recompute ? await recomputeWithWarning("admin/revertAdminAction") : "";

  // Las alertas son un informe derivado y *append-only*, y se reevalúan **después** del
  // recálculo y solo para el jugador cuyas partidas han cambiado: es el mismo criterio
  // que `createAdminActRecord`, y un fallo suyo no deja nada a medias.
  if (outcome.reevaluatePlayerId !== undefined) {
    await reevaluatePlayerAlerts(outcome.reevaluatePlayerId);
  }

  const base = `Se ha deshecho: ${action.summary}. ${outcome.consequence}`;

  return { status: "success", message: aviso === "" ? base : `${base} ${aviso}` };
}

/** Reparte la reversión por tipo. Cada rama valida lo suyo antes de escribir. */
async function revertByType(
  action: RevertibleAction,
  actorEmail: string,
): Promise<BranchResult> {
  if (action.targetId === null) {
    return { ok: false, message: MISSING_TARGET_ERROR };
  }

  switch (action.type) {
    case AdminActionType.PLAYER_APPROVED:
    case AdminActionType.PLAYER_REJECTED:
      return revertPlayerStatus(action, action.targetId, actorEmail);
    case AdminActionType.PLAYER_CREATED:
      return revertPlayerCreated(action, action.targetId, actorEmail);
    case AdminActionType.PLAYER_EDITED:
      return revertPlayerEdited(action, action.targetId, actorEmail);
    case AdminActionType.MATCH_POINTS_REVERTED:
    case AdminActionType.MATCH_POINTS_RESTORED:
      return revertMatchPoints(action, action.targetId, actorEmail);
    default:
      // Los tipos no revertibles ya se han descartado con `isRevertibleActionType()`,
      // así que aquí no se llega: el `default` existe para que el `switch` cubra el
      // enum entero y un tipo nuevo no se cuele sin decidir su rama.
      return { ok: false, message: NOT_REVERTIBLE_ERROR };
  }
}

/**
 * Marca la acción como revertida y escribe la fila `ACTION_REVERTED`.
 *
 * El `updateMany` condicionado a `revertedAt: null` es la guarda de la carrera: si otro
 * superadmin la ha revertido entre la lectura y este momento, no actualiza ninguna fila
 * y la transacción entera se deshace. Se hace **antes** del cambio inverso para que un
 * "ya estaba revertida" no llegue a tocar los datos.
 *
 * La fila nueva no lleva `targetId`: la acción revertida ya está identificada por su
 * `actionId` en el `details`, y apuntar además a la misma fila que la original haría
 * creer que la reversión toca ese jugador o esa partida por su cuenta.
 */
async function markReverted(
  tx: Prisma.TransactionClient,
  action: RevertibleAction,
  actorEmail: string,
): Promise<void> {
  const marked = await tx.adminAction.updateMany({
    where: { id: action.id, revertedAt: null },
    data: { revertedAt: new Date(), revertedByEmail: actorEmail },
  });

  if (marked.count === 0) {
    throw new AlreadyRevertedError();
  }

  await recordAdminAction(tx, {
    type: AdminActionType.ACTION_REVERTED,
    actorEmail,
    actionId: action.id,
    actionSummary: action.summary,
  });
}

/* -------------------------------------------------------------------------- */
/* Aprobar y rechazar                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Devuelve al jugador el estado que tenía antes de aprobarlo o rechazarlo.
 *
 * El estado de antes y el de después los guarda la propia acción en `details`
 * (`statusBefore`/`statusAfter`), que es justo por lo que están ahí: sin ellos el
 * historial no podría distinguir un `PENDING` descartado de un participante que estaba
 * puntuando y salió de la clasificación.
 *
 * Se exige que el jugador esté **en el estado que dejó la acción** (`statusAfter`). Si
 * no lo está, algo lo ha cambiado después —otra aprobación, un rechazo, una
 * reinscripción— y deshacerla pisaría ese cambio: se dice y no se escribe nada. Es la
 * diferencia entre deshacer una acción y deshacer todo lo que vino detrás.
 *
 * Y si la vuelta es a `APPROVED` con la verificación del alta pendiente, **se
 * bloquea**: una reversión no puede aprobar a alguien que no ha confirmado sin que
 * quede rastro de la excepción (ver el comentario dentro de la función).
 */
async function revertPlayerStatus(
  action: RevertibleAction,
  targetId: string,
  actorEmail: string,
): Promise<BranchResult> {
  const details = readDetails(action.details);
  const before = readPlayerStatus(details["statusBefore"]);
  const after = readPlayerStatus(details["statusAfter"]);

  if (before === null || after === null) {
    return {
      ok: false,
      message: "Esa acción no guarda el estado al que hay que volver, así que no se puede deshacer.",
    };
  }

  const player = await db.player.findUnique({
    where: { id: targetId },
    select: {
      id: true,
      name: true,
      status: true,
      discordVerificationRequestedAt: true,
      discordVerifiedAt: true,
    },
  });

  if (player === null) {
    return { ok: false, message: "Ese jugador ya no está en el panel." };
  }

  if (player.status !== after) {
    return {
      ok: false,
      message: `No se puede deshacer: ${player.name} no está en el estado que dejó esa acción. Algo lo ha cambiado después, y deshacerla ahora pisaría ese cambio.`,
    };
  }

  /**
   * Deshacer no puede ser una puerta de atrás de la verificación del alta (issue
   * 119).
   *
   * Una reversión puede devolver la fila a `APPROVED` —es el caso de deshacer un
   * rechazo—, y si esa fila está sujeta y no ha confirmado, hacerlo aquí dejaría
   * aprobado a alguien sin que la persona haya dicho nada y **sin rastro** de que se
   * saltó la puerta: la fila `ACTION_REVERTED` habla de la acción deshecha, no de
   * esto. Por eso se bloquea y se dice por dónde se puede seguir, que son las dos
   * vías que sí dejan constancia: aprobar desde el panel (y esperar la confirmación)
   * o «Aprobar sin verificación», que es explícita y solo del superadministrador.
   *
   * Solo se comprueba la fila, no la configuración: `requestedAt` únicamente se
   * escribe cuando la verificación estaba configurada, así que es la prueba de que
   * esta fila se pidió verificar. Que la configuración se caiga después no autoriza
   * a aprobarla por la puerta de atrás.
   */
  if (
    before === PlayerStatus.APPROVED &&
    player.discordVerificationRequestedAt !== null &&
    player.discordVerifiedAt === null
  ) {
    return {
      ok: false,
      message: `No se puede deshacer: ${player.name} no ha confirmado su alta por Discord, y esta reversión lo aprobaría sin verificación. Aprobar desde el panel y esperar la confirmación, o —solo el superadministrador— aprobar sin verificación desde la ficha cuando el alta vuelva a estar pendiente, que queda registrado en el historial.`,
    };
  }

  await db.$transaction(async (tx) => {
    await markReverted(tx, action, actorEmail);
    await tx.player.update({ where: { id: player.id }, data: { status: before } });
  });

  return {
    ok: true,
    consequence: `${player.name} vuelve a estar ${statusLabel(before)}.`,
    recompute: true,
  };
}

/** El estado de un jugador, en el idioma de los mensajes. */
function statusLabel(status: PlayerStatus): string {
  switch (status) {
    case PlayerStatus.PENDING:
      return "pendiente";
    case PlayerStatus.APPROVED:
      return "aprobado";
    case PlayerStatus.REJECTED:
      return "rechazado";
    case PlayerStatus.BANNED:
      return "expulsado";
  }
}

/** El estado tal y como lo guardó la acción, o `null` si no se puede leer. */
function readPlayerStatus(value: unknown): PlayerStatus | null {
  return value === PlayerStatus.PENDING ||
    value === PlayerStatus.APPROVED ||
    value === PlayerStatus.REJECTED ||
    value === PlayerStatus.BANNED
    ? value
    : null;
}

/* -------------------------------------------------------------------------- */
/* Alta de jugador                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Deshace un alta **borrando al jugador**, con todo lo suyo y su cursor de sincronización.
 *
 * Es lo acordado y es irreversible: un alta no deja nada detrás que se pueda "restaurar",
 * así que deshacerla es quitar la fila. El jugador y sus partidas se van en cascada y el
 * cursor de sync se borra en la misma transacción, con `deletePlayerCascade()`, la misma
 * operación que hacía la baja destructiva del panel (retirada en la issue 167); la
 * interfaz pide confirmación antes de llegar aquí.
 *
 * Si el jugador ya no está, el alta **ya está deshecha**: se dice y no se escribe ni el
 * rastro, porque no hay cambio que compensar.
 *
 * **No se borra por debajo de una actuación vigente.** Si el jugador está `BANNED` o
 * tiene una expulsión o anulación sin revertir, deshacer el alta dejaría el expediente
 * huérfano (`AdminAct.playerId = null`) y ya no se podría revertir. Es la misma guarda
 * que tenía la baja destructiva del panel cuando existía.
 */
async function revertPlayerCreated(
  action: RevertibleAction,
  targetId: string,
  actorEmail: string,
): Promise<BranchResult> {
  const player = await db.player.findUnique({
    where: { id: targetId },
    select: { id: true, name: true, profileId: true, status: true },
  });

  if (player === null) {
    return { ok: false, message: "Ese jugador ya no está en el panel, así que el alta ya estaba deshecha." };
  }

  if (player.status === PlayerStatus.BANNED) {
    return {
      ok: false,
      message: `No se puede deshacer el alta: ${player.name} está expulsado. Revierte primero la expulsión desde Actuaciones.`,
    };
  }

  const activeActs = await db.adminAct.count({
    where: { playerId: player.id, revertedAt: null, kind: { not: "REVERSAL" } },
  });

  if (activeActs > 0) {
    return {
      ok: false,
      message: `No se puede deshacer el alta: ${player.name} tiene actuaciones vigentes. Revierte primero la expulsión o la anulación desde Actuaciones.`,
    };
  }

  await db.$transaction(async (tx) => {
    await markReverted(tx, action, actorEmail);
    await deletePlayerCascade(player, tx);
  });

  return {
    ok: true,
    consequence: "El jugador y todo lo suyo se han borrado, y esto no se puede deshacer.",
    recompute: true,
  };
}

/* -------------------------------------------------------------------------- */
/* Edición de jugador                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Devuelve a cada campo el valor que tenía **antes** de la edición.
 *
 * ## Qué se restaura, y qué no
 *
 * Solo los campos que la edición cambió, que son los que están en `details.campos`:
 * escribir además los que no tocó sería pisar con una foto de hace un momento lo que
 * otro admin pueda haber cambiado entre medias. Si ninguno de los restaurados llega a
 * cambiar nada —porque ya se habían devuelto a mano—, la edición **ya no está vigente**
 * y se dice, en vez de escribir una fila de reversión que no deshace nada.
 *
 * ## La validación es la de la edición, otra vez
 *
 * Cada valor anterior pasa por `parsePlayerField()`, que es el mismo criterio que el
 * formulario de edición y el del alta. No es una formalidad: entre la edición y su
 * reversión puede haber pasado un mes, y un `@usuario` que entonces estaba libre puede
 * ser hoy el de otra fila. Se comprueba la unicidad **excluyendo esta fila** y, si
 * choca, se dice con el nombre de quien lo tiene y no se escribe nada: la reversión es
 * todo o nada, y una escritura a medias dejaría al jugador con un nombre viejo y un
 * canal nuevo.
 *
 * La lista de países se lee **solo si se va a restaurar el país**, que es la única
 * validación que necesita `Setting`.
 */
async function revertPlayerEdited(
  action: RevertibleAction,
  targetId: string,
  actorEmail: string,
): Promise<BranchResult> {
  const details = readDetails(action.details);
  const fields = readEditedFields(details);

  if (fields.length === 0) {
    return {
      ok: false,
      message: "Esa acción no guarda qué campos cambió, así que no se puede deshacer.",
    };
  }

  const player = await db.player.findUnique({
    where: { id: targetId },
    select: {
      id: true,
      name: true,
      profileId: true,
      contactEmail: true,
      twitchChannel: true,
      youtubeChannel: true,
      kickChannel: true,
      country: true,
      discordUsername: true,
    },
  });

  if (player === null) {
    return { ok: false, message: "Ese jugador ya no está en el panel." };
  }

  const countries =
    fields.includes("country") && readDetail(details, "country.antes") !== null
      ? await readCountries()
      : [];

  let restaurados: Partial<CamposEditables> = {};

  for (const field of fields) {
    const antes = readDetail(details, `${field}.antes`);

    if (antes === undefined) {
      return {
        ok: false,
        message: `Esa acción no guarda el valor anterior de ${PLAYER_FIELD_LABELS[field]}, así que no se puede deshacer.`,
      };
    }

    const parsed = parsePlayerField(field, antes, countries);

    if (!parsed.ok) {
      return {
        ok: false,
        message: `No se puede deshacer la edición: el valor anterior de ${PLAYER_FIELD_LABELS[field]} no vale con las reglas de hoy. ${parsed.error}`,
      };
    }

    restaurados = { ...restaurados, ...campoRestaurado(field, parsed.value) };
  }

  const actual: CamposEditables = {
    name: player.name,
    contactEmail: player.contactEmail,
    twitchChannel: player.twitchChannel,
    youtubeChannel: player.youtubeChannel,
    kickChannel: player.kickChannel,
    country: player.country,
    discordUsername: player.discordUsername,
  };

  // La unicidad del `@usuario`, y solo si se va a restaurar y el valor **cambia**: sin
  // cambio no hay conflicto posible, y `findUnique` por `discordUsername` solo puede
  // devolver otra fila (si fuera esta, el valor ya sería el mismo).
  if (
    restaurados.discordUsername !== undefined &&
    restaurados.discordUsername !== null &&
    restaurados.discordUsername !== player.discordUsername
  ) {
    const ocupado = await db.player.findUnique({
      where: { discordUsername: restaurados.discordUsername },
      select: { name: true },
    });

    if (ocupado !== null) {
      return {
        ok: false,
        message: `No se puede deshacer: el @usuario que tenía ${player.name} ya lo usa ${ocupado.name}. Corrígelo antes de deshacer la edición.`,
      };
    }
  }

  const cambios = camposQueCambian(actual, { ...actual, ...restaurados });

  if (cambios.length === 0) {
    return {
      ok: false,
      message: "Esa edición ya no está vigente: los campos ya tienen los valores de antes.",
    };
  }

  await db.$transaction(async (tx) => {
    await markReverted(tx, action, actorEmail);
    await tx.player.update({ where: { id: player.id }, data: restaurados });
  });

  return {
    ok: true,
    consequence: `Campos restaurados: ${cambios.map((cambio) => cambio.etiqueta).join(", ")}.`,
    recompute: false,
  };
}

/**
 * Un campo restaurado, listo para el `UPDATE`.
 *
 * Existe para que el tipo diga la verdad: `name` y `discordUsername` **nunca** pueden
 * quedar a `null` —el parser los exige—, así que un valor nulo en ellos no se escribe.
 * Con un objeto genérico de claves variables eso no se podría comprobar, y el `data`
 * del `UPDATE` acabaría necesitando un `as` que tapara justo esa parte.
 */
function campoRestaurado(field: PlayerField, value: string | null): Partial<CamposEditables> {
  switch (field) {
    case "name":
      return value === null ? {} : { name: value };
    case "discordUsername":
      return value === null ? {} : { discordUsername: value };
    case "contactEmail":
      return { contactEmail: value };
    case "twitchChannel":
      return { twitchChannel: value };
    case "youtubeChannel":
      return { youtubeChannel: value };
    case "kickChannel":
      return { kickChannel: value };
    case "country":
      return { country: value };
  }
}

/* -------------------------------------------------------------------------- */
/* Puntos de una partida                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Deshace la marca de revertida de una partida, o la vuelve a poner.
 *
 * La dirección sale del tipo de la acción: deshacer un `MATCH_POINTS_REVERTED` es quitar
 * la marca (los puntos vuelven) y deshacer un `MATCH_POINTS_RESTORED` es volver a
 * ponerla. La fila de `Match` se queda siempre en el histórico, que es lo que permite
 * deshacer y rehacer sin perder nada.
 *
 * Se exige que la partida esté **en el estado que dejó la acción** y que cuente con las
 * reglas actuales (`countsWithoutRevertMark()`), la misma guarda que el revert del panel
 * y por el mismo motivo: si la ventana se ha movido desde entonces, la partida ya no
 * puntúa y no hay nada que deshacer.
 */
async function revertMatchPoints(
  action: RevertibleAction,
  targetId: string,
  actorEmail: string,
): Promise<BranchResult> {
  const row = await db.match.findUnique({
    where: { id: targetId },
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
      player: { select: { name: true, profileId: true, registeredAt: true } },
    },
  });

  if (row === null) {
    return { ok: false, message: "Esa partida ya no existe." };
  }

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
    registeredAt: row.player.registeredAt,
    rawJson: row.rawJson,
    playerName: row.player.name,
    playerProfileId: row.player.profileId,
  };

  const deshaceUnRevert = action.type === AdminActionType.MATCH_POINTS_REVERTED;

  if (deshaceUnRevert && match.revertedAt === null) {
    return { ok: false, message: "La partida ya no está revertida, así que esa acción ya no está vigente." };
  }

  if (!deshaceUnRevert && match.revertedAt !== null) {
    return { ok: false, message: "La partida ya está revertida otra vez, así que esa acción ya no está vigente." };
  }

  const ruleset = await readRuleset();
  const cutoffs = await readDivisionCutoffs();

  if (!countsWithoutRevertMark(match, ruleset, cutoffs)) {
    return {
      ok: false,
      message:
        "Esa partida no es clasificatoria con las reglas actuales, así que sus puntos no cambian y no hay nada que deshacer.",
    };
  }

  const marca = deshaceUnRevert ? null : new Date();

  await db.$transaction(async (tx) => {
    await markReverted(tx, action, actorEmail);
    await tx.match.update({ where: { id: match.id }, data: { revertedAt: marca } });
  });

  return {
    ok: true,
    consequence: deshaceUnRevert
      ? "La partida vuelve a contar."
      : "La partida deja de contar otra vez.",
    recompute: true,
    reevaluatePlayerId: match.playerId,
  };
}

/* -------------------------------------------------------------------------- */
/* Lectura del `details`                                                       */
/* -------------------------------------------------------------------------- */

/**
 * El `details` de una acción, como objeto, o uno vacío.
 *
 * Se lee como `unknown` porque la columna es `Json` y lo escribió la acción original,
 * que puede ser de otra versión del código: lo que no tenga la forma esperada se
 * descarta aquí y quien pregunta se queda sin dato, que es el estado que trata como
 * "no se puede deshacer" en vez de inventarse un valor.
 */
function readDetails(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/**
 * Un valor del `details`, tal y como lo escribió la acción.
 *
 * `undefined` es "la clave no está o no es texto", que quien llama trata como un dato
 * que falta; `null` es un vacío **guardado**, que sí es un valor al que se puede volver.
 * La diferencia importa: un canal que estaba vacío se restaura a `null`, pero un
 * `name.antes` que no se puede leer significa que no hay nada que restaurar.
 */
function readDetail(
  details: Record<string, unknown>,
  key: string,
): string | null | undefined {
  if (!(key in details)) {
    return undefined;
  }

  const value = details[key];

  return value === null ? null : typeof value === "string" ? value : undefined;
}

/** Los campos que la edición cambió, filtrados contra la lista de columnas editables. */
const PLAYER_FIELD_NAMES = new Set<string>(PLAYER_FIELDS);

/**
 * Qué campos cambió una edición, leídos del `details` de su acción.
 *
 * La acción los guarda como una lista de nombres de columna separada por comas
 * (`campos`), que es lo que permite escribir una consulta sin traducir. Se filtran
 * contra `PLAYER_FIELDS` y se quitan los repetidos: un nombre que no sea de un campo
 * editable —o una lista manipulada— no puede llegar al `UPDATE`.
 */
function readEditedFields(details: Record<string, unknown>): PlayerField[] {
  const raw = readDetail(details, "campos");

  if (typeof raw !== "string") {
    return [];
  }

  const fields = raw
    .split(",")
    .map((campo) => campo.trim())
    .filter((campo): campo is PlayerField => PLAYER_FIELD_NAMES.has(campo));

  return [...new Set(fields)];
}
