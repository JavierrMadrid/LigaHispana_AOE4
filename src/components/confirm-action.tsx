"use client";

import { useActionState, useState, type ReactNode } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useActionFeedback } from "@/components/action-feedback";

/**
 * Forma del estado que devuelve una acción con confirmación. Es la misma que
 * publica `AdminActionResult`, declarada aquí para que el componente no dependa
 * del módulo de acciones del panel.
 */
export type ActionResult = {
  status: "idle" | "success" | "error";
  message: string | null;
};

const IDLE: ActionResult = { status: "idle", message: null };

type ConfirmActionProps = {
  action: (state: ActionResult, formData: FormData) => Promise<ActionResult>;
  /** Campos ocultos que viajan con el envío (el id del jugador o de la partida). */
  fields: Record<string, string>;
  /** Texto del botón que abre el diálogo. */
  triggerLabel: string;
  triggerClassName: string;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  confirmPendingLabel: string;
  confirmClassName: string;
};

/**
 * Botón que pide confirmación antes de ejecutar una Server Action.
 *
 * Reúne las tres piezas de cualquier acción destructiva del panel: el disparador,
 * el diálogo y el estado de la acción. El resultado se pinta donde toca: el
 * **error se queda dentro del diálogo**, sin cerrarlo, para que se lea junto al
 * botón que lo provocó y se pueda reintentar; el **éxito cierra** el diálogo y su
 * mensaje viaja a la banda de avisos, que sobrevive a que la fila desaparezca.
 *
 * El cierre por éxito se hace dentro de la propia acción y no en un `useEffect`
 * que observara su resultado: eso evita el `setState` sincrónico dentro de un
 * efecto, que dispara renders en cascada. Y no se refresca la ruta a mano: las
 * acciones llaman a `revalidatePath`, y desde Next.js 16 la respuesta de la
 * Server Action ya viene con la ruta actual re-renderizada en el servidor, así
 * que un `router.refresh()` encima solo repetiría el viaje.
 */
export function ConfirmAction({
  action,
  fields,
  triggerLabel,
  triggerClassName,
  title,
  body,
  confirmLabel,
  confirmPendingLabel,
  confirmClassName,
}: ConfirmActionProps) {
  const [open, setOpen] = useState(false);
  const report = useActionFeedback();

  const [state, formAction, pending] = useActionState(runAction, IDLE);

  async function runAction(
    _previous: ActionResult,
    formData: FormData,
  ): Promise<ActionResult> {
    const result = await action(IDLE, formData);

    if (result.status === "success") {
      setOpen(false);

      if (result.message !== null) {
        report({ tone: "success", message: result.message });
      }
    }

    return result;
  }

  const error = state.status === "error" ? state.message : null;

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={triggerClassName}>
        {triggerLabel}
      </button>

      <ConfirmDialog open={open} onClose={() => setOpen(false)} title={title} pending={pending}>
        <form action={formAction} className="flex flex-col gap-4">
          {Object.entries(fields).map(([name, value]) => (
            <input key={name} type="hidden" name={name} value={value} />
          ))}

          <p className="text-sm leading-relaxed text-muted">{body}</p>

          {error !== null ? (
            <p
              role="alert"
              className="rounded-md border border-loss/40 bg-loss/5 px-3 py-2 text-sm leading-relaxed text-loss"
            >
              {error}
            </p>
          ) : null}

          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              data-autofocus
              disabled={pending}
              onClick={() => setOpen(false)}
              className="h-10 rounded-md border border-line px-3 text-sm text-foreground transition-colors hover:border-line-strong disabled:cursor-not-allowed disabled:opacity-60"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={pending}
              className={`h-10 rounded-md px-4 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${confirmClassName}`}
            >
              {pending ? confirmPendingLabel : confirmLabel}
            </button>
          </div>
        </form>
      </ConfirmDialog>
    </>
  );
}
