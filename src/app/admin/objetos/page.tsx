import type { Metadata } from "next";
import Link from "next/link";
import { AdminPageHeader } from "@/components/admin/page-header";
import { Callout } from "@/components/admin/callout";
import { ActionFeedbackProvider } from "@/components/action-feedback";
import { EmptyState } from "@/components/empty-state";
import { requireAdmin } from "@/lib/auth";
import { logDatabaseFailure } from "@/lib/db-errors";
import {
  aoe4WorldGameUrl,
  formatAbsoluteTime,
  formatRelativeTime,
  formatUtcDay,
} from "@/lib/format";
import {
  isObjectsModeEnabled,
  listAwardMatchesForAdmin,
  listObjectAwardsForAdmin,
  listObjectThrowTargetsForAdmin,
  type ObjectAwardAdminView,
  type ObjectAwardMatchView,
  type ObjectAwardPlayerView,
  type ObjectThrowTargetView,
} from "@/lib/object-awards";
import { sameTargetBlocked, sameThrowerBlocked } from "@/lib/objects";
import { FulfillForm, type FulfillMatchOption } from "./fulfill-form";
import { ThrowForm, type ThrowTargetOption } from "./throw-form";

export const metadata: Metadata = {
  title: { absolute: "Objetos · Admin" },
};

/**
 * Operación de los objetos utilizables (issue 134).
 *
 * La página no decide nada: lee las tres vistas de `object-awards.ts` y pinta lo
 * que dicen. Los premios los crea el worker, el lanzamiento y el cumplimiento los
 * validan las Server Actions (`./actions.ts`), y aquí solo se elige el destino o
 * la partida y se enseña el resultado tal cual llega. La mecánica completa está en
 * `docs/OBJETOS.md`.
 *
 * Dos bloques con el modo encendido: **Pendientes ahora**, una tarjeta por objeto que
 * todavía no se ha cerrado, con su desventaja, sus lanzamientos y las dos acciones; e
 * **Historial**, los ya cerrados, compactos y con la partida que cumplió la desventaja
 * si la hay.
 *
 * Con el modo apagado la página es solo histórico: un aviso en la cabecera, ningún
 * formulario y, si un fallo dejara algún pendiente, su tarjeta se pinta sin acciones.
 * El interruptor vive en Administración → Edición y es del superadministrador;
 * `isObjectsModeEnabled()` es la misma puerta que aplica el servicio.
 *
 * Las fechas de la tarjeta se leen en relativo («hace 2 días») con la fecha
 * absoluta en el `title`, como en el resto del panel. El día del premio va en UTC
 * porque es el día con el que se creó y con el que se comparan las reglas.
 *
 * Los dos formularios son componentes de cliente y publican su éxito en la banda
 * de `ActionFeedbackProvider`: al revalidar, el objeto puede dejar de estar
 * pendiente y su tarjeta desaparecer, y el mensaje del servicio tiene que sobrevivir
 * a ese refresco. Los errores se quedan dentro del formulario.
 *
 * Una lectura fallida se pinta como «no se han podido leer», nunca como «no hay
 * objetos»: un corte de la base dejaría las dos secciones vacías y parecería que
 * no hay nada pendiente, que es justo lo que el admin viene a comprobar.
 */
