import "server-only";

import type { PlayerStatus } from "@/generated/prisma/enums";
import {
  adminNoticeChannelText,
  adminNoticeDmText,
  adminNoticePlan,
  type AdminNotice,
} from "@/lib/admin-notices";
import {
  openDmChannel,
  postToChannel,
  resolveDiscordAccount,
  type DiscordDmTarget,
} from "@/lib/discord/dm";
import { getDiscordConfig } from "@/lib/discord/env";
import { createDiscordHttpClient } from "@/lib/discord/http";
import { readEditionConfig } from "@/lib/edition";
import { postChannelMessage } from "@/lib/edition-announcements";
import { readCloudflareContext } from "@/lib/runtime-env";
import { readPublicOrigin } from "@/lib/site-url";

/**
 * El envío de los avisos de administración (issue 56, fase 4).
 *
 * ## Dos mensajes, best-effort, y nunca bloquean la acción
 *
 * `dispatchAdminNotice()` se llama **después** de que la acción haya ido bien (si la
 * transacción falla, no hay nada que avisar) y no espera: en el Worker se apunta con
 * `ctx.waitUntil()`, que alarga la invocación para que el envío termine sin que el
 * administrador espere; fuera del Worker (desarrollo, tests) se lanza y se sigue. En los
 * dos casos el aviso va envuelto para que un fallo **nunca** cambie el resultado que ve
 * el administrador: el motivo queda en el log con el prefijo `[admin-notice]`.
 *
 * ## Qué se manda
 *
 * Un **privado** a la persona afectada y un **global** al canal de avisos, cada uno por
 * su cuenta (ver `adminNoticePlan()`): si no hay cuenta resoluble no hay privado, y si no
 * hay canal no hay global, sin que uno dependa del otro. El privado son **dos** llamadas
 * de la API: abrir el canal del DM (`POST /users/@me/channels`) y publicar en él. El
 * global reutiliza `postChannelMessage()` de `edition-announcements.ts`, que es la misma
 * llamada que ya usan los demás avisos del canal.
 *
 * ## La cuenta de Discord
 *
 * La normal es `discordUserId` (la firma el OAuth). Si solo hay `@usuario` (alta de
 * admin), se resuelve contra el **roster cacheado** con `matchRosterUsername()`, la
 * misma resolución que usa la comprobación de pertenencia; sin roster, o si el nombre no
 * cuadra o es ambiguo, no hay cuenta y **no hay privado**, sin que sea un fallo.
 *
 * ## Los datos se capturan antes del cambio
 *
 * Quien llama pasa el nombre, el estado y las columnas de Discord **leídos antes** de
 * borrar la fila o de tocar la partida: este módulo no vuelve a mirar al jugador, porque
 * en la baja la fila ya no existe. El nombre de la edición y el dominio sí se leen aquí
 * (son baratos y no cambian con la acción).
 */

/** La persona afectada, con lo que hace falta para resolver su cuenta de Discord. */
export type AdminNoticeTarget = DiscordDmTarget;

/**
 * Las tres piezas de un privado se comparten con la verificación de altas
 * (`src/lib/discord/dm.ts`); se reexportan porque ya las importaban los avisos de
 * las actuaciones (`admin-act-notice-send.ts`) y no hay razón para cambiar su sitio
 * de importación.
 */
export { openDmChannel, postToChannel, resolveDiscordAccount };

/** Lo que hay que avisar, tal y como lo pide la acción. */
export type AdminNoticeRequest = {
  kind: "player-removed";
  player: AdminNoticeTarget & { status: PlayerStatus };
  matchCount: number;
};

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : `Error desconocido: ${String(error)}`;
}

/** El `AdminNotice` del módulo puro a partir de lo que ha pedido la acción. */
function toNotice(request: AdminNoticeRequest, editionName: string): AdminNotice {
  return {
    kind: "player-removed",
    editionName,
    name: request.player.name,
    status: request.player.status,
    matchCount: request.matchCount,
  };
}

/**
 * Manda los dos avisos que toquen. **Nunca lanza.**
 *
 * Sin token del bot sale antes de resolver nada. El resto lo decide `adminNoticePlan()`:
 * el privado necesita cuenta y el global canal, cada uno por su cuenta. Los fallos de
 * cada envío se quedan en el log y no impiden el otro.
 */
async function notifyAdminAction(request: AdminNoticeRequest): Promise<void> {
  const config = getDiscordConfig();

  if (config.botToken === null) {
    return;
  }

  const botToken = config.botToken;

  const account = await resolveDiscordAccount(request.player);
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
  const notice = toNotice(request, edition.name);
  const destinatario = request.player.name;

  if (plan.channel && config.announceChannelId !== null) {
    try {
      await postChannelMessage(
        client,
        { ...config, botToken, announceChannelId: config.announceChannelId },
        adminNoticeChannelText(notice, readPublicOrigin()),
      );
    } catch (error) {
      console.error(
        `[admin-notice] No se ha podido avisar en el canal de la acción sobre ${destinatario}: ${toErrorMessage(error)}`,
      );
    }
  }

  if (plan.dm && account !== null) {
    try {
      const dmChannelId = await openDmChannel(client, botToken, account);

      await postToChannel(client, botToken, dmChannelId, adminNoticeDmText(notice));
    } catch (error) {
      console.error(
        `[admin-notice] No se ha podido avisar por privado a ${destinatario}: ${toErrorMessage(error)}`,
      );
    }
  }
}

/**
 * Lanza el aviso **sin bloquear** la acción de administración.
 *
 * En el Worker se apunta a `ctx.waitUntil()`, que es lo que hace que el envío termine sin
 * que el administrador espere a Discord. Fuera del Worker (desarrollo, verificación con
 * datos) se deja correr; el aviso nunca lanza (todo va envuelto en `notifyAdminAction`),
 * así que no hay promesa que rechazar sin dueño.
 */
export function dispatchAdminNotice(request: AdminNoticeRequest): void {
  const promise = notifyAdminAction(request).catch((error) => {
    console.error(`[admin-notice] Fallo inesperado al avisar: ${toErrorMessage(error)}`);
  });

  const ctx = readCloudflareContext()?.ctx;

  if (ctx !== undefined) {
    ctx.waitUntil(promise);

    return;
  }

  void promise;
}
