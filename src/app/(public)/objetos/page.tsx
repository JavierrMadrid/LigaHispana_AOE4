import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight } from "@phosphor-icons/react/dist/ssr/ArrowUpRight";
import { EmptyState } from "@/components/empty-state";
import { HistoryTabs } from "@/components/history-tabs";
import { ObjectHistoryList } from "@/components/object-history-row";
import { PageSizeSelect } from "@/components/page-size-select";
import { Pagination } from "@/components/pagination";
import { HistoryFilters } from "@/components/history-filters";
import { getObjectHistory } from "@/lib/object-history";
import { getStandings } from "@/lib/public";
import { readSingleParam } from "@/lib/query-params";

export const metadata: Metadata = {
  title: "Objetos",
  description:
    "Los objetos utilizables de la Liga Hispana de Age of Empires IV: cada premio, lanzamiento, devolución y desventaja cumplida de la edición activa, de lo más reciente a lo más antiguo, con filtros por participante y por fechas.",
};

// El feed se lee de la base en cada petición (`getObjectHistory` no cachea), así
// que sin esto la página se generaría en el `next build` y el historial se
// quedaría congelado en la foto del despliegue.
export const dynamic = "force-dynamic";

/**
 * La página pública de objetos: premios, lanzamientos, devoluciones y
 * desventajas cumplidas en un solo feed, de lo más reciente a lo más antiguo,
 * filtrable por participante y por rango de fechas y paginado en el servidor.
 *
 * Es la ruta canónica del feed y una sección de pleno derecho: la navegación
 * principal la enlaza y el armazón es el de la portada (`league-home`), con su
 * cabecera, su pie y su paleta. La vieja `/historial-objetos` redirige aquí
 * conservando la búsqueda.
 *
 * La columna lateral recuerda qué significa cada tipo de evento —el rótulo de la
 * fila ya lo dice; la leyenda ahorra deducirlo— y repite el selector local
 * «Puntos / Objetos», que aquí se pinta con el control de la casa y no con el de
 * las páginas heredadas.
 *
 * La página resuelve los tres estados de la lectura: degradada, vacía y con
 * filas. Degradada no es vacía: `data` es `null` porque la base no ha respondido,
 * y decir "no hay objetos" cuando lo que pasa es que no se han podido leer sería
 * una afirmación falsa.
 */
export default async function ObjectsPage({
  searchParams,
}: PageProps<"/objetos">) {
  const params = await searchParams;

  const [historyRead, standingsRead] = await Promise.all([
    getObjectHistory(params),
    getStandings(),
  ]);

  // El filtro usa `Player.profileId`, el id público del participante —el mismo de
  // la ficha y de los enlaces de cada fila—, no el id interno del panel. Sin
  // clasificación legible no hay opciones: el desplegable se queda en "Todos los
  // participantes" en vez de inventar nombres.
  const players =
    standingsRead.status === "ok"
      ? standingsRead.data.rows.map((row) => ({
          id: String(row.profileId),
          name: row.name,
        }))
      : [];

  // Los filtros viajan con la paginación; `page` lo pone `Pagination`.
  const query = {
    jugador: readSingleParam(params.jugador) ?? undefined,
    from: readSingleParam(params.from) ?? undefined,
    to: readSingleParam(params.to) ?? undefined,
    pageSize: readSingleParam(params.pageSize) ?? undefined,
  };
  const hasFilters =
    query.jugador !== undefined || query.from !== undefined || query.to !== undefined;

  return (
    <div className="objects-page">
      <header className="objects-heading">
        <h1>Objetos</h1>
        <p>
          Un objeto es una carga que se gana con una victoria del día y reparte una
          desventaja: mientras sigue pendiente, las partidas de quien lo porta no
          puntúan. Aquí se reúnen los premios, los lanzamientos, las devoluciones y
          las desventajas cumplidas de la edición activa, de lo más reciente a lo
          más antiguo.
        </p>
        <p className="objects-heading-note">
          Los objetos solo se crean si la edición los tiene activados; si se apagan,
          el historial anterior se conserva.
        </p>
      </header>

      <div className="objects-layout">
        <div className="objects-main">
          {historyRead.status === "degraded" ? (
            <div className="objects-empty">
              <EmptyState
                title="No se han podido cargar los objetos"
                body="La base de datos no ha respondido, así que no se sabe qué ha pasado con los objetos. No es lo mismo que no haber ganado, lanzado ni cumplido ninguno. Vuelve a cargar la página en unos minutos."
                action={
                  <nav className="objects-actions">
                    <Link href="/historial">Ver el historial de puntos</Link>
                    <Link href="/">Volver a la clasificación</Link>
                  </nav>
                }
              />
            </div>
          ) : (
            <div className="objects-feed">
              <div className="objects-filters">
                <HistoryFilters basePath="/objetos" players={players} />
              </div>

              {historyRead.data.rows.length === 0 ? (
                <div className="objects-empty">
                  <EmptyState
                    title={
                      hasFilters
                        ? "Ningún movimiento coincide con los filtros"
                        : "Todavía no hay movimientos de objetos"
                    }
                    body={
                      hasFilters
                        ? "Prueba con otro participante o amplía el rango de fechas. El filtro incluye el día final completo y también encuentra los lanzamientos recibidos."
                        : "Aquí aparecerán los premios, los lanzamientos, las devoluciones y las desventajas cumplidas de la edición activa, de lo más reciente a lo más antiguo. Si la edición no ha tenido el modo de objetos activo, no habrá ninguno."
                    }
                  />
                </div>
              ) : (
                <>
                  <div className="objects-list">
                    <ObjectHistoryList rows={historyRead.data.rows} />
                  </div>

                  <div className="objects-footer">
                    <PageSizeSelect label="Eventos por página" />
                    <Pagination
                      page={historyRead.data.page}
                      pageCount={historyRead.data.pageCount}
                      shown={historyRead.data.rows.length}
                      total={historyRead.data.total}
                      basePath="/objetos"
                      query={query}
                    />
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        <aside className="objects-aside" aria-label="Vistas y guía del historial">
          <HistoryTabs variant="home" />

          <section className="objects-legend" aria-labelledby="objects-legend-heading">
            <h2 id="objects-legend-heading">Cómo se lee</h2>
            <dl>
              <div>
                <dt>Premio</dt>
                <dd>El objeto se gana con la victoria del día.</dd>
              </div>
              <div>
                <dt>Lanzamiento</dt>
                <dd>
                  Su portador lo manda a otro participante, que carga con la
                  desventaja.
                </dd>
              </div>
              <div>
                <dt>Devolución</dt>
                <dd>Se lanzó y se le devolvió: el objeto se pierde.</dd>
              </div>
              <div>
                <dt>Cumplimiento</dt>
                <dd>
                  El portador supera la desventaja y sus partidas vuelven a puntuar.
                </dd>
              </div>
            </dl>
          </section>

          <div className="objects-guide">
            <Link href="/puntuacion">
              Cómo se puntúa
              <ArrowUpRight size={14} aria-hidden="true" />
            </Link>
          </div>
        </aside>
      </div>
    </div>
  );
}
