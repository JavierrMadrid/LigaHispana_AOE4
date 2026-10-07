import "server-only";

import { Prisma } from "@/generated/prisma/client";
import {
  OBJECTIVE_DEFINITIONS,
  type ObjectiveAwarded,
  type ObjectiveDefinition,
  type ObjectiveGroup,
  type ObjectiveMetric,
} from "@/lib/objectives";
import { readInstant } from "@/lib/ranked-match";
import type { ScoringRuleset } from "@/lib/scoring";

/**
 * Registro de hitos: cuándo se cumplió cada objetivo del torneo.
 *
 * Son dos cosas que live en un solo sitio porque vienen del mismo cálculo:
 *
 * - **Escribir**: `reconcileObjectiveEvents()`, que escribe la tabla
 *   `ObjectiveEvent` desde el mismo `computeObjectives()` que reparte los puntos.
 * - **Leer**: `resolveObjective()`, que resuelve etiqueta y puntos de un id de
 *   objetivo contra el catálogo y el ruleset activo, que es lo que el historial del
 *   panel publica para que la interfaz no tenga que mirar el catálogo.
 *
 * ## Por qué esto es un espejo y no un log
 *
 * `AdminAction` y `Alert` son registros **append-only**: describen que alguien hizo
 * algo, y aunque después se deshaga, el rastro sigue siendo cierto. Aquí es al
 * revés: la fila describe **quién posee el objetivo ahora mismo**, y en eso no puede
 * haber pasado. El caso que lo obliga: si el panel revierte la partida que cerró una
 * carrera de `masterizar-*`, los puntos se mueven al siguiente jugador, y un evento
 * que nombrara al poseedor antiguo estaría mintiendo en la pantalla que la
 * organización usa para revisar el torneo. Por eso la reconciliación **borra** lo
 * que deja de cumplirse, y por eso `ObjectiveEvent` tiene un único evento por
 * objetivo en vez de un historial de repeticiones.
 *
 * ## Por qué el reparto entre "ahora" y "al final" es el del documento de objetivos
 *
 * `docs/OBJETIVOS.md` dice que todos los objetivos se resuelven en caliente
 * **excepto** el grupo `civilizacion`, que son carreras y se resuelven al
 * completarse. La organización pidió que el historial dijera cuándo se cumplió cada
 * uno, y la traducción literal de esa división es:
 *
 * - **Carreras** (`raceAt` informado): se registra en cuanto hay poseedor, con
 *   `achievedAt` = el instante de la hazaña, que el motor ya conoce (es el mismo
 *   `finishedAt` que decide el tercer desempate de `docs/OBJETIVOS.md`).
 * - **Los 14 en caliente**: como su poseedor cambia en cada recálculo, no se registra
 *   nada hasta que el torneo ha terminado —ventana con `to` informado y ya
 *   pasado—, y entonces con `achievedAt` = ese `to`. Con la ventana abierta no se
 *   registra nunca todavía, que es exactamente lo que significa "solo se añaden una
 *   vez termina el torneo".
 */

/** Cliente con la única tabla que necesita esta reconciliación (`db` o una `tx`). */
export type ObjectiveEventWriter = Pick<Prisma.TransactionClient, "objectiveEvent">;

/** Un objetivo del catálogo, ya resuelto contra el ruleset activo. */
export type ResolvedObjective = {
  /** Id estable del objetivo; es la clave de `ObjectiveEvent`. */
  id: string;
  /** Rótulo público del catálogo (`ObjectiveDefinition.label`). */
  label: string;
  /** Grupo del catálogo, para elegir el icono y la sección del resumen. */
  group: ObjectiveGroup;
  /**
   * Métrica que lo decide (`partidas`, `winrate`, `racha`, `victorias`). Viaja con
   * `id` y `group` porque `ObjectiveIcon` los necesita los tres para elegir el
   * glifo, y quien pinta no puede mirar el catálogo.
   */
  metric: ObjectiveMetric;
  /** Puntos con el ruleset activo por encima del valor por defecto del catálogo. */
  points: number;
};

