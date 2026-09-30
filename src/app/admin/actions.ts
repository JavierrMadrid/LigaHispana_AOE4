"use server";

import type { User } from "@supabase/supabase-js";
import type { SyncSummary } from "@/lib/aoe4world/sync";
import type { ManualSyncLock } from "@/lib/manual-sync";
import { revalidatePath } from "next/cache";
import { AdminActionType, MatchResult, PlayerStatus } from "@/generated/prisma/enums";
import { puntos, recordAdminAction } from "@/lib/admin-actions";
import { reevaluatePlayerAlerts } from "@/lib/alerts/evaluate";
import { syncApprovedPlayers } from "@/lib/aoe4world/sync";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { logDatabaseFailure } from "@/lib/db-errors";
import { consumeManualSyncLock, MANUAL_SYNC_COOLDOWN_SECONDS } from "@/lib/manual-sync";
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
  /**
   * Lo que pasó **después** del alta, cuando el alta sí se hizo.
   *
   * No es un error: el jugador está dado de alta sí o sí. Es para que el panel
   * diga si ya sale en la clasificación, y sobre todo para el caso que más
   * confunde: un jugador aprobado **sin ninguna partida clasificatoria** no tiene
   * fila en `PlayerScore` y por tanto no aparece (P-02 del modelo de datos). Sin
   * este aviso, el `—` de la columna de puntos parece un fallo.
   */
  message: string | null;
};

/* -------------------------------------------------------------------------- */
/* Utilidades                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Trae las partidas de un jugador recién aprobado y lo deja ranked al momento.
 *
 * Sin esto, dar de alta a alguien no lo mete en la clasificación: la web lee
 * `PlayerScore`, y esa tabla solo la rellena el sincronizador, que pasa cada 5
 * minutos. Un jugador recién añadido se quedaba hasta la siguiente pasada sin
 * aparecer, y con el sincronizador caído **no aparecía nunca**: el `—` de la
 * columna de puntos no distingue "todavía no le ha tocado" de "no le va a tocar".
 *
 * Recalcular **solo** no arregla nada, y es la parte que no es obvia: sin partidas
 * importadas el `groupBy` de `recomputeScores()` no ve al jugador, así que no le
 * crea fila. Hay que traer primero sus partidas de AoE4World, y el recálculo va
 * dentro de la misma pasada (`syncApprovedPlayers` lo llama al final).
 *
 * La pasada es solo de este jugador (`profileIds`), no de todo el torneo.
 *
 * Devuelve `""` cuando todo fue bien y un aviso cuando no. **Nunca lanza**: el
 * alta ya está escrita y desheacerla dejaría al jugador sin alta por un problema
 * puntual de la API externa, que es peor que un alta que tarda unos minutos más
 * en verse. Es el mismo criterio que `avisoDeRecalculo()` en el borrado.
 */
