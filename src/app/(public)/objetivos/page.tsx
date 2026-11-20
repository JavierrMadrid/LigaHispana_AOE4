import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight } from "@phosphor-icons/react/dist/ssr/ArrowUpRight";
import { WarningCircle } from "@phosphor-icons/react/dist/ssr/WarningCircle";
import {
  ObjectivesBrowser,
  ObjectivesReload,
} from "@/components/objectives-browser";
import {
  getObjectives,
  getStandings,
  OBJECTIVE_GROUP_LABELS,
} from "@/lib/public";
import Loading from "./loading";

export const metadata: Metadata = {
  title: "Objetivos",
  description:
    "Los objetivos especiales de la Liga Hispana de Age of Empires IV: cuánta puntuación reparte cada uno y quién lo cobra ahora mismo.",
};
export const dynamic = "force-dynamic";

export default async function ObjectivesPage({
  searchParams,
}: {
  searchParams: Promise<{ preview?: string | string[] }>;
}) {
  const params = await searchParams;
  const tools =
    process.env.NODE_ENV === "development"
      ? await import("@/lib/objectives-preview")
      : null;
  const preview = tools?.parseObjectivesPreview(params.preview) ?? null;
  if (preview === "loading") return <Loading />;
  const fixture =
    preview && preview !== "unavailable" && tools
      ? tools.createObjectivesPreview(new Date(), preview)
      : null;
  const [read, standingsRead] = preview
    ? [null, null]
    : await Promise.all([getObjectives(), getStandings()]);
  const objectives =
    fixture?.objectives ?? (read?.status === "ok" ? read.data : null);
  const standings = fixture
    ? fixture.standings
    : standingsRead?.status === "ok" && standingsRead.data
    ? standingsRead.data.rows.map((row) => ({
        profileId: row.profileId,
        name: row.name,
        avatarUrl: row.avatarUrl,
        profileUrl: row.profileUrl,
      }))
    : null;

  if (objectives === null)
    return (
      <div className="catalog-layout">
        <aside className="catalog-context">
          <h1>Objetivos</h1>
          <p>Logros para completar y competiciones para liderar.</p>
          <div className="catalog-guide">
            <Link href="/puntuacion" target="_blank" rel="noopener noreferrer">
              Cómo se puntúa
              <ArrowUpRight size={14} aria-hidden="true" />
            </Link>
          </div>
        </aside>
        <section
          className="catalog-empty"
          aria-labelledby="catalog-error-heading"
        >
          <WarningCircle size={32} aria-hidden="true" />
          <h2 id="catalog-error-heading">
            No se han podido cargar los objetivos
          </h2>
          <p>
            No podemos consultar los objetivos ni quién los cobra ahora mismo.
            Vuelve a intentarlo en unos minutos.
          </p>
          <ObjectivesReload />
        </section>
      </div>
    );
  return (
    <ObjectivesBrowser
      options={objectives.options}
      groupLabels={OBJECTIVE_GROUP_LABELS}
      standings={standings}
      mapPool={objectives.mapPool}
    />
  );
}
