import type { Metadata } from "next";
import { EditionForm } from "@/app/admin/administracion/edition-form";
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
    <section>
      <h2 className="text-lg font-medium">Edición</h2>
      <p className="mt-1 max-w-[70ch] text-sm text-muted">
        El nombre y el premio salen en la web pública; el emblema y el color de acento
        cambian la marca del sitio, y la retransmisión obligatoria enciende el aviso de
        los participantes sin canal de directo. Se guarda sin desplegar.
      </p>

      <div className="mt-4">
        <EditionForm
          edition={edition}
          nameMaxLength={EDITION_NAME_MAX_LENGTH}
          noteMaxLength={EDITION_PRIZE_NOTE_MAX_LENGTH}
        />
      </div>
    </section>
  );
}
