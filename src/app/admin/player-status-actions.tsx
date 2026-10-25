"use client";

import { useActionState, useState } from "react";
import {
  approvePlayer,
  approvePlayerWithoutVerification,
  rejectPlayer,
  resendPlayerVerification,
  type AdminActionResult,
} from "@/app/admin/actions";
import { useActionFeedback } from "@/components/action-feedback";
import { ConfirmAction } from "@/components/confirm-action";
import type { AdminParticipant } from "@/lib/admin";
import { canApproveWithoutVerification } from "./participant-verification";

const IDLE: AdminActionResult = { status: "idle", message: null };

/** Lo que se dice si una acción falla sin mensaje propio: nunca un fallo mudo. */
const GENERIC_ERROR = "No se ha podido completar la acción.";

const TONES = {
  approve: "border-win/40 text-win hover:bg-win/10",
  accent: "border-accent/40 text-accent hover:bg-accent/10",
  neutral: "border-line-strong text-muted hover:bg-surface-raised hover:text-foreground",
} as const;

type Tone = keyof typeof TONES;

/**
 * Los botones de estado de una fila, en un solo sitio.
 *
 * Los usan el listado de participantes (cliente) y la cola de pendientes
 * (servidor), y por eso viven aquí: si cada pantalla compusiera los suyos, una
 * podría ofrecer «Aprobar» en un alta que no se aprueba con eso, que es justo el
 * error que esta funcionalidad introduce. El reparto es el mismo en las dos:
 *
 * | Fila | Acciones |
 * |---|---|
 * | Pendiente con la verificación en curso | «Reenviar/Enviar verificación», «Rechazar» y, solo el superadministrador, «Aprobar sin verificación» |
 * | Pendiente sin verificación | «Aprobar» y «Rechazar» |
 * | Aprobada | «Rechazar» |
 * | Rechazada | «Aprobar» o, si la fila conserva la puerta, «Aprobar y verificar»: el privado sale al aprobar y el alta sigue pendiente |
 *
 * Un alta sujeta **no** ofrece «Aprobar»: aprobarla no la aprueba, solo manda el
 * privado, así que el botón que sí hace algo es el de reenviar. La aprobación
 * directa existe, pero como lo que es —una renuncia del superadministrador— y con
 * confirmación por delante.
 *
 * El **error se queda en la fila**, pegado al botón que lo provocó, porque un aviso
 * en la banda de arriba puede quedar fuera de la vista en una tabla larga; el
 * **éxito viaja a la banda**, igual que en `ConfirmAction`, porque la fila cambia de
 * estado (o desaparece de la cola) y el mensaje tiene que sobrevivir a eso.
 */
