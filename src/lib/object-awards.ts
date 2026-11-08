import "server-only";

import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import type { ObjectKind } from "@/generated/prisma/enums";
import type { LadderCutoffsTable } from "@/lib/alerts/division-cutoffs";
import { readDivisionCutoffs } from "@/lib/alerts/settings";
import { db } from "@/lib/db";
import { readEditionConfig, type EditionConfigClient } from "@/lib/edition";
import { aoe4WorldProfileUrl } from "@/lib/format";
import {
  OBJECT_CATALOG,
  objectDay,
  pickDailyAwards,
  pickPenalty,
  sameTargetBlocked,
  sameThrowerBlocked,
  throwReturnProbability,
  type AwardMatch,
} from "@/lib/objects";
import { rankedMatchSql } from "@/lib/ranked-match";
import { readRuleset, type ScoringRuleset } from "@/lib/scoring";

/**
 * La **persistencia y las operaciones** de los objetos utilizables de la issue
 * 134. Las reglas puras viven en `src/lib/objects.ts` y la mecánica completa en
 * `docs/OBJETOS.md`; este módulo es el que las conecta con la base y con el
 * worker.
 *
 * ## Una sola ventana por objeto
 *
 * `ObjectAward.heldSince` / `exitedAt` describen **la ventana actual**, no un
 * histórico: al cambiar de manos, la ventana se cierra en el instante del
 * lanzamiento y se vuelve a abrir con el portador nuevo. No hay tabla de tramos, así
 * que la fila no puede guardar el cierre de la anterior: su rastro queda en las
 * partidas que ya se marcaron y en el `ObjectThrow`; `exitedAt` vuelve a `null` para
 * que la ventana nueva esté viva.
 *
 * La consecuencia es la limitación conocida del POC: una partida que llega a la
 * base **después** de que la ventana se haya cerrado ya no se excluye, porque
 * `applyObjectBlocks()` solo recorre las ventanas abiertas.
 *
 * ## Qué escribe cada operación
 *
 * | Operación | Qué hace |
 * |---|---|
 * | `isObjectsModeEnabled()` | Lee `edition.config.objectsEnabled`: la puerta de todo lo demás |
 * | `syncDailyObjectAwards()` | Crea los premios que faltan (uno por tipo y día UTC) con el portador y la desventaja sorteados |
 * | `applyObjectBlocks()` | Marca `Match.excludedByAwardId` en las partidas del portador que caen dentro de la ventana abierta |
 * | `disableObjectsMode()` | Cierra los premios pendientes y desbloquea todas las partidas marcadas: el efecto de apagar el modo |
 * | `throwObject()` | Anota el lanzamiento y, si no se devuelve, mueve la ventana al objetivo |
 * | `fulfillObject()` | Da la desventaja por cumplida sobre una partida y desbloquea esa y las posteriores |
 * | `listObjectAwardsForAdmin()` | Devuelve los premios recientes con todo lo que la UI necesita para pintarlos |
 * | `listAwardMatchesForAdmin()` | Las partidas del portador que pueden cumplir la desventaja |
 * | `listObjectThrowTargetsForAdmin()` | Los aprobados a los que se puede lanzar, con su puesto |
 *
 * ## El modo es configurable, y la puerta está aquí
 *
 * El modo de objetos se enciende por edición (`Setting["edition.config"].objectsEnabled`,
 * apagado por defecto) y solo lo cambia el superadministrador. Las cuatro operaciones
 * que crean o mueven estado lo comprueban **en el servicio** y no solo en la UI: el
 * worker, una consola y una Server Action llegan aquí sin pasar por una pantalla.
 * `listObjectAwardsForAdmin()` no se filtra: el panel sigue enseñando el histórico
 * aunque el modo esté apagado.
 *
 * ## El azar
 *
 * Las funciones reciben `random` inyectable y, por defecto, usan `Math.random()`:
 * ni el sorteo de la desventaja ni la tirada de la devolución son un secreto, y
 * evitar `node:crypto` deja el módulo sin dependencias que no estén garantizadas
 * en el runtime de los Workers. Los tests inyectan una tirada fija.
 */

/**
 * Cliente que necesitan estas operaciones: `db` o una transacción. Incluye
 * `$transaction` porque `throwObject()` y `fulfillObject()` escriben la marca del
 * objeto y su partida en la misma unidad.
 */
