import type { Metadata } from "next";
import { EmptyState } from "@/components/empty-state";
import { requireAdmin } from "@/lib/auth";

export const metadata: Metadata = {
  title: { absolute: "Alertas · Admin" },
};

/**
 * Placeholder honesto de la pestaña de alertas.
 *
 * No se pinta ningún contador ni ninguna alerta de ejemplo porque no hay nada
 * que leer: el DAL del panel (`src/lib/admin.ts`) no tiene ninguna consulta que
 * las sustente y fabricarla sería mostrar un dato que no existe. Cuando existan,
 * se escribirá su lectura con el mismo contrato que el resto.
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
