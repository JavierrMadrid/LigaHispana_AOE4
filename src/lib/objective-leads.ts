import "server-only";

import { Prisma } from "@/generated/prisma/client";
import { ObjectiveLeadKind } from "@/generated/prisma/enums";
import { objectiveKind, type ObjectiveAwarded } from "@/lib/objectives";
import { windowBounds } from "@/lib/ranked-match";
import type { ScoringRuleset } from "@/lib/scoring";

/**
 * El registro de **quién posee cada competición**, en vivo y *append-only*.
 *
 * Las 29 competiciones del catálogo (`loco-por-ganar`, `bienhadado`, los cuatro
 * `rey-*` y los 23 `masterizando-<civ>`) no se "cumplen": se poseen. Hoy cambian de
 * dueño tantas veces como cambie el ranking, y hasta ahora eso no dejaba rastro
 * hasta el cierre del torneo, donde el espejo de objetivos (`ObjectiveEvent`,
 * `src/lib/objective-events.ts`) escribía un único "cumplió" con fecha de fin de
 * ventana. Ese texto miente en los dos sentidos: una competición que cambió de
 * manos tres veces se leía como un hito único, y quien la perdió no aparecía por
 * ninguna parte.
 *
 * Aquí cada cambio deja **dos filas** con el mismo instante —una `LOST` para el
 * que la suelta y una `GAINED` para el que la agarra—, y el historial puede contar
 * "ahora lidera" y "ya no lidera" en cualquier orden y tantas veces como pase. Los
 * puntos que viajan en esas filas son **informativos**: no se suman a nada, y el
 * reparto permanente/temporal de `PlayerScore` no cambia por esto.
 *
 * ## Qué hay puro en este módulo y qué no
 *
 * Lo que decide el registro —deducir el poseedor del estado anotado
 * (`leadHolders()`) y compararlo con el que acaba de calcular el motor
 * (`leadChanges()`, con `currentLeadHolders()` para leer `awarded`)— es **puro** y
 * se prueba sin base de datos (`tests/unit/lib/objective-leads.test.ts`). Lo único
 * que toca la base es `reconcileObjectiveLeadEvents()`, que lee el registro de la
 * edición y escribe la diferencia.
 *
 * ## Por qué el orden de los dos eventos de un cambio no lo decide el orden de escritura
 *
 * Las dos filas de un cambio comparten `at` (el instante del recálculo), así que el
 * estado que "queda" al leerlo lo decide el desempate por `kind`, y ese desempate
 * está fijado en dos sitios que tienen que decir lo mismo:
 *
 * - el **orden de declaración** de `ObjectiveLeadKind` en el schema (`LOST` antes
 *   que `GAINED`), que es el que aplica Postgres al ordenar por esa columna;
 * - `OBJECTIVE_LEAD_RANK`, que es el que aplica `leadHolders()` al deducir el
 *   poseedor y el que usan los dos feeds al ordenar las filas del mismo instante.
 *
 * La regla es la misma en los tres sitios: **la ganancia es el estado que queda**,
 * así que a igual instante va delante de la pérdida en el feed (que va de lo más
 * reciente a lo más antiguo) y es la que decide de quién es la competición.
 */

/** Cliente con la única tabla que necesita esta reconciliación (`db` o una `tx`). */
export type ObjectiveLeadWriter = Pick<Prisma.TransactionClient, "objectiveLeadEvent">;

/**
 * Rango de cada evento para el desempate a igual instante: la ganancia gana.
 *
 * Es la versión en memoria del orden de declaración del enum (ver el docblock del
 * módulo): un número mayor significa "va antes en descendente" y "es el estado que
 * queda" al deducir el poseedor.
 */
export const OBJECTIVE_LEAD_RANK: Record<ObjectiveLeadKind, number> = {
  [ObjectiveLeadKind.GAINED]: 1,
  [ObjectiveLeadKind.LOST]: 0,
};

/**
 * Una fila del registro, en lo mínimo que necesitan las funciones puras de aquí.
 *
 * Es la forma que devuelve la lectura de la reconciliación y la que usan los tests:
 * ni el `id` ni `editionFrom` hacen falta para deducir un poseedor, porque la
 * lectura ya viene filtrada por edición.
 */
export type LeadEventRow = {
  objectiveId: string;
  playerId: string;
  kind: ObjectiveLeadKind;
  at: Date;
};

