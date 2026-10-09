import type { Metadata } from "next";
import Link from "next/link";
import { PageHead } from "@/components/page-head";
import { RankedModesTable } from "@/components/ranked-modes-table";
import {
  MobileSectionIndex,
  SectionHeading,
  SectionIndexAside,
  type DocSection,
} from "@/components/section-index";
import { formatTournamentWindow } from "@/lib/format";
import { getTournamentWindow } from "@/lib/public";

export const metadata: Metadata = {
  title: "Puntuación",
  description:
    "Cómo se reparten los puntos de la Liga Hispana de Age of Empires IV: cuánto vale cada victoria clasificatoria, qué cuenta como partida, los objetivos especiales y los desempates.",
};

const SECTIONS: readonly DocSection[] = [
  { id: "periodo", label: "Periodo del torneo" },
  { id: "como-se-puntua", label: "Cómo se puntúa" },
  { id: "clasificatorias", label: "Qué cuenta como partida clasificatoria" },
  { id: "objetivos", label: "Objetivos especiales" },
  { id: "desempates", label: "Desempates" },
];

// El periodo del torneo se lee de la base de datos en cada petición: la ventana
// vive en el ruleset y la organización puede fijar o mover el fin sin desplegar,
// así que una página generada en el `build` enseñaría fechas viejas.
export const dynamic = "force-dynamic";

