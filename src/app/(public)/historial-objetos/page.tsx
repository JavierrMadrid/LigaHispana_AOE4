import type { Metadata } from "next";
import Link from "next/link";
import { EmptyState } from "@/components/empty-state";
import { HistoryTabs } from "@/components/history-tabs";
import { ObjectHistoryList } from "@/components/object-history-row";
import { PageHead } from "@/components/page-head";
import { PageSizeSelect } from "@/components/page-size-select";
import { Pagination } from "@/components/pagination";
import { HistoryFilters } from "@/components/history-filters";
import { getObjectHistory } from "@/lib/object-history";
import { getStandings } from "@/lib/public";
import { readSingleParam } from "@/lib/query-params";

export const metadata: Metadata = {
  title: "Historial de objetos",
  description:
    "Los objetos utilizables de la Liga Hispana de Age of Empires IV: cada premio, lanzamiento, devolución y desventaja cumplida de la edición activa, de lo más reciente a lo más antiguo, con filtros por participante y por fechas.",
};

// El feed se lee de la base en cada petición (`getObjectHistory` no cachea), así
// que sin esto la página se generaría en el `next build` y el historial se
// quedaría congelado en la foto del despliegue.
export const dynamic = "force-dynamic";

/**
 * El historial público de objetos: premios, lanzamientos, devoluciones y
 * desventajas cumplidas en un solo feed, de lo más reciente a lo más antiguo,
 * filtrable por participante y por rango de fechas y paginado en el servidor.
 *
 * Es el hermano de `/historial` y comparte su cromo: el selector local de la
 * cabecera, la barra de filtros, la lista con filetes y la paginación. No se
 * publican tiradas ni probabilidades; lo que se lee es quién ganó, lanzó o
 * cumplió qué objeto, y con qué desventaja.
 *
 * La página resuelve los tres estados de la lectura: degradada, vacía y con filas.
 * Degradada no es vacía: `data` es `null` porque la base no ha respondido, y decir
 * "no hay objetos" cuando lo que pasa es que no se han podido leer sería una
 * afirmación falsa.
 */
export default async function ObjectHistoryPage({
  searchParams,
}: PageProps<"/historial-objetos">) {
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
      ? standingsRead.data.rows.map((row) => ({ id: String(row.profileId), name: row.name }))
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
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8">
      <PageHead title="Historial de objetos" />

      <HistoryTabs />

      <p className="max-w-[68ch] text-[15px] leading-relaxed text-muted">
        Un objeto es una carga que se gana con una victoria del día y reparte una
        desventaja a quien lo porta: mientras la desventaja sigue pendiente, las
        partidas del portador no puntúan. Este feed reúne los premios, los
        lanzamientos, las devoluciones y las desventajas cumplidas de la edición
        activa, de lo más reciente a lo más antiguo. Un premio que se cumple sale dos
        veces: cuando se ganó y cuando se superó su desventaja. Los objetos solo se
        crean si la edición los tiene activados; si se apagan, el historial anterior
        se conserva.
      </p>

      {historyRead.status === "degraded" ? (
        <EmptyState
          title="No se han podido cargar los objetos"
          body="La base de datos no ha respondido, así que no se sabe qué ha pasado con los objetos. No es lo mismo que no haber ganado, lanzado ni cumplido ninguno. Vuelve a cargar la página en unos minutos."
          action={
            <nav className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
              <Link
                href="/historial"
                className="text-accent underline underline-offset-4 hover:text-accent-strong"
              >
                Ver el historial de puntos
              </Link>
              <Link href="/" className="text-muted transition-colors hover:text-accent">
                Volver a la clasificación
              </Link>
            </nav>
          }
        />
      ) : (
        <div className="flex flex-col gap-4">
          <HistoryFilters basePath="/historial-objetos" players={players} />

          {historyRead.data.rows.length === 0 ? (
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
          ) : (
            <>
              <ObjectHistoryList rows={historyRead.data.rows} />

              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <PageSizeSelect label="Eventos por página" />
                <Pagination
                  page={historyRead.data.page}
                  pageCount={historyRead.data.pageCount}
                  shown={historyRead.data.rows.length}
                  total={historyRead.data.total}
                  basePath="/historial-objetos"
                  query={query}
                />
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