async function llevarAClasificacion(
  scope: string,
  player: { id: string; profileId: number; name: string },
): Promise<string> {
  const altaHecha = `Se ha dado de alta a ${player.name}.`;

  try {
    const summary = await syncApprovedPlayers({ profileIds: [player.profileId] });
    const jugados = summary.players[0];

    if (summary.scoringError !== null) {
      return frase(
        altaHecha,
        `No se ha podido recalcular la clasificación (${summary.scoringError}).`,
        "Aparecerá en cuanto el sincronizador lo consiga.",
      );
    }

    // `!== "ok"` y no `=== "failed"`: una pasada cancelada por plazo
    // (`status: "cancelled"`) tampoco ha traído nada, y si no se distingue
    // acabaría diciendo "no tiene partidas clasificatorias", que es mentira.
    if (jugados === undefined || jugados.status !== "ok") {
      return frase(
        altaHecha,
        `No se han podido traer sus partidas de AoE4World: ${
          jugados?.error ?? "la pasada se quedó sin tiempo."
        }`,
        "Aparecerá en cuanto el sincronizador lo consiga.",
      );
    }

    // La condición de aparecer en la clasificación es exactamente tener fila en
    // `PlayerScore`, así que se pregunta a esa tabla y no se reimplementa la regla.
    const fila = await db.playerScore.findFirst({
      where: { playerId: player.id },
      select: { rank: true, total: true },
    });

    if (fila === null) {
      return frase(
        altaHecha,
        "Todavía no tiene ninguna partida clasificatoria, así que aún no sale en la clasificación.",
        "En cuanto cierre su primera aparecería con su puesto y sus puntos.",
      );
    }

    return frase(
      altaHecha,
      `Ya está en la clasificación: puesto ${fila.rank} con ${fila.total} ${
        fila.total === 1 ? "punto" : "puntos"
      }.`,
    );
  } catch (error) {
    logDatabaseFailure(`${scope}/sync`, error);

    return frase(
      altaHecha,
      "No se han podido traer sus partidas.",
      "Aparecerá en la clasificación en cuanto el sincronizador lo consiga.",
    );
  }
}

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
 *
 * Si el jugador queda **aprobado**, después del alta se le traen sus partidas y se
 * recalcula la clasificación, para que salga en la tabla en cuanto se pulse el
 * botón y no en la siguiente pasada del sincronizador. Va fuera de la transacción
 * a propósito: traer las partidas es una llamada a AoE4World de varios segundos, y
 * meterla dentro dejaría la fila bloqueada todo ese rato.
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
    return { error: "El profile ID de AoE4World debe ser un número.", message: null };
  }

  if (!name) {
    return { error: "El nombre es obligatorio (máx. 64 caracteres).", message: null };
  }

  // El `try` cubre **solo** la base de datos. Un fallo de validación tiene que
  // seguir siendo un error de aplicación, y por eso el bloque va aquí y no
  // alrededor de la acción entera.
  let nuevo: { id: string; profileId: number; name: string } | null = null;

  try {
    const existing = await db.player.findUnique({ where: { profileId } });

    if (existing) {
      return {
        error: `El perfil ${profileId} ya está registrado (${existing.name}).`,
        message: null,
      };
    }

    await db.$transaction(async (tx) => {
      const created = await tx.player.create({
        data: { profileId, name, twitchChannel, status: status as PlayerStatus },
        select: { id: true },
      });

      nuevo = { id: created.id, profileId, name };

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

    return { error: SAVE_FAILED_MESSAGE, message: null };
  }

  revalidatePath("/admin");

  // Solo si queda aprobado: un pendiente o un rechazado no debe traer partidas ni
  // recalcular, porque `recomputeScores()` los deja fuera de la clasificación igual.
  if (status !== PlayerStatus.APPROVED || nuevo === null) {
    return {
      error: null,
      message:
        status === PlayerStatus.PENDING
          ? `Se ha dado de alta a ${name} como pendiente. Al aprobarlo se traerán sus partidas y aparecerá en la clasificación.`
          : null,
    };
  }

  const message = await llevarAClasificacion("admin/createPlayer", nuevo);

  // Otra vez, y no por descuido: el panel saca los puntos de `PlayerScore`, y esa
  // tabla no cambia hasta que la pasada de arriba ha recalculado. Revalidar solo
  // antes dejaría la fila con `—` aunque el jugador ya esté en la clasificación.
  revalidatePath("/admin");

  return { error: null, message };
}

/* -------------------------------------------------------------------------- */
/* Aprobar y rechazar                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Aprueba o rechaza una solicitud.
 *
 * Estas dos **no** registran acción en `AdminAction` y por eso mantienen la firma
 * simple de un solo `FormData`: son botones que cambian una fila que solo mira el
 * panel. Cuando la pestaña de acciones quiera mostrarlas hay que añadir su tipo al
 * enum, su frase en `admin-actions.ts` y pasar estas dos a `AdminActionResult`.
 *
 * Aprobar **sí** tiene efecto en lo que ve el público, y por eso es la única de las
 * dos que hace trabajo de más: al pasar a `APPROVED` el jugador entra en el
 * sincronizador, así que se le traen sus partidas y se recalcula la clasificación.
 * Sin eso, aprobar una solicitud de `/participar` lo dejaría invisible hasta la
 * siguiente pasada. No hay estado de vuelta que informar —el botón no lleva
 * diálogo— así que un fallo solo se registra, y el alta ya está escrita.
 */
async function setPlayerStatus(playerId: string, status: PlayerStatus) {
  await requireAdmin();

  if (!playerId) {
    return;
  }

  let jugador: { id: string; profileId: number; name: string } | null = null;

  try {
    const row = await db.player.update({
      where: { id: playerId },
      data: { status },
      select: { id: true, profileId: true, name: true },
    });

    jugador = row;
  } catch (error) {
    // Sin estado de vuelta, un fallo aquí solo puede registrarse: la acción termina
    // sin cambiar nada y no hay superficie en la que informar a quien la pulsó.
    logDatabaseFailure(`admin/${status}`, error);

    return;
  }

  if (status === PlayerStatus.APPROVED && jugador !== null) {
    const aviso = await llevarAClasificacion("admin/approvePlayer", jugador);

    if (aviso !== "") {
      console.warn(`[admin/approvePlayer] ${aviso}`);
    }
  }

  // Al final, no antes: aprobar también recalcula, y los puntos del panel salen de
  // la tabla que esa pasada acaba de reescribir.
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
  /** `Player.id` de la fila afectada: las alertas se reevalúan por id, no por `profileId`. */
  playerId: string;
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
        playerId: true,
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
            playerId: row.playerId,
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

  /**
   * La misma pregunta que se hace el motor, con la misma función, y **la misma
   * respuesta en los dos sentidos**: solo tiene sentido tocar una partida que cuenta.
   * Al revertir, porque es lo que se le quita; al restaurar, porque es lo que vuelve.
   * Se pregunta siempre con `revertedAt: null`, que es lo que deja la decisión en las
   * otras tres condiciones de la regla.
   *
   * Sin esta guarda, un `FormData` hecho a mano podría dejar marcada para siempre una
   * partida que nunca llegó a puntuar, y el admin vería "revertida" en el histórico de
   * algo que en realidad nunca contó.
   *
   * Que el criterio sea el mismo en ambos sentidos es deliberado. Con la guarda
   * invertida al restaurar, ninguna partida clasificatoria se podía devolver: se
   * exigía que no contara. El revert quedaba sin vuelta desde el panel.
   */
  const ruleset = await readRuleset();
  const contariaSinMarca = countsAsRanked({ ...match, revertedAt: null }, ruleset.window);

  if (!contariaSinMarca) {
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

  // La partida ya no cuenta (o vuelve a contar) y eso cambia el conjunto de
  // clasificatorias del jugador, así que sus rachas y sus acumulados también
  // cambian. Va **después** del recálculo y fuera de su compensación a propósito:
  // las alertas son un informe derivado y append-only, y un fallo suyo no deja
  // nada a medias —lo que no habría pasado si se evaluaran antes de confirmar el
  // cambio—. Si falla, la siguiente pasada del sincronizador lo arregla, y lo
  // dice `reevaluatePlayerAlerts` en el log.
  await reevaluatePlayerAlerts(match.playerId);

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

/* -------------------------------------------------------------------------- */
/* Sincronización a mano                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Estado de `syncNow`.
 *
 * No reutiliza `AdminActionResult` porque esta necesita un tercer estado: el candado
 * puede responder "ahora no" sin que sea un fallo —la pasada se hizo hace nada—, y
 * quien lo lee tiene que distinguir "no he podido sincronizar" de "no hacía falta".
 */
export type SyncNowState = {
  status: "idle" | "success" | "cooldown" | "error";
  message: string | null;
};

/**
 * Minutos que dice el mensaje de cooldown.
 *
 * Salen de la constante del candado y no de un número escrito a mano, para que el texto
 * no pueda mentir si algún día cambia la ventana. Ver `src/lib/manual-sync.ts`.
 */
const MINUTOS_DE_CANDADO = MANUAL_SYNC_COOLDOWN_SECONDS / 60;

/**
 * Lanza una pasada del sincronizador a mano, para cuando el cron no llega.
 *
 * Es la **única** vía manual que queda: el botón de `/partidas` se retiró y la llamada
 * pasó aquí, detrás de `requireAdmin()`. Eso no es una comodidad —recuperar un torneo
 * congelado es una operación de la organización— y además es lo que evita tener un
 * botón público que cualquiera pueda machacar. `/api/sync` no se cierra: sigue siendo el
 * disparo del cron de Supabase, sin cambios.
 *
 * ## Por qué comparte candado con el cron
 *
 * Es el mismo candado global de `/api/sync` (`src/lib/manual-sync.ts`), y no uno
 * propio. Con dos candados, un admin podía encadenar pasadas seguidas mientras el cron
 * seguía creyendo que su ventana estaba libre: el trabajo real —las peticiones a la API
 * de AoE4World y el presupuesto de CPU del plan Free— lo pagan las dos, y el candado
 * compartido es lo que impide que se apilen. El precio es que la cadencia real del
 * torneo sigue siendo la de un sync cada 5-10 minutos, no mejor.
 *
 * ## Por qué no registra `AdminAction`
 *
 * Porque la pasada ya deja un rastro más completo: `Setting["sync.lastRun"]` guarda los
 * contadores, los errores y los jugadores que no se pudieron sincronizar, y es lo que
 * alimenta el aviso de salud de `/admin`. Una fila en el historial de acciones por cada
 * pasada sería ruido: esto no cambia el torneo, solo lo consulta.
 *
 * ## Por qué no declara parámetros
 *
 * Porque no lee ni un campo del formulario ni el estado anterior: el botón no tiene nada
 * que mandar. Sigue siendo la acción que espera `useActionState` —devuelve el estado
 * nuevo y React refresca la ruta—, porque una función sin parámetros es asignable a la
 * que la pide.
 */
export async function syncNow(): Promise<SyncNowState> {
  await requireAdmin();

  let lock: ManualSyncLock;

  try {
    lock = await consumeManualSyncLock();
  } catch (error) {
    // Sin candado comprobado **no** se lanza la pasada. Al revés, el botón sería una
    // forma de pedir tantas pasadas como se pulsara, que es justo lo que el candado
    // existe para impedir. El motivo se queda en el log; a quien lo pulsó solo le
    // llega que ahora no se puede.
    console.error(
      "[admin/syncNow] No se ha podido comprobar el candado del sync manual:",
      error instanceof Error ? error.message : String(error),
    );

    return {
      status: "error",
      message:
        "No se ha podido comprobar si toca sincronizar. Inténtalo de nuevo en unos minutos.",
    };
  }

  if (!lock.allowed) {
    // No es un error: la pasada ya se hizo hace nada, así que tampoco hacía falta otra.
    // Por eso tiene su propio estado y no se pinta como fallo.
    return {
      status: "cooldown",
      message: `Se ha sincronizado hace poco; el candado deja una pasada cada ${MINUTOS_DE_CANDADO} minutos.`,
    };
  }

  let summary: SyncSummary;

  try {
    // La pasada son ~15 s de llamadas a AoE4World más el recálculo, así que el botón
    // tiene que aguantar en estado de "pendiente" ese rato. Es normal que tarde: no es
    // una escritura de formulario corta.
    summary = await syncApprovedPlayers();
  } catch (error) {
    // `syncApprovedPlayers()` no propaga ni el fallo de un jugador ni el del recálculo:
    // los deja en el resumen. Lo que llega aquí es que la pasada no se pudo hacer
    // (configuración o base de datos), y entonces el rastro tampoco se ha escrito.
    console.error(
      "[admin/syncNow] La pasada manual ha fallado:",
      error instanceof Error ? error.message : String(error),
    );

    return {
      status: "error",
      message: "No se ha podido sincronizar ahora mismo. El motivo está en el log del servidor.",
    };
  }

  // Al final, no antes: la pasada acaba de reescribir `PlayerScore` y `sync.lastRun`, que
  // son justo las dos cosas que pinta `/admin` (los contadores y el aviso de salud del
  // sincronizador).
  revalidatePath("/admin");

  const segundos = Math.round(summary.durationMs / 1000);

  return {
    status: "success",
    message: frase(
      `Pasada terminada en ${segundos} s.`,
      // Con cero aprobados la frase de "3 de 3 sincronizados" sería mentira de rigor:
      // no se ha sincronizado a nadie porque no hay a quién.
      summary.playersTotal === 0
        ? "No hay jugadores aprobados que sincronizar."
        : `${summary.playersOk} de ${summary.playersTotal} jugadores sincronizados.`,
      summary.playersFailed > 0
        ? `${summary.playersFailed} no se han podido sincronizar; están en el aviso de esta misma pestaña.`
        : "",
      `${summary.newMatches} ${summary.newMatches === 1 ? "partida nueva" : "partidas nuevas"}.`,
      // Un fallo del recálculo no da la vuelta atrás el trabajo ya hecho —las partidas
      // están guardadas— así que es un éxito con aviso, no un `error`. El motivo literal
      // no se enseña: ya lo registra el worker, y aquí solo hace falta que se sepa que la
      // clasificación que se ve es la anterior.
      summary.scoringError !== null
        ? "No se ha podido recalcular la clasificación, así que la web sigue enseñando la anterior: se reintentará en la próxima pasada."
        : "",
    ),
  };
}
