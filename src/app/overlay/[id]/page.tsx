import type { Metadata } from "next";
import { OverlayApp } from "@/components/overlay/overlay-app";
import { OverlayCard, OverlayCardHeader } from "@/components/overlay/overlay-card";
import { accentTheme } from "@/components/edition-theme";
import { readOverlayProfileId } from "@/lib/overlay-api";
import { readOverlayConfig } from "@/lib/overlay-view";
import { getEditionConfig } from "@/lib/public";

export const metadata: Metadata = {
  title: "Overlay",
  description:
    "Tarjeta de clasificación y objetivos para superponer al directo del torneo.",
  robots: { index: false, follow: false },
};

// La marca de la edición vive en `Setting`: sin esto la página se generaría en el
// build y se quedaría con el nombre y el oro del despliegue.
export const dynamic = "force-dynamic";

const HOUSE_EMBLEM = "/imagenes/marca/emblema-256.png";

export default async function OverlayPage({
  params,
  searchParams,
}: PageProps<"/overlay/[id]">) {
  const { id } = await params;
  const profileId = readOverlayProfileId(id);

  if (profileId.status !== "ok") {
    return (
      <div className="fixed inset-0 flex items-start justify-end p-4 sm:p-6">
        <OverlayCard>
          <OverlayCardHeader
            emblem={HOUSE_EMBLEM}
            title="Liga Hispana"
            subtitle="No disponible"
          />
          <div className="flex flex-col gap-2 px-4 py-5">
            <p className="font-display text-sm font-semibold text-foreground">
              Overlay no válido
            </p>
            <p className="text-xs leading-relaxed text-muted">
              «{id}» no es un identificador de AoE4World válido. La URL tiene que
              ser <span className="whitespace-nowrap">/overlay/&lt;número&gt;</span>.
            </p>
          </div>
        </OverlayCard>
      </div>
    );
  }

  const config = readOverlayConfig(await searchParams);

  // Con la base caída se cae al oro y al emblema de la casa en vez de inventarse
  // la marca de la edición.
  const editionRead = await getEditionConfig();
  const edition = editionRead.status === "ok" ? editionRead.data : null;
  const accentStyle = accentTheme(edition?.branding.accentColor ?? null);

  return (
    <OverlayApp
      profileId={String(profileId.value)}
      editionName={edition?.name ?? null}
      editionEmblem={edition?.branding.emblemUrl ?? null}
      accentStyle={accentStyle}
      config={config}
    />
  );
}
