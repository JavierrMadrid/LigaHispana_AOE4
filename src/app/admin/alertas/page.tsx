import type { Metadata } from "next";
import { EmptyState } from "@/components/empty-state";
import { requireAdmin } from "@/lib/auth";

export const metadata: Metadata = {
  title: { absolute: "Alertas · Admin" },
};

/**
 * Placeholder honesto de la pestaña de alertas.
 *
 * Esta pestaña es para **comportamientos anómalos de los participantes**: un
 * jugador que no cuadra con el resto, no el estado de un proceso. Y sigue sin
 * hacerse a propósito: todavía no está definido qué condiciones disparan una
 * alerta, ni qué cuenta como comportamiento extraño, así que no hay nada que leer.
 *
 * Inventar los avisos sería peor que no tenerlos: un contador o una alerta de
 * ejemplo enseñan un estado del torneo que no existe, y quien organize el torneo
 * acabaría tomando decisiones sobre él.
 *
 * Lo que **no** va aquí es el estado del sincronizador, que sí es salud del
 * sistema y no una alerta de jugador: ese vive en `getSyncHealth()` y se enseña
 * como aviso en `/admin`, la pestaña donde se trabaja. Ver README.md, "Ver si el
 * sincronizador está vivo".
 */
export default async function AlertsPage() {
  await requireAdmin();

  return (
    <div className="flex flex-col gap-6">
      <section>
        <h1 className="text-2xl font-semibold">Alertas</h1>
        <p className="mt-1 max-w-[70ch] text-sm text-muted">
          Avisos del torneo para la organización.
        </p>
      </section>

      <EmptyState
        title="Sección en desarrollo"
        body={
          <>
            Estamos definiendo qué avisos merece la pena vigilar (partidas sin
            resolver, jugadores sin sincronizar, resultados que no cuadran) y con
            qué reglas. Hasta entonces esta pestaña no muestra datos: no hay
            ninguna lectura que los alimente, así que aquí no verás ni contadores
            ni alertas de ejemplo.
          </>
        }
      />
    </div>
  );
}
