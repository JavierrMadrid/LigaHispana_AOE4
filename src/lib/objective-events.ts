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
 * revés: la fila describe **quién cobra el objetivo ahora mismo**, y en eso no puede
 * haber pasado. El caso que lo obliga: si el panel revierte la partida que cerró una
 * competición, o la que completó un logro, los puntos se mueven, y un evento que
 * nombrara al beneficiario antiguo estaría mintiendo en la pantalla que la
 * organización usa para revisar el torneo. Por eso la reconciliación **borra** lo
 * que deja de cumplirse, y por eso `ObjectiveEvent` es un espejo y no un historial
 * de repeticiones.
 *
 * ## Por qué el reparto entre "ahora" y "al final" es el del documento de objetivos
 *
 * El catálogo nuevo **no tiene carreras**: tanto las competiciones como los logros
 * se resuelven en caliente y su poseedor o sus beneficiarios pueden cambiar en
 * cada recálculo (una competición porque cambia el líder, un logro porque se
 * revierte la partida que lo cerró). Por eso **todos** los objetivos se registran
 * igual: solo cuando el torneo ha terminado —ventana con `to` informado y ya
 * pasado—, con `achievedAt` = ese `to`. Con la ventana abierta no se registra
 * nada todavía, que es lo que significa "solo se añaden una vez termina el
 * torneo".
 *
 * Un logro tiene **varios beneficiarios**, así que hay un evento por objetivo y
 * jugador (`@@unique([objectiveId, playerId])`), no uno por objetivo.
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

/** Lo que hay que escribir, indexado por (objetivo, jugador). */
type ExpectedEvent = { objectiveId: string; playerId: string; achievedAt: Date };

/** Clave compuesta del mapa: un evento por objetivo y jugador. */
function eventKey(objectiveId: string, playerId: string): string {
  return `${objectiveId}\u0000${playerId}`;
}

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
 * El estado esperado: un evento por objetivo cobrado y jugador, con el instante en
 * que se cumple.
 *
 * Como ningún objetivo del catálogo es una carrera, todos se registran con el fin
 * del torneo: mientras la ventana esté abierta el mapa se queda vacío y la
 * reconciliación de abajo borra lo que hubiera.
 */
function eventosEsperados(
  ruleset: ScoringRuleset,
  awarded: readonly ObjectiveAwarded[],
): Map<string, ExpectedEvent> {
  const fin = finDelTorneo(ruleset);
  const esperados = new Map<string, ExpectedEvent>();

  if (fin === null) {
    return esperados;
  }

  for (const objetivo of awarded) {
    esperados.set(eventKey(objetivo.id, objetivo.playerId), {
      objectiveId: objetivo.id,
      playerId: objetivo.playerId,
      achievedAt: fin,
    });
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
 * El coste de la comparación es una lectura pequeña (como mucho un evento por
 * objetivo y jugador) y el ahorro es no escribir nada en una pasada sin novedades
 * (el worker corre 288 veces al día): el `upsert` tal cual reescribiría las filas
 * en cada pasada y llenaría el *WAL* para no cambiar nada. Se lee, se compara y
 * solo se escribe lo que de verdad difiere:
 *
 * - **altas** (`createMany`): el objetivo lo cobra alguien y no había evento.
 * - **cambios** (`update`): hay evento, pero de otro instante.
 * - **bajas** (`deleteMany`): el objetivo ya no lo cobra quien lo cobraba, o su
 *   ventana se ha reabierto (`to: null`). Es el caso de una partida revertida.
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

  const porClave = new Map(
    actuales.map((fila) => [eventKey(fila.objectiveId, fila.playerId), fila]),
  );
  const altas: ExpectedEvent[] = [];
  const cambios: { objectiveId: string; playerId: string; achievedAt: Date }[] = [];

  for (const [clave, esperado] of esperados) {
    const actual = porClave.get(clave);

    if (actual === undefined) {
      altas.push(esperado);
      continue;
    }

    if (actual.achievedAt.getTime() !== esperado.achievedAt.getTime()) {
      cambios.push({
        objectiveId: esperado.objectiveId,
        playerId: esperado.playerId,
        achievedAt: esperado.achievedAt,
      });
    }
  }

  const bajas = actuales
    .filter((fila) => !esperados.has(eventKey(fila.objectiveId, fila.playerId)))
    .map((fila) => ({ objectiveId: fila.objectiveId, playerId: fila.playerId }));

  if (altas.length > 0) {
    await client.objectiveEvent.createMany({ data: altas });
  }

  for (const cambio of cambios) {
    await client.objectiveEvent.update({
      where: {
        objectiveId_playerId: {
          objectiveId: cambio.objectiveId,
          playerId: cambio.playerId,
        },
      },
      data: { achievedAt: cambio.achievedAt },
    });
  }

  if (bajas.length > 0) {
    await client.objectiveEvent.deleteMany({ where: { OR: bajas } });
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
  // por qué un objetivo lo cobra quien lo cobra.
  if (resultado.created > 0 || resultado.updated > 0 || resultado.removed > 0) {
    console.info(
      `[objective-events] ${resultado.created} nuevos, ${resultado.updated} actualizados, ` +
        `${resultado.removed} borrados; ${resultado.total} objetivos con evento.`,
    );
  }

  return resultado;
}