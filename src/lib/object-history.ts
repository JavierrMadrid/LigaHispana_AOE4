import "server-only";

import { Prisma } from "@/generated/prisma/client";
import { PlayerStatus } from "@/generated/prisma/enums";
import type { ObjectKind } from "@/generated/prisma/enums";
import { db } from "@/lib/db";
import { readFromDatabase, type PublicRead } from "@/lib/db-errors";
import { OBJECT_CATALOG } from "@/lib/objects";
import { readProfileIdFilter } from "@/lib/public";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  dateRangeWhere,
  hasDateBounds,
  paginate,
  readBoundedInt,
  type DateRange,
  type QueryParam,
} from "@/lib/query-params";
import { windowBounds } from "@/lib/ranked-match";
import { readRuleset } from "@/lib/scoring";

/**
 * El **historial público de objetos**: el feed de `/historial-objetos`.
 *
 * Es la cara pública de lo que el panel enseña en `/admin/objetos`, pero como
 * **feed de eventos** y no como tarjetas por objeto: premios, lanzamientos,
 * devoluciones y desventajas cumplidas, todos en una sola lista paginada en
 * servidor y de lo más reciente a lo más antiguo, con el mismo lenguaje que
 * `getPointHistory()` de `/historial` (filtro por participante, rango de fechas
 * inclusivo, estados degradado y vacío).
 *
 * ## Por qué vive aparte de `src/lib/public.ts`
 *
 * Comparte helpers puros con el historial de puntos, pero sus fuentes son otras
 * (`ObjectAward` y `ObjectThrow`), no tienen relación de Prisma con `Player` ni
 * con `Match` y su paginación se resuelve en memoria acotada por edición. Meterlo
 * en `public.ts` engordaría la capa sin necesidad; la página importa
 * `getObjectHistory` de aquí.
 *
 * ## Qué publica y qué no
 *
 * Solo lo que se pinta: nombre y `profileId` público del jugador, el objeto del
 * catálogo y la desventaja. **No** salen `ObjectAward.id` ni `ObjectThrow.id` (la
 * clave pública es `award:<id>`, `throw:<id>` o `fulfill:<awardId>`), ni la tirada
 * (`roll`), ni el `Player.id` interno, ni el `Match.id`, ni probabilidades, ni
 * correos, ni nada de `AdminAction`.
 *
 * ## Qué es cada evento
 *
 * | `kind` | Cuándo existe | `at` | `player` | `opponent` |
 * |---|---|---|---|---|
 * | `AWARD` | Se creó el `ObjectAward` | `winnerMatch.startedAt` (respaldo: `award.day`) | ganador | `null` |
 * | `THROW` | Lanzamiento con `returned = false` | `throw.at` | lanzador | objetivo |
 * | `RETURN` | Lanzamiento con `returned = true` | `throw.at` | lanzador | objetivo |
 * | `FULFILL` | El premio tiene `satisfiedByMatchId` | `satisfiedByMatch.startedAt` (respaldo: `exitedAt`) | portador (respaldo: ganador) | `null` |
 *
 * Un premio cumplido genera **dos** eventos, `AWARD` y `FULFILL`. Una **retirada**
 * (`exitedAt` informado y `satisfiedByMatchId` nulo, lo que deja apagar el modo) no
 * genera `FULFILL`.
 *
 * ## Alcance
 *
 * - **Edición activa**: se acota con `windowBounds(ruleset.window).from`, igual que
 *   el feed de objetos del overlay (`loadOverlayObjectEvents()`). Si ese suelo no se
 *   puede leer, no se acota.
 * - **Solo aprobados**: el sujeto (`player`) tiene que estar aprobado; si el
 *   contrario no existe o no lo está, `opponent` es `null` y el evento se conserva.
 *   Es la misma regla que la clasificación y `/historial`.
 * - **Fechas**: `from`/`to` con los bordes de `dateRangeWhere()` (el día final entra
 *   completo) y el filtro de `jugador` con `readProfileIdFilter()`. El filtro de
 *   participante también encuentra los lanzamientos **recibidos**, porque compara
 *   con `opponent`.
 *
 * ## Coste
 *
 * Los objetos son pocos por día (como mucho uno de cada tipo) y los lanzamientos
 * son un puñado, así que el feed se arma **en memoria**. No se carga el histórico
 * entero: las consultas se acotan en SQL por la edición (`createdAt`/`at`) y los
 * lanzamientos además por su fecha, que ya es la del evento. Los premios no se
 * acotan por fechas en SQL a propósito —una fila da dos eventos con fechas
 * distintas—, así que su rango se aplica en memoria sobre el `at` de cada evento.
 * Aun así, la página que lo use tiene que ser **dinámica** y `data` es
 * `null` cuando la base no responde, para no confundir "no hay objetos" con "no se
 * han podido leer" (ver el docblock de cabecera de `src/lib/public.ts`).
 */