export type ObjectAwardsClient = Pick<
  PrismaClient,
  | "$queryRaw"
  | "$transaction"
  | "objectAward"
  | "objectThrow"
  | "match"
  | "player"
  | "playerScore"
  | "setting"
>;

/** Opciones comunes: el cliente y el reloj se inyectan en los tests. */
export type ObjectAwardsOptions = {
  client?: ObjectAwardsClient;
};

/** El resultado de una pasada de otorgamiento. */
export type SyncDailyObjectAwardsResult = {
  /** Premios creados de verdad (los que ya existían no cuentan). */
  created: number;
  /** Las filas creadas, ya con el portador y la desventaja. */
  awards: Prisma.ObjectAwardModel[];
};

/* -------------------------------------------------------------------------- */
/* El interruptor de la edición                                                */
/* -------------------------------------------------------------------------- */

/**
 * ¿Está encendido el modo de objetos en la edición activa?
 *
 * Sale de `Setting["edition.config"].objectsEnabled`, que es **apagado por defecto** y
 * solo cambia el superadministrador (`saveEditionConfig`). La consulta la hace el
 * propio servicio y no solo la UI porque estas operaciones también se llaman desde el
 * worker, desde una consola de servidor y desde una Server Action: esconder el botón
 * no impide que una pasada antigua o una llamada directa creen premios o bloqueen
 * partidas en una edición que tiene el modo apagado.
 *
 * Un fallo de la base se propaga, como en `readEditionConfig()`: "no hay nada
 * configurado" es el valor por defecto, pero "no se ha podido leer" no.
 */
export async function isObjectsModeEnabled(client: EditionConfigClient = db): Promise<boolean> {
  const config = await readEditionConfig(client);

  return config.objectsEnabled;
}

export type SyncDailyObjectAwardsOptions = ObjectAwardsOptions & {
  /** Ruleset activo; si no viene se lee de `Setting`. */
  ruleset?: ScoringRuleset;
  /**
   * Reloj de la pasada. Solo descarta partidas con `startedAt` en el futuro (un
   * desajuste de reloj o una fila de prueba): el día y `heldSince` salen siempre
   * del `startedAt` de la partida, no de este instante.
   */
  now?: Date;
  /** Tirada en `[0, 1)` para `pickPenalty()`. Por defecto, `Math.random`. */
  random?: () => number;
};

/** Una fila candidata tal y como la devuelve la consulta cruda. */
type AwardCandidateRow = {
  id: string;
  gameId: string;
  playerId: string;
  startedAtMs: number;
  winReason: string | null;
};

/**
 * Las partidas que pueden otorgar un objeto, en una sola consulta.
 *
 * Es el mismo patrón que `objectiveRowsQuery()` de `objectives.ts`: la regla de
 * qué es clasificatoria sale de `rankedMatchSql()` —con la fila de `Player`
 * delante, porque abarca a todos los jugadores— y aquí solo se añade lo propio de
 * los objetos: la partida está ganada y tiene un motivo de victoria. La condición
 * de equipos de esa regla necesita los cortes, que se pasan desde fuera.
 *
 * El orden incluye `p."id"` como último desempate. En una partida por equipos todos
 * los ganadores comparten `gameId` y `startedAt`, así que sin él el ganador del
 * objeto dependería del plan de la consulta; con él, el primero por id de jugador,
 * que es estable entre pasadas.
 */
function awardCandidatesQuery(
  ruleset: ScoringRuleset,
  cutoffs: LadderCutoffsTable | null,
): Prisma.Sql {
  return Prisma.sql`
    select m."id" as "id",
           m."gameId" as "gameId",
           p."id" as "playerId",
           (extract(epoch from m."startedAt" at time zone 'UTC') * 1000)::double precision as "startedAtMs",
           m."winReason" as "winReason"
    from "Match" m
    join "Player" p on p."id" = m."playerId"
    where p."status" = 'APPROVED'
      and m."result" = 'WIN'
      and m."winReason" is not null
      and ${rankedMatchSql(Prisma.sql`m`, Prisma.sql`p`, ruleset.modes, ruleset.window, cutoffs)}
    order by m."startedAt", m."gameId", p."id"
  `;
}

