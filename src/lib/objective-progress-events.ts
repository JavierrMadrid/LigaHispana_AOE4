import "server-only";

import { Prisma } from "@/generated/prisma/client";
import { ObjectiveProgressKind } from "@/generated/prisma/enums";
import {
  currentObjectiveProgress,
  diffObjectiveProgress,
  objectiveProgressKey,
  planObjectiveProgressStateWrites,
  type ObjectiveProgressEventDraft,
} from "@/lib/objective-progress";
import { objectiveKind, type ObjectiveOption, type PlayerAggregate } from "@/lib/objectives";
import { windowBounds, type ScoringWindow } from "@/lib/ranked-match";
import type { ScoringRuleset } from "@/lib/scoring";

/**
 * La escritura del progreso de los objetivos: el **estado** de la edición y el
 * **feed** que leerá la API del overlay.
 *
 * Lo que decide *qué* cambió es puro y vive en `objective-progress.ts`; aquí solo
 * se lee, se escribe la diferencia y se pone el instante. Son dos tablas con dos
 * papeles distintos y no se pueden reducir a una:
 *
 * - `ObjectiveProgressState` es la **memoria de trabajo**: una fila por jugador,
 *   objetivo y edición, reescrita en cada pase. Sirve para saber qué cambió sin
 *   releer el feed entero;
 * - `ObjectiveProgressEvent` es el **feed** *append-only*: lo que se publica y no se
 *   toca. Un evento que dice "pasó de 7 a 8 victorias" no deja de ser cierto porque
 *   después se revierta la partida.
 *
 * ## Por qué va dentro de la transacción de `recomputeScores()`
 *
 * Por el mismo motivo que el resto de registros del motor: o el feed y la
 * clasificación describen lo mismo, o no cambia ninguno de los dos. Con el cerrojo
 * de la clasificación ya tomado, todos los caminos que recalculan —el worker, `npm
 * run score`, revertir o restaurar una partida, aprobar o dar de baja a un jugador—
 * dejan el feed al día sin tener que acordarse de un segundo paso.
 *
 * ## La siembra de la primera pasada de una edición
 *
 * Un estado nuevo no reconstruye el pasado (el momento en que empezó a progresar no
 * consta en ninguna parte): se anota `CUMPLIDO` si el jugador ya lo tiene y
 * `PROGRESADO` si solo lleva avance parcial, y **no hay `PERDIDO`** en la siembra
 * porque no había nada que perder.
 *
 * ## Qué instante es `at`
 *
 * El del recálculo que detectó el cambio. La única excepción es la siembra de un
 * logro con la ventana ya cerrada: ahí `at` es `window.to`, que es cuando el torneo
 * lo da por cumplido (ver `objectiveProgressEventAt()`).
 *
 * ## La cohorte
 *
 * `editionFrom` es el `window.from` de la edición activa y sella todas las filas: la
 * API filtra por la edición en curso, así que una edición nueva arranca su propio
 * estado y su propio feed sin mezclar el de la anterior.
 *
 * ## Es idempotente
 *
 * Sin diferencias no escribe nada: se lee el estado de la edición, se compara con el
 * cómputo de este pase y solo se anexan los eventos y se reescriben las filas que de
 * verdad cambian. Una pasada ociosa del worker no toca ninguna de las dos tablas.
 *
 * ## `PERDIDO` solo en competiciones
 *
 * Una competición se posee y se pierde, y quien la pierde merece que quede anotado.
 * Un logro no se des-cumple: una bajada solo puede venir de corregir datos, y
 * publicarla como pérdida contaría una historia que el torneo no vivió. Por eso un
 * logro revertido no genera evento (lo decide `diffObjectiveProgress()`).
 *
 * ## El estado es interno; el evento es lo que se publica
 *
 * La API del overlay lee `ObjectiveProgressEvent` y nada más: `ObjectiveProgressState`
 * es un detalle de la implementación del motor y puede reescribirse entero sin que
 * el contrato publicado cambie.
 */

/** Cliente con las dos tablas que necesita esta reconciliación (`db` o una `tx`). */
export type ObjectiveProgressWriter = Pick<
  Prisma.TransactionClient,
  "objectiveProgressEvent" | "objectiveProgressState"
>;

/** Qué ha escrito una reconciliación, por si hay que comprobarla o contarla. */
export type ObjectiveProgressReconcileResult = {
  /** Eventos anexados al feed en esta pasada (0 en la inmensa mayoría). */
  eventsCreated: number;
  /** Filas de estado nuevas: la siembra de un jugador en un objetivo. */
  statesCreated: number;
  /** Filas de estado reescritas porque su valor, su cumplimiento o su repetición cambió. */
  statesUpdated: number;
  /** Filas de estado borradas porque el jugador ya no tiene ese progreso. */
  statesDeleted: number;
};

/**
 * Filas por sentencia.
 *
 * El seed de una edición puede ser de miles de filas y `createMany` arma **un
 * parámetro por columna y fila**: 12 000 filas de ocho columnas pasan del límite de
 * 65 535 parámetros de Postgres y la sentencia falla entera. Mil filas por trozo
 * deja el margen de sobra sin convertir la escritura en una ristra de sentencias.
 */
const WRITE_CHUNK_SIZE = 1000;

