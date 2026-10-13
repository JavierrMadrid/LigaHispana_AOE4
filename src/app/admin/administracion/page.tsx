import type { Metadata } from "next";
import { AdminsPanel } from "@/app/admin/administracion/admins-panel";
import { AnnouncementsForm } from "@/app/admin/administracion/announcements-form";
import { CountriesForm } from "@/app/admin/administracion/countries-form";
import { EditionForm } from "@/app/admin/administracion/edition-form";
import {
  RulesetForm,
  type ObjectiveGroupBlock,
} from "@/app/admin/administracion/ruleset-form";
import { requireSuperadmin } from "@/lib/auth";
import { listAdmins } from "@/lib/admin-users";
import { DEFAULT_COUNTRIES, readCountries } from "@/lib/countries";
import {
  DEFAULT_EDITION_CONFIG,
  EDITION_NAME_MAX_LENGTH,
  EDITION_PRIZE_NOTE_MAX_LENGTH,
  readEditionConfig,
} from "@/lib/edition";
import { OBJECTIVE_DEFINITIONS, OBJECTIVE_GROUP_LABELS } from "@/lib/objectives";
import { formatMadridLocalInstant } from "@/lib/ranked-match";
import { DEFAULT_RULESET, RANKED_MODES, readRuleset } from "@/lib/scoring";

export const metadata: Metadata = {
  title: { absolute: "Administración · Admin" },
};

/**
 * Rótulos de las familias de ladder para la pantalla. El valor crudo se usa como
 * respaldo, para que una familia nueva del ruleset se vea aunque no tenga rótulo
 * aquí en vez de desaparecer del formulario.
 */
const MODE_LABELS: Record<string, string> = {
  rm_solo: "Ranked 1vs1",
  rm_team: "Ranked por equipos",
};

/**
 * Pestaña de administración: solo del superadministrador.
 *
 * Reúne lo que ningún admin regular puede tocar —la lista de admins, la
 * configuración de la edición y las pruebas del canal de avisos—. La puerta la
 * cierra `requireSuperadmin()`: un admin normal que llegue aquí vuelve a
 * `/admin`, y sin sesión se va a `/login`.
 *
 * Las cuatro lecturas son independientes y van en paralelo. Cada una degrada a
 * su valor de respaldo si la base no responde —la lista de admins a `null`, que
 * se dice en su sitio, y el resto a sus valores por defecto—, porque esta
 * pantalla tiene cuatro formularios y no tiene por qué caerse entera porque una
 * lectura falle. Los formularios vuelven a validar en el servidor al guardar, así
 * que una lectura degradada aquí no publica nada por accidente.
 */
