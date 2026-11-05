import type { Metadata } from "next";
import { WindowForm } from "@/app/admin/administracion/fechas/window-form";
import { RegistrationDeadlineForm } from "@/app/admin/administracion/registration-deadline-form";
import { AdminPageHeader } from "@/components/admin/page-header";
import { EmptyState } from "@/components/empty-state";
import { formatMadridDateTime } from "@/lib/format";
import { editionEnded, editionStarted, formatMadridLocalInstant } from "@/lib/ranked-match";
import { readRuleset } from "@/lib/scoring";
import { readRegistrationState } from "@/lib/settings";

export const metadata: Metadata = {
  title: { absolute: "Fechas · Admin" },
};

/**
 * Subpestaña de fechas: la configuración temporal de la edición, en orden
 * cronológico.
 *
 * Primero el **plazo de inscripción** —hasta cuándo se admiten solicitudes nuevas— y
 * después la **ventana del torneo** —qué partidas cuentan para la clasificación—, que
 * es el orden en que ocurren. Las dos fechas se escriben en hora local de Madrid y se
 * guardan en UTC, y las dos tienen su propia acción: la ventana se guarda con
 * `saveTournamentWindow()` y el cierre de inscripciones con `setRegistrationClosesAt()`,
 * que se reutiliza tal cual desde el formulario de Inscripciones.
 *
 * La pantalla tiene tres estados, y cuál toca no lo decide un campo del formulario sino
 * la **ventana guardada**: **no empezada** (`!editionStarted()`), donde se editan las dos
 * fechas; **activa** (`editionStarted()` y `!editionEnded()`), donde el inicio queda
 * congelado y solo se puede fijar, mover o vaciar el fin; y **terminada**
 * (`editionEnded()`), donde las dos vuelven a ser editables porque el torneo ya no
 * reparte puntos. En la terminada, mover el inicio **empieza una edición nueva** y hay
 * que confirmarlo (`confirmNewEdition`): la clasificación se recalcula y la anterior deja
 * de mostrarse en la web, aunque sus partidas e historiales siguen guardados.
 *
 * La acción lo vuelve a comprobar por su cuenta —una Server Action es un endpoint
 * público—, así que lo de aquí es la explicación del bloqueo y de la confirmación, no su
 * defensa: con la edición en marcha el inicio **no viaja** en el formulario.
 *
 * Si el ruleset no se puede leer no se pinta un formulario, ni entero ni a medias: sin
 * las fechas guardadas no se sabe si la edición ha empezado, y enseñar el inicio como
 * editable sobre una edición en marcha es justo lo que no se puede permitir. La fecha
 * de cierre sí es independiente del ruleset, pero se pinta con la misma cautela: un
 * campo vacío que no es el guardado borraría la fecha real al guardar.
 */
export default async function AdminDatesPage() {
  const [ruleset, registration] = await Promise.all([
    readRuleset().catch(() => null),
    readRegistrationState().catch(() => null),
  ]);

  if (ruleset === null) {
    return (
      <div className="flex flex-col gap-6">
        <AdminPageHeader
          level={2}
          title="Fechas"
          description="Las dos fechas que enmarcan la edición: cierre de inscripciones y ventana del torneo."
        />
        <EmptyState
          title="No se han podido leer las fechas de la edición"
          body="La base de datos no ha respondido. Sin la ventana guardada no se puede saber si la edición ha empezado, así que no se ofrece el formulario. Vuelve a intentarlo en unos minutos."
        />
      </div>
    );
  }

  // Un solo instante para las dos preguntas: si la edición ha empezado y si ha
  // terminado. `active` es el único estado que congela el inicio.
  const now = new Date();
  const ended = editionEnded(ruleset.window, now);
  const active = editionStarted(ruleset.window, now) && !ended;

  const windowStartLabel = formatMadridDateTime(ruleset.window.from);
  const windowEndLabel =
    ruleset.window.to === null ? null : formatMadridDateTime(ruleset.window.to);

  // Las fechas se prefilan en el `datetime-local` de Madrid. Se convierten aquí, en el
  // servidor, porque `formatMadridLocalInstant()` es `server-only`; los formularios solo
  // reciben los textos. Un límite que no se pueda leer deja el campo vacío en vez de con
  // un valor inventado.
  const windowFrom = formatMadridLocalInstant(ruleset.window.from) ?? "";
  const windowTo =
    ruleset.window.to === null ? "" : (formatMadridLocalInstant(ruleset.window.to) ?? "");

  const savedClosesAt = registration?.closesAt ?? null;
  const closesAt =
    savedClosesAt === null ? "" : (formatMadridLocalInstant(savedClosesAt) ?? "");

  return (
    <div className="flex flex-col gap-6">
      <AdminPageHeader
        level={2}
        title="Fechas"
        description="Las dos fechas que enmarcan la edición: cierre de inscripciones y ventana del torneo."
      />

      <RegistrationDeadlineForm
        closesAt={closesAt}
        reason={registration?.reason ?? null}
      />

      <WindowForm
        windowFrom={windowFrom}
        windowTo={windowTo}
        locked={active}
        previousEnded={ended}
        windowStartLabel={windowStartLabel}
        windowEndLabel={windowEndLabel}
      />
    </div>
  );
}