/** Trocea una lista de filas para no pasarse del límite de parámetros de Postgres. */
function inChunks<T>(rows: readonly T[]): T[][] {
  const chunks: T[][] = [];

  for (let i = 0; i < rows.length; i += WRITE_CHUNK_SIZE) {
    chunks.push(rows.slice(i, i + WRITE_CHUNK_SIZE));
  }

  return chunks;
}

/**
 * El instante que se anota en un evento.
 *
 * Casi siempre es el del recálculo: es lo único que se puede afirmar de un cambio
 * que el motor descubre al mirar, no al ocurrir. La excepción es la **siembra de un
 * logro con la ventana ya cerrada**: ahí el torneo lo dio por cumplido al cerrarse,
 * así que `at` es `window.to` y el feed no fecha en el recálculo un hito que se
 * cerró antes. Un `to` ilegible o futuro deja el pase como "ventana todavía abierta"
 * y se anota `now`, que es la dirección segura: nunca un instante que no ha llegado.
 */
export function objectiveProgressEventAt(
  draft: Pick<ObjectiveProgressEventDraft, "kind" | "objectiveId">,
  isSeed: boolean,
  window: ScoringWindow,
  now: Date,
): Date {
  if (!isSeed || draft.kind !== ObjectiveProgressKind.CUMPLIDO) {
    return now;
  }

  if (objectiveKind(draft.objectiveId) !== "achievement") {
    return now;
  }

  const { to } = windowBounds(window);

  if (to === null || !Number.isFinite(to.getTime()) || to.getTime() > now.getTime()) {
    return now;
  }

  return to;
}

/**
 * Deja `ObjectiveProgressState` y `ObjectiveProgressEvent` igual que el cómputo que
 * se acaba de hacer.
 *
 * `options` es el catálogo ya calculado por `computeObjectives()` y `players`, los
 * jugadores que lo alimentaron: de ahí sale el `Player.id` de cada `profileId`, que
 * es lo que la base necesita para apuntar la fila. Un `profileId` que no esté en el
 * mapa no tiene a quién apuntar y se queda fuera.
 *
 * Se lee el estado de la edición activa, se compara y se escribe **solo lo que
 * difiere**: una pasada sin novedades no ejecuta ninguna escritura. Ver el docblock
 * del módulo para el porqué de cada pieza.
 */
export async function reconcileObjectiveProgress(
  tx: ObjectiveProgressWriter,
  ruleset: ScoringRuleset,
  options: readonly ObjectiveOption[],
  players: readonly PlayerAggregate[],
): Promise<ObjectiveProgressReconcileResult> {
  const now = new Date();
  const { from } = windowBounds(ruleset.window);

  const previousRows = await tx.objectiveProgressState.findMany({
    where: { editionFrom: from },
    select: {
      playerId: true,
      objectiveId: true,
      value: true,
      completed: true,
      repetition: true,
    },
  });
  const previous = new Map(
    previousRows.map((row) => [objectiveProgressKey(row.playerId, row.objectiveId), row]),
  );

  const playerIdByProfileId = new Map(players.map((player) => [player.profileId, player.playerId]));
  const current = currentObjectiveProgress(options, playerIdByProfileId);
  const drafts = diffObjectiveProgress(previous, current, options);

  const events = drafts.map((draft) => ({
    objectiveId: draft.objectiveId,
    playerId: draft.playerId,
    kind: draft.kind,
    // La siembra es justo el estado que no existía: lo decide el mapa anterior, no
    // el tipo de evento, porque un `CUMPLIDO` también se emite al completarse algo
    // que ya iba por la mitad.
    at: objectiveProgressEventAt(
      draft,
      !previous.has(objectiveProgressKey(draft.playerId, draft.objectiveId)),
      ruleset.window,
      now,
    ),
    editionFrom: from,
    ownValue: draft.ownValue,
    otherValue: draft.otherValue,
    repetition: draft.repetition,
  }));

  for (const chunk of inChunks(events)) {
    await tx.objectiveProgressEvent.createMany({ data: chunk });
  }

  const plan = planObjectiveProgressStateWrites(previous, current);

  for (const chunk of inChunks(plan.create)) {
    await tx.objectiveProgressState.createMany({
      data: chunk.map((row) => ({ ...row, editionFrom: from, updatedAt: now })),
    });
  }

  // Fila a fila y no con un `updateMany` por trozo: la clave primaria es de tres
  // columnas y cada fila lleva valores distintos, así que no hay un `where` común que
  // agrupe nada. En régimen normal son unas pocas (solo lo que cambió en el pase).
  for (const row of plan.update) {
    await tx.objectiveProgressState.updateMany({
      where: { playerId: row.playerId, objectiveId: row.objectiveId, editionFrom: from },
      data: {
        value: row.value,
        completed: row.completed,
        repetition: row.repetition,
        updatedAt: now,
      },
    });
  }

  for (const chunk of inChunks(plan.remove)) {
    await tx.objectiveProgressState.deleteMany({
      where: {
        editionFrom: from,
        OR: chunk.map((row) => ({ playerId: row.playerId, objectiveId: row.objectiveId })),
      },
    });
  }

  return {
    eventsCreated: events.length,
    statesCreated: plan.create.length,
    statesUpdated: plan.update.length,
    statesDeleted: plan.remove.length,
  };
}
