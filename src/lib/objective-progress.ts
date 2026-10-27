import "server-only";

import { ObjectiveProgressKind } from "@/generated/prisma/enums";
import {
  POR_TIERRA_ID,
  VICTORIAS_ID,
  objectiveKind,
  objectiveRepeatable,
  type ObjectiveDefinition,
  type ObjectiveOption,
} from "@/lib/objectives";

/**
 * El **progreso de los objetivos**, como estado y como historia.
 *
 * El motor de `objectives.ts` dice qué objetivos cobra cada jugador *ahora*. Este
 * módulo traduce esa foto a dos cosas distintas que la fase de escritura guarda en
 * dos tablas distintas:
 *
 * - el **estado** (`ObjectiveProgressState`), que es la memoria de trabajo de la
 *   reconciliación: una fila por jugador, objetivo y edición, reescrita en cada
 *   pase. Solo sirve para saber **qué cambió** sin releer el feed entero;
 * - el **evento** (`ObjectiveProgressEvent`), que es historia y no se toca: "pasó
 *   de 7 a 8 victorias" no deja de ser cierto porque luego se revierta una partida.
 *   Un espejo no serviría, porque el overlay necesita la secuencia, no el estado
 *   final.
 *
 * ## Por qué el valor se recorta al máximo
 *
 * En los logros con tope (`imparable`, 14 días; `lider-<civ>`, 3 victorias;
 * `por-tierra-y-agua`, un mapa por cada uno del pool) el progreso no sigue subiendo
 * aunque se cumpla más veces: el premio ya está cobrado y una barra que pasara del
 * 100 % mentiría. En las **competiciones** no hay tope porque el valor es la
 * métrica del ranking (partidas, racha, victorias), que se compara entre jugadores y
 * recortarla haría que el segundo pareciera el primero. Y `victorias` tampoco lo
 * tiene: paga por unidad y no se completa nunca, así que su valor es la cifra real
 * de victorias.
 *
 * ## Por qué `PERDIDO` solo se emite en competiciones
 *
 * Una competición es volátil: se posee mientras se va primero y se pierde cuando
 * alguien adelanta, y quien la pierde merece que quede anotado. Un logro, en
 * cambio, **no se des-cumple** por debajo del umbral —el premio es fijo y ya se
 * repartió—; una bajada solo puede venir de corregir datos (revertir una partida,
 * un apagado del objetivo), y publicarla como pérdida contaría una historia que el
 * torneo no vivió. Por eso la v1.1.0 solo permite `PERDIDO` en objetivos volátiles.
 *
 * ## La siembra: `CUMPLIDO` o `PROGRESADO`
 *
 * La primera fila de un objetivo no reconstruye el pasado (el momento en que
 * empezó a progresar no consta en ninguna parte), pero sí distingue dos casos: si
 * el jugador ya lo tiene, se anota `CUMPLIDO`; si va por la mitad, `PROGRESADO`.
 * Así el overlay puede pintar el estado inicial sin inventarse un cumplimiento que
 * no ha ocurrido.
 *
 * ## Los valores son los del momento
 *
 * `ownValue` y `repetition` viajan en el evento tal y como estaban **cuando se
 * detectó el cambio**, no como están hoy: el contrato del overlay pide el progreso
 * histórico exacto, y el valor actual no sirve para reconstruir el de ayer.
 *
 * Todo lo de aquí es **puro**: recibe las opciones ya calculadas por
 * `computeObjectives()` y los mapas de estado, y no toca la base ni el reloj. La
 * lectura y la escritura viven en la fase de reconciliación, dentro de la
 * transacción de `recomputeScores()`.
 */

/** Una fila de `ObjectiveProgressState` en memoria. */
export type ObjectiveProgressStateRow = {
  objectiveId: string;
  playerId: string;
  value: number;
  completed: boolean;
  repetition: number | null;
};

/** Un evento a escribir en `ObjectiveProgressEvent`, sin `at` ni `editionFrom`. */
export type ObjectiveProgressEventDraft = {
  objectiveId: string;
  playerId: string;
  kind: ObjectiveProgressKind;
  ownValue: number;
  otherValue: number | null;
  repetition: number | null;
};