/** Los cuatro tipos de evento del feed, en el orden de desempate a igual instante. */
export type ObjectHistoryKind = "AWARD" | "THROW" | "RETURN" | "FULFILL";

/** La identidad pública de un participante: solo nombre y `profileId` de AoE4World. */
export type ObjectHistoryPlayer = {
  name: string;
  profileId: number;
};

/** Un evento del feed, ya resuelto para pintar. */
export type ObjectHistoryEvent = {
  /** Clave estable: `award:<id>`, `throw:<id>` o `fulfill:<awardId>`. */
  id: string;
  kind: ObjectHistoryKind;
  /** Instante del evento; es por lo que se ordena y se filtran las fechas. */
  at: Date;
  /** Sujeto del evento: ganador, lanzador o portador. Siempre aprobado. */
  player: ObjectHistoryPlayer;
  /** El otro jugador de un lanzamiento; `null` en premios y cumplimientos. */
  opponent: ObjectHistoryPlayer | null;
  object: {
    kind: ObjectKind;
    /** Nombre del catálogo (`Reliquia pagana`, `Moneda del Rey falsificada`…). */
    name: string;
  };
  /** La desventaja del premio; `text` es `null` si su id ya no está en el catálogo. */
  penalty: { id: string; text: string | null };
};

/** Una página del feed público de `/historial-objetos`. */
export type ObjectHistory = {
  rows: ObjectHistoryEvent[];
  total: number;
  page: number;
  pageSize: number;
  /** Páginas con este filtro; `0` si no hay ninguna fila. */
  pageCount: number;
};

/**
 * Los filtros del feed, tal como llegan de la URL.
 *
 * `jugador` es el `profileId` de AoE4World —el id público de la ficha, no el
 * `Player.id` del panel—; un valor que no se entiende es ausencia de filtro, nunca
 * un filtro sin resultados. `from`/`to` son el mismo rango que `/historial`.
 */
export type ObjectHistoryQuery = {
  jugador?: QueryParam;
  from?: QueryParam;
  to?: QueryParam;
  page?: QueryParam;
  pageSize?: QueryParam;
};

/** Los filtros de la URL ya validados, listos para las consultas y el recorte. */
export type ObjectHistoryFilters = {
  /** `Player.profileId`, o `null` si no hay filtro (o el valor no se entiende). */
  profileId: number | null;
  rango: DateRange;
};

/**
 * El filtro de participante y el rango de fechas, validados con los mismos helpers
 * que el historial de puntos: `readProfileIdFilter()` y `dateRangeWhere()`.
 *
 * Exportado para su test, como los del historial de puntos: una URL manipulada
 * tiene que comportarse igual en las dos pantallas.
 */
export function readObjectHistoryFilters(query: ObjectHistoryQuery): ObjectHistoryFilters {
  return {
    profileId: readProfileIdFilter(query.jugador),
    rango: dateRangeWhere(query.from, query.to),
  };
}

/* -------------------------------------------------------------------------- */
/* Piezas puras: filas de origen, mapeo, orden, filtros y página               */
/* -------------------------------------------------------------------------- */

/** Una fila de `ObjectAward` en lo que necesita el feed (`winnerMatchId` aparte). */
export type ObjectHistoryAwardSource = {
  id: string;
  kind: ObjectKind;
  penaltyId: string;
  winnerId: string;
  winnerMatchId: string;
  holderId: string | null;
  day: Date;
  exitedAt: Date | null;
  satisfiedByMatchId: string | null;
};

/** Un lanzamiento con el objeto de su premio, ya resuelto en la consulta. */
export type ObjectHistoryThrowSource = {
  id: string;
  fromId: string;
  toId: string;
  at: Date;
  returned: boolean;
  award: { kind: ObjectKind; penaltyId: string };
};

/** Un jugador tal y como lo necesita el mapeo: identidad pública y estado. */
export type ObjectHistoryPlayerSource = {
  name: string;
  profileId: number;
  status: PlayerStatus;
};

