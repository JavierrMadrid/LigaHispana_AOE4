import type { Metadata } from "next";
import { EmptyState } from "@/components/empty-state";
import { ObjectivesBrowser } from "@/components/objectives-browser";
import { PageHead } from "@/components/page-head";
import { getObjectives, MASTERIZAR_TODOS_ID, OBJECTIVE_GROUP_LABELS } from "@/lib/public";

export const metadata: Metadata = {
  title: "Objetivos especiales",
  description:
    "Los 38 objetivos especiales de la Liga Hispana de Age of Empires IV: cuánta puntuación reparte cada uno y quién lo posee ahora mismo.",
};

// Los poseedores cambian en cada recálculo del worker. Sin esto la página se
// generaría en el `next build` y la foto de quién posee cada objetivo se
// quedaría congelada.
export const dynamic = "force-dynamic";

export default async function ObjectivesPage() {
  const read = await getObjectives();

  // `data` es `null` cuando la base de datos no ha podido leer. El catálogo de
  // los 38 objetivos está en el código, pero **quién posee cada uno** solo está
  // en la base, así que sin datos no hay nada que pintar: ni siquiera la tabla
  // vacía, que diría que nadie posee nada.
  const objectives = read.status === "ok" ? read.data : null;

  return (
    <div className="flex flex-col gap-8">
      <PageHead title="Objetivos especiales" />
      {objectives === null ? (
        <EmptyState
          title="No se han podido cargar los objetivos"
          body="El catálogo de los 38 objetivos está en el código, pero quién posee cada uno vive en la base de datos, y ahora mismo no ha respondido. Vuelve a cargar la página en unos minutos."
        />
      ) : (
        <ObjectivesBrowser
          options={objectives.options}
          groupLabels={OBJECTIVE_GROUP_LABELS}
          minimums={objectives.minimums}
          masterizarTodosId={MASTERIZAR_TODOS_ID}
        />
      )}
    </div>
  );
}