/**
 * Crea los premios de objeto que faltan: uno por tipo y día UTC.
 *
 * Las partidas candidatas salen de una sola consulta filtrada por la regla única
 * de clasificatorias, y la selección de la primera del día la hace
 * `pickDailyAwards()`. Los pares `(kind, day)` que ya existen se excluyen antes de
 * proponerlos, y además la inserción usa `skipDuplicates` sobre
 * `@@unique([kind, day])`: si dos pasadas coinciden, la segunda no crea nada y el
 * resultado sigue siendo correcto.
 *
 * El premio se crea en cuanto el worker ve la primera victoria del día con el
 * motivo correspondiente. Si una partida **anterior** de ese día llega después, no
 * reescribe el premio: el índice único lo impide y el POC asume que la primera que
 * se ve es la primera que cuenta.
 *
 * Devuelve solo las filas creadas en esta pasada. Un fallo de lectura o de
 * escritura se propaga: el worker lo recoge y sigue con la pasada.
 */
export async function syncDailyObjectAwards(
  options: SyncDailyObjectAwardsOptions = {},
): Promise<SyncDailyObjectAwardsResult> {
  const client = options.client ?? db;
  const now = options.now ?? new Date();
  const random = options.random ?? Math.random;

  // El modo apagado no crea premios: se comprueba antes de leer el ruleset y las
  // partidas, así que una edición sin objetos no gasta la consulta cruda.
  if (!(await isObjectsModeEnabled(client))) {
    return { created: 0, awards: [] };
  }

  const ruleset = options.ruleset ?? (await readRuleset(client));

  if (ruleset.modes.length === 0) {
    return { created: 0, awards: [] };
  }

  const cutoffs = await readDivisionCutoffs(client);
  const rows = await client.$queryRaw<AwardCandidateRow[]>(awardCandidatesQuery(ruleset, cutoffs));
  const taken = await client.objectAward.findMany({ select: { kind: true, day: true } });

  const candidates: AwardMatch[] = rows
    .filter((row) => row.startedAtMs <= now.getTime())
    .map((row) => ({
      id: row.id,
      gameId: row.gameId,
      playerId: row.playerId,
      startedAt: new Date(row.startedAtMs),
      winReason: row.winReason,
    }));

  const planned = pickDailyAwards(candidates, { taken });

  if (planned.length === 0) {
    return { created: 0, awards: [] };
  }

  const awards = await client.objectAward.createManyAndReturn({
    data: planned.map((award) => ({
      kind: award.kind,
      day: award.day,
      penaltyId: pickPenalty(award.kind, random).id,
      winnerId: award.winnerId,
      winnerMatchId: award.winnerMatchId,
      holderId: award.winnerId,
      heldSince: award.heldSince,
    })),
    skipDuplicates: true,
  });

  return { created: awards.length, awards };
}

/** Una ventana abierta, ya sin los campos nulos que no pueden serlo. */
type OpenWindow = {
  id: string;
  holderId: string;
  heldSince: Date;
};

/**
 * El `updateMany` que marca las partidas de una ventana.
 *
 * Va en su propia función porque `throwObject()` tiene que ejecutar exactamente
 * esta marca **antes** de mover la ventana, y la quiere en la misma transacción
 * que el lanzamiento. Solo toca las partidas que aún no tienen marca
 * (`excludedByAwardId: null`), así que es idempotente y nunca pisa la exclusión de
 * otro objeto.
 */
function blockWindowUpdate(
  client: ObjectAwardsClient,
  award: OpenWindow,
): Prisma.PrismaPromise<Prisma.BatchPayload> {
  return client.match.updateMany({
    where: {
      playerId: award.holderId,
      excludedByAwardId: null,
      startedAt: { gt: award.heldSince },
    },
    data: { excludedByAwardId: award.id },
  });
}

/**
 * Marca las partidas que caen dentro de cada ventana **abierta**.
 *
 * Es la materialización de `isMatchBlocked()` sobre la base: las partidas del
 * portador con `startedAt > heldSince` quedan con `excludedByAwardId` y el motor
 * las deja de contar en sus tres traducciones. El borde de `heldSince` es estricto
 * —la partida que dio el objeto cuenta—, y por eso el filtro empieza en `gt`; el
 * borde de `exitedAt` lo resuelve `fulfillObject()`, que cierra la ventana y
 * desbloquea a partir de la partida que cumple.
 *
 * Solo recorre premios con `exitedAt` a `null`; una ventana cerrada ya no bloquea
 * nada. De ahí la limitación conocida y documentada: una partida que llega a la
 * base después de cerrar la ventana no se quema.
 *
 * Es idempotente: solo marca las que tienen `excludedByAwardId` a `null`, así que
 * dos pasadas seguidas no cambian nada y la segunda devuelve 0. Devuelve cuántas
 * partidas ha marcado de nuevo, que es lo que el worker usa para forzar el
 * recálculo.
 */