/**
 * Las fuentes del feed, ya leídas.
 *
 * `matchStarts` y `players` son mapas por id porque `ObjectAward` y `ObjectThrow`
 * guardan ids sueltos, sin relación de Prisma: resolverlos aparte es lo mismo que
 * hace `listObjectAwardsForAdmin()`, y así la parte pura se prueba sin base.
 */
export type ObjectHistorySources = {
  awards: readonly ObjectHistoryAwardSource[];
  throws: readonly ObjectHistoryThrowSource[];
  /** `Match.id` -> `startedAt`, solo de las partidas que citan los premios. */
  matchStarts: ReadonlyMap<string, Date>;
  /** `Player.id` -> identidad y estado, solo de los jugadores que salen. */
  players: ReadonlyMap<string, ObjectHistoryPlayerSource>;
};

/**
 * El rango de desempate de cada tipo, en el orden en que se lee un empate: primero
 * el premio, después el lanzamiento, la devolución y, por último, el cumplimiento.
 *
 * Exportado para que el test pueda comprobar que el comparador es total sin
 * repetir la tabla.
 */
export const OBJECT_HISTORY_KIND_RANK: Record<ObjectHistoryKind, number> = {
  AWARD: 0,
  THROW: 1,
  RETURN: 2,
  FULFILL: 3,
};

/**
 * El orden del feed: fecha descendente, y a igual instante el tipo y el id.
 *
 * Es un orden **total** y estable a propósito: la paginación recorta un array
 * ordenado, así que sin desempate único dos filas del mismo instante podrían
 * cambiar de lado entre una página y la siguiente y una se repetiría o se perdería.
 * Los empates son posibles (un lanzamiento y una devolución del mismo día, dos
 * premios del mismo día UTC), de ahí que el `kind` y el `id` cierren la comparación.
 *
 * Exportado para su test, como `comparePointHistory()`.
 */