/**
 * Catálogo indexado por id.
 *
 * Es un `Map` a nivel de módulo (y no uno que se construye en cada llamada) porque
 * el catálogo es una constante del código: no depende de `Setting` ni de la base de
 * datos. Lo que **sí** depende del ruleset son los puntos, y eso se resuelve en cada
 * llamada, en `resolveObjective`.
 */
const DEFINITIONS: ReadonlyMap<string, ObjectiveDefinition> = new Map(
  OBJECTIVE_DEFINITIONS.map((definition) => [definition.id, definition]),
);

/**
 * Etiqueta, grupo y puntos de un objetivo, resueltos **al leer**.
 *
 * Es el mismo criterio que `objectiveLookup()` en `src/lib/public.ts`:
 * `ruleset.objectives[id] ?? definition.points`. La tabla `ObjectiveEvent` no guarda
 * ni la etiqueta ni los puntos a propósito, y esto es el sitio único donde se
 * resuelven, para que el historial y la clasificación no puedan dar dos cifras
 * distintas del mismo objetivo.
 *
 * `null` cuando el id no está en el catálogo: solo puede pasar con una fila escrita
 * a mano (el motor borra las que no corresponden), y quien llame lo trata como
 * "esto no se puede publicar" en vez de inventar una etiqueta.
 */
export function resolveObjective(id: string, ruleset: ScoringRuleset): ResolvedObjective | null {
  const definition = DEFINITIONS.get(id);

  if (definition === undefined) {
    return null;
  }

  return {
    id: definition.id,
    label: definition.label,
    group: definition.group,
    metric: definition.metric,
    points: ruleset.objectives[definition.id] ?? definition.points,
  };
}

/** Lo que hay que escribir, por id de objetivo. */
type ExpectedEvent = { playerId: string; achievedAt: Date };

/**
 * El fin del torneo, o `null` si todavía no ha terminado.
 *
 * Tres casos se quedan en `null` y por tanto en "no se registra el objetivo todavía":
 * la ventana está abierta (`to: null`), el `to` guardado no se puede leer, o el `to`
 * es un instante que todavía no ha llegado. Los tres son el mismo hecho desde el
 * punto de vista de la organización: **el torneo no ha terminado**.
 */
function finDelTorneo(ruleset: ScoringRuleset): Date | null {
  const to = ruleset.window.to === null ? null : readInstant(ruleset.window.to);

  return to !== null && to.getTime() <= Date.now() ? to : null;
}

/**
 * El estado esperado: un evento por objetivo con poseedor, con el instante en que se
 * cumplió.
 *
 * Un objetivo **sin** poseedor no aparece, y como el mapa no lo contiene, la
 * reconciliación de abajo lo borra de la tabla si estaba. Es la parte de la regla que
 * se suele olvidar: si se revierte la partida que cerró una carrera, la carrera se
 * reabre, los puntos se mueven y el evento del poseedor anterior tiene que irse con
 * ellos.
 */
function eventosEsperados(
  ruleset: ScoringRuleset,
  awarded: readonly ObjectiveAwarded[],
): Map<string, ExpectedEvent> {
  const fin = finDelTorneo(ruleset);
  const esperados = new Map<string, ExpectedEvent>();

  for (const objetivo of awarded) {
    if (objetivo.raceAt !== null) {
      // Carrera (`civilizacion`): se cumple en cuanto alguien la cierra, y el
      // motor ya sabe en qué instante fue.
      esperados.set(objetivo.id, {
        playerId: objetivo.playerId,
        achievedAt: new Date(objetivo.raceAt),
      });
      continue;
    }

    // Objetivo "en caliente": sin fin de torneo no hay poseedor que registrar.
    if (fin !== null) {
      esperados.set(objetivo.id, { playerId: objetivo.playerId, achievedAt: fin });
    }
  }

  return esperados;
}

/** Qué ha hecho una reconciliación, por si hay que comprobarla o contarla. */
export type ObjectiveEventsResult = {
  created: number;
  updated: number;
  removed: number;
  /** Eventos que hay en la tabla después de reconciliar (los esperados). */
  total: number;
};