export function PlayerStatusActions({
  player,
  canReverse,
  align = "end",
}: {
  player: AdminParticipant;
  /** `getAdminAccess() === "superadmin"`: habilita «Aprobar sin verificación». */
  canReverse: boolean;
  /** A qué lado se pegan los botones: en el listado a la derecha, en la cola a la izquierda. */
  align?: "start" | "end";
}) {
  const [error, setError] = useState<string | null>(null);
  const end = align === "end";

  // Un expulsado no se aprueba ni se rechaza desde aquí: su salida es revertir la
  // actuación. El listado ya lo aparta (`BANNED` tiene su propio bloque), y esto
  // evita que un uso nuevo pinte botones que el servidor va a denegar.
  if (player.status === "BANNED") {
    return null;
  }

  // Una fila rechazada que conserva la puerta vuelve a pedir confirmación al
  // aprobarse: el privado anterior ya no vale. Por eso el botón no dice «Aprobar»
  // a secas —no aprueba, manda el privado y deja el alta pendiente— sino «Aprobar y
  // verificar», y el `title` lo remata.
  const approveSendsVerification =
    player.status === "REJECTED" &&
    player.discordVerificationRequestedAt !== null &&
    player.discordVerifiedAt === null;

  return (
    <div className={`flex flex-col gap-2 ${end ? "items-end" : "items-start"}`}>
      <div
        className={`flex flex-wrap items-center gap-2 ${end ? "justify-end" : "justify-start"}`}
      >
        {player.discordVerificationPending ? (
          <>
            <StatusActionButton
              action={resendPlayerVerification}
              playerId={player.id}
              label={
                player.discordVerificationSentAt !== null
                  ? "Reenviar verificación"
                  : "Enviar verificación"
              }
              title={
                player.discordVerificationSentAt === null
                  ? "Manda a la persona el privado de Discord para que confirme que participa."
                  : "Manda un privado nuevo; los botones del anterior dejan de valer."
              }
              tone="accent"
              onError={setError}
            />

            {canApproveWithoutVerification(player, canReverse) ? (
              <ConfirmAction
                action={(_previous, formData) =>
                  approvePlayerWithoutVerification(formData)
                }
                fields={{ playerId: player.id }}
                title="Aprobar sin verificación"
                body={
                  <>
                    El alta de {player.name} quedará aprobada sin que la persona haya
                    confirmado por privado que participa, y entrará en la clasificación en
                    la próxima pasada del sincronizador.
                    <span className="mt-2 block text-xs text-muted">
                      Queda registrado en el historial como «Aprobación sin verificación».
                    </span>
                  </>
                }
                triggerLabel="Aprobar sin verificación"
                triggerClassName="h-10 whitespace-nowrap rounded-md border border-line-strong px-3 text-xs text-muted transition-colors hover:bg-surface-raised hover:text-foreground"
                confirmLabel="Aprobar sin verificación"
                confirmPendingLabel="Aprobando…"
                confirmClassName="bg-accent text-accent-ink hover:bg-accent-strong"
              />
            ) : null}

            <StatusActionButton
              action={rejectPlayer}
              playerId={player.id}
              label="Rechazar"
              title={
                player.discordVerificationSentAt === null
                  ? undefined
                  : "El privado enviado deja de valer."
              }
              tone="neutral"
              onError={setError}
            />
          </>
        ) : player.status === "PENDING" ? (
          <>
            <StatusActionButton
              action={approvePlayer}
              playerId={player.id}
              label="Aprobar"
              title="Entra en la clasificación en la próxima pasada del sincronizador."
              tone="approve"
              onError={setError}
            />
            <StatusActionButton
              action={rejectPlayer}
              playerId={player.id}
              label="Rechazar"
              tone="neutral"
              onError={setError}
            />
          </>
        ) : player.status === "APPROVED" ? (
          <StatusActionButton
            action={rejectPlayer}
            playerId={player.id}
            label="Rechazar"
            tone="neutral"
            onError={setError}
          />
        ) : (
          <StatusActionButton
            action={approvePlayer}
            playerId={player.id}
            label={approveSendsVerification ? "Aprobar y verificar" : "Aprobar"}
            title={
              approveSendsVerification
                ? "Al aprobar se le mandará un privado de Discord y el alta seguirá pendiente hasta que confirme."
                : "Entra en la clasificación en la próxima pasada del sincronizador."
            }
            tone="approve"
            onError={setError}
          />
        )}
      </div>

      {error !== null ? (
        <p role="alert" className="max-w-[26rem] text-left text-xs leading-relaxed text-loss">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Un botón de estado: un `<form>` de una Server Action con el `playerId` en un campo
 * oculto.
 *
 * Usa `useActionState` con un adaptador porque las acciones devuelven
 * `AdminActionResult` y no cambian de firma por esto. Mientras viaja, el botón se
 * deshabilita y pasa a «…», como `PendingButton`: son varios segundos contra Discord
 * cuando hay privado de por medio y dos clics seguidos no pueden encolar dos envíos.
 */
function StatusActionButton({
  action,
  playerId,
  label,
  title,
  tone,
  onError,
}: {
  action: (formData: FormData) => Promise<AdminActionResult>;
  playerId: string;
  label: string;
  title?: string;
  tone: Tone;
  onError: (message: string | null) => void;
}) {
  const report = useActionFeedback();
  const [, formAction, pending] = useActionState(runAction, IDLE);

  async function runAction(
    _previous: AdminActionResult,
    formData: FormData,
  ): Promise<AdminActionResult> {
    const result = await action(formData);

    if (result.status === "error") {
      onError(result.message ?? GENERIC_ERROR);
    } else if (result.status === "success") {
      onError(null);

      if (result.message !== null) {
        report({ tone: "success", message: result.message });
      }
    }

    return result;
  }

  return (
    <form action={formAction}>
      <input type="hidden" name="playerId" value={playerId} />
      <button
        type="submit"
        disabled={pending}
        title={title}
        className={`h-10 whitespace-nowrap rounded-md border px-3 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${TONES[tone]}`}
      >
        {pending ? "…" : label}
      </button>
    </form>
  );
}
