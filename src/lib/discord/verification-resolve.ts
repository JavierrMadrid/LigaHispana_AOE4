import "server-only";

import { Prisma } from "@/generated/prisma/client";
import { PlayerStatus } from "@/generated/prisma/enums";
import { db } from "@/lib/db";
import { logDatabaseFailure, uniqueViolationOn } from "@/lib/db-errors";
import {
  resolveVerificationClick,
  verificationLinksDiscord,
  verificationResolvedText,
  verificationStaleText,
  type VerificationDecision,
} from "@/lib/discord/verification";

/**
 * Resolver la pulsación de un botón del privado de verificación (issue 119).
 *
 * ## La lectura, la decisión y la escritura
 *
 * Primero se busca la fila por el token del `custom_id`, que es lo único que
 * Discord devuelve. Con la fila delante se decide (`resolveVerificationClick()`,
 * puro): token vigente, cuenta destinataria y estado `PENDING`. Y la escritura va
 * por un **`updateMany` condicionado** al mismo token, estado y `verifiedAt`, no por
 * un `update` por id: dos pulsaciones simultáneas —o un reintento de Discord— no
 * pueden aplicar el cambio dos veces, porque la primera limpia el token y la
 * segunda ya no encuentra fila que actualizar. El primero que llega gana; el otro
 * recibe el texto genérico.
 *
 * ## El `discordUserId` que se escribe al confirmar
 *
 * `Player.discordUserId` solo lo firma Discord, y una pulsación desde la cuenta a la
 * que se mandó el privado **es** una firma: la interacción trae el id de quien
 * pulsó. Si la fila no tenía cuenta vinculada, se escribe; si ya la tenía, se deja
 * como estaba. Si esa cuenta está vinculada a **otro** participante, no se escribe
 * (la unicidad lo impediría) y se avisa: el alta se confirma igual, porque la
 * persona ha dicho que sí desde su cuenta, y el conflicto es un dato del panel que
 * la organización tiene que arreglar.
 *
 * ## Lo que no se hace aquí
 *
 * Ni puntuación ni roles: el jugador queda `APPROVED` y el worker de siempre lo
 * recogerá en la siguiente pasada. Tampoco se escribe `AdminAction`: la acción la
 * hizo la persona, no un admin, y `actorEmail` no tendría un correo que poner. El
 * rastro de la aprobación sin verificación del superadministrador sí se escribe, en
 * su propia acción.
 */

/** Lo que se contesta al botón, ya redactado. */
export type VerificationClickOutcome = {
  text: string;
  /** `approve`, `reject` o `stale`; el endpoint no lo necesita, los tests sí. */
  outcome: "approve" | "reject" | "stale";
};

/** Prefijo de todo lo que se registra desde este módulo. */
const LOG_PREFIX = "[discord-verification]";

/**
 * Aplica la respuesta de la persona y devuelve el texto con el que se edita el
 * privado. **Nunca lanza**: un fallo de base devuelve el texto genérico, porque el
 * endpoint tiene que contestar a Discord en menos de tres segundos o el botón se
 * queda girando.
 */
