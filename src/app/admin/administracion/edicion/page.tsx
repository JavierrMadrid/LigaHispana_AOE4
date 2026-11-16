import type { Metadata } from "next";
import { EditionForm } from "@/app/admin/administracion/edition-form";
import { AdminPageHeader } from "@/components/admin/page-header";
import {
  DEFAULT_EDITION_CONFIG,
  EDITION_NAME_MAX_LENGTH,
  EDITION_PRIZE_NOTE_MAX_LENGTH,
  readEditionConfig,
} from "@/lib/edition";
import { editionStarted } from "@/lib/ranked-match";
import { readRuleset } from "@/lib/scoring";

export const metadata: Metadata = {
  title: { absolute: "Edición · Admin" },
};

/**
 * Subpestaña de la edición: los datos que la distinguen y que deciden quién cobra
 * qué. La lectura degrada al documento por defecto si la base no responde, porque
 * el formulario vuelve a validar en el servidor al guardar.
 *
 * El interruptor del modo de objetos se enseña bloqueado si la edición ya empezó
 * (issue 223): la pantalla cuenta el motivo y la acción lo vuelve a comprobar. Un
 * fallo al leer el ruleset **no** bloquea: sería peor impedir el guardado por no poder
 * leer una fecha, y el servidor lo rechaza igual si toca.
 */
export default async function AdminEditionPage() {
  const [edition, ruleset] = await Promise.all([
    readEditionConfig().catch(() => DEFAULT_EDITION_CONFIG),
    readRuleset().catch(() => null),
  ]);
  const objectsLocked = ruleset !== null && editionStarted(ruleset.window, new Date());

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
        objectsLocked={objectsLocked}
      />
    </div>
  );
}
