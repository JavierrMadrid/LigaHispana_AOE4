"use client";

import { useActionState } from "react";
import type { AdminActionResult } from "@/app/admin/actions";
import { sendTestAnnouncement } from "./actions";
import { StatusLine } from "./fields";

const initialState: AdminActionResult = { status: "idle", message: null };

const BUTTON_CLASS =
  "h-10 rounded-md border border-line-strong px-4 text-sm text-foreground transition-colors hover:border-accent/60 hover:text-accent disabled:cursor-not-allowed disabled:opacity-60";

/**
 * Prueba del canal de avisos del bot.
 *
 * Los dos avisos reales —comienzo y final— se mandan solos, una vez, cuando el
 * reloj cruza su fecha; esto solo comprueba que el canal está bien puesto. Manda
 * el texto **real** del aviso, con el prefijo `(Prueba)`, para que lo que se ve
 * en el canal sea cómo va a quedar el mensaje de verdad.
 *
 * Cada aviso es su propio formulario con el `kind` en un campo oculto, como el
 * resto de controles del panel: así lo que viaja no depende de que el navegador
 * adjunte el botón pulsado, y el `pending` compartido deshabilita los dos
 * mientras uno viaja.
 */
export function AnnouncementsForm() {
  const [state, formAction, pending] = useActionState(sendTestAnnouncement, initialState);

  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      <p className="max-w-[70ch] text-xs leading-relaxed text-muted">
        La prueba no se anota como enviada, así que no impide que el aviso de verdad
        salga cuando le toque. Si el bot no está configurado en el despliegue, la
        prueba lo dirá en lugar de enviar nada.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <form action={formAction}>
          <input type="hidden" name="kind" value="start" />
          <button type="submit" disabled={pending} className={BUTTON_CLASS}>
            Probar el aviso de inicio
          </button>
        </form>

        <form action={formAction}>
          <input type="hidden" name="kind" value="end" />
          <button type="submit" disabled={pending} className={BUTTON_CLASS}>
            Probar el aviso de final
          </button>
        </form>
      </div>

      <div className="mt-4">
        <StatusLine state={state} pending={pending} pendingLabel="Enviando la prueba…" />
      </div>
    </div>
  );
}
