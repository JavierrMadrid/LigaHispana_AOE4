import "server-only";

import { db } from "@/lib/db";
import { logDatabaseFailure } from "@/lib/db-errors";
import { resolveDiscordAccount, postDirectMessage } from "@/lib/discord/dm";
import {
  getDiscordConfig,
  isDiscordVerificationConfigured,
} from "@/lib/discord/env";
import { createDiscordHttpClient } from "@/lib/discord/http";
import { verificationDmMessage } from "@/lib/discord/verification";
import { readEditionConfig } from "@/lib/edition";

/**
 * El envío del privado que pide confirmar un alta de administración (issue 119).
 *
 * ## Qué hace, en orden, y por qué en ese orden
 *
 * 1. Comprueba que la verificación está configurada. Si no, no hay nada que hacer
 *    y el alta sigue el camino de siempre.
 * 2. Resuelve la cuenta de Discord: `discordUserId` si lo hay, y si no el
 *    `@usuario` contra el roster cacheado (la misma resolución que los avisos).
 *    Sin cuenta no se puede mandar, y eso **no es un fallo global**: se devuelve el
 *    motivo para que el panel lo diga y la fila se queda como estaba.
 * 3. Comprueba que esa cuenta no esté ya vinculada a **otro** participante. Si lo
 *    está, no se manda: el botón de un privado es una identidad, y mandárselo a una
 *    cuenta que ya es de otra fila abriría la puerta a aprobar la fila equivocada.
 * 4. Genera el token, lo guarda y manda el privado. El token se escribe **antes**
 *    de la llamada para que una pulsación rapidísima encuentre fila; si el envío
 *    falla, se limpia otra vez, junto con `sentAt` (el privado anterior deja de
 *    valer en cuanto se rota el token).
 * 5. Escribe `sentAt` solo si Discord ha aceptado el mensaje.
 *
 * ## Lo que no se guarda, y lo que no se loguea
 *
 * El token **no aparece en ningún log ni en ningún mensaje del panel**. Es la única
 * llave para **encontrar** la fila desde la interacción, y aunque resolverla exija
 * además la cuenta destinataria y que la fila siga `PENDING`, dejarlo en el log del
 * Worker (que tiene acceso público) no tiene ningún sentido. Los mensajes que se
 * devuelven al panel hablan de la cuenta y del motivo, no del token.
 *
 * ## Un fallo de envío no pierde la fila
 *
 * El alta ya está escrita cuando se llama aquí. Si Discord falla, `requestedAt`
 * sigue informado y el privado se puede **reenviar** desde el panel
 * (`resendPlayerVerification`); lo que no se hace es dejar un token vivo de un
 * mensaje que no existe.
 */

/** Lo que hace falta del jugador para mandarle el privado. */
export type VerificationTarget = {
  id: string;
  name: string;
  profileId: number;
  discordUserId: string | null;
  discordUsername: string | null;
};

/**
 * El resultado del envío.
 *
 * `ok: false` no significa que el alta haya fallado: significa que el privado no
 * salió, y `message` es el motivo ya redactado para que el panel lo enseñe tal cual.
 */
export type VerificationSendResult =
  | { ok: true }
  | { ok: false; message: string };

/** Prefijo de todo lo que se registra desde este módulo. */
const LOG_PREFIX = "[discord-verification]";

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Manda el privado de verificación a un jugador y deja la fila lista para recibir
 * la respuesta. **Nunca lanza**: todo lo que puede fallar se devuelve como
 * `ok: false` con su motivo, porque quien llama está a mitad de una acción de
 * administración y no puede tumbar la petición por un fallo de Discord.
 */
