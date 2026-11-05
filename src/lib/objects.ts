import { ObjectKind } from "@/generated/prisma/enums";

/**
 * Los **objetos utilizables** del POC de la issue 134: el catálogo y las reglas
 * puras que lo rodean.
 *
 * Un objeto se gana con una victoria del día y reparte una **desventaja** a quien lo
 * porta. Este módulo decide **quién lo gana**, **qué desventaja le toca** y **qué
 * partidas no puntúan** mientras lo tiene; no escribe nada, no lee la base y no
 * mira el reloj: las fechas y el azar entran por parámetro. La mecánica completa,
 * con las tablas y los ejemplos, está en `docs/OBJETOS.md`.
 *
 * ## La mecánica acordada
 *
 * 1. El objeto lo gana el **vencedor de la primera partida del día UTC** que cumpla
 *    el motivo de victoria del objeto (una victoria sagrada, de conquista o de
 *    maravilla). `pickDailyAwards()` hace esa selección sobre partidas ya
 *    filtradas como clasificatorias.
 * 2. El portador puede **lanzarlo a otro jugador una vez al día**. En el POC el
 *    lanzamiento se hace desde el panel de admin, no hay automatismo.
 * 3. Si el lanzamiento **se devuelve** (con la probabilidad de
 *    `returnProbability()`), el objeto sigue en el lanzador y ese día ya no puede
 *    volver a lanzarlo. Si no se devuelve, el portador pasa a ser el objetivo, con
 *    `heldSince` en el instante del lanzamiento y `exitedAt` cerrado para el
 *    portador anterior.
 * 4. Mientras un objeto está pendiente, **las partidas del portador no puntúan**
 *    (`isMatchBlocked()`): quedan fuera de la clasificación y de los objetivos. La
 *    desventaja se da por **cumplida** cuando el admin la marca sobre una partida
 *    concreta: esa partida cuenta y `exitedAt` se cierra en su `startedAt`, así que
 *    la siguiente vuelve a puntuar.
 * 5. Si el jugador estaba **en partida** cuando el objeto le llegó, no le afecta
 *    hasta la siguiente: la comparación es `startedAt > heldSince`, estricta.
 *
 * ## Lo que este módulo no decide
 *
 * No hay scoring, ni worker, ni panel, ni notificaciones: devuelve datos y booleanos
 * para que esas piezas se apoyen en una única definición. Por eso tampoco importa
 * nada de `scoring.ts` ni de `ranked-match.ts`.
 *
 * ## Un motivo de victoria sin confirmar
 *
 * Los literales que publica AoE4World para la **victoria sagrada** y la **victoria
 * por maravilla** no están confirmados (los que sí lo están son `"Surrender"`,
 * `"Conquest"` y `"Elimination"`). `objectKindForWinReason()` mapea por **tokens**
 * deliberadamente tolerante —minúsculas, sin acentos y por inclusión— para que
 * `"Sacred Victory"`, `"Religious Victory"` o `"Victoria sagrada"` caigan del mismo
 * lado sin tener que acertar el literal exacto; cuando se confirme, se aprieta el
 * mapeo y se ajustan sus tests.
 */

/** Una desventaja del catálogo: el id que se guarda y su texto. */
export type ObjectPenalty = {
  /** Id estable que se persiste en `ObjectAward.penaltyId`. */
  id: string;
  /** Texto de la desventaja, ya redactado en español. */
  text: string;
};

/** Un objeto del catálogo: qué es, con qué se gana y qué desventajas reparte. */
export type ObjectDefinition = {
  kind: ObjectKind;
  /** Nombre del objeto, tal cual se publica en el panel. */
  name: string;
  /** Con qué victoria se obtiene, en una línea para el panel y la documentación. */
  obtainedBy: string;
  /** Las tres desventajas del POC, en el orden en que se sortean. */
  penalties: readonly ObjectPenalty[];
};

/** Los tres tipos, en el orden del catálogo y del enum del schema. */
export const OBJECT_KINDS = [
  ObjectKind.RELIQUIA,
  ObjectKind.MONEDA,
  ObjectKind.MONUMENTO,
] as const;

