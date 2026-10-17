import type { Metadata } from "next";
import Link from "next/link";
import { EmptyState } from "@/components/empty-state";
import { PageHead } from "@/components/page-head";
import { PageSizeSelect } from "@/components/page-size-select";
import { Pagination } from "@/components/pagination";
import { PointHistoryFilters } from "@/components/point-history-filters";
import { PointHistoryList } from "@/components/point-history-row";
import { getPointHistory, getStandings } from "@/lib/public";

export const metadata: Metadata = {
  title: "Historial de puntos",
  description:
    "Las ganancias de puntos de la Liga Hispana de Age of Empires IV: cada victoria clasificatoria y cada objetivo cumplido, de lo más reciente a lo más antiguo, con filtros por participante y por fechas.",
};

// El feed se lee de la base en cada petición (`getPointHistory` no cachea), así que
// sin esto la página se generaría en el `next build` y el historial se quedaría
// congelado en la foto del despliegue.
export const dynamic = "force-dynamic";

/** Un valor de `searchParams` reducido a texto; el vacío (`?from=`) es ausencia. */
function single(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;

  return raw === undefined || raw === "" ? undefined : raw;
}

/**
 * El historial público de ganancias de puntos: victorias clasificatorias y
 * objetivos cumplidos en un solo feed, de lo más reciente a lo más antiguo,
 * filtrable por participante y por rango de fechas y paginado en el servidor.
 *
 * Es la cara pública del historial del panel (`/admin/historial`) y se lee con el
 * cromo de las páginas públicas: la tabla del panel no se copia porque con siete
 * columnas solo cabría desplazando en horizontal, así que la fila es una tarjeta de
 * dos columnas que en móvil se apila. Tampoco se copia su alcance: aquí solo entran
 * las **ganancias** —las partidas de cero puntos no son una ganancia y no salen— y
 * solo de participantes aprobados, la misma regla que la clasificación.
 *
 * La página resuelve los tres estados de la lectura: degradada, vacía y con filas.
 * Degradada no es vacía: `data` es `null` porque la base no ha respondido, y decir
 * "no hay ganancias" cuando lo que pasa es que no se han podido leer sería una
 * afirmación falsa.
 */
export default async function PointHistoryPage({ searchParams }: PageProps<"/historial">) {
  const params = await searchParams;

  // Las dos lecturas son independientes: el feed que se lista y el censo que
  // alimenta el filtro de participante. Van en paralelo.
  const [historyRead, standingsRead] = await Promise.all([
    getPointHistory(params),
    getStandings(),
  ]);

  // El filtro usa `Player.profileId`, el id público del participante —el mismo del
  // detalle del jugador—, no el id interno del panel. Sin clasificación legible
  // no hay lista de opciones: el desplegable se queda en "Todos los participantes" en
  // vez de inventar nombres.
  const players =
    standingsRead.status === "ok"
      ? standingsRead.data.rows.map((row) => ({ id: String(row.profileId), name: row.name }))
      : [];

  // Los filtros viajan con la paginación; `page` lo pone `Pagination`.
  const query = {
    jugador: single(params.jugador),
    from: single(params.from),
    to: single(params.to),
    pageSize: single(params.pageSize),
  };
  const hasFilters =
    query.jugador !== undefined || query.from !== undefined || query.to !== undefined;

  return (
    // El ancho de lectura: un feed de frases no gana nada estirándose a lo ancho de
    // la ventana, así que se ciñe al mismo `max-w-6xl` que `/puntuacion`.
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8">
      <PageHead title="Historial de puntos" />

      <p className="max-w-[68ch] text-[15px] leading-relaxed text-muted">
        Las ganancias de puntos del torneo, de lo más reciente a lo más antiguo: cada
        victoria clasificatoria y cada objetivo cumplido, con lo que aporta cada uno.
        Los objetivos que se resuelven en caliente se apuntan cuando termina el
        torneo, así que durante la competición esta lista solo enseña victorias. Las
        reglas y las cifras del sistema están en{" "}
        <Link
          href="/puntuacion"
          className="text-accent underline underline-offset-4 hover:text-accent-strong"
        >
          Puntuación
        </Link>
        .
      </p>

      {historyRead.status === "degraded" ? (
        <EmptyState
          title="No se han podido cargar las ganancias"
          body="La base de datos no ha respondido, así que no se sabe qué se ha sumado. No es lo mismo que no haber sumado nada. Vuelve a cargar la página en unos minutos."
          action={
            <nav className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
              <Link
                href="/"
                className="text-accent underline underline-offset-4 hover:text-accent-strong"
              >
                Volver a la clasificación
              </Link>
              <Link
                href="/puntuacion"
                className="text-muted transition-colors hover:text-accent"
              >
                Ver cómo se puntúa
              </Link>
            </nav>
          }
        />
      ) : (
        <div className="flex flex-col gap-4">
          <PointHistoryFilters basePath="/historial" players={players} />

          {historyRead.data.rows.length === 0 ? (
            <EmptyState
              title={
                hasFilters
                  ? "Ninguna ganancia coincide con los filtros"
                  : "Todavía no hay ganancias de puntos"
              }
              body={
                hasFilters
                  ? "Prueba con otro participante o amplía el rango de fechas. El filtro incluye el día final completo."
                  : "Aquí aparecerán las victorias clasificatorias y los objetivos cumplidos, de lo más reciente a lo más antiguo. Las victorias salen en cuanto la sincronización las registra; los objetivos que se resuelven en caliente se apuntan cuando termina el torneo."
              }
            />
          ) : (
            <>
              <PointHistoryList rows={historyRead.data.rows} />

              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <PageSizeSelect label="Ganancias por página" />
                <Pagination
                  page={historyRead.data.page}
                  pageCount={historyRead.data.pageCount}
                  shown={historyRead.data.rows.length}
                  total={historyRead.data.total}
                  basePath="/historial"
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
