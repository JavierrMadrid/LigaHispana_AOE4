import type { Metadata } from "next";
import Link from "next/link";
import { PageHead } from "@/components/page-head";
import {
  MobileSectionIndex,
  SectionHeading,
  SectionIndexAside,
  type DocSection,
} from "@/components/section-index";
import { formatEventWindow } from "@/lib/format";
import {
  getEditionConfig,
  getEditionEvents,
  getMatcherinoDonations,
} from "@/lib/public";

export const metadata: Metadata = {
  title: "Reglas",
  description:
    "El reglamento de la Liga Hispana de Age of Empires IV: formato, condiciones de participación, eventos puntuales, normas de obligado cumplimiento y organización del torneo.",
};

const SECTIONS: readonly DocSection[] = [
  { id: "formato", label: "Formato" },
  { id: "participacion", label: "Participación" },
  { id: "eventos", label: "Eventos" },
  { id: "normas", label: "Normas" },
  { id: "organizacion", label: "Organización" },
];

// La retransmisión obligatoria, el premio base y la campaña de donaciones viven en
// `Setting` y la organización los cambia sin desplegar: una página generada en el
// `build` seguiría anunciando el premio o la norma de la edición anterior. Por eso
// se lee en cada petición, como `/puntuacion`.
export const dynamic = "force-dynamic";

