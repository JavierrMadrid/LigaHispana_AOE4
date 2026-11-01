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
import { hasNoCap } from "@/lib/objective-format";
import { getEditionConfig, getObjectives, getTournamentWindow } from "@/lib/public";

export const metadata: Metadata = {
  title: "Puntuación",
  description:
    "Cómo se reparten los puntos de la Liga Hispana de Age of Empires IV: cuánto vale cada victoria clasificatoria y cómo la multiplica un evento puntual, qué cuenta como partida, los objetivos especiales y los desempates.",
};

const SECTIONS: readonly DocSection[] = [
  { id: "periodo", label: "Periodo del torneo" },
  { id: "como-se-puntua", label: "Cómo se puntúa" },
  { id: "clasificatorias", label: "Qué cuenta como partida clasificatoria" },
  { id: "objetivos", label: "Objetivos especiales" },
  { id: "desempates", label: "Desempates" },
];

// El periodo, los puntos por victoria, los objetivos activos y el premio se leen
// de la base de datos en cada petición: la ventana vive en el ruleset, el premio
// en la configuración de la edición, y la organización los cambia sin desplegar.
// Una página generada en el `build` enseñaría las cifras de la edición anterior.
export const dynamic = "force-dynamic";

/**
 * Miles con el separador de español, el punto. Con CLDR, `es-ES` no agrupa las
 * cifras de cuatro dígitos —2754, no 2.754—, así que el total del torneo se lee
 * entero y solo los millones llevan punto.
 */
const countFormat = new Intl.NumberFormat("es-ES");