/**
 * Clave compuesta del mapa de estado: un estado por jugador y objetivo dentro de la
 * edición.
 *
 * El separador es `\u0000` porque no puede aparecer ni en un `Player.id` ni en un
 * id del catálogo, así que no hay dos pares distintos que produzcan la misma clave.
 * Es el mismo patrón que `eventKey()` de `objective-events.ts`, con el orden de
 * argumentos de esta tabla.
 */
export function objectiveProgressKey(playerId: string, objectiveId: string): string {
  return `${playerId}\u0000${objectiveId}`;
}

/**
 * El máximo de progreso de un objetivo del **catálogo**, para la ficha de
 * `/objetivos` (fase 4).
 *
 * Es la versión "de definición" de `optionMaxProgress()`: sirve antes de calcular,
 * cuando todavía no hay una `ObjectiveOption`. Los tres casos que no son
 * `definition.target`:
 *
 * - **competiciones**: `null`, porque no se progresa hacia ellas, se poseen;
 * - **`victorias`**: `null`, porque no tiene tope y no se completa nunca;
 * - **`por-tierra-y-agua`**: el tamaño del **pool activo**, que es su umbral real y
 *   solo se conoce en tiempo de cálculo (`null` si el pool está vacío, que es un
 *   objetivo imposible de cumplir y no un máximo de cero).
 */
export function objectiveMaxProgress(
  definition: ObjectiveDefinition,
  mapPoolSize: number,
): number | null {
  if (definition.kind === "competition") {
    return null;
  }

  if (definition.id === VICTORIAS_ID) {
    return null;
  }

  if (definition.id === POR_TIERRA_ID) {
    return mapPoolSize > 0 ? Math.trunc(mapPoolSize) : null;
  }

  return definition.target;
}

/**
 * El máximo de progreso de una opción ya calculada, para el motor.
 *
 * Se lee del `target` resuelto y no del catálogo porque el motor ya ha hecho el
 * trabajo de sustituir el umbral de `por-tierra-y-agua` por el tamaño del pool
 * (`targetFor()`). `victorias` sale `null` por lo mismo que en el catálogo: su
 * `target` es `null` y no hay tope que aplicar.
 */
export function optionMaxProgress(option: ObjectiveOption): number | null {
  if (option.kind === "competition") {
    return null;
  }

  return option.target?.value ?? null;
}

/**
 * Recorta un progreso a un entero no negativo dentro de `max`.
 *
 * El valor llega de una métrica contada (días, victorias, mapas), así que
 * `Math.trunc` no debería recortar nada real; está aquí para que un dato raro no
 * escriba una fila que no es un entero. `max` inválido —no finito o negativo— se
 * trata como 0: un tope roto no puede dejar pasar el valor entero.
 */
export function clampObjectiveProgress(value: number, max: number | null): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  const recortado = Math.max(0, Math.trunc(value));

  if (max === null) {
    return recortado;
  }

  if (!Number.isFinite(max) || max < 0) {
    return 0;
  }

  return Math.min(recortado, Math.trunc(max));
}

/**
 * El estado de progreso **actual** de cada jugador y objetivo, a partir del
 * catálogo recién calculado.
 *
 * Es la foto que se compara contra el estado guardado de la edición. Solo entran
 * los jugadores que estén en `ranking`: el ranking ya trae a todos los
 * contendientes (poseedor y beneficiarios incluidos), así que no hay estado que
 * inventar para nadie más. Un `profileId` que no esté en el mapa de jugadores se
 * salta: el llamador lo construye con los mismos jugadores que alimentan el
 * cómputo, y un desconocido no tiene `Player.id` al que apuntar la fila.
 *
 * Un jugador que no ha completado y no tiene progreso no genera fila: "nada" es la
 * ausencia de estado, y así la reconciliación no distingue entre un jugador que
 * nunca ha aparecido y uno que volvió a cero.
 */