/**
 * El catálogo del POC.
 *
 * El texto de una desventaja **no se guarda** en la base: se persiste su id
 * (`ObjectAward.penaltyId`) y aquí se resuelve, igual que los objetivos no guardan
 * su etiqueta. Cambiar una redacción no reescribe el histórico.
 */
export const OBJECT_CATALOG: Record<ObjectKind, ObjectDefinition> = {
  [ObjectKind.RELIQUIA]: {
    kind: ObjectKind.RELIQUIA,
    name: "Reliquia pagana",
    obtainedBy: "victoria sagrada o religiosa",
    penalties: [
      { id: "sin-guarecer-reliquias", text: "No se pueden guarecer reliquias." },
      { id: "sin-unidades-monasterio", text: "No se pueden crear unidades del monasterio." },
      { id: "sin-victoria-sagrada", text: "No se puede ganar por victoria sagrada." },
    ],
  },
  [ObjectKind.MONEDA]: {
    kind: ObjectKind.MONEDA,
    name: "Moneda del Rey falsificada",
    obtainedBy: "conquista",
    penalties: [
      { id: "sin-2tc", text: "No se puede hacer 2TC." },
      {
        id: "sin-militares-5min",
        text: "No se pueden construir unidades militares los 5 primeros minutos.",
      },
      { id: "sin-barcos-pesqueros", text: "No se pueden crear barcos pesqueros." },
    ],
  },
  [ObjectKind.MONUMENTO]: {
    kind: ObjectKind.MONUMENTO,
    name: "Monumento",
    obtainedBy: "maravilla",
    penalties: [
      { id: "sin-fuertes", text: "No se pueden construir fuertes." },
      { id: "victoria-minuto-25", text: "Debes ganar la partida a partir del minuto 25." },
      {
        id: "sin-fuerte-toda-la-partida",
        text: "No se puede construir un fuerte en toda la partida.",
      },
    ],
  },
};

/**
 * La **medianoche UTC** del día de `at`: el día con el que se agrupa un objeto.
 *
 * Se normaliza aquí y no al leer porque es la clave de `@@unique([kind, day])`: dos
 * instantes del mismo día UTC tienen que dar exactamente la misma fecha, o dos
 * partidas del mismo día podrían crear dos objetos del mismo tipo.
 */
