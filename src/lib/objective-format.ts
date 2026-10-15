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
 * Un objetivo **sin tope**: un logro que no se completa nunca porque se repite con
 * cada unidad de su métrica. Hoy solo lo es `victorias`.
 *
 * Se reconoce por su forma ya resuelta —`kind: "achievement"` con `target: null`—,
 * que es el mismo criterio que el motor aplica en `hasFixedPrize()`
 * (`src/lib/objectives.ts`) leído al revés. Importa para no mentir en ningún sitio:
 * no tiene umbral que enseñar, no se «consigue», no tiene barra de avance que pintar
 * y su cifra de puntos es **por unidad**, no un premio cerrado.
 *
 * Es puro y estructural: vale igual para una `ObjectiveOption` que para una
 * `ParticipantObjective`.
 */
export function hasNoCap(objective: {
  kind: ObjectiveKind;
  target: ObjectiveTarget | null;
}): boolean {
  return objective.kind === "achievement" && objective.target === null;
}

/**
 * El pie de la placa de premio de un objetivo: `puntos`, o `puntos por victoria`
 * en uno sin tope.
 *
 * La placa de un objetivo normal enseña un premio cerrado —lo que reparte, se cobre
 * entero o no— y con decir `puntos` se entiende. En `victorias` no hay premio: cada
 * victoria paga, así que la cifra de la placa es **por unidad** y el pie tiene que
 * decirlo, o la placa estaría afirmando que el objetivo reparte eso en total.
 */