export async function applyObjectBlocks(options: ObjectAwardsOptions = {}): Promise<number> {
  const client = options.client ?? db;

  // Con el modo apagado no se marca ninguna partida: la exclusión es un efecto del
  // modo, no una propiedad de las filas que ya existan.
  if (!(await isObjectsModeEnabled(client))) {
    return 0;
  }

  const awards = await client.objectAward.findMany({
    where: { holderId: { not: null }, heldSince: { not: null }, exitedAt: null },
    select: { id: true, holderId: true, heldSince: true },
  });

  const open: OpenWindow[] = awards.flatMap((award) =>
    award.holderId === null || award.heldSince === null
      ? []
      : [{ id: award.id, holderId: award.holderId, heldSince: award.heldSince }],
  );

  let blocked = 0;

  for (const award of open) {
    const result = await blockWindowUpdate(client, award);
    blocked += result.count;
  }

  return blocked;
}

export type DisableObjectsModeOptions = ObjectAwardsOptions & {
  /** Instante con el que se cierran los premios pendientes. Por defecto, ahora. */
  now?: Date;
};

/** Lo que ha cambiado el apagado del modo. */
export type DisableObjectsModeResult = {
  /** Premios pendientes que se han cerrado. */
  closed: number;
  /** Partidas que se han desbloqueado. */
  unblocked: number;
};

/**
 * Apaga el modo de objetos **de verdad**: cierra los premios pendientes y desbloquea
 * todas las partidas marcadas.
 *
 * Lo llama `saveEditionConfig` cuando el interruptor queda apagado, **fuera** de la
 * transacción que guarda la configuración: el cambio ya está escrito y esto es su
 * efecto. No hay congelación ni reanudación: los premios se cierran con `exitedAt` en
 * `now` y ninguna partida vuelve a quedar excluida, porque `applyObjectBlocks()` no
 * marca nada con el modo apagado. Volver a encenderlo no reabre nada: empieza limpio.
 *
 * Es idempotente: con los premios ya cerrados y las partidas ya desbloqueadas, las dos
 * escrituras no cambian ninguna fila y devuelve ceros. **No borra el histórico**: los
 * premios y sus lanzamientos siguen ahí y el panel los sigue enseñando.
 */
export async function disableObjectsMode(
  options: DisableObjectsModeOptions = {},
): Promise<DisableObjectsModeResult> {
  const client = options.client ?? db;
  const now = options.now ?? new Date();

  // En una transacción, para que no quede un estado intermedio con los premios
  // cerrados y las partidas todavía bloqueadas, que el worker ya no desbloquearía.
  const [awards, matches] = await client.$transaction([
    client.objectAward.updateMany({
      where: { exitedAt: null },
      data: { exitedAt: now },
    }),
    client.match.updateMany({
      where: { excludedByAwardId: { not: null } },
      data: { excludedByAwardId: null },
    }),
  ]);

  return { closed: awards.count, unblocked: matches.count };
}

export type ThrowObjectOptions = ObjectAwardsOptions & {
  awardId: string;
  /** `Player.id` del objetivo del lanzamiento. */
  toId: string;
  now?: Date;
  /** Tirada en `[0, 1)`; por defecto, `Math.random`. */
  random?: () => number;
};

export type ThrowObjectResult = {
  /** `true` = se devolvió y el objeto sigue en el lanzador. */
  returned: boolean;
  /** Probabilidad de devolución que se aplicó, ya degradada si faltaban puestos. */
  probability: number;
  /** La tirada que se consumió, tal cual se guarda en `ObjectThrow.roll`. */
  roll: number;
  /** `Player.id` del portador después del lanzamiento. */
  holderId: string;
};

