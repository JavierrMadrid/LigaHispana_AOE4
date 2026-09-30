"use server";

import type { User } from "@supabase/supabase-js";
import { revalidatePath } from "next/cache";
import { AdminActionType, MatchResult, PlayerStatus } from "@/generated/prisma/enums";
import { puntos, recordAdminAction } from "@/lib/admin-actions";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { logDatabaseFailure } from "@/lib/db-errors";
import { parseName, parseProfileId, parseTwitchChannel } from "@/lib/player-input";
import { countsAsRanked } from "@/lib/ranked-match";
import { readRuleset, recomputeScores } from "@/lib/scoring";

/**
 * Server Actions del panel de administración.
 *
 * Todas viven bajo `src/app/admin/**` a propósito, y todas empiezan por
 * `requireAdmin()`. Las dos cosas son la misma defensa:
 *
 * - El `matcher` del Proxy (`src/proxy.ts`) cubre `/admin/:path*`, y **excluir una
 *   ruta del `matcher` excluye también sus Server Functions**. Una acción fuera de
 *   `/admin` no se saltaría solo la comprobación optimista de la cookie: en el Proxy
 *   no se ejecutaría, así que su `requireAdmin()` ni siquiera llegaría a comprobar
 *   nada.
 * - El Proxy solo mira cookies. La comprobación real es esta: una Server Action es
 *   un endpoint público y se puede llamar directamente con su id, sin pasar por
 *   ninguna página.
 *
 * El patrón de cada una es el que ya traía `/admin/jugadores/actions.ts` (cuyo
 * contenido vive aquí): **validar fuera del `try`**, dejar el `try` únicamente para
 * la base de datos, registrar el fallo con `logDatabaseFailure` y devolver al
 * formulario un mensaje que no enseña ni el error ni la traza.
 */

/* -------------------------------------------------------------------------- */
/* Estados                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Estado de una acción que necesita poder **informar del resultado**.
 *
 * Es lo que permite que un diálogo de confirmación diga "no se ha podido borrar" en
 * vez de cerrarse en silencio. Sin estado de vuelta, un borrado que fallara con la
 * base caída sería indistinguible de uno que funcionó: el formulario desaparecería
 * igual y quien lo pulsó se quedaría creyendo lo contrario.
 *
 * - `idle`: todavía no se ha enviado nada.
 * - `success`: se hizo, y `message` dice qué pasó.
 * - `error`: no se hizo, y `message` dice por qué o qué se ha deshacido.
 */
export type AdminActionResult = {
  status: "idle" | "success" | "error";
  message: string | null;
};

/** Estado del formulario de alta, que solo distingue "hay error" de "no hay error". */
export type PlayerFormState = {
  error: string | null;
};

/* -------------------------------------------------------------------------- */
/* Utilidades                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Campo de texto de un formulario, ya recortado.
 *
 * `FormData.get` devuelve `FormDataEntryValue`, que también puede ser un `File`: sin
 * este filtro, `String(file)` produciría `"[object File]"` y esa cadena acabaría en
 * un `where` de Prisma.
 */
function readField(formData: FormData, name: string): string {
  const value = formData.get(name);

  return typeof value === "string" ? value.trim() : "";
}

/** Fallo de base de datos al guardar. El motivo se queda en el log del servidor. */
const SAVE_FAILED_MESSAGE = "No se ha podido guardar. Inténtalo de nuevo en unos minutos.";

/** Junta frases sin que aparezca ni un espacio de más ni un doble espacio. */
function frase(...partes: string[]): string {
  return partes
    .map((parte) => parte.trim())
    .filter((parte) => parte !== "")
    .join(" ");
}

/**
 * Quién está actuando, para la columna `AdminAction.actorEmail`.
 *
 * En el tipo de Supabase `User.email` es **opcional** (una cuenta creada solo con
 * teléfono no lo tiene) y `actorEmail` no admite nulos. Las cuentas de este panel se
 * crean a mano con correo y contraseña, así que la ausencia sería una anomalía real,
 * no algo routine: en vez de dejar un hueco se guarda el id del usuario con un
 * prefijo que lo hace evidente en el historial y que sigue siendo rastreable.
 */
function actorEmail(user: User): string {
  return user.email ?? `sin-correo:${user.id}`;
}