/**
 * El orden del registro dentro de una competición: el instante y, a igual instante,
 * la **ganancia después de la pérdida**.
 *
 * Es lo que hace falta para deducir de quién es una competición a partir de sus
 * filas: las dos de un cambio de poseedor comparten instante, y el estado que queda
 * es el del jugador que pasa a poseerla. El desempate final por `playerId` no
 * describe ningún caso real (dos ganancias del mismo instante no pueden salir de una
 * sola reconciliación) y está solo para que el orden sea **total**: el resultado no
 * puede depender del orden en que la base devuelva las filas.
 */
function compareLeadEvents(a: LeadEventRow, b: LeadEventRow): number {
  const porInstante = a.at.getTime() - b.at.getTime();

  if (porInstante !== 0) {
    return porInstante;
  }

  const porSigno = OBJECTIVE_LEAD_RANK[a.kind] - OBJECTIVE_LEAD_RANK[b.kind];

  if (porSigno !== 0) {
    return porSigno;
  }

  return a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0;
}

/**
 * El poseedor que deja cada competición según las filas del registro: el `Player.id`
 * del último estado anotado, o `null` si el último estado anotado es una pérdida.
 *
 * Una competición **sin filas** no aparece en el mapa, y eso es distinto de "no la
 * posee nadie": el mapa es el estado *anotado*, y `leadChanges()` trata la ausencia
 * como "no hay nada anotado" al decidir qué hay que anotar. Los dos casos acaban en
 * la misma fila `GAINED` si ahora hay poseedor, que es la siembra.
 *
 * Es puro y no depende del orden de entrada: el "último" estado lo elige
 * `compareLeadEvents()`.
 */
export function leadHolders(events: readonly LeadEventRow[]): Map<string, string | null> {
  const ultima = new Map<string, LeadEventRow>();

  for (const evento of events) {
    const previa = ultima.get(evento.objectiveId);

    if (previa === undefined || compareLeadEvents(evento, previa) > 0) {
      ultima.set(evento.objectiveId, evento);
    }
  }

  const holders = new Map<string, string | null>();

  for (const [objectiveId, evento] of ultima) {
    holders.set(
      objectiveId,
      evento.kind === ObjectiveLeadKind.GAINED ? evento.playerId : null,
    );
  }

  return holders;
}

/**
 * El poseedor actual de cada competición, según el cómputo que se acaba de hacer.
 *
 * `awarded` trae todo el catálogo cobrado (un beneficiario por logro y jugador, el
 * poseedor por competición), así que aquí se filtra lo que le toca a este registro
 * por el **catálogo**: un id que no sea una competición no entra. Un objetivo
 * apagado no llega a `awarded`, y por eso su poseedor desaparece del mapa —que es lo
 * que hace que la reconciliación anote la pérdida.
 */
export function currentLeadHolders(awarded: readonly ObjectiveAwarded[]): Map<string, string> {
  const holders = new Map<string, string>();

  for (const objetivo of awarded) {
    if (objectiveKind(objetivo.id) === "competition") {
      holders.set(objetivo.id, objetivo.playerId);
    }
  }

  return holders;
}

/** Una fila que hay que anexar al registro. */
export type LeadChange = {
  objectiveId: string;
  kind: ObjectiveLeadKind;
  playerId: string;
};

/**
 * La diferencia entre lo anotado y lo que acaba de calcular el motor.
 *
 * `anteriores` es el estado del registro de la edición (el que devuelve
 * `leadHolders()`) y `actuales`, el del cómputo (`currentLeadHolders()`). Se recorre
 * la **unión** de las dos claves, y no solo las actuales, porque el caso que hay que
 * anotar también existe al revés: un objetivo que ya no tiene poseedor —apagado,
 * borrado del catálogo o con el ranking corregido— tiene que dejar su `LOST` aunque
 * ya no aparezca en el cómputo.
 *
 * Los tres desenlaces posibles de una competición:
 *
 * - **mismo poseedor** (incluido "ninguno en los dos lados"): no hay nada que
 *   anotar, y esto es lo que pasa en casi todas las pasadas del worker;
 * - **cambio de poseedor**: `LOST` para el anterior y `GAINED` para el nuevo;
 * - **solo uno de los dos lados**: `LOST` si el que había desaparece, `GAINED` si
 *   aparece el primero (la siembra, sin reconstruir el pasado).
 *
 * La **pérdida va antes que la ganancia** en la lista que se escribe. Es
 * determinista (por `objectiveId`) y el orden no decide nada de lo que se lee —las
 * dos filas comparten instante y quien manda es `kind`, ver el docblock del
 * módulo—, pero conviene que la escritura no dependa del orden del mapa.
 */