export default async function ScoringPage() {
  const [windowRead, objectivesRead, editionRead] = await Promise.all([
    getTournamentWindow(),
    getObjectives(),
    getEditionConfig(),
  ]);

  // Degradada no se inventan cifras: la lista de condiciones ya dice "dentro de
  // las fechas del torneo" y ese texto genérico se queda tal cual. Con `to: null`
  // la ventana sigue siendo válida (abierta) y se enseña como "Desde el …".
  const tournamentWindow = windowRead.status === "ok" ? windowRead.data : null;

  // `getObjectives()` es la lectura que trae el ruleset activo entero: los puntos
  // por victoria y los objetivos **activos**, cada uno con sus puntos ya
  // resueltos. De ahí salen el recuento y el total, en vez de escribirlos a mano.
  const objectives = objectivesRead.status === "ok" ? objectivesRead.data : null;
  const pointsPerWin = objectives?.pointsPerWin ?? null;
  const objectiveCount = objectives?.options.length ?? null;
  // La suma de los objetivos de **premio fijo**: `victorias` queda fuera, porque no
  // reparte un premio sino que paga por victoria y sin tope. Sumarlo diría que el
  // torneo reparte una cifra que no reparte (ver `docs/PUNTUACION.md`).
  const objectivePoints =
    objectives === null
      ? null
      : objectives.options
          .filter((option) => !hasNoCap(option))
          .reduce((total, option) => total + option.points, 0);

  const edition = editionRead.status === "ok" ? editionRead.data : null;
  const prize = edition !== null && edition.prize.amount !== null ? edition.prize : null;

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
          objetivos se quedan en el texto. Sin la lectura del ruleset no se pinta:
          los números no se inventan. */}
      {pointsPerWin !== null && objectiveCount !== null && objectivePoints !== null ? (
        <section
          aria-label="Resumen de la puntuación"
          className="thread-top relative max-w-[68ch] overflow-hidden rounded-lg border border-line bg-surface px-5 py-4 text-[15px]"
        >
          <dl className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-3">
            <div className="flex items-baseline gap-2">
              <dd className="font-display text-2xl font-semibold tabular-nums text-accent">
                {pointsPerWin}
              </dd>
              <dt className="text-sm text-muted">puntos por victoria, sin tope</dt>
            </div>
            <div className="flex items-baseline gap-2">
              <dd className="font-display text-2xl font-semibold tabular-nums text-muted">
                0
              </dd>
              <dt className="text-sm text-muted">por derrota</dt>
            </div>
            <div className="flex items-baseline gap-2">
              <dd className="font-display text-2xl font-semibold tabular-nums text-foreground">
                {objectiveCount}
              </dd>
              <dt className="text-sm text-muted">
                objetivos, con {countFormat.format(objectivePoints)} puntos de premio
                fijo
              </dt>
            </div>
          </dl>
        </section>
      ) : null}

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
                  {pointsPerWin ?? "-"}
                </span>
                <span>
                  {pointsPerWin !== null ? (
                    <>
                      Cada victoria en una partida clasificatoria vale{" "}
                      <strong className="font-semibold text-foreground">
                        {pointsPerWin} {pointsPerWin === 1 ? "punto" : "puntos"}
                      </strong>
                      , que paga el objetivo{" "}
                      <Link
                        href="/objetivos"
                        className="text-accent underline underline-offset-4 hover:text-accent-strong"
                      >
                        Victorias
                      </Link>
                      : sin umbral ni tope, suma con cada partida ganada.
                    </>
                  ) : (
                    "Cada victoria en una partida clasificatoria suma puntos."
                  )}
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
                Durante un evento puntual, esa victoria multiplica sus puntos por el
                multiplicador del evento. El multiplicador solo afecta a los puntos por
                victoria: el calendario y los requisitos de cada evento están en{" "}
                <Link
                  href="/reglas#eventos"
                  className="text-accent underline underline-offset-4 hover:text-accent-strong"
                >
                  Reglas
                </Link>
                .
              </p>
              <p>
                Una victoria vale lo mismo en 1vs1 que en partidas por equipos.
              </p>
              <p>
                El total de un jugador suma tres partes: los{" "}
                <strong className="font-semibold text-foreground">permanentes</strong>{" "}
                (los logros que ya ha conseguido, con Victorias dentro), los{" "}
                <strong className="font-semibold text-foreground">temporales</strong>{" "}
                (las competiciones, que se deciden al cierre) y el bono de los
                eventos puntuales, que va con los permanentes.
              </p>
              <p>
                El{" "}
                <Link
                  href="/historial"
                  className="text-accent underline underline-offset-4 hover:text-accent-strong"
                >
                  historial de puntos
                </Link>{" "}
                enseña qué ha sumado cada victoria clasificatoria y cada objetivo
                cumplido, de lo más reciente a lo más antiguo, con filtros por
                participante y por fechas. El bono de los eventos puntuales no aparece
                ahí: se suma al total de la clasificación. Una ganancia revertida por la
                organización no cuenta y aparece en el historial tachada y marcada.
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
                <span>
                  En las partidas por equipos, ningún compañero está a dos
                  escalones o más de división del jugador.
                </span>
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

            <p className="mt-4 max-w-[68ch] text-[15px] leading-relaxed text-muted">
              El escalón es la división (bronce, plata, oro, platino, diamante o
              conquistador), sin el subrango I/II/III. Así, un jugador en oro
              cuenta con compañeros en plata, oro o platino, y no con uno en
              bronce ni con uno en diamante.
            </p>

            <div className="mt-6">
              <RankedModesTable />
            </div>
          </section>

          <section id="objetivos" className="scroll-mt-24">
            <SectionHeading title="Objetivos especiales" />
            <div className="mt-4 flex max-w-[68ch] flex-col gap-3 text-[15px] leading-relaxed text-muted">
              <p>
                El torneo reparte puntos extra entre{" "}
                {objectiveCount !== null ? (
                  <strong className="font-semibold text-foreground">
                    {objectiveCount} objetivos
                  </strong>
                ) : (
                  "los objetivos especiales"
                )}
                . Uno de ellos es{" "}
                <strong className="font-semibold text-foreground">Victorias</strong>:
                el que paga cada victoria clasificatoria, sin umbral ni tope.
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
                Casi todos los logros tienen su umbral fijo: 3 victorias o partidas
                con una civilización, 3 partidas cortas o largas, una racha de 5
                victorias, etc. Los repetibles —Victorias, Imparable— suman una vez
                por unidad: por victoria y por día.
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
                  {objectiveCount !== null
                    ? `Ver los ${objectiveCount} objetivos y quién los cobra`
                    : "Ver los objetivos y quién los cobra"}
                </Link>
              </p>
            </div>
          </section>

          <section id="desempates" className="scroll-mt-24">
            <SectionHeading title="Desempates" />
            <p className="mt-4 max-w-[68ch] text-[15px] leading-relaxed text-muted">
              Si dos jugadores empatan a puntos, se desempata, por este orden,
              por la tasa de victorias (victorias entre partidas jugadas), por
              las partidas ganadas y por las partidas jugadas. Si el empate
              persiste, comparten posición (por ejemplo, 1, 2, 2, 4) y, si hay
              premios, se reparten a partes iguales.
            </p>
            {prize !== null ? (
              <p className="mt-3 max-w-[68ch] text-[15px] leading-relaxed text-muted">
                El premio base de esta edición es de{" "}
                <strong className="font-semibold text-foreground">
                  {prize.amount} €
                </strong>
                {prize.note !== null ? `, ${prize.note}` : ""}.
              </p>
            ) : null}
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
