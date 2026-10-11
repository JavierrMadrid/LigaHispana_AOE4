"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

/**
 * Refresco automático de la lista de partidas en juego.
 *
 * Cada {@link REFRESH_MS} vuelve a pedir la ruta al servidor con `router.refresh()`,
 * que relee la base de datos. **No toca la API de AoE4World**: de traer partidas
 * nuevas se encargan el cron de Supabase y, en su defecto, la llamada manual del
 * panel de admin (`syncNow`), que es la única vía manual que queda.
 *
 * Se salta cuando la pestaña no está visible, para no interrogar la base desde
 * pestañas en segundo plano.
 *
 * Con `showStatus` pinta además la hora del último refresco. Es opcional porque
 * en `/partidas` el temporizador va suelto y no debe ocupar sitio; en la portada
 * sí interesa, para que el recuento de partidas en juego no envejezca en
 * silencio. El estado arranca en `null` —nada de texto— y se rellena ya en el
 * cliente tras montar, para que el render de servidor y el primero de cliente
 * coincidan y la hora local (`es-ES`) no rompa la hidratación.
 */

const REFRESH_MS = 75_000;

export function LiveRefresh({ showStatus = false }: { showStatus?: boolean }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  useEffect(() => {
    // La primera marca es la del montaje: la página acaba de leer los datos. Va
    // en un `requestAnimationFrame` y no en el cuerpo del efecto para no provocar
    // un render en cascada síncrono; el valor sigue siendo `null` en el render de
    // servidor y en el primero de cliente.
    const frame = requestAnimationFrame(() => setUpdatedAt(new Date()));

    const timer = setInterval(() => {
      if (document.visibilityState === "visible") {
        startTransition(() => router.refresh());
        setUpdatedAt(new Date());
      }
    }, REFRESH_MS);

    return () => {
      cancelAnimationFrame(frame);
      clearInterval(timer);
    };
  }, [router, startTransition]);

  if (!showStatus) {
    return null;
  }

  return (
    <span className="text-xs text-muted">
      {updatedAt === null
        ? null
        : `Actualizado a las ${updatedAt.toLocaleTimeString("es-ES", {
            hour: "2-digit",
            minute: "2-digit",
          })}`}
    </span>
  );
}