/**
 * Lanza un objeto a otro jugador.
 *
 * Valida, en este orden: que el premio exista, que tenga portador y siga pendiente,
 * que el objetivo no sea el portador, que ese objetivo no haya recibido ya el
 * objeto hoy (regla Y) y que el portador no haya lanzado ya hoy. Los errores son
 * `Error` con el texto en español que el panel enseñará tal cual.
 *
 * La probabilidad sale del puesto de los dos en `PlayerScore` del ruleset vigente.
 * Si falta la fila de alguno (un alta recién aprobada, un recálculo a medias) se
 * degrada a 0,01 con `throwReturnProbability()`: el lanzamiento no se bloquea por
 * un dato administrativo y el objeto viaja al objetivo salvo una tirada mínima.
 *
 * Si **no** se devuelve, consolida la ventana actual (marca sus partidas) y mueve el
 * portador dejando la ventana nueva abierta en el instante del lanzamiento, todo en
 * la misma transacción que el `ObjectThrow`. Si **se devuelve**, la ventana no se
 * toca: solo se anota el lanzamiento con `returned = true`.
 */
export async function throwObject(options: ThrowObjectOptions): Promise<ThrowObjectResult> {
  const client = options.client ?? db;
  const now = options.now ?? new Date();
  const random = options.random ?? Math.random;
  const { awardId, toId } = options;

  if (!(await isObjectsModeEnabled(client))) {
    throw new Error("El modo de objetos está desactivado en esta edición.");
  }

  const award = await client.objectAward.findUnique({ where: { id: awardId } });

  if (award === null) {
    throw new Error("El objeto no existe.");
  }

  if (award.holderId === null || award.heldSince === null) {
    throw new Error("El objeto no tiene portador.");
  }

  if (award.exitedAt !== null) {
    throw new Error("El objeto ya no está pendiente.");
  }

  if (toId === award.holderId) {
    throw new Error("El objeto no se puede lanzar a quien ya lo tiene.");
  }

  const target = await client.player.findUnique({ where: { id: toId }, select: { id: true } });

  if (target === null) {
    throw new Error("El jugador de destino no existe.");
  }

  const throws = await client.objectThrow.findMany({
    where: { awardId },
    select: { fromId: true, toId: true, at: true },
  });

  if (sameTargetBlocked(throws, toId, now)) {
    throw new Error("Ese jugador ya ha recibido este objeto hoy.");
  }

  if (sameThrowerBlocked(throws, award.holderId, now)) {
    throw new Error("El portador ya ha lanzado este objeto hoy.");
  }

  const ruleset = await readRuleset(client);
  const [throwerScore, targetScore, totalPlayers] = await Promise.all([
    client.playerScore.findUnique({
      where: { playerId_ruleSetVersion: { playerId: award.holderId, ruleSetVersion: ruleset.version } },
      select: { rank: true },
    }),
    client.playerScore.findUnique({
      where: { playerId_ruleSetVersion: { playerId: toId, ruleSetVersion: ruleset.version } },
      select: { rank: true },
    }),
    client.playerScore.count({ where: { ruleSetVersion: ruleset.version } }),
  ]);

  const probability = throwReturnProbability({
    throwerRank: throwerScore?.rank ?? null,
    targetRank: targetScore?.rank ?? null,
    totalPlayers,
  });
  const roll = random();
  const returned = roll < probability;

  if (returned) {
    await client.objectThrow.create({
      data: { awardId, fromId: award.holderId, toId, at: now, roll, returned: true },
    });
  } else {
    await client.$transaction([
      blockWindowUpdate(client, {
        id: award.id,
        holderId: award.holderId,
        heldSince: award.heldSince,
      }),
      client.objectThrow.create({
        data: { awardId, fromId: award.holderId, toId, at: now, roll, returned: false },
      }),
      client.objectAward.update({
        where: { id: awardId },
        // La fila guarda **una** ventana, así que la anterior no se puede cerrar
        // aquí sin cerrar también la nueva: su rastro queda en las partidas ya
        // marcadas y en el `ObjectThrow` que acaba de crearse, y `exitedAt` vuelve
        // a `null` para que el objetivo quede pendiente. Con `exitedAt = now` la
        // ventana nueva nacería vacía y el portador no tendría desventaja.
        data: { exitedAt: null, holderId: toId, heldSince: now },
      }),
    ]);
  }

  return {
    returned,
    probability,
    roll,
    holderId: returned ? award.holderId : toId,
  };
}

export type FulfillObjectOptions = ObjectAwardsOptions & {
  awardId: string;
  /** `Match.id` de la partida con la que se da la desventaja por cumplida. */
  matchId: string;
};

