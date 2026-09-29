import type { Metadata } from "next";
import Link from "next/link";
import { PageHead } from "@/components/page-head";

export const metadata: Metadata = {
  title: "Reglas",
  description:
    "Formato, sistema de puntuación con objetivos especiales y qué cuenta como partida clasificatoria en la Liga Hispana de Age of Empires IV.",
};

const SECTIONS = [
  { id: "formato", label: "Formato" },
  { id: "puntuacion", label: "Puntuación" },
  { id: "objetivos", label: "Objetivos especiales" },
  { id: "clasificatorias", label: "Partidas clasificatorias" },
  { id: "estado", label: "Estado del reglamento" },
] as const;

const MODES = [
  { mode: "Ranked 1vs1", ladder: "rm_solo", counts: true },
  { mode: "Ranked por equipos 2v2", ladder: "rm_2v2", counts: true },
  { mode: "Ranked por equipos 3v3", ladder: "rm_3v3", counts: true },
  { mode: "Ranked por equipos 4v4", ladder: "rm_4v4", counts: true },
  { mode: "Quick match", ladder: "", counts: false },
  { mode: "Partidas personalizadas", ladder: "", counts: false },
] as const;

/**
 * Cabecera de una sección normativa: el titular en Cinzel sobre el filete que
 * abre el bloque. Repite el ritmo de cabecera de los grupos de `/objetivos`
 * para que las dos páginas se lean como la misma crónica.
 */
function SectionHeading({ title }: { title: string }) {
  return (
    <h2 className="border-b border-line pb-3 font-display text-xl font-semibold text-foreground">
      {title}
    </h2>
  );
}