export default async function RulesPage() {
  // Las lecturas son ligeras y van en paralelo. Con la base caída llega
  // `"degraded"` y no se inventa nada: sin premio no se pinta premio, sin campaña
  // no se pinta la línea de donaciones, sin eventos no se inventa un calendario
  // (se dice que no se han podido leer) y, sin configuración, la retransmisión se
  // queda como estaba (la norma existe y la controla la organización).
  const [editionRead, donationsRead, eventsRead] = await Promise.all([
    getEditionConfig(),
    getMatcherinoDonations(),
    getEditionEvents(),
  ]);

  const edition = editionRead.status === "ok" ? editionRead.data : null;
  const streamingRequired = edition?.streamingRequired ?? false;
  const prize = edition !== null && edition.prize.amount !== null ? edition.prize : null;
  const donationsPublished = donationsRead.status === "ok" && donationsRead.data.enabled;

  // El calendario se lee en orden de inicio. La lista guardada conserva el orden en
  // que se publicó cada evento, que no tiene por qué ser el cronológico.
  const events =
    eventsRead.status === "ok"
      ? [...eventsRead.data].sort(
          (a, b) => new Date(a.from).getTime() - new Date(b.from).getTime(),
        )
      : [];

  return (
    // Conserva el ancho anterior (`max-w-6xl`): el contenedor público subió a
    // `max-w-[80rem]` para la clasificación, pero el bloque de lectura no gana
    // nada con estirarse.
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-10">
      <PageHead title="Reglas" />

      <p className="max-w-[68ch] text-[15px] leading-relaxed text-muted">
        Las normas del torneo. Cuánto vale cada victoria, qué cuenta como partida
        clasificatoria y cómo funcionan los objetivos está en{" "}
        <Link
          href="/puntuacion"
          className="text-accent underline underline-offset-4 hover:text-accent-strong"
        >
          Puntuación
        </Link>
        .
      </p>

      <MobileSectionIndex
        sections={SECTIONS}
        ariaLabel="Secciones de las reglas"
      />

      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_13rem] lg:gap-14">
        <div className="flex min-w-0 flex-col gap-16">
          <section id="formato" className="scroll-mt-24">
            <SectionHeading title="Formato" />
            <div className="mt-4 flex max-w-[68ch] flex-col gap-3 text-[15px] leading-relaxed text-muted">
              <p>
                El torneo es{" "}
                <strong className="font-semibold text-foreground">
                  individual
                </strong>
                : no hay equipos. Cada persona compite con su cuenta, registrada
                con su perfil de AoE4World.
              </p>
              <p>
                Se juega en la misma ladder <em>ranked</em> del juego. No hay que
                jugar amistosas ni apuntarse a nada: basta con jugar partidas{" "}
                <em>ranked</em> con la cuenta dada de alta.
              </p>
              <p>
                Solo cuentan las partidas{" "}
                <strong className="font-semibold text-foreground">
                  terminadas
                </strong>
                , jugadas dentro de las fechas del torneo y después de la
                inscripción del jugador.
              </p>
              <p>
                En las partidas por equipos solo cuentan las que se juegan con{" "}
                <strong className="font-semibold text-foreground">
                  equipos equilibrados
                </strong>
                : si algún compañero está a dos escalones o más de división del
                jugador, por encima o por debajo, esa partida no puntúa para él.
                El escalón es la división (bronce, plata, oro, platino, diamante
                o conquistador), sin subrango.
              </p>
            </div>
          </section>

          <section id="participacion" className="scroll-mt-24">
            <SectionHeading title="Participación" />
            <ul className="mt-4 flex max-w-[68ch] flex-col gap-3 text-[15px] leading-relaxed text-muted">
              <li>
                El alta se hace con el{" "}
                <strong className="font-semibold text-foreground">
                  perfil de AoE4World
                </strong>{" "}
                y un correo de contacto. Toda solicitud queda pendiente de que la
                organización la apruebe o la rechace.
              </li>
              <li>
                Las inscripciones se deben hacer{" "}
                <strong className="font-semibold text-foreground">
                  hasta la fecha de cierre que publica la organización
                </strong>
                .
              </li>
              <li>
                Hay que{" "}
                <strong className="font-semibold text-foreground">
                  tener Discord y entrar en el servidor
                </strong>{" "}
                del torneo; la propia inscripción incluye el botón para entrar.
              </li>
              <li>
                Si la organización da de alta a alguien, el bot le manda un{" "}
                <strong className="font-semibold text-foreground">
                  privado de Discord para confirmar que participa
                </strong>
                . Hasta que la persona confirme desde su cuenta, el alta no queda
                aprobada y no aparece en la clasificación; si responde que no, queda
                rechazada.
              </li>
            </ul>
          </section>

          <section id="eventos" className="scroll-mt-24">
            <SectionHeading title="Eventos" />
            <div className="mt-4 flex max-w-[68ch] flex-col gap-3 text-[15px] leading-relaxed text-muted">
              <p>
                La organización puede programar{" "}
                <strong className="font-semibold text-foreground">
                  eventos puntuales
                </strong>
                : ventanas de tiempo dentro del torneo en las que una victoria
                clasificatoria paga un multiplicador. Se publican antes de que empiece
                el torneo: desde la fecha de inicio del torneo, el calendario queda
                cerrado.
              </p>
              <p>
                El multiplicador se aplica{" "}
                <strong className="font-semibold text-foreground">
                  solo a los puntos por victoria
                </strong>
                . Las derrotas siguen sin sumar y los objetivos conservan su valor.
                Cuenta toda partida clasificatoria que empiece dentro de la ventana.
              </p>
              <p>
                Algunos eventos exigen{" "}
                <strong className="font-semibold text-foreground">
                  estar en el servidor de Discord
                </strong>{" "}
                del torneo: solo cobran el multiplicador quienes estén dentro cuando
                empieza el evento. A quien se aprueba con el evento ya en marcha se le
                comprueba al aprobarse.
              </p>
              <p>
                El bot del torneo avisa en Discord 24, 12 y 1 hora antes de cada evento,
                y el aviso de comienzo del torneo incluye el calendario.
              </p>
            </div>

            {eventsRead.status !== "ok" ? (
              <p className="mt-5 max-w-[68ch] rounded-lg border border-line bg-surface px-4 py-3 text-sm leading-relaxed text-muted">
                No se han podido leer los eventos de esta edición. Vuelve a intentarlo
                en unos minutos.
              </p>
            ) : events.length === 0 ? (
              <p className="mt-5 max-w-[68ch] rounded-lg border border-line bg-surface px-4 py-3 text-sm leading-relaxed text-muted">
                Esta edición no tiene eventos puntuales programados.
              </p>
            ) : (
              <ul className="mt-5 flex max-w-[68ch] flex-col gap-3">
                {events.map((event) => {
                  const windowText = formatEventWindow(event);

                  return (
                    <li
                      key={event.id}
                      className="rounded-lg border border-line bg-surface p-4 sm:p-5"
                    >
                      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                        <h3 className="font-display text-lg font-semibold text-foreground">
                          {event.name}
                        </h3>
                        <p className="ml-auto font-display text-2xl font-semibold leading-none tabular-nums text-accent">
                          <span className="sr-only">Multiplicador </span>
                          {`x${event.multiplier}`}
                        </p>
                      </div>

                      <p className="mt-1.5 text-sm text-muted">
                        {windowText ?? "Las fechas de este evento no se pueden leer."}
                      </p>

                      {event.description !== null ? (
                        <p className="mt-3 text-[15px] leading-relaxed text-muted">
                          {event.description}
                        </p>
                      ) : null}

                      {event.discordRequired ? (
                        <p className="mt-3">
                          <span className="inline-block rounded-full border border-accent/40 px-2 py-0.5 text-xs text-accent">
                            Requiere estar en Discord al empezar
                          </span>
                        </p>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section id="normas" className="scroll-mt-24">
            <SectionHeading title="Normas" />
            <p className="mt-4 max-w-[68ch] text-[15px] leading-relaxed text-muted">
              Estas normas son de obligado cumplimiento una vez dentro del torneo:
              incumplirlas es{" "}
              <strong className="font-semibold text-foreground">
                motivo de expulsión
              </strong>
              .
            </p>

            <ol className="mt-5 max-w-[68ch] list-decimal space-y-3 pl-6 text-[15px] leading-relaxed text-muted marker:font-display marker:font-semibold marker:text-accent">
              <li>
                <strong className="font-semibold text-foreground">
                  Cuenta real y personal.
                </strong>{" "}
                Cada participante compite con una única cuenta propia. No se
                admiten cuentas <em>smurf</em> (alternativas o de segunda cuenta)
                ni hacer pasar por propia la cuenta de otra persona.
              </li>
              <li>
                <strong className="font-semibold text-foreground">
                  Partidas de posicionamiento.
                </strong>{" "}
                Hay que haber completado las 5 partidas de posicionamiento de{" "}
                <em>ranked</em> 1vs1 de la temporada actual.
              </li>
              <li>
                <strong className="font-semibold text-foreground">
                  Presencia en Discord.
                </strong>{" "}
                Hay que permanecer en el servidor de Discord del torneo durante
                todo el torneo: es el canal oficial por el que la organización
                avisa y resuelve dudas.
              </li>
              {/* La retransmisión es la única norma condicional: la edición decide
                  si existe (`streamingRequired`). Con la norma apagada no se lista,
                  porque no hay nada que cumplir. */}
              {streamingRequired ? (
                <li>
                  <strong className="font-semibold text-foreground">
                    Retransmisión en directo.
                  </strong>{" "}
                  Las partidas del torneo deben emitirse en directo en Twitch,
                  YouTube o Kick.
                </li>
              ) : null}
              <li id="historial" className="scroll-mt-24">
                <strong className="font-semibold text-foreground">
                  Historial público.
                </strong>{" "}
                El historial de partidas de la cuenta debe mantenerse en público
                (en el juego, ajuste <em>Share History</em>), para que la
                organización pueda revisar cualquier partida.
              </li>
              <li>
                <strong className="font-semibold text-foreground">
                  Jugar hasta el final.
                </strong>{" "}
                Está prohibido abandonar o dejarse perder de forma continuada para
                manipular el elo: bajar de elo para después ganar puntos contra
                rivales por debajo de tu nivel habitual.
              </li>
              <li>
                <strong className="font-semibold text-foreground">
                  Sin rivales repetidos.
                </strong>{" "}
                No se puede forzar para jugar contra el mismo rival en 1vs1 para acumular victorias de forma intencionada.
              </li>
            </ol>

            <p className="mt-6 max-w-[68ch] border-t border-line pt-5 text-sm leading-relaxed text-muted">
              Para vigilar el cumplimiento de estas reglas, la organización cuenta
              con un sistema de alertas: la web revisa las partidas de forma
              automática y deja constancia de los comportamientos sospechosos
              recogidos en este reglamento (manipulación del elo, rivales
              repetidos, historial no público, partidas que no llegan y{" "}
              {streamingRequired
                ? "ausencia del Discord o falta de canal de directo"
                : "ausencia del Discord"}
              ). Las alertas son avisos para
              que la organización revise cada caso: no son sanciones automáticas y
              la decisión final es siempre de la organización.
            </p>
          </section>

          <section id="organizacion" className="scroll-mt-24">
            <SectionHeading title="Organización" />
            <ul className="mt-4 flex max-w-[68ch] flex-col gap-3 text-[15px] leading-relaxed text-muted">
              <li>
                La organización{" "}
                <strong className="font-semibold text-foreground">
                  aprueba, rechaza o edita
                </strong>{" "}
                participantes.
              </li>
              <li>
                Puede{" "}
                <strong className="font-semibold text-foreground">
                  revertir o restaurar
                </strong>{" "}
                una partida: deja de contar sin borrarla.
              </li>
              <li>Cada acción de la organización queda registrada.</li>
              {/* El premio y las donaciones son datos de la edición: solo se
                  pintan cuando la configuración los publica. */}
              {prize !== null ? (
                <li>
                  El premio base de esta edición es de{" "}
                  <strong className="font-semibold text-foreground">
                    {prize.amount} €
                  </strong>
                  {prize.note !== null ? `, ${prize.note}` : ""}.
                </li>
              ) : null}
              {donationsPublished ? (
                <li>Las donaciones de la campaña de la comunidad se suman al premio.</li>
              ) : null}
            </ul>
          </section>
        </div>

        <SectionIndexAside
          sections={SECTIONS}
          ariaLabel="Secciones de las reglas"
        />
      </div>
    </div>
  );
}
