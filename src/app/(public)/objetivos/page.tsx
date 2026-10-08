import type { Metadata } from "next";
import { EmptyState } from "@/components/empty-state";
import { ObjectivesBrowser } from "@/components/objectives-browser";
import { PageHead } from "@/components/page-head";
import { getObjectives, getStandings, OBJECTIVE_GROUP_LABELS } from "@/lib/public";

export const metadata: Metadata = {
  title: "Objetivos especiales",
  description:
    "Los objetivos especiales de la Liga Hispana de Age of Empires IV: cuánta puntuación reparte cada uno y quién lo cobra ahora mismo.",
};

// Los cobradores cambian en cada recálculo del worker. Sin esto la página se
// generaría en el `next build` y la foto de quién cobra cada objetivo se
// quedaría congelada.
export const dynamic = "force-dynamic";

export default async function ObjectivesPage() {
  // El catálogo de objetivos y la clasificación del torneo salen de dos lecturas
  // independientes: la segunda es la que da el listado completo de participantes
  // que "Ver completados" cruza con el check.
  const [read, standingsRead] = await Promise.all([getObjectives(), getStandings()]);

  // `data` es `null` cuando la base de datos no ha podido leer. El catálogo de
  // objetivos está en el código, pero **quién los cobra** solo está en la base,
  // así que sin datos no hay nada que pintar: ni siquiera la tabla vacía, que
  // diría que nadie cobra nada.
  const objectives = read.status === "ok" ? read.data : null;
  const standings =
    standingsRead.status === "ok" && standingsRead.data !== null
      ? standingsRead.data.map((row) => ({
          profileId: row.profileId,
          name: row.name,
          avatarUrl: row.avatarUrl,
          profileUrl: row.profileUrl,
        }))
      : null;

  return (
    <div className="flex flex-col gap-8">
      <PageHead title="Objetivos especiales" />
      {objectives === null ? (
        <EmptyState
          title="No se han podido cargar los objetivos"
          body="El catálogo de objetivos está en el código, pero quién cobra cada uno vive en la base de datos, y ahora mismo no ha respondido. Vuelve a cargar la página en unos minutos."
        />
      ) : (
        <ObjectivesBrowser
          options={objectives.options}
          groupLabels={OBJECTIVE_GROUP_LABELS}
          standings={standings}
          mapPool={objectives.mapPool}
        />
      )}
    </div>
  );
}