export async function sendPlayerVerificationDm(
  player: VerificationTarget,
  now: Date = new Date(),
): Promise<VerificationSendResult> {
  const config = getDiscordConfig();

  if (!isDiscordVerificationConfigured(config)) {
    return {
      ok: false,
      message:
        "La verificación de altas no está configurada: faltan la clave pública, el client ID o las credenciales del bot de Discord.",
    };
  }

  const account = await resolveDiscordAccount(player, LOG_PREFIX);

  if (account === null) {
    const detalle =
      player.discordUsername === null
        ? "la fila no tiene cuenta de Discord"
        : `no se ha encontrado @${player.discordUsername} en el roster del servidor`;

    return {
      ok: false,
      message: `No se ha podido resolver la cuenta de Discord de ${player.name}: ${detalle}.`,
    };
  }

  // La unicidad de `discordUserId` es lo que impide que dos filas se disputen la
  // misma cuenta; la comprobación aquí convierte el `P2002` en un mensaje que dice
  // con quién choca.
  let conflicto: { name: string } | null;

  try {
    conflicto = await db.player.findFirst({
      where: { discordUserId: account, NOT: { id: player.id } },
      select: { name: true },
    });
  } catch (error) {
    logDatabaseFailure("discord-verification/cuenta", error);

    return {
      ok: false,
      message: "No se ha podido comprobar la cuenta de Discord. Inténtalo de nuevo en unos minutos.",
    };
  }

  if (conflicto !== null) {
    return {
      ok: false,
      message: `Esa cuenta de Discord ya está vinculada a ${conflicto.name}. Corrige el @usuario antes de verificar el alta.`,
    };
  }

  let edition: Awaited<ReturnType<typeof readEditionConfig>>;

  try {
    edition = await readEditionConfig();
  } catch (error) {
    logDatabaseFailure("discord-verification/edicion", error);

    return {
      ok: false,
      message: "No se ha podido leer el nombre de la edición. Inténtalo de nuevo en unos minutos.",
    };
  }

  const token = crypto.randomUUID();

  try {
    await db.player.update({
      where: { id: player.id },
      data: {
        discordVerificationToken: token,
        discordVerificationUserId: account,
      },
    });
  } catch (error) {
    logDatabaseFailure("discord-verification/token", error);

    return {
      ok: false,
      message: "No se ha podido preparar el privado de verificación. Inténtalo de nuevo en unos minutos.",
    };
  }

  try {
    await postDirectMessage(
      createDiscordHttpClient(config),
      config.botToken,
      account,
      verificationDmMessage(
        { editionName: edition.name, playerName: player.name, profileId: player.profileId },
        token,
      ),
    );
  } catch (error) {
    // Se deshace el token y la cuenta: un botón que no ha llegado no puede quedar
    // como una verificación a medias. `requestedAt` no se toca, así que el panel
    // puede reenviar.
    //
    // `sentAt` se limpia también, y no es un detalle: al rotar el token, los botones
    // del privado **anterior** dejan de valer, así que dejarlo informado haría que
    // aprobar contestara "esperando confirmación" sobre un mensaje que ya no puede
    // resolver nada. Sin `sentAt`, el siguiente aprobar manda uno nuevo.
    try {
      await db.player.update({
        where: { id: player.id },
        data: {
          discordVerificationToken: null,
          discordVerificationUserId: null,
          discordVerificationSentAt: null,
        },
      });
    } catch (cleanupError) {
      logDatabaseFailure("discord-verification/limpieza", cleanupError);
    }

    console.error(
      `${LOG_PREFIX} No se ha podido mandar el privado de verificación a ${player.name} (AoE4World ${player.profileId}): ${describe(error)}`,
    );

    return {
      ok: false,
      message:
        "No se ha podido enviar el privado de verificación. Revisa que el bot pueda escribir a esa cuenta y reinténtalo con «Reenviar verificación».",
    };
  }

  try {
    await db.player.update({
      where: { id: player.id },
      data: { discordVerificationSentAt: now },
    });
  } catch (error) {
    // El mensaje ya está en Discord y el token es válido: perder `sentAt` solo
    // significa que el panel no sabe que se mandó y volverá a intentarlo. No es un
    // fallo del envío y no se deshace nada.
    logDatabaseFailure("discord-verification/sentAt", error);
  }

  console.info(
    `${LOG_PREFIX} Privado de verificación enviado a ${player.name} (AoE4World ${player.profileId}).`,
  );

  return { ok: true };
}