export function currentObjectiveProgress(
  options: readonly ObjectiveOption[],
  playerIdByProfileId: ReadonlyMap<number, string>,
): Map<string, ObjectiveProgressStateRow> {
  const estados = new Map<string, ObjectiveProgressStateRow>();

  for (const option of options) {
    const max = optionMaxProgress(option);
    const repetible = objectiveRepeatable(option.id);

    const countByProfileId = new Map<number, number>();

    for (const beneficiario of option.beneficiaries) {
      countByProfileId.set(beneficiario.profileId, beneficiario.count);
    }

    for (const contender of option.ranking) {
      const playerId = playerIdByProfileId.get(contender.profileId);

      if (playerId === undefined) {
        continue;
      }

      const value = clampObjectiveProgress(contender.value, max);
      const completed =
        option.kind === "competition"
          ? option.holder?.profileId === contender.profileId
          : countByProfileId.has(contender.profileId);

      if (!completed && value <= 0) {
        continue;
      }

      let repetition: number | null = null;

      if (repetible) {
        const count = countByProfileId.get(contender.profileId);

        if (count !== undefined) {
          const recortado = clampObjectiveProgress(count, max);
          repetition = recortado > 0 ? recortado : null;
        }
      }

      estados.set(objectiveProgressKey(playerId, option.id), {
        objectiveId: option.id,
        playerId,
        value,
        completed,
        repetition,
      });
    }
  }

  return estados;
}

/**
 * La diferencia entre el estado guardado de la edición y el que acaba de calcular
 * el motor, como eventos a anexar.
 *
 * Se recorre la **unión** de las dos claves y no solo las actuales, porque el caso
 * que hay que anotar también existe al revés: un estado que ya no está (el jugador
 * bajó a cero, el objetivo se apagó) tiene que dejar su `PERDIDO` si era una
 * competición completada. Los desenlaces:
 *
 * - **estado nuevo**: `CUMPLIDO` si ya está completo, `PROGRESADO` si solo lleva
 *   avance parcial. Es la siembra, que no reconstruye el pasado;
 * - **pasa a completado**: `CUMPLIDO`;
 * - **deja de estar completado**: `PERDIDO` en competiciones (con el valor del
 *   nuevo poseedor en `otherValue`) y nada en logros, que no se des-cumplen;
 * - **mismo estado, más progreso**: `PROGRESADO`, si sube el valor o, cuando el
 *   valor está recortado por el tope, si sube la repetición (`victorias` sin tope
 *   no llega a este caso, pero `imparable` con el valor a 14 sí);
 * - **mismo estado, menos progreso o igual**: nada. Una bajada no se publica: el
 *   feed cuenta avances y cumplimientos, y la siguiente subida vuelve a anotarse.
 *
 * `at` y `editionFrom` no viajan en los borradores a propósito: son iguales para
 * todos los eventos de un pase y los pone la escritura, que es la que conoce el
 * reloj y la ventana activa.
 *
 * El resultado se ordena por jugador, objetivo y tipo para que sea determinista: el
 * orden no decide nada de lo que se lee (el feed va por `at`), pero así la escritura
 * y los tests no dependen del orden en que el mapa devuelva las claves.
 */
export function diffObjectiveProgress(
  previous: ReadonlyMap<string, ObjectiveProgressStateRow>,
  current: ReadonlyMap<string, ObjectiveProgressStateRow>,
  options: readonly ObjectiveOption[],
): ObjectiveProgressEventDraft[] {
  const optionsById = new Map(options.map((option) => [option.id, option]));
  const holderValue = (objectiveId: string): number | null =>
    optionsById.get(objectiveId)?.holder?.value ?? null;

  const drafts: ObjectiveProgressEventDraft[] = [];
  const claves = new Set([...previous.keys(), ...current.keys()]);

  for (const clave of claves) {
    const antes = previous.get(clave);
    const ahora = current.get(clave);

    if (ahora === undefined) {
      if (
        antes !== undefined &&
        antes.completed &&
        objectiveKind(antes.objectiveId) === "competition"
      ) {
        drafts.push({
          objectiveId: antes.objectiveId,
          playerId: antes.playerId,
          kind: ObjectiveProgressKind.PERDIDO,
          ownValue: 0,
          otherValue: holderValue(antes.objectiveId),
          repetition: null,
        });
      }

      continue;
    }

    if (antes === undefined) {
      if (ahora.completed) {
        drafts.push({
          objectiveId: ahora.objectiveId,
          playerId: ahora.playerId,
          kind: ObjectiveProgressKind.CUMPLIDO,
          ownValue: ahora.value,
          otherValue: null,
          repetition: ahora.repetition,
        });
      } else if (ahora.value > 0) {
        drafts.push({
          objectiveId: ahora.objectiveId,
          playerId: ahora.playerId,
          kind: ObjectiveProgressKind.PROGRESADO,
          ownValue: ahora.value,
          otherValue: null,
          repetition: ahora.repetition,
        });
      }

      continue;
    }

    if (!antes.completed && ahora.completed) {
      drafts.push({
        objectiveId: ahora.objectiveId,
        playerId: ahora.playerId,
        kind: ObjectiveProgressKind.CUMPLIDO,
        ownValue: ahora.value,
        otherValue: null,
        repetition: ahora.repetition,
      });

      continue;
    }

    if (antes.completed && !ahora.completed) {
      if (objectiveKind(ahora.objectiveId) === "competition") {
        drafts.push({
          objectiveId: ahora.objectiveId,
          playerId: ahora.playerId,
          kind: ObjectiveProgressKind.PERDIDO,
          ownValue: ahora.value,
          otherValue: holderValue(ahora.objectiveId),
          repetition: null,
        });
      }

      continue;
    }

    const subeValor = ahora.value > antes.value;
    const subeRepeticion =
      antes.repetition !== null &&
      ahora.repetition !== null &&
      ahora.repetition > antes.repetition;

    if (subeValor || subeRepeticion) {
      drafts.push({
        objectiveId: ahora.objectiveId,
        playerId: ahora.playerId,
        kind: ObjectiveProgressKind.PROGRESADO,
        ownValue: ahora.value,
        otherValue: null,
        repetition: ahora.repetition,
      });
    }
  }

  return drafts.sort(
    (a, b) =>
      compararTexto(a.playerId, b.playerId) ||
      compararTexto(a.objectiveId, b.objectiveId) ||
      compararTexto(a.kind, b.kind),
  );
}

