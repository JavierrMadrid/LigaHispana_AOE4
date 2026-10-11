import type {
  ObjectiveContender,
  ObjectiveKind,
  ObjectiveMetric,
  ObjectiveOption,
  ObjectiveTarget,
} from "@/lib/objectives";

/**
 * Formato de las cifras de un objetivo.
 *
 * Es una pieza pura —solo depende del objetivo y del contendiente— y vive en
 * `lib` para poder probarla sin montar ninguna tarjeta: las unidades de cada
 * métrica (singular y plural) y la diferencia entre un logro (avance sobre el
 * umbral) y una competición (el valor de la métrica que da la posición) son
 * justo lo que no conviene descubrir a ojo en la interfaz.
 */

/** Singular y plural de la unidad de cada métrica. */
const METRIC_UNITS: Record<ObjectiveMetric, readonly [string, string]> = {
  partidas: ["partida", "partidas"],
  victorias: ["victoria", "victorias"],
  racha: ["victoria seguida", "victorias seguidas"],
  dias: ["día", "días"],
  civilizaciones: ["civilización", "civilizaciones"],
  mapas: ["mapa", "mapas"],
};

function metricUnit(metric: ObjectiveMetric, count: number): string {
  const [singular, plural] = METRIC_UNITS[metric];

  return count === 1 ? singular : plural;
}

/**
 * El valor de un contendiente, listo para pintar.
 *
 * En un **logro** es el avance sobre el umbral (`value/target`, p. ej. `12/23
 * civilizaciones`, `2/3 victorias`), con la unidad del objetivo. En una
 * **competición** no hay umbral que enseñar: lo que da la posición es el valor
 * de la métrica a secas (`50 partidas`, `5 victorias seguidas`). Los números son
 * enteros en todo el catálogo, así que no hay decimales que redondear.
 *
 * El avance de un logro se **satura en el umbral**: un `imparable` que acumule
 * más días de los que pide el objetivo se lee `14/14`, no `20/14`. Superar el
 * umbral no añade nada al objetivo (el motor ya lo da por cobrado, con el tope
 * de puntos aplicado), así que pintar el exceso solo confunde sobre cuánto
 * falta. El valor real del ranking no se toca: la saturación es de formato.
 */
export function contenderValue(option: ObjectiveOption, contender: ObjectiveContender): string {
  if (option.kind === "achievement" && option.target !== null) {
    const target = option.target.value;
    const value = Math.min(contender.value, target);

    return `${value}/${target} ${metricUnit(option.metric, target)}`;
  }

  return `${contender.value} ${metricUnit(option.metric, contender.value)}`;
}

/**
 * Texto del resumen de completadores, encabezando la clasificación de un
 * objetivo.
 *
 * En un **logro** son sus beneficiarios (`option.beneficiaries`), que se leen
 * **sobre el total de participantes** del torneo: "3 de 12 lo han completado".
 * En una **competición** solo hay un poseedor, así que un recuento no aplica y
 * se dice si está marcado o no. Es puro: solo depende del objetivo y del total.
 */
export function completionSummary(option: ObjectiveOption, total: number): string {
  if (option.kind === "competition") {
    return option.holder === null ? "Sin poseedor todavía" : "Poseedor marcado";
  }

  const count = option.beneficiaries.length;

  if (count === 0) {
    return "Todavía nadie lo ha completado";
  }

  return count === 1
    ? `1 de ${total} lo ha completado`
    : `${count} de ${total} lo han completado`;
}

/**
 * Un participante colocado en la clasificación de un objetivo.
 *
 * `contender` y `position` son `null` cuando el participante **no disputa** el
 * objetivo: no aparece en su ranking, así que no tiene valor ni puesto que
 * enseñar.
 */
export type ObjectivePlacement<T> = {
  participant: T;
  contender: ObjectiveContender | null;
  /** Puesto 1-based en el objetivo (`1` es el más avanzado), o `null`. */
  position: number | null;
};

/**
 * Ordena los participantes de una clasificación por el ranking del objetivo y
 * anota el puesto de cada uno.
 *
 * Primero va quien **disputa** el objetivo, de más a menos, con el orden que ya
 * trae `ranking` (su cadena de desempate resuelta); al final, quien **no
 * aparece** en él —los `—`, que no tienen valor que comparar— conserva el orden
 * de entrada, que es el de la clasificación general. El `position` de cada
 * disputante es su índice 1-based en el ranking; el de quien no disputa es
 * `null`. Así "Ver completados" lee el avance del más al menos avanzado sin
 * inventar un segundo criterio para los que no disputan.
 *
 * Es puro: solo cruza las dos listas por `profileId`, sin conocer el objetivo.
 * Un ranking vacío deja la entrada intacta y todo el mundo sin puesto.
 */