/* -------------------------------------------------------------------------- */
/* Alta de jugador                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Da de alta un jugador desde el panel.
 *
 * Mantiene el comportamiento de siempre (mismo `try` solo alrededor de la base,
 * mismo mensaje de fallo, mismos campos) y añade el registro de la acción, que se
 * escribe **en la misma transacción** que el alta: o hay jugador y rastro, o no hay
 * ninguno de los dos.
 */
export async function createPlayer(
  _prevState: PlayerFormState,
  formData: FormData,
): Promise<PlayerFormState> {
  const admin = await requireAdmin();

  const profileId = parseProfileId(formData.get("profileId"));
  const name = parseName(formData.get("name"));
  const twitchChannel = parseTwitchChannel(formData.get("twitchChannel"));
  const statusRaw = String(formData.get("status") ?? "APPROVED");
  const status =
    statusRaw === "PENDING" || statusRaw === "REJECTED" ? statusRaw : "APPROVED";

  if (!profileId) {
    return { error: "El profile ID de AoE4World debe ser un número." };
  }

  if (!name) {
    return { error: "El nombre es obligatorio (máx. 64 caracteres)." };
  }

  // El `try` cubre **solo** la base de datos. Un fallo de validación tiene que
  // seguir siendo un error de aplicación, y por eso el bloque va aquí y no
  // alrededor de la acción entera.
  try {
    const existing = await db.player.findUnique({ where: { profileId } });

    if (existing) {
      return { error: `El perfil ${profileId} ya está registrado (${existing.name}).` };
    }

    await db.$transaction(async (tx) => {
      const created = await tx.player.create({
        data: { profileId, name, twitchChannel, status: status as PlayerStatus },
        select: { id: true },
      });

      await recordAdminAction(tx, {
        type: AdminActionType.PLAYER_CREATED,
        actorEmail: actorEmail(admin),
        targetId: created.id,
        name,
        profileId,
        status,
      });
    });
  } catch (error) {
    logDatabaseFailure("admin/createPlayer", error);

    return { error: SAVE_FAILED_MESSAGE };
  }

  revalidatePath("/admin");

  return { error: null };
}

/* -------------------------------------------------------------------------- */
/* Aprobar y rechazar                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Aprueba o rechaza una solicitud.
 *
 * Estas dos **no** registran acción en `AdminAction` y por eso mantienen la firma
 * simple de un solo `FormData`: son botones que cambian una fila que solo mira el
 * panel, sin efecto en la clasificación ni en lo que ve el público. Cuando la
 * pestaña de acciones quiera mostrarlas hay que añadir su tipo al enum, su frase en
 * `admin-actions.ts` y pasar estas dos a `AdminActionResult`.
 */
async function setPlayerStatus(playerId: string, status: PlayerStatus) {
  await requireAdmin();

  if (!playerId) {
    return;
  }

  try {
    await db.player.update({ where: { id: playerId }, data: { status } });
  } catch (error) {
    // Sin estado de vuelta, un fallo aquí solo puede registrarse: la acción termina
    // sin cambiar nada y no hay superficie en la que informar a quien la pulsó.
    logDatabaseFailure(`admin/${status}`, error);

    return;
  }

  revalidatePath("/admin");
}

export async function approvePlayer(formData: FormData) {
  await setPlayerStatus(readField(formData, "playerId"), PlayerStatus.APPROVED);
}

export async function rejectPlayer(formData: FormData) {
  await setPlayerStatus(readField(formData, "playerId"), PlayerStatus.REJECTED);
}

/* -------------------------------------------------------------------------- */
/* Baja de jugador                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Borra un jugador con todo lo suyo y deja la clasificación coherente.
 *
 * El borrado de `Player` arrastra en cascada sus partidas y sus filas de
 * clasificación, así que la web deja de listarlo de inmediato. Aun así se recalcula:
 * es lo que garantiza que la pasada que se escriba a continuación describa la
 * clasificación que realmente queda, en vez de dejarlo para que lo arregle el cron.
 *
 * **A diferencia del revert, aquí un fallo del recálculo no se compensa**, y es a
 * propósito: el jugador ya está borrado y no se puede deshacer un borrado sin
 * inventar un "deshacer" que nadie pidió. Pero tampoco queda nada incoherente: los
 * puntos de cada jugador son de sus propias partidas, así que quitar a un jugador no
 * cambia los totales de los demás, y su fila de `PlayerScore` ya no existe. Lo único
 * pendiente es el rastro de `scoring.lastRun`, que se rellena en la siguiente
 * pasada. Por eso el estado devuelto es de **éxito con un aviso**: el borrado sí ha
 * pasado, y callarlo sería peor que decirlo.
 */
