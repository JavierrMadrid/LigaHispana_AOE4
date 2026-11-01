import "server-only";

import {
  adminActChannelText,
  adminActDmText,
  type AdminActKind,
} from "@/lib/admin-acts";
import {
  openDmChannel,
  postToChannel,
  resolveDiscordAccount,
  type DiscordDmTarget,
} from "@/lib/discord/dm";
import { adminNoticePlan } from "@/lib/admin-notices";
import { getDiscordConfig } from "@/lib/discord/env";
import { createDiscordHttpClient } from "@/lib/discord/http";
import { readEditionConfig } from "@/lib/edition";
import { postChannelMessage } from "@/lib/edition-announcements";
import { readCloudflareContext } from "@/lib/runtime-env";
import { readPublicOrigin } from "@/lib/site-url";

/**
 * Envío de los avisos de las actuaciones administrativas.
 *
 * Una actuación se anuncia **siempre** que se aplica: al canal de avisos y por
 * privado a la persona afectada. No es el aviso de un cambio cualquiera: es la
 * comunicación de una decisión con su razón pública.
 *
 * ## Solo la razón pública
 *
 * El texto lo arma `src/lib/admin-acts.ts`, cuya firma **no admite** la información
 * privada: este módulo no la recibe y no tiene forma de mandarla. El DM lleva la misma
 * razón que el canal; lo privado se queda en el panel.
 *
 * ## Best-effort, después del commit y sin bloquear
 *
 * Se llama después de que la actuación esté escrita y el recálculo se haya intentado.
 * En el Worker se apunta a `ctx.waitUntil()`; fuera, se deja correr. Un fallo de
 * Discord queda en el log con el prefijo `[admin-act-notice]` y **no** cambia el
 * resultado que ve el administrador: sin token, canal o cuenta, la actuación se aplica
 * igual y lo único que pasa es que no se avisa.
 */

/** La persona afectada, con lo que hace falta para resolver su cuenta de Discord. */
export type AdminActNoticeTarget = DiscordDmTarget;

/** Lo que hay que avisar de una actuación, ya decidido por el servicio. */
export type AdminActNoticeRequest = {
  kind: AdminActKind;
  player: AdminActNoticeTarget;
  /** La única razón que puede salir del panel. */
  publicReason: string;
  /** Partidas anuladas; en una reversión, total afectado. */
  matchCount: number;
  /** Actuaciones revertidas (solo `REVERSAL`). */
  targetCount: number;
  /** Resúmenes públicos de las actuaciones revertidas (solo `REVERSAL`). */
  targetSummaries: readonly string[];
};

/** Prefijo del log de este módulo, el que se pasa a la resolución de la cuenta. */
const LOG_PREFIX = "[admin-act-notice]";

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : `Error desconocido: ${String(error)}`;
}

/**
 * Manda los dos avisos que toquen. **Nunca lanza.**
 *
 * Sin token del bot sale antes de resolver nada. El privado necesita una cuenta
 * resoluble y el global un canal, cada uno por su cuenta: que falte uno no impide el
 * otro. Los fallos de cada envío se quedan en el log y no impiden el otro.
 */
async function notifyAdminAct(request: AdminActNoticeRequest): Promise<void> {
  const config = getDiscordConfig();

  if (config.botToken === null) {
    return;
  }

  const botToken = config.botToken;

  const account = await resolveDiscordAccount(request.player, LOG_PREFIX);
  const plan = adminNoticePlan({
    hasToken: true,
    hasAccount: account !== null,
    hasChannel: config.announceChannelId !== null,
  });

  if (!plan.dm && !plan.channel) {
    return;
  }

  const edition = await readEditionConfig();
  const client = createDiscordHttpClient(config);
  const notice = {
    kind: request.kind,
    editionName: edition.name,
    playerName: request.player.name,
    publicReason: request.publicReason,
    matchCount: request.matchCount,
    targetCount: request.targetCount,
    targetSummaries: request.targetSummaries,
    url: readPublicOrigin(),
  };
  const destinatario = request.player.name;

  if (plan.channel && config.announceChannelId !== null) {
    try {
      await postChannelMessage(
        client,
        { ...config, botToken, announceChannelId: config.announceChannelId },
        adminActChannelText(notice),
      );
    } catch (error) {
      console.error(
        `${LOG_PREFIX} No se ha podido avisar en el canal de la actuación sobre ${destinatario}: ${toErrorMessage(error)}`,
      );
    }
  }

  if (plan.dm && account !== null) {
    try {
      const dmChannelId = await openDmChannel(client, botToken, account);

      await postToChannel(client, botToken, dmChannelId, adminActDmText(notice));
    } catch (error) {
      console.error(
        `${LOG_PREFIX} No se ha podido avisar por privado a ${destinatario}: ${toErrorMessage(error)}`,
      );
    }
  }
}

/**
 * Lanza el aviso **sin bloquear** la actuación.
 *
 * En el Worker se apunta a `ctx.waitUntil()`, que es lo que hace que el envío termine
 * sin que el administrador espere. Fuera del Worker (desarrollo, verificación con
 * datos) se deja correr; el aviso nunca lanza, así que no hay promesa que rechazar sin
 * dueño.
 */
export function dispatchAdminActNotice(request: AdminActNoticeRequest): void {
  const promise = notifyAdminAct(request).catch((error) => {
    console.error(`${LOG_PREFIX} Fallo inesperado al avisar: ${toErrorMessage(error)}`);
  });

  const ctx = readCloudflareContext()?.ctx;

  if (ctx !== undefined) {
    ctx.waitUntil(promise);

    return;
  }

  void promise;
}