/** Qué hay que hacer con `ObjectiveProgressState` para pasar del guardado al actual. */
export type ObjectiveProgressStatePlan = {
  /** Filas que no estaban: la primera vez que se ve ese jugador en ese objetivo. */
  create: ObjectiveProgressStateRow[];
  /** Filas que ya estaban pero han cambiado; los valores son los **actuales**. */
  update: ObjectiveProgressStateRow[];
  /** Filas que ya no corresponden; los valores son los **anteriores**. */
  remove: ObjectiveProgressStateRow[];
};

/**
 * La diferencia mínima que hay que escribir en `ObjectiveProgressState`.
 *
 * El estado es la **memoria de trabajo** de la reconciliación, no el dato publicado:
 * el feed que lee el overlay es `ObjectiveProgressEvent`. Por eso aquí no se decide
 * nada del torneo, solo qué filas hay que dejar como están y cuáles no, de modo que
 * una pasada sin cambios devuelve los tres arrays vacíos y no ejecuta ni una
 * escritura (el worker corre cada 10 minutos).
 *
 * Un cambio de `value`, de `completed` o de `repetition` obliga a reescribir la fila:
 * los tres son el estado que la siguiente pasada compara, y dejar uno atrás haría
 * que el mismo cambio se anotara dos veces en el feed. Los arrays salen ordenados por
 * jugador y objetivo para que el plan (y los tests) no dependan del orden en que el
 * mapa devuelva las claves.
 */
export function planObjectiveProgressStateWrites(
  previous: ReadonlyMap<string, ObjectiveProgressStateRow>,
  current: ReadonlyMap<string, ObjectiveProgressStateRow>,
): ObjectiveProgressStatePlan {
  const create: ObjectiveProgressStateRow[] = [];
  const update: ObjectiveProgressStateRow[] = [];
  const remove: ObjectiveProgressStateRow[] = [];

  for (const [clave, ahora] of current) {
    const antes = previous.get(clave);

    if (antes === undefined) {
      create.push(ahora);
      continue;
    }

    if (
      antes.value !== ahora.value ||
      antes.completed !== ahora.completed ||
      antes.repetition !== ahora.repetition
    ) {
      update.push(ahora);
    }
  }

  for (const [clave, antes] of previous) {
    if (!current.has(clave)) {
      remove.push(antes);
    }
  }

  const porJugadorYObjetivo = (
    a: ObjectiveProgressStateRow,
    b: ObjectiveProgressStateRow,
  ): number =>
    compararTexto(a.playerId, b.playerId) || compararTexto(a.objectiveId, b.objectiveId);

  return {
    create: create.sort(porJugadorYObjetivo),
    update: update.sort(porJugadorYObjetivo),
    remove: remove.sort(porJugadorYObjetivo),
  };
}

/** Comparación lexicográfica de dos cadenas, sin depender del locale. */
function compararTexto(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
