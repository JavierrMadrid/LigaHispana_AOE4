"use client";

import { useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";

/**
 * Refresco automático de la lista de partidas en juego.
 *
 * Cada {@link REFRESH_MS} vuelve a pedir la ruta al servidor con `router.refresh()`,
 * que relee la base de datos. **No toca la API de AoE4World**: de traer partidas
 * nuevas se encargan el cron de Supabase y, en su defecto, la llamada manual del
 * panel de admin (`syncNow`), que es la única vía manual que queda. Aquí no hay
 * botón ni texto de actualización.
 *
 * Se salta cuando la pestaña no está visible, para no interrogar la base desde
 * pestañas en segundo plano.
 */

const REFRESH_MS = 75_000;

export function LiveRefresh() {
  const router = useRouter();
  const [, startTransition] = useTransition();

  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") {
        startTransition(() => router.refresh());
      }
    }, REFRESH_MS);

    return () => clearInterval(timer);
  }, [router, startTransition]);

  return null;
}
