import type { Metadata } from "next";
import { EditionForm } from "@/app/admin/administracion/edition-form";
import { AdminPageHeader } from "@/components/admin/page-header";
import {
  DEFAULT_EDITION_CONFIG,
  EDITION_NAME_MAX_LENGTH,
  EDITION_PRIZE_NOTE_MAX_LENGTH,
  readEditionConfig,
} from "@/lib/edition";

export const metadata: Metadata = {
  title: { absolute: "Edición · Admin" },
};

/**
 * Subpestaña de la edición: los datos que la distinguen y que deciden quién cobra
 * qué. La lectura degrada al documento por defecto si la base no responde, porque
 * el formulario vuelve a validar en el servidor al guardar.
 */
export default async function AdminEditionPage() {
  const edition = await readEditionConfig().catch(() => DEFAULT_EDITION_CONFIG);

  return (
    <div className="flex flex-col gap-6">
      <AdminPageHeader
        level={2}
        title="Edición"
        description="La edición que se publica en la web: nombre, marca, premio y reglas."
      />

      <EditionForm
        edition={edition}
        nameMaxLength={EDITION_NAME_MAX_LENGTH}
        noteMaxLength={EDITION_PRIZE_NOTE_MAX_LENGTH}
      />
    </div>
  );
}