export function compareObjectHistory(a: ObjectHistoryEvent, b: ObjectHistoryEvent): number {
  const porFecha = b.at.getTime() - a.at.getTime();

  if (porFecha !== 0) {
    return porFecha;
  }

  const porKind = OBJECT_HISTORY_KIND_RANK[a.kind] - OBJECT_HISTORY_KIND_RANK[b.kind];

  if (porKind !== 0) {
    return porKind;
  }

  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** La identidad pública de un jugador, o `null` si no existe o no está aprobado. */
function publicPlayer(
  players: ReadonlyMap<string, ObjectHistoryPlayerSource>,
  playerId: string,
): ObjectHistoryPlayer | null {
  const player = players.get(playerId);

  return player === undefined || player.status !== PlayerStatus.APPROVED
    ? null
    : { name: player.name, profileId: player.profileId };
}

/** La desventaja resuelta contra el catálogo; el texto es `null` si el id no está. */
function objectHistoryPenalty(
  kind: ObjectKind,
  penaltyId: string,
): { id: string; text: string | null } {
  const text = OBJECT_CATALOG[kind].penalties.find((penalty) => penalty.id === penaltyId)?.text;

  return { id: penaltyId, text: text ?? null };
}

/**
 * Convierte las fuentes en eventos del feed, ya ordenados.
 *
 * Un premio sin ganador aprobado no genera `AWARD`: el sujeto tiene que ser
 * público. El `FULFILL` solo sale con
 * `satisfiedByMatchId` informado (una retirada no lo lleva) y cae al `exitedAt`
 * cuando la partida que cumplió la desventaja ya no existe. Un lanzamiento cuyo
 * lanzador no está aprobado se descarta entero; si el objetivo no lo está, el
 * evento se conserva con `opponent: null`.
 *
 * Exportado para su test: es la parte pura de la lectura y concentra las cuatro
 * reglas de fecha y de aprobación.
 */
export function buildObjectHistoryEvents(sources: ObjectHistorySources): ObjectHistoryEvent[] {
  const events: ObjectHistoryEvent[] = [];

  for (const award of sources.awards) {
    const object = { kind: award.kind, name: OBJECT_CATALOG[award.kind].name };
    const penalty = objectHistoryPenalty(award.kind, award.penaltyId);
    const winner = publicPlayer(sources.players, award.winnerId);

    if (winner !== null) {
      events.push({
        id: `award:${award.id}`,
        kind: "AWARD",
        at: sources.matchStarts.get(award.winnerMatchId) ?? award.day,
        player: winner,
        opponent: null,
        object,
        penalty,
      });
    }

    if (award.satisfiedByMatchId === null) {
      continue;
    }

    const holder = publicPlayer(sources.players, award.holderId ?? award.winnerId);
    const fulfilledAt =
      sources.matchStarts.get(award.satisfiedByMatchId) ?? award.exitedAt;

    if (holder === null || fulfilledAt === null) {
      continue;
    }

    events.push({
      id: `fulfill:${award.id}`,
      kind: "FULFILL",
      at: fulfilledAt,
      player: holder,
      opponent: null,
      object,
      penalty,
    });
  }

  for (const item of sources.throws) {
    const thrower = publicPlayer(sources.players, item.fromId);

    if (thrower === null) {
      continue;
    }

    events.push({
      id: `throw:${item.id}`,
      kind: item.returned ? "RETURN" : "THROW",
      at: item.at,
      player: thrower,
      opponent: publicPlayer(sources.players, item.toId),
      object: { kind: item.award.kind, name: OBJECT_CATALOG[item.award.kind].name },
      penalty: objectHistoryPenalty(item.award.kind, item.award.penaltyId),
    });
  }

  return events.sort(compareObjectHistory);
}

/**
 * Aplica el suelo de edición, el rango de fechas y el filtro de participante.
 *
 * Los dos bordes del rango son los de `dateRangeWhere()`: `gte` **incluido** y
 * `lt` **excluido**, que es lo que hace que un `?to=2026-09-30` incluya el día 30
 * entero. El filtro de participante mira al sujeto **y al contrario**, para que los
 * lanzamientos recibidos salgan en el historial de quien los recibió.
 *
 * Exportado para su test: es la parte pura que decide qué fechas entran.
 */
export function filterObjectHistoryEvents(
  events: readonly ObjectHistoryEvent[],
  options: ObjectHistoryFilters & { editionFrom: Date | null },
): ObjectHistoryEvent[] {
  const floor = options.editionFrom?.getTime();
  const from = options.rango.gte?.getTime();
  const to = options.rango.lt?.getTime();

  return events.filter((event) => {
    const at = event.at.getTime();

    if (floor !== undefined && at < floor) {
      return false;
    }

    if (from !== undefined && at < from) {
      return false;
    }

    if (to !== undefined && at >= to) {
      return false;
    }

    if (options.profileId === null) {
      return true;
    }

    return (
      event.player.profileId === options.profileId ||
      event.opponent?.profileId === options.profileId
    );
  });
}

/**
 * Recorta la página del feed con la misma aritmética que `paginate()`: la página se
 * acota a la última con filas y `pageCount` es `0` cuando no hay ninguna.
 *
 * Se apoya en `paginate()` en vez de repetir el cálculo y el `load` solo corta un
 * array ya filtrado: no vuelve a consultar la base.
 */
export async function paginateObjectHistory(
  rows: readonly ObjectHistoryEvent[],
  { page, pageSize }: { page: number; pageSize: number },
): Promise<ObjectHistory> {
  return paginate(
    async (wanted) => ({
      rows: rows.slice((wanted - 1) * pageSize, wanted * pageSize),
      total: rows.length,
    }),
    { page, pageSize },
  );
}

/* -------------------------------------------------------------------------- */
/* La lectura                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * El historial público de objetos de la edición activa.
 *
 * En cada llamada, sin caché; con la base caída devuelve
 * `{ status: "degraded", data: null }`, y `data` es `null` y no una lista vacía para
 * que la pantalla distinga "no hay objetos" de "no se han podido leer".
 */
export async function getObjectHistory(
  query: ObjectHistoryQuery = {},
): Promise<PublicRead<ObjectHistory>> {
  return readFromDatabase("public/getObjectHistory", () => loadObjectHistory(query));
}

/** Las columnas de `ObjectAward` que publica el feed y que necesita el mapeo. */
const OBJECT_HISTORY_AWARD_SELECT = {
  id: true,
  kind: true,
  penaltyId: true,
  winnerId: true,
  winnerMatchId: true,
  holderId: true,
  day: true,
  exitedAt: true,
  satisfiedByMatchId: true,
} satisfies Prisma.ObjectAwardSelect;

/** Las columnas de `ObjectThrow` y el objeto de su premio. */
const OBJECT_HISTORY_THROW_SELECT = {
  id: true,
  fromId: true,
  toId: true,
  at: true,
  returned: true,
  award: { select: { kind: true, penaltyId: true } },
} satisfies Prisma.ObjectThrowSelect;

/**
 * Las filas de las dos fuentes, acotadas en SQL por la edición.
 *
 * `ObjectThrow` se acota además por `at`, que ya es la fecha de su evento. Un
 * `ObjectAward`, en cambio, **no se puede acotar por fechas** sin perder filas: la
 * misma fila genera el `AWARD` en la fecha de la partida que lo dio y el `FULFILL`
 * en la de la partida que cumplió la desventaja, que puede ser días después. Un
 * filtro por `day` dejaría fuera un cumplimiento que sí cae en el rango pedido, así
 * que el recorte de fechas de los premios se hace **solo en memoria**, sobre el `at`
 * de cada evento. El coste es el de una edición de premios, que son como mucho tres
 * por día.
 *
 * El filtro de participante tampoco va al `where`: hay que mirar los dos lados del
 * evento (sujeto y contrario) y la edición ya acota el volumen de filas, así que se
 * aplica en memoria junto con las fechas exactas.
 */
async function readObjectHistoryRows(
  editionFrom: Date | null,
  rango: DateRange,
): Promise<{ awards: ObjectHistoryAwardSource[]; throws: ObjectHistoryThrowSource[] }> {
  const awardWhere: Prisma.ObjectAwardWhereInput =
    editionFrom === null ? {} : { createdAt: { gte: editionFrom } };

  // El rango de fechas va en `AND` para no pisar el suelo de la edición: los dos
  // tienen que cumplirse, no elegir el que llegue antes.
  const throwWhere: Prisma.ObjectThrowWhereInput = {
    ...(editionFrom === null ? {} : { at: { gte: editionFrom } }),
    ...(hasDateBounds(rango) ? { AND: [{ at: rango }] } : {}),
  };

  const [awards, throws] = await Promise.all([
    db.objectAward.findMany({ where: awardWhere, select: OBJECT_HISTORY_AWARD_SELECT }),
    db.objectThrow.findMany({ where: throwWhere, select: OBJECT_HISTORY_THROW_SELECT }),
  ]);

  return { awards, throws };
}

/**
 * Arma el feed: lee las fuentes, resuelve ids sueltos, mapea, filtra, ordena y
 * recorta la página.
 *
 * Los ids de partida y de jugador se resuelven en **dos consultas aparte**, como
 * `listObjectAwardsForAdmin()`: no hay relación de Prisma entre `ObjectAward` y
 * `Match`/`Player`. Solo se piden los ids que salen en las filas ya acotadas.
 */
async function loadObjectHistory(query: ObjectHistoryQuery): Promise<ObjectHistory> {
  const page = readBoundedInt(query.page, { min: 1, max: 100_000, fallback: 1 });
  const pageSize = readBoundedInt(query.pageSize, {
    min: 1,
    max: MAX_PAGE_SIZE,
    fallback: DEFAULT_PAGE_SIZE,
  });
  const filters = readObjectHistoryFilters(query);

  const ruleset = await readRuleset();
  const windowFrom = windowBounds(ruleset.window).from;
  const editionFrom = Number.isNaN(windowFrom.getTime()) ? null : windowFrom;

  const { awards, throws } = await readObjectHistoryRows(editionFrom, filters.rango);

  const matchIds = new Set<string>();
  const playerIds = new Set<string>();

  for (const award of awards) {
    matchIds.add(award.winnerMatchId);

    if (award.satisfiedByMatchId !== null) {
      matchIds.add(award.satisfiedByMatchId);
    }

    playerIds.add(award.winnerId);

    if (award.holderId !== null) {
      playerIds.add(award.holderId);
    }
  }

  for (const item of throws) {
    playerIds.add(item.fromId);
    playerIds.add(item.toId);
  }

  const matchesPromise: Promise<{ id: string; startedAt: Date }[]> =
    matchIds.size === 0
      ? Promise.resolve([])
      : db.match.findMany({
          where: { id: { in: [...matchIds] } },
          select: { id: true, startedAt: true },
        });

  const playersPromise: Promise<(ObjectHistoryPlayerSource & { id: string })[]> =
    playerIds.size === 0
      ? Promise.resolve([])
      : db.player.findMany({
          where: { id: { in: [...playerIds] } },
          select: { id: true, name: true, profileId: true, status: true },
        });

  const [matches, players] = await Promise.all([matchesPromise, playersPromise]);

  const events = buildObjectHistoryEvents({
    awards,
    throws,
    matchStarts: new Map(matches.map((match) => [match.id, match.startedAt])),
    // `Player.id` no se publica, pero hace falta para cruzar las filas.
    players: new Map(players.map((player) => [player.id, player])),
  });

  return paginateObjectHistory(
    filterObjectHistoryEvents(events, { ...filters, editionFrom }),
    { page, pageSize },
  );
}
