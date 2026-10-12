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
 * Los 150 s no son arbitrarios: la frescura de los datos la marca el sync (cada
 * 10 minutos), así que sondear más a menudo no adelanta nada, y cada refresco es
 * una render dinámica con consultas a Postgres dentro del presupuesto de CPU del
 * plan Free (ver `docs/OPERACION.md`, "El límite de CPU del plan Free").
 *
 * Se salta cuando la pestaña no está visible, para no interrogar la base desde
 * pestañas en segundo plano.
 *
 * Con `showStatus` pinta además «Actualizado a las …», y la hora que enseña es
 * `dataUpdatedAt`: el `finishedAt` de la última pasada del sincronizador, que
 * llega del servidor. **No** es la hora del refresco del navegador: esa diría
 * cuándo se pidió la página, no cuándo se tocaron los datos, y son cosas
 * distintas. Como el valor es una prop, cada `router.refresh()` lo trae al día
 * solo, sin que el cliente lleve ninguna cuenta.
 *
 * Es opcional porque en `/partidas` el temporizador va suelto y no debe ocupar
 * sitio; en la portada sí interesa, para que el recuento de partidas en juego no
 * envejezca en silencio.
 *
 * `dataUpdatedAt` en `null` significa "no hay hora que enseñar" —nunca se ha
 * registrado una pasada, o su lectura falló— y entonces se dice que sigue sin
 * actualizar en vez de inventar una hora. La frase se formatea ya en cliente y no
 * en el servidor porque `toLocaleTimeString` usa la zona del navegador: el render
 * de servidor y el primero de cliente pintan `null`, y el texto aparece tras
 * montar, así que la hidratación no se desajusta.
 */

const REFRESH_MS = 150_000;

export function LiveRefresh({
  showStatus = false,
  dataUpdatedAt = null,
}: {
  /** Pinta «Actualizado a las …» con la hora de la última pasada. */
  showStatus?: boolean;
  /** `finishedAt` ISO de la última pasada registrada, o `null` si no hay ninguna. */
  dataUpdatedAt?: string | null;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    // El texto se enciende ya en cliente, un fotograma después de montar: el
    // `setState` va ahí y no en el cuerpo del efecto porque el linter lo marca
    // como render en cascada. En el render de servidor y en el primero de
    // cliente sigue siendo `null`.
    const frame = requestAnimationFrame(() => setMounted(true));

    const timer = setInterval(() => {
      if (document.visibilityState === "visible") {
        startTransition(() => router.refresh());
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
      {!mounted
        ? null
        : dataUpdatedAt === null
          ? "Sin actualizar todavía"
          : `Actualizado a las ${new Date(dataUpdatedAt).toLocaleTimeString("es-ES", {
              hour: "2-digit",
              minute: "2-digit",
            })}`}
    </span>
  );
}