export async function handleVerificationClick(input: {
  decision: VerificationDecision;
  token: string;
  userId: string | null;
  now?: Date;
}): Promise<VerificationClickOutcome> {
  const now = input.now ?? new Date();

  if (input.userId === null) {
    return { outcome: "stale", text: verificationStaleText() };
  }

  let player: {
    id: string;
    name: string;
    status: PlayerStatus;
    discordUserId: string | null;
    discordVerificationUserId: string | null;
    discordVerificationRequestedAt: Date | null;
    discordVerifiedAt: Date | null;
  } | null;

  try {
    player = await db.player.findUnique({
      where: { discordVerificationToken: input.token },
      select: {
        id: true,
        name: true,
        status: true,
        discordUserId: true,
        discordVerificationUserId: true,
        discordVerificationRequestedAt: true,
        discordVerifiedAt: true,
      },
    });
  } catch (error) {
    logDatabaseFailure("discord-verification/leer", error);

    return { outcome: "stale", text: verificationStaleText() };
  }

  if (player === null) {
    return { outcome: "stale", text: verificationStaleText() };
  }

  const outcome = resolveVerificationClick({
    decision: input.decision,
    tokenMatches: true,
    senderMatches: player.discordVerificationUserId === input.userId,
    status: player.status,
    state: {
      requestedAt: player.discordVerificationRequestedAt,
      verifiedAt: player.discordVerifiedAt,
    },
  });

  if (outcome === "stale") {
    // Sin el token y sin datos de la cuenta: el nombre del jugador es lo único que
    // hace falta para saber por qué una pulsación no valía.
    console.warn(
      `${LOG_PREFIX} Pulsación descartada sobre ${player.name}: el botón no está vigente, no es de la cuenta destinataria o la fila ya no está pendiente.`,
    );

    return { outcome: "stale", text: verificationStaleText() };
  }

  const userId = input.userId;

  // La condición del `update` es la misma que la de la decisión: si algo cambió
  // entre la lectura y esta escritura, no se actualiza nada y la respuesta es la
  // genérica. Es lo que hace que dos pulsaciones seguidas no cuenten dos veces.
  const where = {
    id: player.id,
    discordVerificationToken: input.token,
    status: PlayerStatus.PENDING,
    discordVerificationRequestedAt: { not: null },
    discordVerifiedAt: null,
  };

  if (outcome === "reject") {
    try {
      const rechazados = await db.player.updateMany({
        where,
        data: {
          status: PlayerStatus.REJECTED,
          discordDeclinedAt: now,
          discordVerificationToken: null,
          discordVerificationUserId: null,
        },
      });

      // La carrera con otra pulsación (o con la resolución por el otro botón): si no
      // se ha actualizado ninguna fila, este botón ya no valía y se contesta lo
      // genérico, sin decir que se ha rechazado.
      if (rechazados.count === 0) {
        return { outcome: "stale", text: verificationStaleText() };
      }
    } catch (error) {
      logDatabaseFailure("discord-verification/rechazo", error);

      return { outcome: "stale", text: verificationStaleText() };
    }

    console.info(`${LOG_PREFIX} ${player.name} ha rechazado el alta desde su cuenta.`);

    return { outcome: "reject", text: verificationResolvedText("decline") };
  }

  let conflicto: { name: string } | null;

  try {
    conflicto = await db.player.findFirst({
      where: { discordUserId: userId, NOT: { id: player.id } },
      select: { name: true },
    });
  } catch (error) {
    logDatabaseFailure("discord-verification/conflicto", error);

    return { outcome: "stale", text: verificationStaleText() };
  }

  const base = verificationResolvedText("confirm");
  const nombreEnConflicto = conflicto === null ? null : conflicto.name;

  // `discordUserId` solo se escribe **si la fila no lo tenía**: si ya venía del
  // OAuth, esa es la identidad que firmó Discord y una pulsación no la sustituye.
  // El caso que sí se resuelve aquí es el alta de admin, que nace sin id.
  const vincular =
    player.discordUserId === null && verificationLinksDiscord(nombreEnConflicto);
  const conflictoTexto =
    player.discordUserId !== null || vincular
      ? ""
      : " No se ha podido vincular tu cuenta de Discord a este perfil porque ya está vinculada a otro participante; la organización lo revisará.";

  const confirmar = async (conCuenta: boolean): Promise<number> => {
    const resultado = await db.player.updateMany({
      where,
      data: {
        status: PlayerStatus.APPROVED,
        discordVerifiedAt: now,
        discordVerificationToken: null,
        discordVerificationUserId: null,
        ...(conCuenta ? { discordUserId: userId } : {}),
      },
    });

    return resultado.count;
  };

  try {
    const actualizados = await confirmar(vincular);

    if (actualizados === 0) {
      return { outcome: "stale", text: verificationStaleText() };
    }
  } catch (error) {
    // La carrera entre la comprobación de conflicto y la escritura: otra fila se
    // quedó la cuenta entre medias. No se pierde la confirmación, se aprueba sin
    // vincular y se dice lo mismo que si el conflicto se hubiera visto antes.
    if (error instanceof Prisma.PrismaClientKnownRequestError && uniqueViolationOn(error, "discordUserId")) {
      try {
        const actualizados = await confirmar(false);

        if (actualizados === 0) {
          return { outcome: "stale", text: verificationStaleText() };
        }
      } catch (reintento) {
        logDatabaseFailure("discord-verification/confirmacion", reintento);

        return { outcome: "stale", text: verificationStaleText() };
      }
    } else {
      logDatabaseFailure("discord-verification/confirmacion", error);

      return { outcome: "stale", text: verificationStaleText() };
    }
  }

  if (nombreEnConflicto !== null && player.discordUserId === null) {
    console.warn(
      `${LOG_PREFIX} ${player.name} ha confirmado el alta, pero su cuenta de Discord ya está vinculada a ${nombreEnConflicto}: no se ha escrito en la fila.`,
    );
  } else {
    console.info(`${LOG_PREFIX} ${player.name} ha confirmado el alta desde su cuenta.`);
  }

  return { outcome: "approve", text: base + conflictoTexto };
}