/**
 * Deja `ObjectiveEvent` igual que el cómputo de objetivos que se acaba de hacer.
 *
 * Es idempotente y se ejecuta **dentro de la transacción de `recomputeScores()`**,
 * con el cerrojo de la clasificación ya tomado: o el registro y la clasificación
 * describen lo mismo, o no cambia ninguno de los dos. Por eso todos los caminos que
 * recalculan lo dejan al día —el worker, `npm run score`, revertir o restaurar los
 * puntos de una partida, aprobar o dar de alta a un jugador— sin tener que acordarse
 * de llamarlo.
 *
 * ## Por qué lee antes de escribir
 *
 * El coste de la comparación es una lectura de ≤38 filas y el ahorro es no escribir
 * nada en una pasada sin novedades (el worker corre 288 veces al día): el `upsert`
 * tal cual reescribiría las 38 filas en cada pasada y llenaría el *WAL* para no
 * cambiar nada. Se lee, se compara y solo se escribe lo que de verdad difiere:
 *
 * - **altas** (`createMany`): el objetivo tiene poseedor y no había evento.
 * - **cambios** (`update`): hay evento, pero de otro poseedor o de otro instante.
 * - **bajas** (`deleteMany`): el objetivo ya no se cumple con los datos de ahora, o
 *   su ventana se ha reabierto (`to: null`). Es el caso de una partida revertida.
 *
 * Con las filas ya contadas, el caso "nada esperado y nada que borrar" no ejecuta
 * ninguna escritura: es lo que pasa en casi todas las pasadas.
 */
export async function reconcileObjectiveEvents(
  client: ObjectiveEventWriter,
  ruleset: ScoringRuleset,
  awarded: readonly ObjectiveAwarded[],
): Promise<ObjectiveEventsResult> {
  const esperados = eventosEsperados(ruleset, awarded);
  const actuales = await client.objectiveEvent.findMany({
    select: { objectiveId: true, playerId: true, achievedAt: true },
  });

  const porId = new Map(actuales.map((fila) => [fila.objectiveId, fila]));
  const altas: { objectiveId: string; playerId: string; achievedAt: Date }[] = [];
  const cambios: { objectiveId: string; playerId: string; achievedAt: Date }[] = [];

  for (const [objectiveId, esperado] of esperados) {
    const actual = porId.get(objectiveId);

    if (actual === undefined) {
      altas.push({ objectiveId, ...esperado });
      continue;
    }

    if (
      actual.playerId !== esperado.playerId ||
      actual.achievedAt.getTime() !== esperado.achievedAt.getTime()
    ) {
      cambios.push({ objectiveId, ...esperado });
    }
  }

  const bajas = actuales
    .filter((fila) => !esperados.has(fila.objectiveId))
    .map((fila) => fila.objectiveId);

  if (altas.length > 0) {
    await client.objectiveEvent.createMany({ data: altas });
  }

  for (const cambio of cambios) {
    await client.objectiveEvent.update({
      where: { objectiveId: cambio.objectiveId },
      data: { playerId: cambio.playerId, achievedAt: cambio.achievedAt },
    });
  }

  if (bajas.length > 0) {
    await client.objectiveEvent.deleteMany({ where: { objectiveId: { in: bajas } } });
  }

  const resultado: ObjectiveEventsResult = {
    created: altas.length,
    updated: cambios.length,
    removed: bajas.length,
    total: esperados.size,
  };

  // Solo se escribe cuando algo ha cambiado de verdad, que en un torneo son unas
  // cuantas veces en toda su vida. Merece la pena que quede en el log: es lo primero
  // que se mira cuando alguien pregunta por qué un hito no sale en el historial o
  // por qué un objetivo tiene el poseedor que tiene.
  if (resultado.created > 0 || resultado.updated > 0 || resultado.removed > 0) {
    console.info(
      `[objective-events] ${resultado.created} nuevos, ${resultado.updated} actualizados, ` +
        `${resultado.removed} borrados; ${resultado.total} objetivos con evento.`,
    );
  }

  return resultado;
}