export async function deletePlayer(
  _prevState: AdminActionResult,
  formData: FormData,
): Promise<AdminActionResult> {
  const admin = await requireAdmin();
  const playerId = readField(formData, "playerId");

  if (!playerId) {
    return { status: "error", message: "No se ha podido saber qué jugador hay que borrar." };
  }

  let encontrado: {
    id: string;
    name: string;
    profileId: number;
    matchCount: number;
  } | null;

  try {
    const row = await db.player.findUnique({
      where: { id: playerId },
      select: {
        id: true,
        name: true,
        profileId: true,
        _count: { select: { matches: true } },
      },
    });

    encontrado =
      row === null
        ? null
        : {
            id: row.id,
            name: row.name,
            profileId: row.profileId,
            matchCount: row._count.matches,
          };
  } catch (error) {
    logDatabaseFailure("admin/deletePlayer", error);

    return { status: "error", message: SAVE_FAILED_MESSAGE };
  }

  if (encontrado === null) {
    return { status: "error", message: "Ese jugador ya no está en el panel." };
  }

  // `const` a propósito: se usa dentro de un cierre (la transacción) y TypeScript
  // solo estrecha un `let` si no puede haber sido reasignado entre medias.
  const player = encontrado;

  try {
    await db.$transaction(async (tx) => {
      await tx.player.delete({ where: { id: player.id } });

      await recordAdminAction(tx, {
        type: AdminActionType.PLAYER_REMOVED,
        actorEmail: actorEmail(admin),
        targetId: player.id,
        name: player.name,
        profileId: player.profileId,
        matchCount: player.matchCount,
      });
    });
  } catch (error) {
    logDatabaseFailure("admin/deletePlayer", error);

    return { status: "error", message: SAVE_FAILED_MESSAGE };
  }

  revalidatePath("/admin");

  const partidas =
    player.matchCount === 0
      ? "No tenía partidas guardadas."
      : `Sus ${player.matchCount} ${player.matchCount === 1 ? "partida" : "partidas"} se han borrado con ella.`;

  return {
    status: "success",
    message: frase(
      `Se ha eliminado a ${player.name} (AoE4World ${player.profileId}).`,
      partidas,
      await avisoDeRecalculo("admin/deletePlayer"),
    ),
  };
}

/* -------------------------------------------------------------------------- */
/* Puntos de una partida                                                       */
/* -------------------------------------------------------------------------- */

/** La partida tal y como la necesitan estas dos acciones. */
type MatchForScoring = {
  id: string;
  gameId: string;
  points: number;
  revertedAt: Date | null;
  /** Lo que `countsAsRanked()` necesita para decidir si la partida cuenta. */
  mode: string | null;
  result: MatchResult | null;
  startedAt: Date;
  finishedAt: Date | null;
  playerName: string;
  playerProfileId: number;
};

/**
 * Recalcula la clasificación y devuelve el aviso si no lo ha conseguido.
 *
 * No lanza, porque en `deletePlayer` el cambio **ya está escrito** y propagar el
 * error dejaría a quien lo pidió creyendo que no se aplicó nada cuando sí. El texto
 * va vacío cuando todo fue bien.
 */
async function avisoDeRecalculo(scope: string): Promise<string> {
  try {
    await recomputeScores();

    return "";
  } catch (error) {
    logDatabaseFailure(`${scope}/recompute`, error);

    return "La clasificación se recalculará sola en la próxima pasada del sincronizador.";
  }
}

/**
 * Vuelve a dejar la partida como estaba y borra la fila de `AdminAction` que esta
 * misma acción acaba de escribir.
 *
 * Es la compensación del revert, y va en **una** transacción para que el estado
 * final sea coherente: o la partida vuelve a puntuar y no queda rastro del intento,
 * o no se toca nada.
 *
 * Devuelve si se pudo. Un `false` significa que la base está en mal estado, y eso hay
 * que decirlo: es el único caso en el que el sistema queda en un estado que nadie
 * puede ver —una partida marcada cuya clasificación todavía la cuenta— y por eso el
 * mensaje de la acción lo dice en voz alta en vez de fingir que no ha pasado nada.
 */
