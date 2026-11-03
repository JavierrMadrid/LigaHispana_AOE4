import type { Metadata } from "next";
import Link from "next/link";
import { WindowForm } from "@/app/admin/administracion/fechas/window-form";
import { RegistrationDeadlineForm } from "@/app/admin/administracion/registration-deadline-form";
import { EmptyState } from "@/components/empty-state";
import { formatMadridDateTime } from "@/lib/format";
import { editionEnded, editionStarted, formatMadridLocalInstant } from "@/lib/ranked-match";
import { readRuleset } from "@/lib/scoring";
import { readRegistrationState } from "@/lib/settings";

export const metadata: Metadata = {
  title: { absolute: "Fechas · Admin" },
};

type RegistrationDates = Awaited<ReturnType<typeof readRegistrationState>>;

/**
 * El estado efectivo del plazo, en una frase: si admite solicitudes y **qué mando** lo
 * ha cerrado. Es el mismo dato que pinta la píldora del interruptor en `Inscripciones`,
 * contado aquí sin repetir su control: con el plazo cerrado por la fecha, lo que hay que
 * saber es que mover la fecha es lo que lo reabre.
 */
function registrationStateText(registration: RegistrationDates | null): string {
  if (registration === null) {
    return "No se ha podido leer el estado del plazo.";
  }

  if (registration.reason === "deadline") {
    return "Ahora mismo el plazo está cerrado por la fecha de cierre, que ya ha pasado: aunque el interruptor siga encendido, no se admiten solicitudes nuevas. Vacía o mueve la fecha para reabrirlo.";
  }

  if (registration.reason === "switch") {
    return "Ahora mismo el plazo está cerrado por el interruptor manual: no se admiten solicitudes nuevas aunque la fecha no haya llegado. El interruptor se cambia en Inscripciones.";
  }

  return registration.closesAt === null
    ? "Ahora mismo el plazo está abierto y sin fecha de cierre: solo lo cerrará el interruptor manual."
    : "Ahora mismo el plazo está abierto; la fecha de cierre lo cerrará sola cuando llegue.";
}

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
      <section className="flex flex-col gap-6">
        <div>
          <h2 className="text-lg font-medium">Fechas</h2>
          <p className="mt-1 max-w-[70ch] text-sm text-muted">
            Hasta cuándo se admiten inscripciones y qué partidas cuentan para la
            clasificación.
          </p>
        </div>
        <EmptyState
          title="No se han podido leer las fechas de la edición"
          body="La base de datos no ha respondido. Sin las fechas de la ventana guardadas no se puede saber si la edición ya ha empezado, así que no se ofrece el formulario: un inicio editable sobre una edición en marcha movería el corte de partidas ya publicadas. Vuelve a intentarlo en unos minutos."
        />
      </section>
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
    <section className="flex flex-col gap-8">
      <div>
        <h2 className="text-lg font-medium">Fechas</h2>
        <p className="mt-1 max-w-[70ch] text-sm text-muted">
          Las fechas que enmarcan la edición: hasta cuándo se admiten inscripciones y
          desde cuándo hasta cuándo cuentan las partidas para la clasificación. Se
          escriben en hora local de Madrid y se guardan en UTC.
        </p>
      </div>

      <div>
        <h3 className="text-base font-medium text-foreground">Inscripción</h3>
        <p className="mt-1 max-w-[70ch] text-sm text-muted">
          Hasta cuándo se admiten solicitudes nuevas. La fecha de cierre las cierra sola
          cuando llega; el interruptor manual, que cierra el plazo al instante, y los
          países admitidos siguen en{" "}
          <Link
            href="/admin/administracion/inscripciones"
            className="text-accent underline underline-offset-4 transition-colors hover:text-accent-strong"
          >
            Inscripciones
          </Link>
          .
        </p>
        <p className="mt-2 max-w-[70ch] text-sm text-foreground">
          {registrationStateText(registration)}
        </p>

        <div className="mt-3">
          {registration === null ? (
            <p className="max-w-[70ch] rounded-md border border-line bg-surface px-4 py-3 text-sm leading-relaxed text-muted">
              Sin leer la fecha guardada no se ofrece el campo: guardarlo vacío borraría
              una fecha de cierre que sigue vigente. Vuelve a intentarlo en unos minutos.
            </p>
          ) : (
            <RegistrationDeadlineForm closesAt={closesAt} />
          )}
        </div>
      </div>

      <div>
        <h3 className="text-base font-medium text-foreground">Torneo</h3>
        <p className="mt-1 max-w-[70ch] text-sm text-muted">
          La ventana que decide qué partidas cuentan: las que empezaron a partir del
          inicio y antes del fin. El inicio es obligatorio; el fin es opcional y se puede
          fijar más tarde. Al guardar se recalcula la clasificación, porque mover la
          ventana cambia qué partidas puntúan.
        </p>

        {active ? (
          <p className="mt-3 max-w-[70ch] rounded-md border border-accent/30 bg-accent/5 px-4 py-3 text-sm leading-relaxed text-muted">
            <strong className="font-semibold text-foreground">
              El inicio de la ventana está congelado
            </strong>
            .{" "}
            {windowStartLabel !== null
              ? `La edición empezó el ${windowStartLabel}`
              : "La edición ya ha empezado"}{" "}
            y moverlo cambiaría el corte de todas las partidas publicadas. Solo se puede
            fijar, mover o vaciar el fin de la ventana.
          </p>
        ) : null}

        {ended ? (
          <p className="mt-3 max-w-[70ch] rounded-md border border-accent/30 bg-accent/5 px-4 py-3 text-sm leading-relaxed text-muted">
            <strong className="font-semibold text-foreground">
              La edición anterior ha terminado
            </strong>
            .{" "}
            {windowEndLabel !== null
              ? `Terminó el ${windowEndLabel}`
              : "La ventana ya tiene un fin pasado"}{" "}
            y desde entonces no reparte puntos. Puedes mover el inicio para preparar la
            siguiente edición: al guardar, la clasificación se recalcula contra la ventana
            nueva y la edición anterior deja de mostrarse en la web, aunque sus partidas y
            sus historiales siguen guardados.
          </p>
        ) : null}

        <div className="mt-3">
          <WindowForm
            windowFrom={windowFrom}
            windowTo={windowTo}
            locked={active}
            previousEnded={ended}
          />
        </div>
      </div>
    </section>
  );
}