export function objectDay(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

/**
 * Los tokens de cada objeto. Van en el orden en que se prueban, aunque no se
 * solapan: el orden solo importa si algún día se añade un token compartido.
 */
const WIN_REASON_TOKENS: readonly (readonly [ObjectKind, readonly string[]])[] = [
  [ObjectKind.RELIQUIA, ["religious", "sacred", "sagrad"]],
  [ObjectKind.MONEDA, ["conquest", "conquista", "elimination"]],
  [ObjectKind.MONUMENTO, ["wonder", "maravilla"]],
];

/**
 * Qué objeto se gana con un motivo de victoria, o `null` si no mapea.
 *
 * Se compara por **tokens** y sin distinguir mayúsculas ni acentos: el payload trae
 * el literal tal cual (`"Sacred Victory"`, `"Conquest"`…), y los de la victoria
 * sagrada y la maravilla todavía no están confirmados. Incluir el token es más
 * tolerante que exigir la cadena exacta y no puede confundir dos motivos entre sí
 * porque los tokens de los tres objetos no se solapan.
 *
 * `"Surrender"` (el más habitual) no da objeto: rendirse no es ninguna de las tres
 * condiciones. `null` tampoco, y significa "no hay resumen o no traía motivo", no
 * "sin motivo".
 */
export function objectKindForWinReason(winReason: string | null): ObjectKind | null {
  if (winReason === null) {
    return null;
  }

  const normalized = winReason
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();

  const match = WIN_REASON_TOKENS.find(([, tokens]) =>
    tokens.some((token) => normalized.includes(token)),
  );

  return match?.[0] ?? null;
}

/**
 * Una partida candidata a otorgar un objeto.
 *
 * Tiene que llegar **ya filtrada** como clasificatoria y con `result` de victoria:
 * este módulo no sabe de ventanas, ni de aprobaciones, ni de partidas revertidas.
 * Lo que sí comprueba es el motivo (`winReason`), que es lo que decide si la
 * victoria otorga objeto.
 */
export type AwardMatch = {
  /** `Match.id` de la fila, que es lo que se guarda en `ObjectAward.winnerMatchId`. */
  id: string;
  /**
   * `Match.gameId`. Es el **desempate estable** cuando dos partidas empiezan en el
   * mismo instante: `Match.id` es un cuid y no dice nada del orden de juego.
   */
  gameId: string;
  /** `Player.id` del vencedor. */
  playerId: string;
  /** Inicio de la partida: ordena las candidatas y sella `heldSince`. */
  startedAt: Date;
  /** Motivo de la victoria tal cual lo publica AoE4World. */
  winReason: string | null;
};

/** Un objeto que toca otorgar, con la partida que lo otorga. */
export type DailyAward = {
  kind: ObjectKind;
  /** Medianoche UTC del día de la partida que lo otorga. */
  day: Date;
  /** `Player.id` del vencedor. */
  winnerId: string;
  /** `Match.id` de la partida que lo otorga. */
  winnerMatchId: string;
  /**
   * Cuándo le llega el objeto al portador: el `startedAt` de la partida que lo
   * otorga. Se sella con el inicio y no con el fin a propósito: esa misma partida
   * no queda excluida (la comparación de `isMatchBlocked()` es estricta), y la
   * siguiente sí. Usar la medianoche de `day` excluiría la partida que lo gana si
   * empezó después de las 00:00 UTC.
   */
  heldSince: Date;
};

/** Opciones de `pickDailyAwards()`. */
export type PickDailyAwardsOptions = {
  /**
   * Pares (tipo, día) que **ya existen** en la base: no se vuelven a proponer. Es
   * el complemento de `@@unique([kind, day])`: la función es la mitad pura de un
   * alta que no debe reescribir el histórico.
   */
  taken?: Iterable<{ kind: ObjectKind; day: Date }>;
};

/**
 * Los objetos que toca otorgar, uno por (tipo, día UTC).
 *
 * De todas las victorias de un tipo en un día gana la **más temprana** por
 * `startedAt`; si dos empiezan al mismo instante, la de `gameId` menor en orden
 * lexicográfico (comparación de código, no `localeCompare`, para que no dependa del
 * entorno). Las partidas cuyo motivo no mapea no generan nada.
 *
 * La salida va ordenada por día y, dentro del día, por el orden del catálogo, para
 * que el resultado no dependa del orden en que llegaron las partidas.
 */
export function pickDailyAwards(
  matches: readonly AwardMatch[],
  options: PickDailyAwardsOptions = {},
): DailyAward[] {
  const taken = new Set<string>();

  for (const existing of options.taken ?? []) {
    taken.add(awardKey(existing.kind, objectDay(existing.day)));
  }

  const byKey = new Map<string, { kind: ObjectKind; day: Date; match: AwardMatch }>();

  for (const match of matches) {
    const kind = objectKindForWinReason(match.winReason);

    if (kind === null) {
      continue;
    }

    const day = objectDay(match.startedAt);
    const key = awardKey(kind, day);

    if (taken.has(key)) {
      continue;
    }

    const current = byKey.get(key);

    if (current === undefined || earlierThan(match, current.match)) {
      byKey.set(key, { kind, day, match });
    }
  }

  return [...byKey.values()]
    .sort(
      (a, b) =>
        a.day.getTime() - b.day.getTime() ||
        OBJECT_KINDS.indexOf(a.kind) - OBJECT_KINDS.indexOf(b.kind),
    )
    .map(({ kind, day, match }) => ({
      kind,
      day,
      winnerId: match.playerId,
      winnerMatchId: match.id,
      heldSince: match.startedAt,
    }));
}

/** Si `candidate` va antes que `current`: primero `startedAt`, después `gameId`. */
function earlierThan(candidate: AwardMatch, current: AwardMatch): boolean {
  const difference = candidate.startedAt.getTime() - current.startedAt.getTime();

  return difference === 0 ? candidate.gameId < current.gameId : difference < 0;
}

/** Clave de (tipo, día) para el mapa y para el conjunto de ya otorgados. */
function awardKey(kind: ObjectKind, day: Date): string {
  return `${kind}:${day.toISOString()}`;
}

/** Datos de un lanzamiento que hacen falta para la probabilidad de devolución. */
export type ReturnProbabilityInput = {
  /** Puesto del objetivo en la clasificación; **1 = primero**. */
  targetRank: number;
  /** Puesto del lanzador; **1 = primero**. */
  throwerRank: number;
  /** Jugadores clasificados: el denominador de la proporción. */
  totalPlayers: number;
};

/**
 * Probabilidad de que un lanzamiento **se devuelva**.
 *
 * `(targetRank - throwerRank) / totalPlayers`, acotada entre 0,01 y 0,99. El orden
 * de la resta es el de la regla: lanzar a alguien **peor clasificado** (un puesto
 * mayor) sube la probabilidad de que se devuelva, y lanzar a alguien mejor la deja
 * en el suelo. La probabilidad nunca es 0 ni 1: siempre hay una tirada.
 *
 * Con `totalPlayers < 1` no hay proporción que calcular y devuelve 0,01, el mínimo.
 */
export function returnProbability({
  targetRank,
  throwerRank,
  totalPlayers,
}: ReturnProbabilityInput): number {
  if (totalPlayers < 1) {
    return 0.01;
  }

  const probability = (targetRank - throwerRank) / totalPlayers;

  return Math.min(0.99, Math.max(0.01, probability));
}

/** Puestos de un lanzamiento, tal y como los tiene el panel al lanzar. */
export type ThrowReturnProbabilityInput = {
  /** Puesto del lanzador, o `null` si todavía no hay fila de clasificación suya. */
  throwerRank: number | null;
  /** Puesto del objetivo, o `null` si todavía no hay fila de clasificación suya. */
  targetRank: number | null;
  /** Jugadores clasificados en el ruleset vigente. */
  totalPlayers: number;
};

/**
 * La probabilidad de devolución del lanzamiento, con la degradación del panel.
 *
 * `returnProbability()` necesita los dos puestos y el total de clasificados. Al
 * lanzar puede faltar alguno: el objetivo acaba de aprobarse, su `PlayerScore`
 * todavía no se ha recalculado o la tabla va un paso por detrás. En vez de impedir
 * el lanzamiento (el objeto quedaría bloqueado por un dato administrativo) se
 * degrada al mínimo, 0,01: la tirada siempre existe y el objeto viaja al objetivo
 * salvo un 1 %. Es la misma dirección que ya toma `returnProbability()` cuando no
 * hay ningún clasificado.
 */
export function throwReturnProbability({
  throwerRank,
  targetRank,
  totalPlayers,
}: ThrowReturnProbabilityInput): number {
  if (throwerRank === null || targetRank === null) {
    return 0.01;
  }

  return returnProbability({ targetRank, throwerRank, totalPlayers });
}

/**
 * La desventaja que le toca al objeto, con el azar inyectado.
 *
 * `draw` devuelve un número en `[0, 1)` y el índice sale de repartir ese rango en
 * tercios. Se acota el índice para que un `draw()` de 1 (o fuera de rango) no
 * devuelva `undefined` en vez de la última desventaja.
 */
export function pickPenalty(kind: ObjectKind, draw: () => number): ObjectPenalty {
  const { penalties } = OBJECT_CATALOG[kind];
  const index = Math.min(
    penalties.length - 1,
    Math.max(0, Math.floor(draw() * penalties.length)),
  );

  return penalties[index];
}

/**
 * La parte de `ObjectAward` que decide si una partida queda excluida.
 *
 * Es un tipo de **dominio** y no el de Prisma para poder probar la regla sin base
 * de datos: cualquier fila con estos dos campos vale.
 */
export type ObjectWindow = {
  /** Cuándo le llegó el objeto al portador; `null` = todavía no tiene portador. */
  heldSince: Date | null;
  /** Cuándo dejó de estar pendiente; `null` = sigue pendiente. */
  exitedAt: Date | null;
};

/**
 * Si una partida del portador no puntúa por tener el objeto.
 *
 * | Partida | Regla |
 * |---|---|
 * | `startedAt <= heldSince` | **No** queda excluida: el jugador ya estaba jugando (o la partida es la que le dio el objeto) |
 * | `startedAt > heldSince` y `exitedAt = null` | Excluida: el objeto sigue pendiente |
 * | `startedAt > heldSince` y `startedAt < exitedAt` | Excluida: cayó dentro de la ventana |
 * | `startedAt >= exitedAt` | **No** queda excluida: la ventana ya se cerró (la partida que cumple la desventaja cuenta) |
 *
 * Las dos comparaciones son **estrictas** a propósito. En `heldSince` porque una
 * partida empezada justo cuando llega el objeto ya estaba en marcha; en `exitedAt`
 * porque esa marca es el `startedAt` de la partida que cumple la desventaja, y esa
 * partida tiene que contar.
 *
 * El bloqueo no borra ni revierte nada: es la regla que el motor consultará para
 * dejar la partida fuera de puntos y objetivos mientras el objeto siga pendiente.
 */
export function isMatchBlocked(matchStartedAt: Date, award: ObjectWindow): boolean {
  if (award.heldSince === null) {
    return false;
  }

  if (matchStartedAt.getTime() <= award.heldSince.getTime()) {
    return false;
  }

  if (award.exitedAt !== null && matchStartedAt.getTime() >= award.exitedAt.getTime()) {
    return false;
  }

  return true;
}

/** Un lanzamiento ya anotado: a quién se lanzó y cuándo. */
export type ObjectThrowRecord = {
  toId: string;
  at: Date;
};

/**
 * La **regla Y**: un mismo objetivo no puede recibir el mismo objeto dos veces en
 * el mismo día UTC.
 *
 * Cuenta el lanzamiento aunque se haya devuelto: el `ObjectThrow` ocurrió y lo que
 * la regla evita es insistir sobre la misma persona ese día. Con la mecánica
 * acordada (un lanzamiento por portador y día, y el objeto se queda donde está si
 * se devuelve) la diferencia es teórica, pero la regla queda cerrada.
 *
 * `throws` son los lanzamientos **de este objeto**; el día se compara normalizado
 * con `objectDay()`.
 */
export function sameTargetBlocked(
  throws: readonly ObjectThrowRecord[],
  toId: string,
  day: Date,
): boolean {
  const targetDay = objectDay(day).getTime();

  return throws.some(
    (item) => item.toId === toId && objectDay(item.at).getTime() === targetDay,
  );
}

/** Un lanzamiento con su lanzador, para la regla de uno por portador y día. */
export type ObjectThrowWithThrower = ObjectThrowRecord & { fromId: string };

/**
 * La regla de **un lanzamiento por portador y día UTC**.
 *
 * Cuenta los lanzamientos que hizo el portador actual, se devolvieran o no: el
 * límite es por persona y día, no por objeto. Si el objeto cambia de manos sin
 * devolverse, el portador nuevo sí puede lanzarlo el mismo día, porque no ha
 * lanzado nada; es lo que compara `fromId` y no el `awardId`.
 *
 * `throws` son los lanzamientos **de este objeto**; el día se normaliza con
 * `objectDay()` igual que en la regla Y.
 */
export function sameThrowerBlocked(
  throws: readonly ObjectThrowWithThrower[],
  fromId: string,
  day: Date,
): boolean {
  const targetDay = objectDay(day).getTime();

  return throws.some(
    (item) => item.fromId === fromId && objectDay(item.at).getTime() === targetDay,
  );
}