async function deshacerMarcaDePartida(
  matchId: string,
  revertedAt: Date | null,
  actionId: string,
): Promise<boolean> {
  try {
    await db.$transaction(async (tx) => {
      await tx.match.update({ where: { id: matchId }, data: { revertedAt } });
      await tx.adminAction.delete({ where: { id: actionId } });
    });

    return true;
  } catch (error) {
    logDatabaseFailure("admin/deshacerMarca", error);

    return false;
  }
}

/**
 * Marca una partida como revertida (o quita la marca) y recalcula la clasificación.
 *
 * ## Por qué la marca y el recálculo no van en la misma transacción
 *
 * `recomputeScores()` es el motor entero: ruleset, `UPDATE` de `Match.points`,
 * objetivos, agregado y `PlayerScore`, con su cerrojo `pg_advisory_xact_lock` y su
 * plazo de 60 s. Meterlo en la transacción de la acción obligaría a mantener ese
 * cerrojo durante una escritura que no lo necesita (un `UPDATE` de una sola fila) y a
 * que el panel quedara detrás del cron cada vez que coincidieran. Se hacen seguidas,
 * y el estado intermedio dura lo que tarda el motor.
 *
 * ## Por qué un fallo del recálculo se compensa en vez de propagarse
 *
 * Porque `recomputeScores()` es **atómico**: si falla, su transacción ha deshecho todo
 * lo que escribía (`Match.points`, `PlayerScore`, `scoring.lastRun`), de modo que la
 * base está exactamente como estaba. Lo único que queda fuera de esa transacción es
 * la marca que se acaba de poner, y por eso la compensación deshace **esa** y borra
 * **su** fila de `AdminAction`: el estado final es el de antes del clic.
 *
 * La alternativa —propagar el error y dejar la partida marcada— dejaría el torneo en
 * un estado que nadie puede ver desde ningún sitio: el historial de acciones diría
 * "revertidos 10 puntos", la pestaña de partidas la mostraría marcada y la
 * clasificación pública seguiría contando esos 10 puntos. Y no durarían mucho: el
 * cron lo arreglaría en su siguiente pasada, pero mientras dure es una clasificación
 * que no cuadra con los datos que el propio panel enseña.
 *
 * Si la compensación **tampoco** sale (base caída de verdad) no hay más remedio que
 * decirlo, y el mensaje lo dice: la acción devuelve error y avisa de que la marca ha
 * quedado puesta y hay que revisarla a mano.
 */