export default async function ScoringPage() {
  const windowRead = await getTournamentWindow();
  // Degradada no se inventan fechas: la lista de condiciones ya dice "dentro de
  // las fechas del torneo" y ese texto genérico se queda tal cual. Con `to: null`
  // la ventana sigue siendo válida (abierta) y se enseña como "Desde el …".
  const tournamentWindow = windowRead.status === "ok" ? windowRead.data : null;

  return (
    // Estas dos páginas de contenido conservan el ancho anterior (`max-w-6xl`):
    // el contenedor público se ensanchó a `max-w-[80rem]` para la clasificación,
    // pero el bloque de lectura no gana nada con estirarse.
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-10">
      <PageHead title="Puntuación" />

      <p className="max-w-[68ch] text-[15px] leading-relaxed text-muted">
        Cómo se reparten los puntos del torneo. Las normas están en{" "}
        <Link
          href="/reglas"
          className="text-accent underline underline-offset-4 hover:text-accent-strong"
        >
          Reglas
        </Link>
        .
      </p>

      {/* Banda de resumen: las cifras que resumen el sistema antes del texto
          normativo. Es el mismo cromo que la banda del torneo de la portada
          (`thread-top`, `rounded-lg`, `border-line`, `bg-surface`) y se ciñe a
          la medida de lectura con el mismo `max-w-[68ch] text-[15px]` que los
          párrafos, para que su borde derecho case con el del texto. Los tres
          datos van en una sola línea, anclados a los bordes de la banda
          (`justify-between`); si el ancho no da, envuelven a la línea siguiente.
          Solo las victorias van en el oro del acento; el cero y las cifras de
          objetivos se quedan en el texto. */}
      <section
        aria-label="Resumen de la puntuación"
        className="thread-top relative max-w-[68ch] overflow-hidden rounded-lg border border-line bg-surface px-5 py-4 text-[15px]"
      >
        <dl className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-3">
          <div className="flex items-baseline gap-2">
            <dd className="font-display text-2xl font-semibold tabular-nums text-accent">
              2
            </dd>
            <dt className="text-sm text-muted">puntos por victoria</dt>
          </div>
          <div className="flex items-baseline gap-2">
            <dd className="font-display text-2xl font-semibold tabular-nums text-muted">
              0
            </dd>
            <dt className="text-sm text-muted">por derrota</dt>
          </div>
          <div className="flex items-baseline gap-2">
            <dd className="font-display text-2xl font-semibold tabular-nums text-foreground">
              82
            </dd>
            <dt className="text-sm text-muted">
              objetivos que reparten 4.679 puntos en total
            </dt>
          </div>
        </dl>
      </section>

      <MobileSectionIndex
        sections={SECTIONS}
        ariaLabel="Secciones de la puntuación"
      />

      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_13rem] lg:gap-14">
        <div className="flex min-w-0 flex-col gap-16">
          <section id="periodo" className="scroll-mt-24">
            <SectionHeading title="Periodo del torneo" />
            <p className="mt-4 max-w-[68ch] text-[15px] leading-relaxed text-muted">
              {tournamentWindow !== null ? (
                <>
                  {formatTournamentWindow(tournamentWindow)}. Solo cuentan las
                  partidas jugadas dentro de estas fechas.
                </>
              ) : (
                "Solo cuentan las partidas jugadas dentro de las fechas del torneo."
              )}
            </p>
          </section>

          <section id="como-se-puntua" className="scroll-mt-24">
            <SectionHeading title="Cómo se puntúa" />
            <ul className="mt-4 flex max-w-[68ch] flex-col gap-3 text-[15px] leading-relaxed text-muted">
              <li className="flex gap-3">
                <span
                  aria-hidden="true"
                  className="font-display font-semibold tabular-nums text-accent"
                >
                  2
                </span>
                <span>
                  Cada victoria en una partida clasificatoria vale{" "}
                  <strong className="font-semibold text-foreground">
                    2 puntos
                  </strong>
                  .
                </span>
              </li>
              <li className="flex gap-3">
                <span
                  aria-hidden="true"
                  className="font-display font-semibold tabular-nums text-muted/70"
                >
                  0
                </span>
                <span>Las derrotas no suman ni restan.</span>
              </li>
              <li className="flex gap-3">
                <span
                  aria-hidden="true"
                  className="font-display font-semibold tabular-nums text-muted/70"
                >
                  0
                </span>
                <span>
                  Una partida sin terminar, abandonada o revertida no cuenta.
                </span>
              </li>
            </ul>
            <div className="mt-5 flex max-w-[68ch] flex-col gap-3 text-[15px] leading-relaxed text-muted">
              <p>
                Una victoria vale lo mismo en 1vs1 que en partidas por equipos.
              </p>
              <p>
                El total de un jugador es la suma de sus puntos por victorias más
                los puntos extra de los objetivos.
              </p>
            </div>
          </section>

          <section id="clasificatorias" className="scroll-mt-24">
            <SectionHeading title="Qué cuenta como partida clasificatoria" />
            <p className="mt-4 max-w-[68ch] text-[15px] leading-relaxed text-muted">
              Una partida puntúa si cumple todo esto:
            </p>
            <ul className="mt-4 flex max-w-[68ch] flex-col gap-3 text-[15px] leading-relaxed text-muted">
              <li className="flex gap-3">
                <span
                  aria-hidden="true"
                  className="font-display font-semibold text-accent"
                >
                  -
                </span>
                <span>
                  Es de la ladder <em>ranked</em>: 1vs1 o por equipos. Quick
                  match y personalizadas no cuentan.
                </span>
              </li>
              <li className="flex gap-3">
                <span
                  aria-hidden="true"
                  className="font-display font-semibold text-accent"
                >
                  -
                </span>
                <span>Está terminada, con resultado.</span>
              </li>
              <li className="flex gap-3">
                <span
                  aria-hidden="true"
                  className="font-display font-semibold text-accent"
                >
                  -
                </span>
                <span>Se jugó dentro de las fechas del torneo.</span>
              </li>
              <li className="flex gap-3">
                <span
                  aria-hidden="true"
                  className="font-display font-semibold text-accent"
                >
                  -
                </span>
                <span>Es posterior a la inscripción del jugador.</span>
              </li>
              <li className="flex gap-3">
                <span
                  aria-hidden="true"
                  className="font-display font-semibold text-accent"
                >
                  -
                </span>
                <span>No está revertida por la organización.</span>
              </li>
              <li className="flex gap-3">
                <span
                  aria-hidden="true"
                  className="font-display font-semibold text-accent"
                >
                  -
                </span>
                <span>El jugador está aprobado.</span>
              </li>
            </ul>

            <div className="mt-6">
              <RankedModesTable />
            </div>
          </section>

          <section id="objetivos" className="scroll-mt-24">
            <SectionHeading title="Objetivos especiales" />
            <div className="mt-4 flex max-w-[68ch] flex-col gap-3 text-[15px] leading-relaxed text-muted">
              <p>
                Además de las victorias, el torneo reparte puntos extra entre{" "}
                <strong className="font-semibold text-foreground">82 objetivos</strong>.
              </p>
              <p>
                Hay dos formas de cobrarlos: las{" "}
                <strong className="font-semibold text-foreground">competiciones</strong> las gana
                una sola persona, la que va primera; los{" "}
                <strong className="font-semibold text-foreground">logros</strong> los cobra todo el
                que cumple la condición, y pueden ser varios.
              </p>
              <p>
                Se calculan sobre las mismas partidas clasificatorias, así que
                también respetan la fecha de inscripción.
              </p>
              <p>
                Cada logro tiene su umbral fijo: 3 victorias o partidas con una
                civilización, 3 partidas cortas o largas, una racha de 5 victorias,
                etc.
              </p>
              <p>
                Todos se resuelven en cada recálculo, así que quién los cobra puede
                cambiar de una jornada a otra.
              </p>
              <p>
                <Link
                  href="/objetivos"
                  className="text-accent underline underline-offset-4 hover:text-accent-strong"
                >
                  Ver los 82 objetivos y quién los cobra
                </Link>
              </p>
            </div>
          </section>

          <section id="desempates" className="scroll-mt-24">
            <SectionHeading title="Desempates" />
            <p className="mt-4 max-w-[68ch] text-[15px] leading-relaxed text-muted">
              Si dos jugadores empatan a puntos, va delante quien tenga más
              victorias. Si el empate continúa, decide el porcentaje de victorias
              (victorias entre partidas jugadas) y, si aún persiste, el orden lo fija
              la web de forma estable.
            </p>
          </section>
        </div>

        <SectionIndexAside
          sections={SECTIONS}
          ariaLabel="Secciones de la puntuación"
        />
      </div>
    </div>
  );
}