export function orderByObjectiveRanking<T extends { profileId: number }>(
  participants: readonly T[],
  ranking: readonly ObjectiveContender[],
): ObjectivePlacement<T>[] {
  const placementByProfileId = new Map<number, { contender: ObjectiveContender; position: number }>();

  ranking.forEach((contender, index) => {
    if (!placementByProfileId.has(contender.profileId)) {
      placementByProfileId.set(contender.profileId, { contender, position: index + 1 });
    }
  });

  const disputing: ObjectivePlacement<T>[] = [];
  const rest: ObjectivePlacement<T>[] = [];

  for (const participant of participants) {
    const placement = placementByProfileId.get(participant.profileId);

    if (placement === undefined) {
      rest.push({ participant, contender: null, position: null });
    } else {
      disputing.push({
        participant,
        contender: placement.contender,
        position: placement.position,
      });
    }
  }

  disputing.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

  return [...disputing, ...rest];
}

/**
 * Lista de mapas del objetivo `por-tierra-y-agua`, normalizada para leerla de un
 * tirón: nombre, nombre, nombre.
 *
 * Se recortan los espacios de cada nombre y se descartan los vacíos —un nombre
 * con espacios sobrantes dejaría ` , ` en medio de la lista—, y se une con
 * **coma y un espacio**, sin espacio antes de la coma ni elementos huecos.
 */
export function formatMapPool(maps: readonly string[]): string {
  return maps
    .map((map) => map.trim())
    .filter((map) => map !== "")
    .join(", ");
}

/**
 * El avance de un participante que basta para medir su cercanía al objetivo.
 *
 * Es la proyección mínima de `ParticipantObjective` sobre lo que decide el
 * orden de "Al alcance": el tipo (logro o competición), el valor y el umbral del
 * logro, y la posición entre aspirantes de la competición.
 */
export type ObjectiveClosenessInput = {
  kind: ObjectiveKind;
  value: number;
  target: ObjectiveTarget | null;
  position: number | null;
};

/**
 * Cómo de cerca está el participante de cobrar el objetivo, en una escala común
 * de `0` (lejísimos) a `1` (a un paso).
 *
 * Mezclar logros y competiciones en una sola lista obliga a una decisión, y esta
 * es la que se toma: las dos familias se leen como **la fracción del camino
 * recorrida**, para que puedan compararse sin que una aplaste a la otra.
 *
 * - **Logro**: `value/target`, el avance sobre el umbral. Recorrer 12 de 23
 *   civilizaciones es 0,52. Se satura en `1` (pasarse del umbral no acerca más).
 * - **Competición**: lo que mide es ir primero, así que la cercanía es la
 *   inversa del puesto (`1/position`): líder 1, 2.º 0,5, 3.º 0,33. Cuanto mejor
 *   puesto, más cerca de cobrarlo. El empate a fracción se rompe por distancia
 *   al líder, que decide quien ordena.
 *
 * Un valor sin referencia (logro sin umbral, o participante sin puesto) devuelve
 * `0`: no hay nada de lo que tirar para medir la cercanía.
 */
export function objectiveCloseness(progress: ObjectiveClosenessInput): number {
  if (progress.kind === "achievement") {
    const target = progress.target?.value ?? 0;

    if (target <= 0) {
      return 0;
    }

    return Math.min(1, Math.max(0, progress.value / target));
  }

  if (progress.position === null || progress.position <= 0) {
    return 0;
  }

  return 1 / progress.position;
}

/**
 * Ordena objetivos por su **porcentaje de consecución**, de mayor a menor: el
 * más avanzado, primero. Es el orden de las tarjetas de un carrusel de
 * subobjetivos, donde interesa ver antes lo que está a punto de caer (y, con un
 * 100 %, lo ya conseguido a la cabeza).
 *
 * Reutiliza `objectiveCloseness`, la misma fracción común a logros y
 * competiciones, y no muta la entrada. `Array.prototype.sort` es estable, así
 * que a igual avance se conserva el orden de entrada (el del catálogo).
 */
export function orderByObjectiveProgress<T extends ObjectiveClosenessInput>(
  items: readonly T[],
): T[] {
  return [...items].sort((a, b) => objectiveCloseness(b) - objectiveCloseness(a));
}
