"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

/**
 * Refresco de la lista de partidas en juego.
 *
 * Hay dos refrescos, y no son lo mismo:
 *
 * - **El temporizador** (cada {@link REFRESH_MS}) solo vuelve a pedir la ruta al
 *   servidor con `router.refresh()`, que relee la base de datos. No toca la API
 *   de AoE4World: de traer partidas nuevas se encarga el Cron Trigger cada 5
 *   minutos. Se salta cuando la pestaña no está visible, para no interrogar la
 *   base desde pestañas en segundo plano.
 * - **El botón** lanza una pasada del sincronizador de verdad (`POST /api/sync`,
 *   el mismo trabajo que el cron) y después relee. Es para quien no quiere
 *   esperar al siguiente disparo. Como el endpoint tiene un candado global de un
 *   minuto, puede contestar que ya se ha actualizado hace un momento; eso no es
 *   un fallo y se dice tal cual, sin pintarlo como error.
 */

const REFRESH_MS = 75_000;

type ManualState = "idle" | "running" | "cooldown" | "error";

type ManualResponse = { status?: string };

const COOLDOWN_MESSAGE = "Se ha actualizado hace poco; inténtalo de nuevo en un rato.";
const ERROR_MESSAGE = "No se ha podido actualizar ahora mismo.";

export function LiveRefresh() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [state, setState] = useState<ManualState>("idle");

  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") {
        startTransition(() => router.refresh());
      }
    }, REFRESH_MS);

    return () => clearInterval(timer);
  }, [router, startTransition]);

  const syncNow = useCallback(async () => {
    setState("running");

    try {
      const response = await fetch("/api/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const body = (await response.json().catch(() => null)) as ManualResponse | null;

      if (body?.status === "cooldown") {
        setState("cooldown");

        return;
      }

      if (!response.ok || body?.status !== "ok") {
        setState("error");

        return;
      }

      setState("idle");
      startTransition(() => router.refresh());
    } catch {
      setState("error");
    }
  }, [router, startTransition]);

  const running = state === "running" || pending;
  const note = state === "cooldown" ? COOLDOWN_MESSAGE : state === "error" ? ERROR_MESSAGE : "";

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <button
        type="button"
        disabled={running}
        onClick={syncNow}
        className="inline-flex h-10 items-center rounded-md border border-line bg-surface px-3 text-sm text-foreground transition-colors hover:border-accent/50 hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
      >
        {running ? "Actualizando" : "Actualizar"}
      </button>
      {/* El hueco se queda siempre en el DOM: si apareciese y desapareciese, un
          lector de pantalla no anunciaría el cambio. */}
      <p
        role="status"
        aria-live="polite"
        className="max-w-[38ch] text-xs leading-relaxed text-muted"
      >
        {note}
      </p>
    </div>
  );
}