export default function RulesPage() {
  return (
    <div className="flex flex-col gap-10">
      <PageHead title="Reglas" />

      {/* Índice de secciones para pantallas estrechas: el índice lateral solo
          existe a partir de `lg`, así que por debajo se ofrece plegado, con la
          misma lista y el mismo rótulo. */}
      <nav aria-label="Secciones de las reglas" className="lg:hidden">
        <details className="group rounded-lg border border-line bg-surface">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-3 sm:px-4 text-sm font-medium text-foreground [&::-webkit-details-marker]:hidden">
            En esta página
            <svg
              viewBox="0 0 12 12"
              aria-hidden="true"
              className="size-3 shrink-0 text-muted transition-transform motion-reduce:transition-none group-open:rotate-180"
            >
              <path
                d="M2.5 4.5 6 8l3.5-3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </summary>
          <ul className="flex flex-col border-t border-line py-1">
            {SECTIONS.map((section) => (
              <li key={section.id}>
                <a
                  href={`#${section.id}`}
                  className="block px-4 py-2.5 text-sm text-muted transition-colors hover:text-foreground"
                >
                  {section.label}
                </a>
              </li>
            ))}
          </ul>
        </details>
      </nav>

      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_13rem] lg:gap-14">
        <div className="flex min-w-0 flex-col gap-16">
          <section id="formato" className="scroll-mt-24">
            <SectionHeading title="Formato" />
            <div className="mt-4 flex max-w-[68ch] flex-col gap-3 text-[15px] leading-relaxed text-muted">
              <p>
                No hay equipos. Cada persona compite por su cuenta y su cuenta es la
                que se registra en la liga, junto con un identificador de perfil de
                AoE4World.
              </p>
              <p>
                Se juega en la misma ladder ranked que usan las cuentas públicas del
                juego. No hace falta tirar partidas amistosas ni apuntarse a ningún
                evento: basta con jugar rankeds con la cuenta dada de alta.
              </p>
              <p>
                La clasificación se recalcula sola cada pocos minutos con los
                resultados que va publicando AoE4World, así que no hay que recargar
                la página a mano.
              </p>
            </div>
          </section>

          <section id="puntuacion" className="scroll-mt-24">
            <SectionHeading title="Puntuación" />
            <ul className="mt-4 flex max-w-[68ch] flex-col gap-3 text-[15px] leading-relaxed text-muted">
              <li className="flex gap-3">
                <span
                  aria-hidden="true"
                  className="font-display font-semibold tabular-nums text-accent"
                >
                  10
                </span>
                <span>
                  Cada victoria en partida clasificatoria vale{" "}
                  <strong className="font-semibold text-foreground">10 puntos</strong>.
                </span>
              </li>
              <li className="flex gap-3">
                <span
                  aria-hidden="true"
                  className="font-display font-semibold tabular-nums text-muted/70"
                >
                  0
                </span>
                <span>Las derrotas no suman ni restan nada.</span>
              </li>
              <li className="flex gap-3">
                <span
                  aria-hidden="true"
                  className="font-display font-semibold tabular-nums text-muted/70"
                >
                  0
                </span>
                <span>
                  Una partida abandonada, caída o sin resolver no cuenta: ni suma ni
                  resta, y desaparece de la lista de partidas en juego.
                </span>
              </li>
            </ul>
            <p className="mt-5 max-w-[68ch] text-[15px] leading-relaxed text-muted">
              A esa suma se añaden los{" "}
              <strong className="font-semibold text-foreground">
                objetivos especiales
              </strong>
              , que reparten puntos extra a quien va primero. Están detallados en la
              sección siguiente.
            </p>
            <p className="mt-3 max-w-[68ch] text-sm leading-relaxed text-muted/85">
              Las cifras de la clasificación salen de las partidas que AoE4World ya ha
              resuelto. Una partida que todavía no tiene resultado no puntúa nunca.
            </p>
          </section>

          <section id="objetivos" className="scroll-mt-24">
            <SectionHeading title="Objetivos especiales" />
            <div className="mt-4 flex max-w-[68ch] flex-col gap-3 text-[15px] leading-relaxed text-muted">
              <p>
                El torneo reparte 2320 puntos extra entre 37 objetivos. Cada objetivo
                lo cobra una sola persona, la que va primera en su clasificación: no
                hay puestos parciales ni puntos repartidos.
              </p>
              <p>
                Quién posee cada objetivo se resuelve en caliente, en cada recálculo
                de la clasificación, así que el poseedor puede cambiar de una jornada
                a otra. La excepción son las carreras de civilización: cada una se
                cierra en cuanto alguien llega a 10 victorias con esa civilización y
                ya no se reabre.
              </p>
              <p>
                Tres familias exigen un mínimo. El mejor ratio (<em>Prohibido perder</em>)
                y la mejor racha (<em>¿Golpe de suerte?</em>) piden 10 partidas
                clasificatorias, y cada civilización se cierra al llegar a 10
                victorias. Los demás objetivos no tienen umbral.
              </p>
              <p>
                <Link
                  href="/objetivos"
                  className="text-accent underline underline-offset-4 hover:text-accent-strong"
                >
                  Ver los objetivos, sus puntos y quién los posee
                </Link>
              </p>
            </div>
          </section>

          <section id="clasificatorias" className="scroll-mt-24">
            <SectionHeading title="Qué cuenta como partida clasificatoria" />
            <p className="mt-4 max-w-[68ch] text-[15px] leading-relaxed text-muted">
              Solo cuentan las partidas de la ladder <em>ranked</em>: el 1vs1 y el
              ranked por equipos. Cualquier otro modo, incluidas las partidas
              personalizadas y el quick match, sirve para practicar pero no suma
              puntos.
            </p>

            {/* Sin ancho mínimo: con el relleno compacto de móvil las tres
                columnas caben por sí solas en un teléfono, así que no hay que
                desplazar. El `overflow-x-auto` queda como red de seguridad. */}
            <div className="mt-6 overflow-x-auto overscroll-x-contain rounded-lg border border-line">
              <table className="w-full border-collapse text-sm">
                <caption className="sr-only">
                  Modos de juego de Age of Empires IV y si puntúan en la liga.
                </caption>
                <thead className="bg-surface">
                  <tr className="text-left text-xs font-medium text-muted">
                    <th scope="col" className="px-3 py-3 sm:px-4">
                      Modo
                    </th>
                    <th scope="col" className="px-3 py-3 sm:px-4">
                      Identificador en AoE4World
                    </th>
                    <th scope="col" className="px-3 py-3 sm:px-4 text-right">
                      Puntúa
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {MODES.map((row) => (
                    <tr key={row.mode}>
                      <td className="px-3 py-3 sm:px-4 text-foreground">{row.mode}</td>
                      <td className="px-3 py-3 sm:px-4">
                        {row.ladder === "" ? (
                          <span className="text-muted">sin ladder ranked</span>
                        ) : (
                          <span className="font-mono text-muted">{row.ladder}</span>
                        )}
                      </td>
                      <td
                        className={`px-3 py-3 sm:px-4 text-right font-medium ${
                          row.counts ? "text-accent" : "text-muted"
                        }`}
                      >
                        {row.counts ? "Sí" : "No"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="mt-5 max-w-[68ch] text-sm leading-relaxed text-muted/85">
              En una partida por equipos solo puntúa la victoria de cada jugador de
              la liga: sus compañeros de equipo no suman puntos. La lista de
              partidas en juego sí muestra la alineación completa, con todos los
              jugadores de cada equipo y su civilización.
            </p>
          </section>

          <section id="estado" className="scroll-mt-24">
            <SectionHeading title="Estado del reglamento" />
            <div className="mt-4 flex max-w-[68ch] flex-col gap-3 text-[15px] leading-relaxed text-muted">
              <p>
                El sistema de puntuación que se aplica hoy es la versión 2 del
                reglamento: 10 puntos por victoria clasificatoria más los 37
                objetivos especiales. Sigue abierto mientras la organización cierra
                los últimos detalles, como los puntos exactos de cada objetivo;
                cualquier cambio de estructura sube la versión y se recalcula la
                clasificación entera.
              </p>
              <p>
                Cuando se publiquen las reglas definitivas se anunciarán en esta
                página y la clasificación se recalculará entera. No se pierde nada de
                lo ya jugado: la web guarda la versión provisional y la nueva por
                separado, con la fecha de cada cálculo.
              </p>
              <p>
                Hasta entonces, la tabla de la clasificación es la que se muestra en
                la portada y se recalcula sola en cada visita.
              </p>
            </div>
          </section>
        </div>

        <nav aria-label="Secciones de las reglas" className="hidden lg:block">
          <div className="sticky top-24">
            <p className="text-xs text-muted">En esta página</p>
            <ul className="mt-3 flex flex-col gap-2 border-l border-line">
              {SECTIONS.map((section) => (
                <li key={section.id}>
                  <a
                    href={`#${section.id}`}
                    className="-ml-px block border-l border-transparent pl-3 text-sm text-muted transition-colors hover:border-accent hover:text-foreground"
                  >
                    {section.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </nav>
      </div>
    </div>
  );
}
