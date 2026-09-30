"use client";

import { useActionState } from "react";
import { syncNow, type SyncNowState } from "./actions";

const initialState: SyncNowState = { status: "idle", message: null };

/**
 * Botón de la llamada manual del sincronizador.
 *
 * Es la única vía manual que queda: el botón de `/partidas` se retiró y la pasada
 * se pide desde aquí (`syncNow`, detrás de `requireAdmin()`). Sirve para cuando el
 * cron no llega, y por eso no pide confirmación: no es destructiva.
 *
 * El resultado vive en un `role="status"` que **siempre** está en el DOM, aunque
 * esté vacío. Si apareciese y desapareciese, un lector de pantalla no anunciaría el
 * cambio, que es el mismo criterio que traía el refresco de `/partidas`. El color
 * distingue el fallo (`--loss`) del éxito (`--win`) sin gritar, y el estado
 * `cooldown` se queda en neutro porque no es un error: la pasada se hizo hace nada.
 *
 * La pasada consulta AoE4World y tarda alrededor de 15 segundos, así que mientras
 * está en curso el mensaje lo dice: dejar un "guardando" seco haría pensar que se ha
 * colgado.
 */
export function SyncNowButton() {
  const [state, formAction, pending] = useActionState(syncNow, initialState);

  const tone = pending
    ? "text-muted"
    : state.status === "error"
      ? "text-loss"
      : state.status === "success"
        ? "text-win"
        : "text-muted";

  const message = pending
    ? "Sincronizando con AoE4World; la pasada puede tardar alrededor de 15 segundos."
    : (state.message ?? "");

  return (
    <div className="flex flex-col gap-2">
      <form action={formAction}>
        <button
          type="submit"
          disabled={pending}
          className="h-10 rounded-md border border-line-strong px-3 text-xs text-foreground transition-colors hover:border-accent/50 hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending ? "Sincronizando…" : "Sincronizar ahora"}
        </button>
      </form>
      <p
        role="status"
        aria-live="polite"
        className={`max-w-[70ch] text-xs leading-relaxed ${tone}`}
      >
        {message}
      </p>
    </div>
  );
}
