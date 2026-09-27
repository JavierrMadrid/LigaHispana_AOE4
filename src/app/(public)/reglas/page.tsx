import type { Metadata } from "next";
import { PageHead } from "@/components/page-head";

export const metadata: Metadata = {
  title: "Reglas",
  description:
    "Formato, sistema de puntuación provisional y qué cuenta como partida clasificatoria en la Liga Hispana de Age of Empires IV.",
};

const SECTIONS = [
  { id: "formato", label: "Formato" },
  { id: "puntuacion", label: "Puntuación" },
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

export default function RulesPage() {
  return (
    <div className="flex flex-col gap-10">
      <PageHead
        title="Reglas"
        lead="El torneo es individual. Cada jugador entra con su cuenta de AoE4World, juega en la ladder ranked y acumula puntos. Quien termine con más puntos, gana."
      />

      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_13rem] lg:gap-14">
        <div className="flex min-w-0 flex-col gap-12">
          <section id="formato" className="scroll-mt-24">
            <h2 className="font-display text-xl font-semibold text-foreground">
              Formato
            </h2>
            <div className="mt-4 flex max-w-[68ch] flex-col gap-3 leading-relaxed text-foreground/85">
              <p>
                No hay equipos. Cada persona compite por su cuenta y su cuenta es la
                que se registra en la liga, junto con un identificador de perfil de
                AoE4World.
              </p>
              <p>
                Se juega en la misma ladder ranked que usan las cuentas públicas del
                juego. No hace falta tirar partidas amistosas ni apuntarse a ningún
                evento: basta con jugar al ranked con la cuenta dada de alta.
              </p>
              <p>
                La clasificación se recalcula sola cada pocos minutos con los
                resultados que va publicando AoE4World, así que no hay que recargar
                la página a mano.
              </p>
            </div>
          </section>

          <section id="puntuacion" className="scroll-mt-24">
            <h2 className="font-display text-xl font-semibold text-foreground">
              Puntuación
            </h2>
            <ul className="mt-4 flex max-w-[68ch] flex-col gap-3">
              <li className="flex gap-3 leading-relaxed text-foreground/85">
                <span
                  aria-hidden="true"
                  className="font-display font-semibold tabular-nums text-accent"
                >
                  1
                </span>
                <span>
                  Cada victoria en partida clasificatoria vale{" "}
                  <strong className="font-semibold text-foreground">1 punto</strong>.
                </span>
              </li>
              <li className="flex gap-3 leading-relaxed text-foreground/85">
                <span
                  aria-hidden="true"
                  className="font-display font-semibold tabular-nums text-muted"
                >
                  0
                </span>
                <span>Las derrotas no suman ni restan nada.</span>
              </li>
              <li className="flex gap-3 leading-relaxed text-foreground/85">
                <span
                  aria-hidden="true"
                  className="font-display font-semibold tabular-nums text-muted"
                >
                  0
                </span>
                <span>
                  Una partida abandonada, caída o sin resolver no cuenta: ni suma ni
                  resta, y desaparece de la lista de partidas en directo.
                </span>
              </li>
            </ul>
            <p className="mt-5 max-w-[68ch] leading-relaxed text-muted">
              Las cifras de la clasificación salen de las partidas que AoE4World ya ha
              resuelto. Una partida que todavía no tiene resultado no puntúa nunca.
            </p>
          </section>

          <section id="clasificatorias" className="scroll-mt-24">
            <h2 className="font-display text-xl font-semibold text-foreground">
              Qué cuenta como partida clasificatoria
            </h2>
            <p className="mt-4 max-w-[68ch] leading-relaxed text-foreground/85">
              Solo cuentan las partidas de la ladder <em>ranked</em>: el 1vs1 y el
              ranked por equipos. Cualquier otro modo, incluidas las partidas
              personalizadas y el quick match, sirve para practicar pero no suma
              puntos.
            </p>

            <div className="mt-6 overflow-x-auto rounded-lg border border-line">
              <table className="w-full border-collapse text-sm">
                <caption className="sr-only">
                  Modos de juego de Age of Empires IV y si puntúan en la liga.
                </caption>
                <thead className="bg-surface">
                  <tr className="text-left text-xs font-medium text-muted">
                    <th scope="col" className="px-4 py-3">
                      Modo
                    </th>
                    <th scope="col" className="px-4 py-3">
                      Identificador en AoE4World
                    </th>
                    <th scope="col" className="px-4 py-3 text-right">
                      Puntúa
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {MODES.map((row) => (
                    <tr key={row.mode}>
                      <td className="px-4 py-3 text-foreground">{row.mode}</td>
                      <td className="px-4 py-3">
                        {row.ladder === "" ? (
                          <span className="text-muted">sin ladder ranked</span>
                        ) : (
                          <span className="font-mono text-muted">{row.ladder}</span>
                        )}
                      </td>
                      <td
                        className={`px-4 py-3 text-right font-medium ${
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

            <p className="mt-5 max-w-[68ch] leading-relaxed text-muted">
              En una partida por equipos solo se registra la victoria de cada jugador
              de la liga. Sus compañeros de equipo no suman puntos, y el rival que
              aparece en la lista de partidas en directo es solo el primer jugador
              del equipo contrario.
            </p>
          </section>

          <section id="estado" className="scroll-mt-24">
            <h2 className="font-display text-xl font-semibold text-foreground">
              Estado del reglamento
            </h2>
            <div className="mt-4 flex max-w-[68ch] flex-col gap-3 leading-relaxed text-foreground/85">
              <p>
                El sistema de puntuación que se aplica hoy es provisional. La
                comunidad está definiéndolo ahora mismo; hasta que se cierre, se
                aplica la regla más simple que cumple el formato del torneo, que es un
                punto plano por victoria.
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