export default async function AdminObjectsPage() {
  await requireAdmin();

  const data = await readObjects();
  const now = new Date();

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-4">
        <AdminPageHeader
          title="Objetos"
          description="Objetos que reparten desventaja: aquí se lanzan y se dan por cumplidos."
        />

        {data !== null && !data.objectsEnabled ? (
          <Callout tone="locked" title="Modo de objetos desactivado">
            En esta edición no se crean objetos ni se excluyen partidas: solo se conserva
            el historial. Se enciende en{" "}
            <Link
              href="/admin/administracion/edicion"
              className="text-foreground underline underline-offset-4 transition-colors hover:text-accent"
            >
              Administración → Edición
            </Link>
            , una pantalla reservada al superadministrador.
          </Callout>
        ) : null}
      </div>

      {/* La banda de avisos vive por encima del contenido y conserva su estado
          entre refrescos de la ruta. Es lo que hace que el éxito de un lanzamiento
          o de un cumplimiento no se pierda cuando la tarjeta deja de estar
          pendiente y desaparece del listado. */}
      <ActionFeedbackProvider>
        {data === null ? (
          <EmptyState
            title="No se han podido leer los objetos"
            body="La base de datos no ha respondido. Vuelve a intentarlo en unos minutos; las secciones no se muestran vacías a propósito, porque eso haría creer que no hay nada pendiente."
          />
        ) : (
          <>
            <PendingSection
              enabled={data.objectsEnabled}
              awards={data.awards}
              targets={data.targets}
              matchesByAward={data.matchesByAward}
              now={now}
            />
            <HistorySection awards={data.awards} />
          </>
        )}
      </ActionFeedbackProvider>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Lectura                                                                    */
/* -------------------------------------------------------------------------- */

type ObjectsRead = {
  awards: ObjectAwardAdminView[];
  targets: ObjectThrowTargetView[];
  /** Partidas del portador por premio; solo se piden para los pendientes. */
  matchesByAward: Map<string, ObjectAwardMatchView[]>;
  /** ¿Está encendido el modo? Apagado, la página solo enseña el historial. */
  objectsEnabled: boolean;
};

/**
 * Las tres lecturas del panel y la puerta del modo, juntas.
 *
 * Las partidas se piden solo de los premios pendientes porque son los únicos que
 * ofrecen el formulario de cumplimiento. Un fallo de cualquiera de las lecturas
 * degrada la página entera: media pantalla con datos y media vacía se leería como
 * que esos objetos no existen, y sin la puerta no se sabe si toca enseñar acciones.
 */
async function readObjects(): Promise<ObjectsRead | null> {
  try {
    const [awards, targets, objectsEnabled] = await Promise.all([
      listObjectAwardsForAdmin(),
      listObjectThrowTargetsForAdmin(),
      isObjectsModeEnabled(),
    ]);

    const pendingIds = awards.filter((award) => award.pending).map((award) => award.id);
    const matchLists = await Promise.all(
      pendingIds.map((awardId) => listAwardMatchesForAdmin({ awardId })),
    );

    return {
      awards,
      targets,
      objectsEnabled,
      matchesByAward: new Map(
        pendingIds.map((awardId, index) => [awardId, matchLists[index]]),
      ),
    };
  } catch (error) {
    logDatabaseFailure("admin/objetos", error);

    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Pendientes                                                                 */
/* -------------------------------------------------------------------------- */

function PendingSection({
  enabled,
  awards,
  targets,
  matchesByAward,
  now,
}: {
  enabled: boolean;
  awards: ObjectAwardAdminView[];
  targets: ObjectThrowTargetView[];
  matchesByAward: Map<string, ObjectAwardMatchView[]>;
  now: Date;
}) {
  const pending = awards.filter((award) => award.pending);

  // Apagado el modo no hay nada que operar: `disableObjectsMode()` cierra los
  // pendientes al apagarlo, así que en condiciones normales esta sección no existe.
  // Si un fallo dejara alguno, se enseña sin acciones: el modo ya no las permite.
  if (!enabled && pending.length === 0) {
    return null;
  }

  return (
    <section aria-labelledby="objetos-pendientes" className="flex flex-col gap-4">
      <div>
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 id="objetos-pendientes" className="text-lg font-semibold">
            Pendientes ahora
          </h2>
          <p className="text-sm text-muted tabular-nums">
            {pending.length === 1
              ? "1 objeto pendiente"
              : `${pending.length} objetos pendientes`}
          </p>
        </div>
        <p className="mt-1 max-w-[70ch] text-sm leading-relaxed text-muted">
          {enabled
            ? "El portador puede lanzarlo; la desventaja se cierra sobre una partida suya posterior."
            : "El modo está apagado: estas tarjetas no ofrecen lanzar ni dar por cumplida la desventaja."}
        </p>
      </div>

      {pending.length === 0 ? (
        <EmptyState
          title="Ningún objeto pendiente"
          body="Los objetos se crean solos cuando alguien gana la primera partida del día con una victoria sagrada, de conquista o de maravilla. Cuando lo haga, aparecerá aquí con su desventaja y las dos acciones."
        />
      ) : (
        <ul className="flex flex-col gap-4">
          {pending.map((award) => (
            <PendingAwardCard
              key={award.id}
              award={award}
              targets={targets}
              matches={matchesByAward.get(award.id) ?? []}
              now={now}
              actionsEnabled={enabled}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Una tarjeta de objeto pendiente.
 *
 * Arriba, qué objeto es y a quién afecta; en medio, las dos acciones —lanzar y
 * dar por cumplida— en dos columnas a partir de `lg`; abajo, la traza de
 * lanzamientos. La tarjeta se divide con filetes y no con cajas anidadas: es el
 * mismo dialecto del resto del panel.
 *
 * El lanzamiento solo se ofrece cuando puede funcionar: si el portador ya lanzó
 * hoy o no queda ningún destino válido, en su sitio va la explicación y la regla
 * que lo impide. El formulario de cumplimiento solo se monta si hay partidas
 * elegibles; si no, se dice que todavía no hay ninguna. Con el modo apagado no se
 * monta ninguno de los dos: en su lugar va la nota de que no hay acciones.
 */
function PendingAwardCard({
  award,
  targets,
  matches,
  now,
  actionsEnabled,
}: {
  award: ObjectAwardAdminView;
  targets: ObjectThrowTargetView[];
  matches: ObjectAwardMatchView[];
  now: Date;
  actionsEnabled: boolean;
}) {
  const holder = award.holder;

  // Las reglas del lanzamiento se leen de `objects.ts`, las mismas que aplica el
  // servicio: aquí no se reescribe el día UTC ni la condición de "ya lanzó".
  const throwsForRules = award.throws.map((item) => ({
    fromId: item.from.playerId,
    toId: item.to.playerId,
    at: item.at,
  }));
  const thrownToday =
    holder !== null && sameThrowerBlocked(throwsForRules, holder.playerId, now);

  const available: ThrowTargetOption[] = [];
  const blockedNames: string[] = [];

  for (const target of targets) {
    if (target.playerId === holder?.playerId) {
      continue;
    }

    if (sameTargetBlocked(throwsForRules, target.playerId, now)) {
      blockedNames.push(target.name);
    } else {
      available.push({
        playerId: target.playerId,
        name: target.name,
        rank: target.rank,
      });
    }
  }

  const matchOptions: FulfillMatchOption[] = matches.map((match) => ({
    matchId: match.matchId,
    label: fulfillMatchLabel(match, award.id),
  }));

  return (
    <li className="rounded-lg border border-line bg-surface">
      <div className="px-5 py-4">
        <h3 className="text-base font-semibold text-foreground">{award.kindName}</h3>
        <p className="mt-1 text-xs text-muted">
          {award.obtainedBy} · Día{" "}
          <time dateTime={award.day.toISOString()} title={formatAbsoluteTime(award.day)}>
            {formatUtcDay(award.day)}
          </time>{" "}
          (UTC)
        </p>

        <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 xl:grid-cols-4">
          <div>
            <dt className="text-xs text-muted">Desventaja</dt>
            <dd className="mt-0.5 max-w-[38ch] text-sm leading-relaxed text-foreground">
              {award.penalty.text ?? award.penalty.id}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Ganador</dt>
            <dd className="mt-0.5 text-sm">
              <PlayerLink player={award.winner} />
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Portador</dt>
            <dd className="mt-0.5 text-sm">
              {holder === null ? (
                <span className="text-muted">Sin portador</span>
              ) : (
                <PlayerLink player={holder} />
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted">En su poder desde</dt>
            <dd className="mt-0.5 text-sm text-foreground">
              {award.heldSince === null ? (
                <span className="text-muted">—</span>
              ) : (
                <time
                  dateTime={award.heldSince.toISOString()}
                  title={formatAbsoluteTime(award.heldSince)}
                >
                  {formatRelativeTime(award.heldSince, now)}
                </time>
              )}
            </dd>
          </div>
        </dl>
      </div>

      {actionsEnabled ? (
        <div className="grid border-t border-line lg:grid-cols-2">
          <div className="px-5 py-4 lg:border-r lg:border-line">
            <h4 className="text-sm font-semibold text-foreground">Lanzar el objeto</h4>
            <p className="mt-1 max-w-[60ch] text-xs leading-relaxed text-muted">
              Una vez por portador y día UTC. Si la tirada se devuelve, el objeto se
              queda donde está y ese portador ya no puede relanzarlo hoy.
            </p>

            {holder === null ? (
              <p className="mt-3 max-w-[60ch] text-sm leading-relaxed text-muted">
                El objeto no tiene portador, así que no hay a quién lanzarlo. Se
                resolverá en la siguiente pasada del sincronizador.
              </p>
            ) : thrownToday ? (
              <p className="mt-3 max-w-[60ch] text-sm leading-relaxed text-muted">
                <span className="text-foreground">{playerName(holder)}</span> ya ha
                lanzado este objeto hoy. El límite es una vez por portador y día UTC, así
                que la acción vuelve a estar disponible a medianoche UTC.
              </p>
            ) : available.length === 0 ? (
              <p className="mt-3 max-w-[60ch] text-sm leading-relaxed text-muted">
                {blockedNames.length === 0 ? (
                  "No hay otros jugadores aprobados a los que lanzar."
                ) : (
                  <>
                    No queda ningún destino disponible hoy: {blockedNames.join(", ")}{" "}
                    ya lo recibieron. El lanzamiento vuelve a estar disponible cuando
                    cambie el día UTC.
                  </>
                )}
              </p>
            ) : (
              <ThrowForm
                awardId={award.id}
                objectName={award.kindName}
                holderName={playerName(holder)}
                targets={available}
                blockedNames={blockedNames}
              />
            )}
          </div>

          <div className="border-t border-line px-5 py-4 lg:border-t-0">
            <h4 className="text-sm font-semibold text-foreground">
              Dar por cumplida la desventaja
            </h4>
            <p className="mt-1 max-w-[60ch] text-xs leading-relaxed text-muted">
              Se cierra sobre una partida del portador empezada después de recibir el
              objeto. La partida elegida y las posteriores vuelven a puntuar.
            </p>

            {holder === null ? (
              <p className="mt-3 max-w-[60ch] text-sm leading-relaxed text-muted">
                Sin portador no hay partidas que puedan cumplir la desventaja.
              </p>
            ) : matchOptions.length === 0 ? (
              <p className="mt-3 max-w-[60ch] text-sm leading-relaxed text-muted">
                El portador no ha jugado ninguna partida desde que recibió el objeto.
                En cuanto juegue la siguiente, aparecerá aquí para elegirla.
              </p>
            ) : (
              <FulfillForm
                awardId={award.id}
                objectName={award.kindName}
                matches={matchOptions}
              />
            )}
          </div>
        </div>
      ) : (
        <div className="border-t border-line px-5 py-4">
          <p className="max-w-[70ch] text-sm leading-relaxed text-muted">
            El modo de objetos está apagado: esta tarjeta no ofrece lanzar ni dar por
            cumplida la desventaja. Vuelve a guardar la configuración de la edición
            para cerrarla.
          </p>
        </div>
      )}

      <div className="border-t border-line px-5 py-4">
        <h4 className="text-sm font-semibold text-foreground">Lanzamientos</h4>
        {award.throws.length === 0 ? (
          <p className="mt-2 max-w-[60ch] text-sm leading-relaxed text-muted">
            Sin lanzamientos: el objeto sigue en manos de quien lo ganó.
          </p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1.5 text-sm">
            {award.throws.map((item) => (
              <li key={item.id} className="text-muted">
                <span className="text-foreground">{playerName(item.from)}</span>{" "}
                lanzó a <span className="text-foreground">{playerName(item.to)}</span>
                {" · "}
                <time dateTime={item.at.toISOString()} title={formatAbsoluteTime(item.at)}>
                  {formatAbsoluteTime(item.at)}
                </time>
                {" · "}
                tirada {formatRoll(item.roll)}
                {" · "}
                {item.returned ? "devuelto" : "aceptado"}
              </li>
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}

/* -------------------------------------------------------------------------- */
/* Historial                                                                  */
/* -------------------------------------------------------------------------- */

function HistorySection({ awards }: { awards: ObjectAwardAdminView[] }) {
  const resolved = awards.filter((award) => !award.pending);

  return (
    <section aria-labelledby="objetos-historial" className="flex flex-col gap-4">
      <div>
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 id="objetos-historial" className="text-lg font-semibold">
            Historial
          </h2>
          <p className="text-sm text-muted tabular-nums">
            {resolved.length === 1 ? "1 objeto cerrado" : `${resolved.length} objetos cerrados`}
          </p>
        </div>
        <p className="mt-1 max-w-[70ch] text-sm leading-relaxed text-muted">
          Los objetos que ya no están pendientes, del más reciente al más antiguo.
        </p>
      </div>

      {resolved.length === 0 ? (
        <EmptyState
          title="Todavía no hay objetos cerrados"
          body="Aquí aparecerán los objetos que dejen de estar pendientes, con la partida que cumplió su desventaja. El historial cubre los últimos días, no la edición entera."
        />
      ) : (
        <div className="overflow-x-auto overscroll-x-contain rounded-lg border border-line">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">
              Objetos que ya no están pendientes: día UTC, objeto y desventaja,
              portador y resultado. Cuando la desventaja se cumplió, el resultado
              enlaza a la partida con la que se cerró.
            </caption>
            <thead className="bg-surface text-muted">
              <tr>
                <th scope="col" className="whitespace-nowrap px-4 py-3 font-medium">
                  Día (UTC)
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  Objeto
                </th>
                <th scope="col" className="hidden px-4 py-3 font-medium lg:table-cell">
                  Desventaja
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  Portador
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  Resultado
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {resolved.map((award) => (
                <ResolvedAwardRow key={award.id} award={award} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/**
 * Una fila del historial.
 *
 * Compacta: el objeto y su desventaja en dos líneas, y el resultado con la fecha
 * y el enlace a la partida que lo cerró. En pantalla estrecha la desventaja cede
 * a su columna y se lee bajo el nombre del objeto, como en las demás tablas del
 * panel; el resto de columnas caben sin plegarse.
 */
function ResolvedAwardRow({ award }: { award: ObjectAwardAdminView }) {
  const holder = award.holder;
  const satisfiedBy = award.satisfiedBy;
  const gameUrl =
    holder !== null && holder.profileId !== null && satisfiedBy !== null
      ? aoe4WorldGameUrl(holder.profileId, satisfiedBy.gameId)
      : null;

  return (
    <tr>
      <td className="whitespace-nowrap px-4 py-3 align-top text-muted">
        <time dateTime={award.day.toISOString()} title={formatAbsoluteTime(award.day)}>
          {HISTORY_DAY.format(award.day)}
        </time>
      </td>

      <td className="px-4 py-3 align-top">
        <span className="block font-medium text-foreground">{award.kindName}</span>
        <span className="mt-0.5 block text-xs text-muted">
          Ganado por {playerName(award.winner)}
        </span>
        <span className="mt-1 block max-w-[40ch] text-xs leading-relaxed text-muted lg:hidden">
          {award.penalty.text ?? award.penalty.id}
        </span>
      </td>

      <td className="hidden max-w-[26rem] px-4 py-3 align-top text-muted lg:table-cell">
        {award.penalty.text ?? award.penalty.id}
      </td>

      <td className="px-4 py-3 align-top">
        {award.holder === null ? (
          <span className="text-muted">Sin portador</span>
        ) : (
          <PlayerLink player={award.holder} />
        )}
      </td>

      <td className="px-4 py-3 align-top">
        {satisfiedBy === null ? (
          <span className="inline-block whitespace-nowrap rounded-full border border-line-strong px-2 py-0.5 text-xs font-medium text-muted">
            Retirada
          </span>
        ) : (
          <>
            <span className="inline-block whitespace-nowrap rounded-full border border-win/40 px-2 py-0.5 text-xs font-medium text-win">
              Cumplida
            </span>
            <span className="mt-1 block text-xs text-muted">
              <time
                dateTime={satisfiedBy.startedAt.toISOString()}
                title={formatAbsoluteTime(satisfiedBy.startedAt)}
              >
                {formatAbsoluteTime(satisfiedBy.startedAt)}
              </time>
              {gameUrl === null ? null : (
                <>
                  {" · "}
                  <a
                    href={gameUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline-offset-4 transition-colors hover:text-accent hover:underline"
                  >
                    Ver partida
                  </a>
                </>
              )}
            </span>
          </>
        )}
      </td>
    </tr>
  );
}

/* -------------------------------------------------------------------------- */
/* Piezas compartidas                                                         */
/* -------------------------------------------------------------------------- */

const ROLL_FORMAT = new Intl.NumberFormat("es-ES", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * El día del historial, corto y en UTC.
 *
 * La tarjeta puede permitirse el día escrito entero porque tiene sitio; en una
 * columna de tabla es ruido, y el año se lee antes en formato numérico. La
 * referencia sigue siendo UTC, que es el día con el que se creó el premio.
 */
const HISTORY_DAY = new Intl.DateTimeFormat("es-ES", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  timeZone: "UTC",
});

/** La tirada que se guardó en `ObjectThrow.roll`, con coma decimal. */
function formatRoll(roll: number): string {
  return ROLL_FORMAT.format(roll);
}

const MATCH_RESULT_LABELS: Record<string, string> = {
  WIN: "Victoria",
  LOSS: "Derrota",
};

/** El resultado de una partida del portador, tal y como se lee en el desplegable. */
function resultLabel(result: string | null): string {
  if (result === null) {
    return "En curso";
  }

  return MATCH_RESULT_LABELS[result] ?? result;
}

/**
 * La etiqueta de una opción del desplegable de cumplimiento.
 *
 * Lleva fecha, rival, mapa, resultado y si la partida cuenta o está excluida: es
 * lo que el admin necesita para reconocer la partida sin abrirla. Se distingue la
 * exclusión de este objeto de la de otro porque la primera es la que el
 * cumplimiento va a levantar.
 */
function fulfillMatchLabel(match: ObjectAwardMatchView, awardId: string): string {
  const parts = [
    formatAbsoluteTime(match.startedAt),
    match.opponentName === null ? "Rival desconocido" : `contra ${match.opponentName}`,
  ];

  if (match.map !== null) {
    parts.push(match.map);
  }

  parts.push(resultLabel(match.result));

  parts.push(
    match.excludedByAwardId === null
      ? "Cuenta"
      : match.excludedByAwardId === awardId
        ? "Excluida por este objeto"
        : "Excluida por otro objeto",
  );

  return parts.join(" · ");
}

/** El nombre visible de un jugador que puede faltar de la base. */
function playerName(player: ObjectAwardPlayerView): string {
  return player.name ?? "Sin nombre";
}

/** Nombre del jugador enlazado a su perfil de AoE4World, si sigue existiendo. */
function PlayerLink({ player }: { player: ObjectAwardPlayerView }) {
  const name = playerName(player);

  if (player.profileUrl === null) {
    return <span className="text-foreground">{name}</span>;
  }

  return (
    <a
      href={player.profileUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="text-foreground underline-offset-4 transition-colors hover:text-accent hover:underline"
    >
      {name}
    </a>
  );
}
