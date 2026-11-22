import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "@phosphor-icons/react/dist/ssr/ArrowRight";
import { CalendarBlank } from "@phosphor-icons/react/dist/ssr/CalendarBlank";
import { Check } from "@phosphor-icons/react/dist/ssr/Check";
import { ListChecks } from "@phosphor-icons/react/dist/ssr/ListChecks";
import { Scales } from "@phosphor-icons/react/dist/ssr/Scales";
import { Sword } from "@phosphor-icons/react/dist/ssr/Sword";
import { Target } from "@phosphor-icons/react/dist/ssr/Target";
import { Trophy } from "@phosphor-icons/react/dist/ssr/Trophy";
import type { ReactNode } from "react";
import { RankedModesTable } from "@/components/ranked-modes-table";
import {
  MobileSectionIndex,
  SectionIndexAside,
  type DocSection,
} from "@/components/section-index";
import { formatTournamentWindow } from "@/lib/format";
import { hasNoCap } from "@/lib/objective-format";
import { getEditionConfig, getObjectives, getTournamentWindow } from "@/lib/public";
import "./scoring.css";

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
 * cifras de cuatro dígitos —3292, no 3.292—, así que el total del torneo se lee
 * entero y solo los millones llevan punto.
 */
const countFormat = new Intl.NumberFormat("es-ES");

