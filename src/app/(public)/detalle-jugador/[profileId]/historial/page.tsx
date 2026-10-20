import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { EmptyState } from "@/components/empty-state";
import { PageHead } from "@/components/page-head";
import { PageSizeSelect } from "@/components/page-size-select";
import { Pagination } from "@/components/pagination";
import { PointHistoryFilters } from "@/components/point-history-filters";
import { PointHistoryList } from "@/components/point-history-row";
import { getPointHistory } from "@/lib/public";
import { readSingleParam } from "@/lib/query-params";
import { readParticipant, readProfileId } from "../data";

const GENERIC_METADATA: Metadata = {
  title: "Historial de puntos del participante",
  description:
    "Las ganancias de puntos de un participante de la Liga Hispana de Age of Empires IV: cada victoria clasificatoria, cada logro cumplido y cada cambio de poseedor de las competiciones, de lo más reciente a lo más antiguo.",
};

/**
 * Metadatos de la pestaña de historial, con el nombre del jugador cuando se le
 * puede leer.
 *
 * La lectura va cacheada por petición y el layout ya la ha hecho, así que no
 * vuelve a la base. Si no se le puede leer, se cae a los metadatos genéricos.
 */
export async function generateMetadata({
  params,
}: PageProps<"/detalle-jugador/[profileId]/historial">): Promise<Metadata> {
  const { profileId } = await params;
  const read = await readParticipant(profileId);

  if (read === null || read.status !== "ok" || read.data === null) {
    return GENERIC_METADATA;
  }

  const { name } = read.data.player;

  return {
    title: `Historial de puntos de ${name}`,
    description: `Las ganancias de puntos de ${name} en la Liga Hispana de Age of Empires IV: cada victoria clasificatoria, cada logro cumplido y cada cambio de poseedor de las competiciones, de lo más reciente a lo más antiguo.`,
  };
}

/**
 * Pestaña de historial de puntos del detalle de un participante.
 *
 * Es el feed público de ganancias (`/historial`) leído para un solo jugador: las
 * mismas filas, la misma lista y la misma paginación en servidor, sin el selector
 * de participante —aquí el jugador es la ruta— y con su filtro de fechas, que es
 * el que sigue teniendo sentido cuando el feed ya es de uno solo. La cabecera y
 * las pestañas son del layout.
 *
 * El jugador lo fija la ruta, así que un `?jugador=` con otro id **no** cambia de
 * quién es el feed: se ignora. Y una ganancia revertida sale con el tratamiento
 * de siempre, tachada y marcada, sin cifra.
 *
 * La pestaña resuelve sus tres estados: degradada, vacía y con filas. Degradada no
 * es vacía: `data` es `null` porque la base no ha respondido, y decir "no hay
 * ganancias" cuando lo que pasa es que no se han podido leer sería una afirmación
 * falsa. La base caída del todo la cuenta el layout, que no llega a pintar esta
 * pestaña; esto cubre que el feed sea lo único que no se pueda leer.
 */
export default async function ParticipantPointHistoryTab({
  params,
  searchParams,
}: PageProps<"/detalle-jugador/[profileId]/historial">) {
  const [{ profileId }, filters] = await Promise.all([params, searchParams]);
  const id = readProfileId(profileId);

  // El layout ya ha resuelto el "no existe": aquí solo se estrecha el id, que es
  // lo que necesitan la consulta y los enlaces de la paginación.
  if (id === null) {
    notFound();
  }

  // El filtro de fechas viaja en la URL y vuelve con la paginación. El vacío
  // (`?from=`) es ausencia, la misma regla que aplica la lectura.
  const query = {
    from: readSingleParam(filters.from) ?? undefined,
    to: readSingleParam(filters.to) ?? undefined,
    pageSize: readSingleParam(filters.pageSize) ?? undefined,
  };
  const hasFilters = query.from !== undefined || query.to !== undefined;
  const basePath = `/detalle-jugador/${id}/historial`;

  const [historyRead, participantRead] = await Promise.all([
    getPointHistory({
      // El participante lo fija la ruta, no la URL.
      jugador: String(id),
      ...query,
      page: filters.page,
    }),
    readParticipant(profileId),
  ]);

  // El nombre solo se usa para el copy del vacío; sale de la lectura que el layout
  // ya tenía cacheada. Sin él, el texto habla de "este participante".
  const name =
    participantRead !== null &&
    participantRead.status === "ok" &&
    participantRead.data !== null
      ? participantRead.data.player.name
      : null;
  const subject = name ?? "Este participante";

  return (
    <div className="flex flex-col gap-8">
      <PageHead
        title={name === null ? "Historial de puntos" : `Historial de puntos de ${name}`}
      />

      <p className="max-w-[68ch] text-[15px] leading-relaxed text-muted">
        Las ganancias de puntos de {name ?? "este participante"}, de lo más reciente a
        lo más antiguo: cada victoria clasificatoria, cada logro cumplido y cada cambio
        de poseedor de las competiciones. El bono de los eventos puntuales se suma al
        total de la clasificación y no se lista aquí. Los logros se resuelven en caliente
        y se apuntan cuando termina el torneo; los cambios de poseedor salen en cuanto la
        sincronización los detecta. Cómo se puntúa está en{" "}
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
          body={`La base de datos no ha respondido, así que no se sabe qué ha sumado ${name ?? "este participante"}. No es lo mismo que no haber sumado nada. Vuelve a cargar la página en unos minutos.`}
          action={
            <nav className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
              <Link
                href={`/detalle-jugador/${id}`}
                className="text-accent underline underline-offset-4 hover:text-accent-strong"
              >
                Volver a sus objetivos
              </Link>
              <Link
                href="/"
                className="text-muted transition-colors hover:text-accent"
              >
                Volver a la clasificación
              </Link>
            </nav>
          }
        />
      ) : (
        <div className="flex flex-col gap-4">
          <PointHistoryFilters basePath={basePath} />

          {historyRead.data.rows.length === 0 ? (
            <EmptyState
              title={
                hasFilters
                  ? "Ninguna ganancia coincide con las fechas"
                  : "Todavía no hay ganancias de puntos"
              }
              body={
                hasFilters
                  ? "Prueba a ampliar el rango de fechas: el filtro incluye el día final completo."
                  : `${subject} todavía no tiene ninguna victoria clasificatoria, ningún logro cumplido ni ningún cambio de poseedor apuntados. Los logros se resuelven en caliente y se apuntan cuando termina el torneo; el resto sale en cuanto la sincronización lo registra.`
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
                  basePath={basePath}
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
