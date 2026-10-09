import type { Metadata } from "next";
import Link from "next/link";
import { PageHead } from "@/components/page-head";
import {
  MobileSectionIndex,
  SectionHeading,
  SectionIndexAside,
  type DocSection,
} from "@/components/section-index";

export const metadata: Metadata = {
  title: "Reglas",
  description:
    "El reglamento de la Liga Hispana de Age of Empires IV: formato, condiciones de participación, normas de obligado cumplimiento y organización del torneo.",
};

const SECTIONS: readonly DocSection[] = [
  { id: "formato", label: "Formato" },
  { id: "participacion", label: "Participación" },
  { id: "normas", label: "Normas" },
  { id: "organizacion", label: "Organización" },
];

export default function RulesPage() {
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
                jugar amistosas ni apuntarse a eventos: basta con jugar partidas{" "}
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
                  hasta 1 día antes del inicio del torneo
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
            </ul>
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
              <li>
                <strong className="font-semibold text-foreground">
                  Retransmisión en directo.
                </strong>{" "}
                Las partidas del torneo deben emitirse en directo en Twitch,
                YouTube o Kick.
              </li>
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
                Está prohibido abandonar o dejarse perder a propósito de forma continuada para
                manipular el elo: bajar de elo a proposito para después ganar puntos contra rivales por debajo de tu nivel habitual.
              </li>
              <li>
                <strong className="font-semibold text-foreground">
                  Sin rivales repetidos.
                </strong>{" "}
                No se puede forzar para jugar contra el mismo rival en 1vs1 para acumular victorias de forma intencionada.
              </li>
              <li>
                <strong className="font-semibold text-foreground">
                  Equipos equilibrados.
                </strong>{" "}
                En partidas por equipos no se puede jugar con compañeros de elo
                muy superior al de uno mismo, ni en una división muy distinta de la
                propia (por encima o por debajo).
              </li>
            </ol>

            <p className="mt-6 max-w-[68ch] border-t border-line pt-5 text-sm leading-relaxed text-muted">
              Para vigilar el cumplimiento de estas reglas, la organización cuenta
              con un sistema de alertas: la web revisa las partidas de forma
              automática y deja constancia de los comportamientos sospechosos
              recogidos en este reglamento (manipulación del elo, rivales
              repetidos, equipos desequilibrados, historial no público, partidas
              que no llegan o ausencia del Discord). Las alertas son avisos para
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
