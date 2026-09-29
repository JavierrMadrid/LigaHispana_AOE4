"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";

const REFRESH_MS = 75_000;

/**
 * Refresco de la lista de partidas en juego.
 *
 * `router.refresh()` vuelve a pedir la ruta al servidor y vuelve a renderizar sus
 * Server Components, que es justo lo que hace falta porque la lista sale de la
 * base de datos en cada petición. El temporizador se salta cuando la pestaña no
 * está visible, para no interrogar la base de datos desde pestañas en segundo
 * plano.
 */
export function LiveRefresh() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") {
        startTransition(() => router.refresh());
      }
    }, REFRESH_MS);

    return () => clearInterval(timer);
  }, [router, startTransition]);

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => startTransition(() => router.refresh())}
      className="inline-flex h-10 items-center rounded-md border border-line bg-surface px-3 text-sm text-foreground transition-colors hover:border-accent/50 hover:text-accent disabled:opacity-50"
    >
      {pending ? "Actualizando" : "Actualizar"}
    </button>
  );
}