function ScoringHeading({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <h2 className="scoring-heading">
      <span aria-hidden="true">{icon}</span>
      {children}
    </h2>
  );
}

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
    <div className="scoring-page">
      <header className="scoring-intro">
        <h1>Puntuación</h1>
        <p>
          Cómo se reparten los puntos del torneo. Las normas están en{" "}
          <Link href="/reglas">Reglas</Link>.
        </p>
      </header>

      {pointsPerWin !== null && objectiveCount !== null && objectivePoints !== null ? (
        <section aria-label="Resumen de la puntuación" className="scoring-summary">
          <dl>
            <div className="scoring-summary-win">
              <dt>{pointsPerWin === 1 ? "Punto" : "Puntos"} por victoria</dt>
              <dd>{pointsPerWin}</dd>
              <dd className="scoring-summary-note">Sin tope</dd>
            </div>
            <div>
              <dt>Puntos por derrota</dt>
              <dd>0</dd>
            </div>
            <div>
              <dt>Objetivos</dt>
              <dd>{objectiveCount}</dd>
              <dd className="scoring-summary-note">
                {countFormat.format(objectivePoints)} puntos de premio fijo
              </dd>
            </div>
          </dl>
        </section>
      ) : null}

      <div className="scoring-guide">
        <div className="scoring-index">
          <MobileSectionIndex sections={SECTIONS} ariaLabel="Secciones de la puntuación" />
          <SectionIndexAside sections={SECTIONS} ariaLabel="Secciones de la puntuación" />
        </div>

        <div className="scoring-sections">
          <section id="periodo">
            <ScoringHeading icon={<CalendarBlank size={19} />}>
              Periodo del torneo
            </ScoringHeading>
            <p>
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

          <section id="como-se-puntua">
            <ScoringHeading icon={<Sword size={19} />}>
              Cómo se puntúa
            </ScoringHeading>
            <ul className="scoring-outcomes" role="list">
              <li>
                <span aria-hidden="true" className="scoring-outcome-value">
                  {pointsPerWin ?? <Check size={16} />}
                </span>
                <span>
                  {pointsPerWin !== null ? (
                    <>
                      Cada victoria en una partida clasificatoria vale{" "}
                      <strong>
                        {pointsPerWin} {pointsPerWin === 1 ? "punto" : "puntos"}
                      </strong>
                      . Los paga el objetivo <Link href="/objetivos">Victorias</Link>,
                      sin umbral ni tope.
                    </>
                  ) : (
                    "Cada victoria en una partida clasificatoria suma puntos."
                  )}
                </span>
              </li>
              <li>
                <span aria-hidden="true" className="scoring-outcome-value">
                  0
                </span>
                <span>Las derrotas no suman ni restan.</span>
              </li>
              <li>
                <span aria-hidden="true" className="scoring-outcome-value">
                  0
                </span>
                <span>
                  Una partida sin terminar, abandonada o revertida no cuenta.
                </span>
              </li>
            </ul>
            <div>
              <p className="scoring-note">
                Durante un evento puntual, esa victoria multiplica sus puntos por el
                multiplicador del evento. El multiplicador solo afecta a los puntos por
                victoria. El calendario y los requisitos de cada evento están en{" "}
                <Link href="/reglas#eventos">Reglas</Link>.
              </p>
              <p>
                Una victoria vale lo mismo en 1vs1 que en partidas por equipos.
              </p>
              <p>
                El total de un jugador suma los{" "}
                <strong>permanentes</strong>{" "}
                (los logros que ya ha conseguido, con Victorias dentro), los{" "}
                <strong>temporales</strong>{" "}
                (las competiciones, que se deciden al cierre) y el bono de los
                eventos puntuales, que va con los permanentes.
              </p>
              <p>
                El <Link href="/historial">historial de puntos</Link>{" "}
                enseña qué ha sumado cada victoria clasificatoria y cada objetivo
                cumplido, de lo más reciente a lo más antiguo, con filtros por
                participante y por fechas. El bono de los eventos puntuales no aparece
                ahí: se suma al total de la clasificación. Una ganancia revertida por la
                organización no cuenta y aparece en el historial tachada y marcada.
              </p>
            </div>
          </section>

          <section id="clasificatorias">
            <ScoringHeading icon={<ListChecks size={19} />}>
              Qué cuenta como partida clasificatoria
            </ScoringHeading>
            <p>Para puntuar, una partida debe cumplir todas estas condiciones.</p>
            <ul className="scoring-conditions" role="list">
              <li>
                <Check size={16} aria-hidden="true" />
                <span>
                  Es de la ladder <em>ranked</em> 1vs1 o por equipos. Quick
                  match y personalizadas no cuentan.
                </span>
              </li>
              <li>
                <Check size={16} aria-hidden="true" />
                <span>Está terminada, con resultado.</span>
              </li>
              <li>
                <Check size={16} aria-hidden="true" />
                <span>Se jugó dentro de las fechas del torneo.</span>
              </li>
              <li>
                <Check size={16} aria-hidden="true" />
                <span>Es posterior a la inscripción del jugador.</span>
              </li>
              <li>
                <Check size={16} aria-hidden="true" />
                <span>No está revertida por la organización.</span>
              </li>
              <li>
                <Check size={16} aria-hidden="true" />
                <span>
                  En las partidas por equipos, ningún compañero está a dos
                  escalones o más de división del jugador.
                </span>
              </li>
              <li>
                <Check size={16} aria-hidden="true" />
                <span>El jugador está aprobado.</span>
              </li>
            </ul>

            <p>
              El escalón es la división (bronce, plata, oro, platino, diamante o
              conquistador), sin el subrango I/II/III. Así, un jugador en oro
              cuenta con compañeros en plata, oro o platino, y no con uno en
              bronce ni con uno en diamante.
            </p>

            <div className="scoring-modes">
              <RankedModesTable />
            </div>
          </section>

          <section id="objetivos">
            <ScoringHeading icon={<Target size={19} />}>
              Objetivos especiales
            </ScoringHeading>
            <div>
              <p>
                El torneo reparte puntos extra entre{" "}
                {objectiveCount !== null ? (
                  <strong>{objectiveCount} objetivos</strong>
                ) : (
                  "los objetivos especiales"
                )}
                . El objetivo <strong>Victorias</strong> paga cada victoria
                clasificatoria, sin umbral ni tope.
              </p>
              <p>
                Las <strong>competiciones</strong> las gana una sola persona, la
                que va primera. Los <strong>logros</strong> los cobra cada
                participante que cumple la condición.
              </p>
              <p>
                Se calculan sobre las mismas partidas clasificatorias, así que
                también respetan la fecha de inscripción.
              </p>
              <p>
                Casi todos los logros tienen un umbral fijo. Algunos ejemplos son
                3 victorias o partidas con una civilización, 3 partidas cortas o
                largas o una racha de 5 victorias. Los repetibles suman por
                victoria en Victorias y por día en Imparable.
              </p>
              <p>
                Todos se resuelven en cada recálculo, así que quién los cobra puede
                cambiar de una jornada a otra.
              </p>
              <p>
                <Link href="/objetivos" className="scoring-next">
                  {objectiveCount !== null
                    ? `Ver los ${objectiveCount} objetivos y quién los cobra`
                    : "Ver los objetivos y quién los cobra"}
                  <ArrowRight size={16} aria-hidden="true" />
                </Link>
              </p>
            </div>
          </section>

          <section id="desempates">
            <ScoringHeading icon={<Scales size={19} />}>
              Desempates
            </ScoringHeading>
            <p>
              Si dos jugadores empatan a puntos, se aplican estos criterios en orden.
            </p>
            <ol className="scoring-tiebreaks">
              <li>
                <strong>Tasa de victorias</strong> (victorias entre partidas jugadas).
              </li>
              <li>
                <strong>Partidas ganadas.</strong>
              </li>
              <li>
                <strong>Partidas jugadas.</strong>
              </li>
            </ol>
            <p>
              Si el empate persiste, comparten posición (por ejemplo, 1, 2, 2, 4)
              y, si hay premios, se reparten a partes iguales.
            </p>
            {prize !== null ? (
              <p className="scoring-note scoring-prize">
                <Trophy size={18} aria-hidden="true" />
                <span>
                  El premio base de esta edición es de <strong>{prize.amount} €</strong>
                  {prize.note !== null ? `, ${prize.note}` : ""}.
                </span>
              </p>
            ) : null}
          </section>
        </div>
      </div>
    </div>
  );
}