export function leadChanges(
  anteriores: ReadonlyMap<string, string | null>,
  actuales: ReadonlyMap<string, string>,
): LeadChange[] {
  const objetivos = [...new Set([...anteriores.keys(), ...actuales.keys()])].sort();
  const cambios: LeadChange[] = [];

  for (const objectiveId of objetivos) {
    const antes = anteriores.get(objectiveId) ?? null;
    const ahora = actuales.get(objectiveId) ?? null;

    if (antes === ahora) {
      continue;
    }

    if (antes !== null) {
      cambios.push({ objectiveId, kind: ObjectiveLeadKind.LOST, playerId: antes });
    }

    if (ahora !== null) {
      cambios.push({ objectiveId, kind: ObjectiveLeadKind.GAINED, playerId: ahora });
    }
  }

  return cambios;
}

/** Qué ha hecho una reconciliación, por si hay que comprobarla o contarla. */
export type ObjectiveLeadEventsResult = {
  /** Filas anexadas en esta pasada (0 en la inmensa mayoría). */
  created: number;
  /** Filas que tiene el registro de esta edición después de reconciliar. */
  total: number;
};

/**
 * Anexa al registro los cambios de poseedor de competiciones que acaba de detectar
 * el recálculo.
 *
 * Es idempotente y se ejecuta **dentro de la transacción de `recomputeScores()`**,
 * junto al espejo de logros y con el mismo cerrojo: o el registro y la clasificación
 * describen lo mismo, o no cambia ninguno de los dos. Por eso todos los caminos que
 * recalculan —el worker, `npm run score`, revertir o restaurar los puntos de una
 * partida, aprobar o dar de alta a un jugador— lo dejan al día sin tener que
 * acordarse de llamarlo.
 *
 * ## Por qué lee antes de escribir
 *
 * El coste es una lectura del registro de la edición (unas cuantas filas: una por
 * cambio de poseedor, y los cambios son raros) y el ahorro es no escribir nada en
 * una pasada sin novedades, que es el caso de las 288 pasadas diarias del worker.
 * Cuando no hay diferencia, la función no ejecuta **ninguna** escritura.
 *
 * ## La cohorte es la ventana activa
 *
 * La lectura y la escritura se sellan con `window.from` de la ventana **activa**: el
 * estado que se compara y el registro que se anexa son los de la edición en curso.
 * Una edición nueva se lee vacía y siembra su primer estado, sin arrastrar los
 * liderazgos de la anterior, y una corrección posterior al cierre de la edición en
 * curso se anexa aquí mismo porque sigue siendo de su cohorte.
 */
export async function reconcileObjectiveLeadEvents(
  client: ObjectiveLeadWriter,
  ruleset: ScoringRuleset,
  awarded: readonly ObjectiveAwarded[],
): Promise<ObjectiveLeadEventsResult> {
  const editionFrom = windowBounds(ruleset.window).from;

  const registradas = await client.objectiveLeadEvent.findMany({
    where: { editionFrom },
    select: { objectiveId: true, playerId: true, kind: true, at: true },
  });

  const cambios = leadChanges(leadHolders(registradas), currentLeadHolders(awarded));

  if (cambios.length > 0) {
    // Un solo instante para las dos filas de un mismo cambio: `at` es el del
    // recálculo, y la interfaz cuenta "ahora lidera" y "ya no lidera" como el mismo
    // momento.
    const at = new Date();

    await client.objectiveLeadEvent.createMany({
      data: cambios.map((cambio) => ({ ...cambio, at, editionFrom })),
    });

    // Solo se escribe cuando alguien cambia de manos una competición, que es de las
    // cosas que se miran cuando alguien pregunta por qué el historial cuenta que
    // perdió un objetivo.
    console.info(
      `[objective-leads] ${cambios.length} eventos nuevos; ` +
        `${registradas.length + cambios.length} en el registro de la edición.`,
    );
  }

  return { created: cambios.length, total: registradas.length + cambios.length };
}
