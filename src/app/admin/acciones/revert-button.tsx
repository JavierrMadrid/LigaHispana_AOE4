"use client";

import { ConfirmAction } from "@/components/confirm-action";
import { revertAdminAction } from "@/app/admin/administracion/actions";
import type { AdminActionType } from "@/generated/prisma/enums";

/**
 * Botón de "Deshacer" de una fila del historial de acciones.
 *
 * Solo lo pinta la página cuando quien mira es el superadministrador y la fila
 * es de un tipo que se puede deshacer y todavía no lo está; la decisión la toma
 * el servidor con `isRevertibleActionType()`, que es la misma regla que aplica
 * `revertAdminAction()`. Aquí solo queda el cromo y el aviso.
 *
 * El aviso de un **alta** es distinto y más fuerte a propósito: deshacerla no
 * devuelve un estado anterior, borra al jugador y todo lo suyo, y eso no se
 * puede recuperar. Las demás devuelven lo que había.
 */
export function RevertButton({
  actionId,
  type,
}: {
  actionId: string;
  type: AdminActionType;
}) {
  const esAlta = type === "PLAYER_CREATED";

  return (
    <ConfirmAction
      action={revertAdminAction}
      fields={{ actionId }}
      title="Deshacer esta acción"
      body={
        esAlta ? (
          <>
            Se deshará el alta: el jugador y todo lo suyo —sus partidas, sus objetivos
            y su estado de sincronización— se borrarán. Deshacer un alta no se puede
            recuperar.
          </>
        ) : (
          <>
            Se devolverá el estado que había antes de esta acción y se anotará la
            reversión en el historial. La acción original quedará marcada como
            deshecha.
          </>
        )
      }
      triggerLabel="Deshacer"
      triggerClassName="h-10 whitespace-nowrap rounded-md border border-loss/40 px-3 text-xs text-loss transition-colors hover:bg-loss/10"
      confirmLabel="Deshacer"
      confirmPendingLabel="Deshaciendo…"
      confirmClassName="bg-loss text-accent-ink hover:brightness-110"
    />
  );
}