async function setMatchReverted(
  formData: FormData,
  revert: boolean,
): Promise<AdminActionResult> {
  const admin = await requireAdmin();
  const scope = revert ? "admin/revertMatchPoints" : "admin/restoreMatchPoints";
  const matchId = readField(formData, "matchId");

  if (!matchId) {
    return { status: "error", message: "No se ha podido saber qué partida hay que cambiar." };
  }

  let encontrada: MatchForScoring | null;

  try {
    const row = await db.match.findUnique({
      where: { id: matchId },
      select: {
        id: true,
        gameId: true,
        points: true,
        revertedAt: true,
        mode: true,
        result: true,
        startedAt: true,
        finishedAt: true,
        player: { select: { name: true, profileId: true } },
      },
    });

    encontrada =
      row === null
        ? null
        : {
            id: row.id,
            gameId: row.gameId,
            points: row.points,
            revertedAt: row.revertedAt,
            mode: row.mode,
            result: row.result,
            startedAt: row.startedAt,
            finishedAt: row.finishedAt,
            playerName: row.player.name,
            playerProfileId: row.player.profileId,
          };
  } catch (error) {
    logDatabaseFailure(scope, error);

    return { status: "error", message: SAVE_FAILED_MESSAGE };
  }

  if (encontrada === null) {
    return { status: "error", message: "Esa partida ya no existe." };
  }

  if (revert && encontrada.revertedAt !== null) {
    return { status: "error", message: "La partida ya estaba revertida." };
  }

  if (!revert && encontrada.revertedAt === null) {
    return { status: "error", message: "La partida no estaba revertida." };
  }

  // `const` a propósito: se usa dentro de un cierre (la transacción) y TypeScript
  // solo estrecha un `let` si no puede haber sido reasignado entre medias.
  const match = encontrada;

  // La misma pregunta que se hace el motor, con la misma función: **una partida que
  // no cuenta no se puede revertir, y una que no contaría no se puede restaurar**.
  // Sin esto, un `FormData` hecho a mano podría dejar marcada para siempre una partida
  // que nunca llegó a puntuar, y el admin vería "revertida" en el histórico de algo que
  // en realidad nunca contó. Para el `restore` se pregunta con `revertedAt: null`, que
  // es lo que deja la decisión en las otras tres condiciones de la regla.
  const ruleset = await readRuleset();
  const contariaSinMarca = countsAsRanked({ ...match, revertedAt: null }, ruleset.window);
  const elCambioSirve = revert ? contariaSinMarca : !contariaSinMarca;

  if (!elCambioSirve) {
    return {
      status: "error",
      message: revert
        ? "Esa partida no es clasificatoria con las reglas actuales, así que no puntúa y no hay nada que revertir."
        : "Esa partida no era clasificatoria con las reglas actuales, así que restaurar sus puntos no cambia la clasificación.",
    };
  }

  /**
   * Los puntos que la partida tiene o recupera, según la dirección del cambio.
   *
   * En el `revert` es `Match.points`, que es justo lo que se está quitando. En el
   * `restore` **no** se puede leer de ahí, porque el motor puso esa fila a `0` al
   * revertirla: lo que vuelve a contar es lo que le corresponde según el ruleset
   * activo, que es la misma fórmula que escribe `recomputeScores()`. Con un ruleset
   * retocado entre medias, además, es el valor que de verdad va a aparecer.
   *
   * Va en el mismo valor para el rastro (`summary` y `details`) y para el mensaje que
   * ve quien lo pulsa, porque son la misma cifra contada desde dos sitios: si se
   * calcularan por separado, el historial y el mensaje acabarían discrepando.
   */
  const puntosDeLaPartida =
    revert ? match.points : match.result === MatchResult.WIN ? ruleset.pointsPerWin : 0;

  const marca = revert ? new Date() : null;
  let actionId: string;

  try {
    actionId = await db.$transaction(async (tx) => {
      await tx.match.update({ where: { id: match.id }, data: { revertedAt: marca } });

      return recordAdminAction(tx, {
        type: revert
          ? AdminActionType.MATCH_POINTS_REVERTED
          : AdminActionType.MATCH_POINTS_RESTORED,
        actorEmail: actorEmail(admin),
        targetId: match.id,
        playerName: match.playerName,
        profileId: match.playerProfileId,
        gameId: match.gameId,
        points: puntosDeLaPartida,
      });
    });
  } catch (error) {
    logDatabaseFailure(scope, error);

    return { status: "error", message: SAVE_FAILED_MESSAGE };
  }

  try {
    await recomputeScores();
  } catch (error) {
    logDatabaseFailure(`${scope}/recompute`, error);

    const compensado = await deshacerMarcaDePartida(match.id, match.revertedAt, actionId);

    return {
      status: "error",
      message: compensado
        ? "No se ha podido recalcular la clasificación, así que el cambio se ha deshecho: la partida sigue como estaba."
        : "No se ha podido recalcular la clasificación ni deshacer el cambio: la partida ha quedado marcada y hay que revisarla a mano. El motivo está en el log del servidor.",
    };
  }

  revalidatePath("/admin");

  return {
    status: "success",
    message: revert
      ? frase(
          `Se han revertido ${puntos(puntosDeLaPartida)} de la partida ${match.gameId} de ${match.playerName}.`,
          "La partida sigue en el histórico y se pueden volver a poner.",
        )
      : `Se han restaurado ${puntos(puntosDeLaPartida)} de la partida ${match.gameId} de ${match.playerName}.`,
  };
}

/**
 * Deja de puntuar una partida sin borrarla.
 *
 * La fila se queda en el histórico marcada con `revertedAt`, el motor la excluye de
 * los puntos, del agregado y de los objetivos, y el worker de sincronización no la
 * toca: una partida borrada volvería a aparecer en su siguiente pasada. Es reversible
 * con `restoreMatchPoints`.
 */
export async function revertMatchPoints(
  _prevState: AdminActionResult,
  formData: FormData,
): Promise<AdminActionResult> {
  return setMatchReverted(formData, true);
}

/** Quita la marca de `revertMatchPoints` y devuelve los puntos al torneo. */
export async function restoreMatchPoints(
  _prevState: AdminActionResult,
  formData: FormData,
): Promise<AdminActionResult> {
  return setMatchReverted(formData, false);
}