export function prizeLabel(objective: {
  kind: ObjectiveKind;
  target: ObjectiveTarget | null;
  metric: ObjectiveMetric;
}): string {
  return hasNoCap(objective) ? `puntos por ${metricUnit(objective.metric, 1)}` : "puntos";
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
 *
 * Un logro **sin tope** (`victorias`) no tiene umbral: se lee por su valor a
 * secas, como una competición (`24 victorias`), que es lo que da la posición.
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
 * **sobre el total de contendientes** del objetivo —los que están en su ranking,
 * que es justo lo que lista la cara de la clasificación—: "3 de 12 lo han
 * completado". En una **competición** solo hay un poseedor, así que un recuento no
 * aplica y se dice si está marcado o no. Y en un logro **sin tope** no hay
 * completadores que contar (todos los que suman lo están cobrando), así que se dice
 * la regla: "Sin tope: cada victoria suma". Es puro: solo depende del objetivo y
 * del número de contendientes.
 */
export function completionSummary(option: ObjectiveOption, contenders: number): string {
  if (option.kind === "competition") {
    return option.holder === null ? "Sin poseedor todavía" : "Poseedor marcado";
  }

  if (hasNoCap(option)) {
    return `Sin tope: cada ${metricUnit(option.metric, 1)} suma`;
  }

  const count = option.beneficiaries.length;

  if (count === 0) {
    return "Todavía nadie lo ha completado";
  }

  return count === 1
    ? `1 de ${contenders} lo ha completado`
    : `${count} de ${contenders} lo han completado`;
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
 * El recuento que encabeza una clasificación: cuántos aparecen en su lista.
 *
 * En un objetivo normal son **contendientes** —hay un umbral o un premio al que
 * aspirar—, pero en uno sin tope no se disputa nada: están los jugadores que ya
 * cobran, y llamarles aspirantes sería mentir sobre lo que están haciendo. Las dos
 * caras de la clasificación (la de `/objetivos` y la de la ficha) dicen lo mismo.
 */
export function standingsCountLabel(option: ObjectiveOption, total: number): string {
  if (hasNoCap(option)) {
    return total === 1 ? "1 jugador" : `${total} jugadores`;
  }

  return total === 1 ? "1 contendiente" : `${total} contendientes`;
}

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
 * Un ranking vacío deja la entrada intacta y todo el mundo sin puesto. El tramo
 * final —quien no disputa— no llega a la cara pública: `objectiveStandingsView` lo
 * descarta antes de pintar.
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
 * Lo que pinta la clasificación de un objetivo: las filas visibles y cuántos
 * disputan.
 */
export type ObjectiveStandingsView<T> = {
  /** Filas a pintar, ya ordenadas por el ranking del objetivo. */
  rows: ObjectivePlacement<T>[];
  /** Cuántos **disputan** el objetivo: la base de la cabecera y del resumen. */
  contenders: number;
};

/**
 * Prepara la clasificación de un objetivo para su cara pública: **solo las filas
 * de quien lo disputa**.
 *
 * El listado de participantes del torneo es más largo que el del objetivo, y quien
 * no ha empezado su participación no aporta nada aquí: sale sin valor ni puesto,
 * alarga una lista que se lee de un vistazo y compite con la información real.
 * Quien quiera el censo completo tiene la página de clasificación del torneo. Por
 * eso se descarta el tramo final que devuelve `orderByObjectiveRanking`, y los
 * puestos siguen siendo los del ranking (1 es el líder), sin renumerar nada.
 *
 * La **excepción** es `highlightProfileId`: el participante de la ficha que abrió
 * la ventana mantiene su fila aunque no dispute (sin valor ni puesto), para que no
 * desaparezca su propia referencia. Esa fila no suma en `contenders`.
 *
 * `contenders` cuenta solo a quien disputa **y está en la lista de participantes**
 * —el ranking puede traer a alguien que la clasificación ya no tenga—, de modo que
 * el recuento de la cabecera y el `completionSummary` digan lo mismo que las filas.
 *
 * Es puro: cruza las dos listas por `profileId`, sin conocer el objetivo.
 */
export function objectiveStandingsView<T extends { profileId: number }>(
  participants: readonly T[],
  ranking: readonly ObjectiveContender[],
  highlightProfileId: number | null = null,
): ObjectiveStandingsView<T> {
  const placements = orderByObjectiveRanking(participants, ranking);

  return {
    rows: placements.filter(
      (placement) =>
        placement.contender !== null || placement.participant.profileId === highlightProfileId,
    ),
    contenders: placements.reduce(
      (total, placement) => (placement.contender === null ? total : total + 1),
      0,
    ),
  };
}

/**
 * El rótulo de un objetivo con sus repeticiones delante: `2×Imparable`,
 * `24×Victorias`. Sin repeticiones (`count === 1`) es la etiqueta a secas.
 *
 * Poner el multiplicador en el nombre y no al lado de los puntos deja la cifra
 * limpia: así `2×Imparable +2` se lee como "dos veces Imparable, dos puntos", que es
 * exactamente lo que pasó. Un logro repetible —`imparable` paga por día,
 * `victorias` por victoria— sin el multiplicador parecería haber pagado dos puntos
 * de golpe.
 */
export function objectiveTitle(objective: { label: string; count: number }): string {
  return objective.count > 1 ? `${objective.count}×${objective.label}` : objective.label;
}

/**
 * Qué fracción del valor del líder vale un contendiente, de `0` a `1`, para la
 * barra de fondo de una fila de la clasificación.
 *
 * La referencia es el **primero del ranking** —el valor más alto de la lista—, así
 * que la barra del líder llega al final y las demás se comparan unas con otras de
 * un vistazo. Vale igual para un logro (avance sobre el umbral) y para una
 * competición (valor de su métrica): en los dos casos se compara la cifra que da la
 * posición, no la cercanía a cobrar el objetivo, que es otra lectura.
 *
 * Un líder sin valor (`0` o menos) no da escala: todo devuelve `0` y la fila se
 * queda sin barra. Se satura en `1` por si un valor llega desordenado.
 */
export function contenderShare(value: number, leader: number): number {
  if (leader <= 0) {
    return 0;
  }

  return Math.min(1, Math.max(0, value / leader));
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
 * Un valor sin referencia devuelve `0`: un **logro sin tope** no tiene umbral al
 * que acercarse —se cobra con cada victoria, no se completa—, y un participante sin
 * puesto no tiene nada con lo que medir la distancia al primero.
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
 * que a igual avance se conserva el orden de entrada (el del catálogo). Un logro
 * **sin tope** no tiene porcentaje que comparar (`0`, como cualquier valor sin
 * umbral), así que queda al final del orden.
 */
export function orderByObjectiveProgress<T extends ObjectiveClosenessInput>(
  items: readonly T[],
): T[] {
  return [...items].sort((a, b) => objectiveCloseness(b) - objectiveCloseness(a));
}
