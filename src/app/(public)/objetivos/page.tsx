import type { Metadata } from "next";
import { ObjectivesBrowser } from "@/components/objectives-browser";
import { PageHead } from "@/components/page-head";
import { getObjectives, OBJECTIVE_GROUP_LABELS } from "@/lib/public";

export const metadata: Metadata = {
  title: "Objetivos especiales",
  description:
    "Los 37 objetivos especiales de la Liga Hispana de Age of Empires IV: cuánta puntuación reparte cada uno y quién lo posee ahora mismo.",
};

// Los poseedores cambian en cada recálculo del worker. Sin esto la página se
// generaría en el `next build` y la foto de quién posee cada objetivo se
// quedaría congelada.
export const dynamic = "force-dynamic";

export default async function ObjectivesPage() {
  const { options } = await getObjectives();

  return (
    <div className="flex flex-col gap-8">
      <PageHead title="Objetivos especiales" />
      <ObjectivesBrowser options={options} groupLabels={OBJECTIVE_GROUP_LABELS} />
    </div>
  );
}