/**
 * Da la desventaja por **cumplida** sobre una partida concreta.
 *
 * Valida que el premio siga pendiente, que la partida sea del portador y que haya
 * empezado **después** de `heldSince` (una partida que ya estaba en marcha cuando
 * llegó el objeto no puede cumplirlo). Cierra la ventana en el `startedAt` de esa
 * partida y desbloquea las que tuvieran **ese** `excludedByAwardId` y empezaran en
 * o después de ese instante: la partida que cumple la desventaja cuenta, y las
 * anteriores siguen sin contar.
 *
 * Devuelve la fila del premio ya actualizada.
 */
export async function fulfillObject(
  options: FulfillObjectOptions,
): Promise<Prisma.ObjectAwardModel> {
  const client = options.client ?? db;
  const { awardId, matchId } = options;

  if (!(await isObjectsModeEnabled(client))) {
    throw new Error("El modo de objetos está desactivado en esta edición.");
  }

  const award = await client.objectAward.findUnique({ where: { id: awardId } });

  if (award === null) {
    throw new Error("El objeto no existe.");
  }

  if (award.holderId === null || award.heldSince === null) {
    throw new Error("El objeto no tiene portador.");
  }

  if (award.exitedAt !== null) {
    throw new Error("El objeto ya no está pendiente.");
  }

  const match = await client.match.findUnique({ where: { id: matchId } });

  if (match === null) {
    throw new Error("La partida no existe.");
  }

  if (match.playerId !== award.holderId) {
    throw new Error("La partida no es del portador del objeto.");
  }

  if (match.startedAt.getTime() <= award.heldSince.getTime()) {
    throw new Error("La partida empezó antes de que el portador recibiera el objeto.");
  }

  const [, updated] = await client.$transaction([
    client.match.updateMany({
      where: {
        playerId: award.holderId,
        excludedByAwardId: award.id,
        startedAt: { gte: match.startedAt },
      },
      data: { excludedByAwardId: null },
    }),
    client.objectAward.update({
      where: { id: awardId },
      data: { exitedAt: match.startedAt, satisfiedByMatchId: matchId },
    }),
  ]);

  return updated;
}

/** Un jugador de la vista del panel: el nombre y el perfil ya resueltos. */
export type ObjectAwardPlayerView = {
  playerId: string;
  profileId: number | null;
  name: string | null;
  avatarUrl: string | null;
  /** Enlace al perfil en AoE4World; `null` si el jugador ya no existe. */
  profileUrl: string | null;
};

/** Un lanzamiento tal y como lo pinta el panel. */
export type ObjectThrowView = {
  id: string;
  from: ObjectAwardPlayerView;
  to: ObjectAwardPlayerView;
  at: Date;
  roll: number;
  returned: boolean;
};

/** Un premio con todo lo que la UI necesita, sin lógica que resolver. */
export type ObjectAwardAdminView = {
  id: string;
  kind: ObjectKind;
  /** Nombre del catálogo (`Reliquia pagana`, `Moneda del Rey falsificada`…). */
  kindName: string;
  /** Con qué victoria se obtiene, en una línea. */
  obtainedBy: string;
  day: Date;
  /** La desventaja resuelta contra el catálogo. `text` es `null` si el id no está. */
  penalty: { id: string; text: string | null };
  winner: ObjectAwardPlayerView;
  holder: ObjectAwardPlayerView | null;
  heldSince: Date | null;
  exitedAt: Date | null;
  /** `true` si el objeto sigue pendiente (`exitedAt` a `null`). */
  pending: boolean;
  /** La partida que dio la desventaja por cumplida, si la hay. */
  satisfiedBy: {
    matchId: string;
    gameId: string;
    startedAt: Date;
    result: string | null;
  } | null;
  /** Lanzamientos del objeto, del más antiguo al más reciente. */
  throws: ObjectThrowView[];
};

/** Ventana de la lista del panel: los últimos 14 días de objetos. */
const ADMIN_WINDOW_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Un jugador sin fila en `Player` (borrado): la vista queda con lo que se sabe. */
function missingPlayer(playerId: string): ObjectAwardPlayerView {
  return { playerId, profileId: null, name: null, avatarUrl: null, profileUrl: null };
}

/**
 * Los premios de los últimos 14 días, con nombre y perfil del ganador y del
 * portador, la desventaja resuelta y sus lanzamientos.
 *
 * Es una función de **lectura para el panel**: no decide nada, devuelve los datos
 * ya cruzados para que la UI no tenga que resolver ids contra el catálogo ni
 * recorrer relaciones. Las claves que no encuentran fila (un jugador borrado) se
 * devuelven con los datos de perfil a `null`; un `penaltyId` que ya no está en el
 * catálogo se devuelve con `text: null` para que el panel enseñe el id en vez de
 * inventarse una redacción.
 */