export default async function AdminAdministrationPage() {
  await requireSuperadmin();

  const [admins, edition, ruleset, countries] = await Promise.all([
    listAdmins().catch(() => null),
    readEditionConfig().catch(() => DEFAULT_EDITION_CONFIG),
    readRuleset().catch(() => DEFAULT_RULESET),
    readCountries().catch(() => [...DEFAULT_COUNTRIES]),
  ]);

  const modeOptions = RANKED_MODES.map((mode) => ({
    value: mode,
    label: MODE_LABELS[mode] ?? mode,
  }));

  // La ventana se prefila en el `datetime-local` de Madrid. Se convierte aquí,
  // en el servidor, porque `formatMadridLocalInstant()` es `server-only`; el
  // formulario solo recibe los dos textos. Un límite que no se pueda leer deja el
  // campo vacío en vez de con un valor inventado.
  const windowFrom = formatMadridLocalInstant(ruleset.window.from) ?? "";
  const windowTo =
    ruleset.window.to === null ? "" : (formatMadridLocalInstant(ruleset.window.to) ?? "");

  // El catálogo de objetivos agrupado por grupos, en el orden en que aparece en
  // `OBJECTIVE_DEFINITIONS`, para no llevar aquí una segunda copia del orden.
  const objectiveGroups: ObjectiveGroupBlock[] = [];

  for (const definition of OBJECTIVE_DEFINITIONS) {
    let block = objectiveGroups.find((candidate) => candidate.group === definition.group);

    if (block === undefined) {
      block = {
        group: definition.group,
        label: OBJECTIVE_GROUP_LABELS[definition.group],
        objectives: [],
      };
      objectiveGroups.push(block);
    }

    block.objectives.push({
      id: definition.id,
      label: definition.label,
      points: ruleset.objectives[definition.id] ?? definition.points,
    });
  }

  return (
    <div className="flex flex-col gap-8">
      <section>
        <h1 className="text-2xl font-semibold">Administración</h1>
        <p className="mt-1 max-w-[70ch] text-sm text-muted">
          Los ajustes que solo puede tocar la cuenta de superadministración: quién
          entra al panel, la configuración de la edición y las pruebas del canal de
          avisos. Cada cambio queda anotado en el historial de acciones.
        </p>
      </section>

      <section>
        <h2 className="text-lg font-medium">Administradores</h2>
        <p className="mt-1 max-w-[70ch] text-sm text-muted">
          Las cuentas que pueden entrar al panel. El alta es por invitación: se
          escribe el correo y la persona recibe un enlace para fijar su contraseña.
          Dar de baja desactiva la cuenta —no la borra—, así que se puede reactivar.
        </p>
        <div className="mt-4">
          <AdminsPanel admins={admins} />
        </div>
      </section>

      <section>
        <h2 className="text-lg font-medium">Configuración de la edición</h2>
        <p className="mt-1 max-w-[70ch] text-sm text-muted">
          Lo que distingue esta edición de la siguiente y lo que decide quién cobra
          qué. Se guarda sin desplegar.
        </p>

        <div className="mt-4 flex flex-col gap-6">
          <div>
            <h3 className="text-base font-medium text-foreground">Datos de la edición</h3>
            <p className="mt-1 max-w-[70ch] text-sm text-muted">
              El nombre y el premio salen en la web pública; el emblema y el color de
              acento cambian la marca del sitio, y la retransmisión obligatoria
              enciende el aviso de los participantes sin canal de directo.
            </p>
            <div className="mt-3">
              <EditionForm
                edition={edition}
                nameMaxLength={EDITION_NAME_MAX_LENGTH}
                noteMaxLength={EDITION_PRIZE_NOTE_MAX_LENGTH}
              />
            </div>
          </div>

          <div>
            <h3 className="text-base font-medium text-foreground">Reglas de puntuación</h3>
            <p className="mt-1 max-w-[70ch] text-sm text-muted">
              Las fechas que delimitan qué partidas puntúan, las ladders que cuentan,
              los puntos por victoria y los objetivos activos. Mover la ventana o
              apagar un objetivo cambia quién cobra qué, así que al guardar se
              recalcula la clasificación.
            </p>
            <div className="mt-3">
              <RulesetForm
                ruleset={ruleset}
                modeOptions={modeOptions}
                groups={objectiveGroups}
                windowFrom={windowFrom}
                windowTo={windowTo}
              />
            </div>
          </div>

          <div>
            <h3 className="text-base font-medium text-foreground">Países admitidos</h3>
            <p className="mt-1 max-w-[70ch] text-sm text-muted">
              La lista de países que se ofrece en la inscripción y contra la que se
              valida el país de un participante.
            </p>
            <div className="mt-3">
              <CountriesForm catalog={[...DEFAULT_COUNTRIES]} selected={countries} />
            </div>
          </div>
        </div>
      </section>

      <section>
        <h2 className="text-lg font-medium">Avisos del torneo</h2>
        <p className="mt-1 max-w-[70ch] text-sm text-muted">
          El bot avisa del comienzo y del final del torneo en el canal de avisos de
          Discord. Cada aviso se manda solo, una vez, al cruzar su fecha: no hay que
          pulsar nada. El canal y el token del bot se configuran en el despliegue.
        </p>
        <div className="mt-4">
          <AnnouncementsForm />
        </div>
      </section>
    </div>
  );
}