export async function listObjectAwardsForAdmin(
  options: ObjectAwardsOptions = {},
): Promise<ObjectAwardAdminView[]> {
  const client = options.client ?? db;
  const since = objectDay(new Date(Date.now() - ADMIN_WINDOW_DAYS * DAY_MS));

  const awards = await client.objectAward.findMany({
    where: { day: { gte: since } },
    orderBy: [{ day: "desc" }, { kind: "asc" }],
    include: { throws: { orderBy: { at: "asc" } } },
  });

  const playerIds = new Set<string>();

  for (const award of awards) {
    playerIds.add(award.winnerId);

    if (award.holderId !== null) {
      playerIds.add(award.holderId);
    }

    for (const item of award.throws) {
      playerIds.add(item.fromId);
      playerIds.add(item.toId);
    }
  }

  const matchIds = awards.flatMap((award) =>
    award.satisfiedByMatchId === null ? [] : [award.satisfiedByMatchId],
  );

  const [players, matches] = await Promise.all([
    playerIds.size === 0
      ? Promise.resolve([])
      : client.player.findMany({
          where: { id: { in: [...playerIds] } },
          select: { id: true, profileId: true, name: true, avatarUrl: true },
        }),
    matchIds.length === 0
      ? Promise.resolve([])
      : client.match.findMany({
          where: { id: { in: matchIds } },
          select: { id: true, gameId: true, startedAt: true, result: true },
        }),
  ]);

  const playersById = new Map(players.map((player) => [player.id, player]));
  const matchesById = new Map(matches.map((match) => [match.id, match]));

  const view = (playerId: string): ObjectAwardPlayerView => {
    const player = playersById.get(playerId);

    return player === undefined
      ? missingPlayer(playerId)
      : {
          playerId: player.id,
          profileId: player.profileId,
          name: player.name,
          avatarUrl: player.avatarUrl,
          profileUrl: aoe4WorldProfileUrl(player.profileId),
        };
  };

  return awards.map((award) => {
    const definition = OBJECT_CATALOG[award.kind];
    const penalty = definition.penalties.find((entry) => entry.id === award.penaltyId);
    const satisfiedBy =
      award.satisfiedByMatchId === null
        ? null
        : (matchesById.get(award.satisfiedByMatchId) ?? null);

    return {
      id: award.id,
      kind: award.kind,
      kindName: definition.name,
      obtainedBy: definition.obtainedBy,
      day: award.day,
      penalty: { id: award.penaltyId, text: penalty?.text ?? null },
      winner: view(award.winnerId),
      holder: award.holderId === null ? null : view(award.holderId),
      heldSince: award.heldSince,
      exitedAt: award.exitedAt,
      pending: award.exitedAt === null,
      satisfiedBy:
        satisfiedBy === null
          ? null
          : {
              matchId: satisfiedBy.id,
              gameId: satisfiedBy.gameId,
              startedAt: satisfiedBy.startedAt,
              result: satisfiedBy.result,
            },
      throws: award.throws.map((item) => ({
        id: item.id,
        from: view(item.fromId),
        to: view(item.toId),
        at: item.at,
        roll: item.roll,
        returned: item.returned,
      })),
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Datos para las acciones del panel                                           */
/* -------------------------------------------------------------------------- */

/** Una partida del portador que el admin puede marcar como desventaja cumplida. */
export type ObjectAwardMatchView = {
  /** `Match.id`, que es lo que se manda a `fulfillObject()`. */
  matchId: string;
  gameId: string;
  startedAt: Date;
  /** `null` mientras la partida sigue en curso. */
  result: string | null;
  opponentName: string | null;
  map: string | null;
  /** Puntos que aporta hoy la partida; 0 si el objeto la tiene excluida. */
  points: number;
  /**
   * Objeto que excluye la partida, o `null` si cuenta. Cuando vale algo, el panel
   * puede marcarla como ya bloqueada; si es el premio que se está mirando, es una
   * partida que el objeto está quemando.
   */
  excludedByAwardId: string | null;
};

/**
 * Las partidas del **portador actual** de un objeto que podrían cumplir su
 * desventaja: las que empezaron después de `heldSince`.
 *
 * Es la lista que el panel enseña para elegir. La condición es la misma que valida
 * `fulfillObject()` (`startedAt > heldSince`, estricta), así que todo lo que sale aquí
 * se puede marcar; el orden es el de la partida más reciente primero, que es la que
 * el admin suele estar mirando.
 *
 * Si el premio no existe, no tiene portador o no tiene `heldSince`, devuelve una lista
 * vacía **sin lanzar**: no es un fallo, es un objeto que todavía no se puede cumplir.
 * Un fallo de la base sí se propaga.
 */
export async function listAwardMatchesForAdmin(
  options: ObjectAwardsOptions & { awardId: string },
): Promise<ObjectAwardMatchView[]> {
  const client = options.client ?? db;

  const award = await client.objectAward.findUnique({
    where: { id: options.awardId },
    select: { holderId: true, heldSince: true },
  });

  if (award === null || award.holderId === null || award.heldSince === null) {
    return [];
  }

  const matches = await client.match.findMany({
    where: {
      playerId: award.holderId,
      startedAt: { gt: award.heldSince },
    },
    orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    select: {
      id: true,
      gameId: true,
      startedAt: true,
      result: true,
      opponentName: true,
      map: true,
      points: true,
      excludedByAwardId: true,
    },
  });

  return matches.map((match) => ({
    matchId: match.id,
    gameId: match.gameId,
    startedAt: match.startedAt,
    result: match.result,
    opponentName: match.opponentName,
    map: match.map,
    points: match.points,
    excludedByAwardId: match.excludedByAwardId,
  }));
}

/** Un jugador aprobado al que se puede lanzar un objeto, con su puesto si lo tiene. */
export type ObjectThrowTargetView = {
  /** `Player.id`: es lo que viaja como `toId`. */
  playerId: string;
  profileId: number;
  name: string;
  /** Enlace al perfil en AoE4World, ya montado. */
  profileUrl: string;
  /**
   * Puesto en la clasificación del ruleset vigente (1 = primero), o `null` si el
   * jugador todavía no tiene fila de `PlayerScore`.
   */
  rank: number | null;
};

/**
 * Orden del desplegable de lanzamiento: por puesto y, quien no tiene puesto, al final.
 *
 * Dentro del mismo puesto desempata el nombre y después el `profileId`, para que el
 * orden no dependa del plan de la consulta. Es una función pura para poder probarla sin
 * base de datos.
 */
export function compareObjectThrowTargets(
  a: Pick<ObjectThrowTargetView, "rank" | "name" | "profileId">,
  b: Pick<ObjectThrowTargetView, "rank" | "name" | "profileId">,
): number {
  const rankA = a.rank ?? Number.MAX_SAFE_INTEGER;
  const rankB = b.rank ?? Number.MAX_SAFE_INTEGER;

  if (rankA !== rankB) {
    return rankA - rankB;
  }

  if (a.name !== b.name) {
    return a.name < b.name ? -1 : 1;
  }

  return a.profileId - b.profileId;
}

/**
 * Los jugadores **aprobados** a los que se puede lanzar un objeto, ordenados por puesto.
 *
 * El puesto sale de `PlayerScore` del ruleset vigente, el mismo que lee
 * `throwObject()` para calcular la probabilidad de devolución: si un jugador todavía no
 * tiene fila sale con `rank: null` y el desplegable lo deja al final, que es lo que el
 * cálculo degrada a 0,01.
 *
 * No reutiliza `getAdminParticipants()` porque aquella lectura no trae el puesto y
 * devuelve todos los estados; esta pantalla solo lanza a aprobados.
 */
export async function listObjectThrowTargetsForAdmin(
  options: ObjectAwardsOptions = {},
): Promise<ObjectThrowTargetView[]> {
  const client = options.client ?? db;
  const ruleset = await readRuleset(client);

  const players = await client.player.findMany({
    where: { status: "APPROVED" },
    select: {
      id: true,
      profileId: true,
      name: true,
      scores: {
        where: { ruleSetVersion: ruleset.version },
        select: { rank: true },
      },
    },
  });

  return players
    .map((player) => ({
      playerId: player.id,
      profileId: player.profileId,
      name: player.name,
      profileUrl: aoe4WorldProfileUrl(player.profileId),
      rank: player.scores[0]?.rank ?? null,
    }))
    .sort(compareObjectThrowTargets);
}
