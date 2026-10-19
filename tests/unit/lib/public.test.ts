import { describe, expect, it } from "vitest";

import type { ObjectiveLeadKind } from "@/generated/prisma/enums";
import {
  comparePointHistory,
  earnedObjectives,
  participantObjective,
  readPointHistoryFilters,
  readProfileIdFilter,
  resolvePlayerStreams,
  resolveStandingsVersion,
  splitStandingPoints,
  type ObjectiveKind,
  type ObjectiveOption,
  type PlayerStreamSource,
  type PointHistoryRow,
  type StandingObjective,
  type StandingPoints,
} from "@/lib/public";

/**
 * La decisión de qué versión de reglas publica la clasificación.
 *
 * `getStandings()` consulta primero la versión **activa** y, solo si sale vacía,
 * la **anterior más alta** que tenga filas: `PlayerScore` está particionada por
 * `ruleSetVersion` y cada recálculo escribe solo la activa, así que una preview
 * contra una base donde todavía no ha corrido el motor vería cero filas y la web
 * diría "0 participantes", que es falso.
 *
 * La decisión es una función pura y aquí se comprueban sus tres desenlaces sin
 * base de datos. Lo que **no** se puede probar aquí es la consulta en sí —cuál es
 * la "anterior más alta con filas" y que las filas publicadas sean todas de una
 * única versión—: eso es Prisma y sale en `npm run verify:sync`.
 */

/** Versión activa y anterior; los valores solo tienen que ser distintos y ordenados. */
const ACTIVA = 4;
const ANTERIOR = 3;

describe("resolveStandingsVersion", () => {
  it("caso A: la activa tiene filas, se publica tal cual y sin aviso", () => {
    expect(resolveStandingsVersion(ACTIVA, 8, ANTERIOR)).toEqual({
      ruleSetVersion: ACTIVA,
      pendingRuleSetVersion: null,
    });
  });

  it("caso A: con filas en la activa no importa que no haya ninguna anterior", () => {
    expect(resolveStandingsVersion(ACTIVA, 1, null)).toEqual({
      ruleSetVersion: ACTIVA,
      pendingRuleSetVersion: null,
    });
  });

  it("caso B: la activa está vacía y se publica la anterior, con la activa como pendiente", () => {
    expect(resolveStandingsVersion(ACTIVA, 0, ANTERIOR)).toEqual({
      ruleSetVersion: ANTERIOR,
      pendingRuleSetVersion: ACTIVA,
    });
  });

  it("caso C: sin filas en la activa ni en ninguna anterior, vacío y sin aviso", () => {
    expect(resolveStandingsVersion(ACTIVA, 0, null)).toEqual({
      ruleSetVersion: ACTIVA,
      pendingRuleSetVersion: null,
    });
  });

  it("nunca mezcla versiones: una sola fila en la activa gana a toda la anterior", () => {
    const decidido = resolveStandingsVersion(ACTIVA, 1, ANTERIOR);

    expect(decidido.ruleSetVersion).toBe(ACTIVA);
    expect(decidido.pendingRuleSetVersion).toBeNull();
  });

  it("el aviso de versión pendiente solo aparece cuando las filas no son de la activa", () => {
    const activa = resolveStandingsVersion(ACTIVA, 3, null);
    const respaldo = resolveStandingsVersion(ACTIVA, 0, ANTERIOR);
    const vacio = resolveStandingsVersion(ACTIVA, 0, null);

    expect(activa.pendingRuleSetVersion).toBeNull();
    expect(respaldo.pendingRuleSetVersion).toBe(ACTIVA);
    expect(respaldo.ruleSetVersion).not.toBe(ACTIVA);
    expect(vacio.pendingRuleSetVersion).toBeNull();
  });
});

/**
 * La resolución del canal canónico de directo de un jugador.
 *
 * Es lo que comparten `getStandings()` y `getLiveMatches()`: si estas dos pantallas
 * no resolvieran el canal igual, una misma persona podría salir con canal en la
 * clasificación y sin él en `/partidas`. La parte pura —de dónde sale cada canal y
 * con qué se queda— se comprueba aquí sin base de datos; que la consulta traiga las
 * columnas es Prisma y sale en `npm run verify:sync`.
 */

/** Un jugador sin ningún canal: la base sobre la que cada caso pone lo suyo. */
function jugador(overrides: Partial<PlayerStreamSource>): PlayerStreamSource {
  return {
    twitchChannel: null,
    twitchUrl: null,
    twitchIsLive: false,
    youtubeChannel: null,
    youtubeIsLive: false,
    kickChannel: null,
    kickIsLive: false,
    ...overrides,
  };
}

describe("resolvePlayerStreams", () => {
  it("un jugador sin canales no inventa ninguno", () => {
    expect(resolvePlayerStreams(jugador({}))).toEqual({
      twitchChannel: null,
      twitchIsLive: false,
      youtubeChannel: null,
      youtubeIsLive: false,
      kickChannel: null,
      kickIsLive: false,
    });
  });

  it("el canal del panel manda sobre el del perfil", () => {
    const streams = resolvePlayerStreams(
      jugador({ twitchChannel: "DelPanel", twitchUrl: "twitch.tv/del-perfil" }),
    );

    expect(streams.twitchChannel).toBe("delpanel");
  });

  it("sin canal de panel, se cae al `twitchUrl` del perfil, y vale tanto nombre como URL", () => {
    expect(resolvePlayerStreams(jugador({ twitchUrl: "twitch.tv/alfa" })).twitchChannel).toBe(
      "alfa",
    );
    expect(resolvePlayerStreams(jugador({ twitchUrl: "beta" })).twitchChannel).toBe("beta");
  });

  it("un canal de panel inválido no tapa el del perfil, porque son dos intentos", () => {
    // "a" no llega al mínimo de 3 del patrón, así que no es canal y se recurre al
    // `twitchUrl`, que sí lo es: rendirse con el primero dejaría sin enlace a quien
    // tiene los dos escritos.
    expect(
      resolvePlayerStreams(jugador({ twitchChannel: "a", twitchUrl: "twitch.tv/alfa" }))
        .twitchChannel,
    ).toBe("alfa");
  });

  it("si ninguno de los dos es un canal, Twitch sale `null`", () => {
    expect(
      resolvePlayerStreams(jugador({ twitchChannel: "", twitchUrl: "twitch.tv/x" })).twitchChannel,
    ).toBeNull();
    expect(resolvePlayerStreams(jugador({ twitchChannel: "a" })).twitchChannel).toBeNull();
  });

  it("YouTube y Kick no tienen respaldo, solo se normalizan", () => {
    const streams = resolvePlayerStreams(
      jugador({
        youtubeChannel: "YouTube.com/@Alfa",
        kickChannel: "kick.com/Beta",
      }),
    );

    expect(streams.youtubeChannel).toBe("alfa");
    expect(streams.kickChannel).toBe("beta");
  });

  it("un canal de YouTube vacío o legacy no es un canal", () => {
    expect(resolvePlayerStreams(jugador({ youtubeChannel: "  " })).youtubeChannel).toBeNull();
    expect(
      resolvePlayerStreams(jugador({ youtubeChannel: "https://youtube.com/c/alfa" }))
        .youtubeChannel,
    ).toBeNull();
  });

  it("los tres estados de directo pasan tal cual, sin tocarlos", () => {
    // `false` es también el estado degradado sin clave de API, así que el valor no
    // se interpreta aquí: solo se copia.
    const streams = resolvePlayerStreams(
      jugador({ twitchIsLive: true, youtubeIsLive: false, kickIsLive: true }),
    );

    expect(streams.twitchIsLive).toBe(true);
    expect(streams.youtubeIsLive).toBe(false);
    expect(streams.kickIsLive).toBe(true);
  });
});

/**
 * El reparto de `points` en las dos columnas de la clasificación.
 *
 * Todo punto de un jugador sale de sus objetivos —las victorias también, como el
 * objetivo `victorias`—, así que el reparto es el de la **forma de cobro**. De los
 * dos tipos de objetivo, el que se calcula en positivo es la **competición**, porque
 * su precio es fijo en el catálogo y el motor cobra exactamente ese precio; los
 * **logros** son el resto, porque `imparable` reparte puntos por día y `victorias`
 * por victorias y su precio de catálogo no es lo que se cobró. El reparto se
 * reconstruye desde el desglose guardado (`breakdown.objectives`) y el catálogo
 * activo, así que cualquiera de los dos puede venir de otra versión de las reglas.
 *
 * Aquí se comprueba la parte pura —`splitStandingPoints`, `earnedObjectives` y
 * `participantObjective`— sin base de datos. Lo que **no** se puede probar aquí es de
 * dónde salen esos datos (`PlayerScore`) ni que `presentStandings` los use: eso es
 * Prisma.
 */

/** Un objetivo del catálogo con lo que decide el reparto: su forma de cobro y sus puntos. */
function objetivo(id: string, kind: ObjectiveKind, points: number): StandingObjective {
  return {
    id,
    label: id,
    // El grupo y la métrica no entran en el reparto; van con valores válidos
    // para que el tipo cuadre.
    group: kind === "achievement" ? "hazanas" : "formato",
    kind,
    description: `${id}, en una frase`,
    metric: "victorias",
    points,
    count: 1,
  };
}

/** Suma de las dos columnas: es la identidad que tiene que cumplirse siempre. */
function suma(reparto: StandingPoints): number {
  return reparto.pointsByAchievements + reparto.pointsByCompetitions;
}

describe("splitStandingPoints", () => {
  /** Objetivos: 200 de una competición y 50 de un logro; el total de la fila es 250. */
  const catalogo = new Map<string, StandingObjective>([
    ["rey-1v1", objetivo("rey-1v1", "competition", 200)],
    ["loco-por-ganar", objetivo("loco-por-ganar", "achievement", 50)],
  ]);
  const TOTAL = 250;

  it("caso normal: reparte los objetivos por tipo y las dos columnas suman el total", () => {
    const reparto = splitStandingPoints(
      TOTAL,
      { objectives: { points: 250, earned: ["rey-1v1", "loco-por-ganar"] } },
      catalogo,
    );

    expect(reparto).toEqual({
      pointsByAchievements: 50,
      pointsByCompetitions: 200,
    });
    expect(suma(reparto)).toBe(TOTAL);
  });

  it("imparable por debajo del tope: el logro es el resto, no su precio de catálogo", () => {
    // `imparable` cobra 1 punto por día con tope de 14 y el catálogo solo publica el
    // tope. Esta fila cobró 5 días: sumando precios la columna de permanentes diría
    // 14 y se llevaría 9 puntos de la de temporales.
    const conImparable = new Map<string, StandingObjective>([
      ["imparable", objetivo("imparable", "achievement", 14)],
      ["rey-1v1", objetivo("rey-1v1", "competition", 200)],
    ]);

    const reparto = splitStandingPoints(
      205,
      { objectives: { points: 205, earned: ["imparable", "rey-1v1"] } },
      conImparable,
    );

    expect(reparto.pointsByAchievements).toBe(5);
    expect(reparto.pointsByCompetitions).toBe(200);
    expect(suma(reparto)).toBe(205);
  });

  it("el sobrante del total que no es de competiciones cae en logros", () => {
    // Fila de un ruleset en el que `rey-1v1` valía 250 y ahora vale 200: la
    // competición se cobra a precio de catálogo y los 50 de diferencia no se pueden
    // atribuir a nada más, así que quedan del lado de los logros.
    const reparto = splitStandingPoints(
      TOTAL,
      { objectives: { points: 250, earned: ["rey-1v1"] } },
      catalogo,
    );

    expect(reparto.pointsByCompetitions).toBe(200);
    expect(reparto.pointsByAchievements).toBe(50);
    expect(suma(reparto)).toBe(TOTAL);
  });

  it("un objetivo repetido en el earned no suma dos veces", () => {
    const reparto = splitStandingPoints(
      TOTAL,
      { objectives: { points: 250, earned: ["rey-1v1", "rey-1v1", "loco-por-ganar"] } },
      catalogo,
    );

    expect(reparto.pointsByCompetitions).toBe(200);
    expect(reparto.pointsByAchievements).toBe(50);
    expect(suma(reparto)).toBe(TOTAL);
  });

  it("desglose ausente o mal formado: no hay competiciones y todo el total va a logros", () => {
    const rotos = [undefined, null, {}, { objectives: null }, { objectives: "lo que sea" }];

    for (const breakdown of rotos) {
      const reparto = splitStandingPoints(TOTAL, breakdown, catalogo);

      expect(reparto).toEqual({
        pointsByAchievements: TOTAL,
        pointsByCompetitions: 0,
      });
      expect(suma(reparto)).toBe(TOTAL);
    }
  });

  it("puntos de objetivos legibles con el earned ilegible: no hay nada que atribuir", () => {
    const reparto = splitStandingPoints(
      TOTAL,
      { objectives: { points: 250, earned: "rey-1v1" } },
      catalogo,
    );

    expect(reparto.pointsByCompetitions).toBe(0);
    expect(reparto.pointsByAchievements).toBe(TOTAL);
    expect(suma(reparto)).toBe(TOTAL);
  });

  it("competiciones a precio de catálogo por encima del total guardado: se recortan al total y la suma sigue cuadrando", () => {
    // Fila de una versión anterior del ruleset: guarda 20 puntos de objetivos
    // cuando la competición vale 200 con los precios de ahora.
    const reparto = splitStandingPoints(
      120,
      { objectives: { points: 20, earned: ["rey-1v1"] } },
      catalogo,
    );

    expect(reparto.pointsByCompetitions).toBe(20);
    expect(reparto.pointsByAchievements).toBe(100);
    expect(suma(reparto)).toBe(120);
  });

  it("con `awards`, la competición se cobra por lo que se cobró y no por el precio de ahora", () => {
    // Fila escrita cuando `rey-1v1` valía 250: el catálogo ya dice 200, pero lo
    // cobrado fue 250 y el desglose lo trae.
    const reparto = splitStandingPoints(
      265,
      {
        objectives: {
          points: 265,
          earned: ["rey-1v1", "loco-por-ganar"],
          awards: { "rey-1v1": { points: 250, count: 1 }, "loco-por-ganar": { points: 15, count: 1 } },
        },
      },
      catalogo,
    );

    expect(reparto.pointsByCompetitions).toBe(250);
    expect(reparto.pointsByAchievements).toBe(15);
    expect(suma(reparto)).toBe(265);
  });

  it("ids desconocidos en el earned: no se atribuyen a competiciones y quedan del lado de los logros", () => {
    const reparto = splitStandingPoints(
      TOTAL,
      { objectives: { points: 150, earned: ["loco-por-ganar", "objetivo-que-ya-no-existe"] } },
      catalogo,
    );

    expect(reparto.pointsByCompetitions).toBe(0);
    expect(reparto.pointsByAchievements).toBe(TOTAL);
    expect(suma(reparto)).toBe(TOTAL);
  });

  it("sin objetivos poseídos: el total entero va a la columna de logros", () => {
    const reparto = splitStandingPoints(TOTAL, { objectives: { points: 0, earned: [] } }, catalogo);

    expect(reparto).toEqual({
      pointsByAchievements: TOTAL,
      pointsByCompetitions: 0,
    });
    expect(suma(reparto)).toBe(TOTAL);
  });
});

/**
 * Los objetivos que publica una fila de la clasificación, con **lo que cobró**.
 *
 * El importe y las repeticiones salen de `awards`; sin él, del precio del catálogo y
 * una repetición. Es lo que hace que una fila con tres días de `imparable` publique
 * 3 puntos (`3 x Imparable`) y no el tope de 14.
 */
describe("earnedObjectives", () => {
  const catalogo = new Map<string, StandingObjective>([
    ["rey-1v1", objetivo("rey-1v1", "competition", 200)],
    ["imparable", objetivo("imparable", "achievement", 14)],
  ]);

  it("lee el importe real y las repeticiones del desglose nuevo", () => {
    const publicados = earnedObjectives(
      {
        objectives: {
          points: 203,
          earned: ["imparable", "rey-1v1"],
          awards: { imparable: { points: 3, count: 3 }, "rey-1v1": { points: 200, count: 1 } },
        },
      },
      catalogo,
    );

    expect(publicados).toEqual([
      { ...catalogo.get("rey-1v1"), points: 200, count: 1 },
      { ...catalogo.get("imparable"), points: 3, count: 3 },
    ]);
  });

  it("una fila legada sin `awards` cae al precio de catálogo y a una repetición", () => {
    const publicados = earnedObjectives(
      { objectives: { points: 14, earned: ["imparable"] } },
      catalogo,
    );

    expect(publicados).toEqual([catalogo.get("imparable")]);
  });

  it("respeta el orden del catálogo aunque el earned venga en otro", () => {
    const publicados = earnedObjectives(
      { objectives: { points: 214, earned: ["imparable", "rey-1v1"] } },
      catalogo,
    );

    expect(publicados.map((item) => item.id)).toEqual(["rey-1v1", "imparable"]);
  });

  it("un desglose ilegible no publica ningún objetivo", () => {
    expect(earnedObjectives(null, catalogo)).toEqual([]);
    expect(earnedObjectives({ objectives: { points: 10, earned: 7 } }, catalogo)).toEqual([]);
  });
});

/**
 * La proyección del ranking de un objetivo sobre un participante.
 *
 * `points` y `count` tienen que ser **lo que cobra ese jugador**, no el precio de la
 * tarjeta: en un logro repetible (`victorias`) el importe es `pointsPerWin × victorias`
 * y en `por-tierra-y-agua` el avance por mapa viaja masticado en `mapGaps`.
 */
describe("participantObjective", () => {
  /** Una opción mínima: solo lo que lee la proyección. */
  function opcion(overrides: Partial<ObjectiveOption> = {}): ObjectiveOption {
    return {
      id: "victorias",
      group: "actividad",
      kind: "achievement",
      label: "Victorias",
      description: "Cada victoria paga los puntos de la regla activa.",
      metric: "victorias",
      points: 2,
      parent: null,
      holder: null,
      ranking: [],
      beneficiaries: [],
      target: null,
      ...overrides,
    };
  }

  it("un logro repetible publica lo cobrado y las repeticiones del beneficiario", () => {
    const proyectado = participantObjective(
      opcion({
        ranking: [
          {
            profileId: 7,
            name: "Siete",
            avatarUrl: null,
            profileUrl: null,
            value: 12,
            matches: 20,
            eligible: true,
          },
        ],
        beneficiaries: [
          {
            profileId: 7,
            name: "Siete",
            avatarUrl: null,
            profileUrl: null,
            points: 24,
            count: 12,
          },
        ],
      }),
      7,
    );

    expect(proyectado.points).toBe(24);
    expect(proyectado.count).toBe(12);
    expect(proyectado.achieved).toBe(true);
    expect(proyectado.value).toBe(12);
  });

  it("sin cobrarlo publica el precio del objetivo y una repetición", () => {
    const proyectado = participantObjective(opcion(), 7);

    expect(proyectado.points).toBe(2);
    expect(proyectado.count).toBe(1);
    expect(proyectado.achieved).toBe(false);
    expect(proyectado.value).toBe(0);
  });

  it("el avance por mapa de `por-tierra-y-agua` sale del contendiente", () => {
    const mapGaps = [
      { map: "Gorge", missing: 1 },
      { map: "Dry Arabia", missing: 3 },
    ];
    const proyectado = participantObjective(
      opcion({
        id: "por-tierra-y-agua",
        metric: "mapas",
        target: { unit: "mapas", value: 2 },
        ranking: [
          {
            profileId: 7,
            name: "Siete",
            avatarUrl: null,
            profileUrl: null,
            value: 1,
            matches: 4,
            eligible: false,
            mapGaps,
          },
        ],
      }),
      7,
    );

    expect(proyectado.mapGaps).toEqual(mapGaps);
  });

  it("en el resto de objetivos no hay mapas que publicar", () => {
    const proyectado = participantObjective(
      opcion({
        kind: "competition",
        ranking: [
          {
            profileId: 7,
            name: "Siete",
            avatarUrl: null,
            profileUrl: null,
            value: 9,
            matches: 9,
            eligible: true,
          },
        ],
      }),
      7,
    );

    expect(proyectado.mapGaps).toBeNull();
  });
});

/**
 * El historial público de ganancias de puntos.
 *
 * Lo que se comprueba aquí es lo puro: los filtros de la URL y el orden del feed mezclado,
 * que es de lo que depende que dos páginas consecutivas no repitan ni pierdan filas. Que las
 * consultas traigan cada clase ya ordenada como el comparador, y que el `where` deje fuera
 * lo que no es una ganancia, es Prisma y sale en `npm run verify:sync`.
 */

/** Una victoria del feed, con lo mínimo que necesita el comparador. */
function victoria({
  gameId,
  profileId = 7,
  fecha = T1,
  points = 2,
  revertedAt = null,
}: {
  gameId: string;
  profileId?: number;
  fecha?: string;
  points?: number;
  revertedAt?: Date | null;
}): PointHistoryRow {
  return {
    id: `match:${gameId}:${profileId}`,
    startedAt: new Date(fecha),
    playerName: `Jugador ${profileId}`,
    playerProfileId: profileId,
    points,
    objective: null,
    gameId,
    opponentName: null,
    mode: "rm_solo",
    leaderboard: "rm_solo",
    map: null,
    teamSize: "1vs1",
    revertedAt,
  };
}

/** Un objetivo cumplido del feed, con lo mínimo que necesita el comparador. */
function hito({
  objetivo,
  profileId = 7,
  fecha = T1,
}: {
  objetivo: string;
  profileId?: number;
  fecha?: string;
}): PointHistoryRow {
  return {
    id: `objective:${objetivo}:${profileId}`,
    startedAt: new Date(fecha),
    playerName: `Jugador ${profileId}`,
    playerProfileId: profileId,
    points: 40,
    objective: {
      id: objetivo,
      label: objetivo,
      group: "actividad",
      metric: "partidas",
      points: 40,
      count: 1,
      // Un logro no se posee.
      lead: null,
    },
    gameId: null,
    opponentName: null,
    mode: null,
    leaderboard: null,
    map: null,
    teamSize: null,
    revertedAt: null,
  };
}

/** Un cambio de poseedor del feed: la `GAINED` o la `LOST` de una competición. */
function liderazgo({
  objetivo,
  lead,
  profileId = 7,
  fecha = T1,
  points = 240,
}: {
  objetivo: string;
  lead: ObjectiveLeadKind;
  profileId?: number;
  fecha?: string;
  points?: number;
}): PointHistoryRow {
  return {
    id: `lead:${objetivo}:${lead}:${profileId}:${new Date(fecha).getTime()}`,
    startedAt: new Date(fecha),
    playerName: `Jugador ${profileId}`,
    playerProfileId: profileId,
    points,
    objective: {
      id: objetivo,
      label: objetivo,
      group: "formato",
      metric: "victorias",
      points,
      count: 1,
      lead,
    },
    gameId: null,
    opponentName: null,
    mode: null,
    leaderboard: null,
    map: null,
    teamSize: null,
    revertedAt: null,
  };
}

const T1 = "2026-09-01T10:00:00.000Z";
const T2 = "2026-09-02T10:00:00.000Z";

describe("comparePointHistory", () => {
  it("ordena de lo más reciente a lo más antiguo", () => {
    expect(comparePointHistory(victoria({ gameId: "1", fecha: T2 }), victoria({ gameId: "2" }))).toBeLessThan(0);
    expect(comparePointHistory(victoria({ gameId: "1" }), victoria({ gameId: "2", fecha: T2 }))).toBeGreaterThan(0);
  });

  it("a igual instante, la victoria va antes que el objetivo", () => {
    expect(comparePointHistory(victoria({ gameId: "1" }), hito({ objetivo: "imparable" }))).toBeLessThan(0);
    expect(comparePointHistory(hito({ objetivo: "imparable" }), victoria({ gameId: "1" }))).toBeGreaterThan(0);
  });

  it("a igual instante, la victoria va antes que un cambio de poseedor", () => {
    expect(
      comparePointHistory(victoria({ gameId: "1" }), liderazgo({ objetivo: "rey-1v1", lead: "GAINED" })),
    ).toBeLessThan(0);
  });

  it("dos victorias del mismo instante desempatan por `gameId`", () => {
    expect(comparePointHistory(victoria({ gameId: "9000002" }), victoria({ gameId: "9000001" }))).toBeLessThan(0);
  });

  it("la misma partida para dos jugadores desempata por `profileId`", () => {
    // El caso que obliga al desempate a mirar al jugador: un 2v2 con dos participantes de la
    // liga deja dos filas del mismo `gameId` y el mismo instante.
    expect(
      comparePointHistory(
        victoria({ gameId: "9000001", profileId: 8 }),
        victoria({ gameId: "9000001", profileId: 7 }),
      ),
    ).toBeLessThan(0);
  });

  it("dos beneficiarios del mismo objetivo desempatan por `profileId`", () => {
    // El día del cierre del torneo todos los eventos comparten instante: es el caso real.
    expect(
      comparePointHistory(
        hito({ objetivo: "imparable", profileId: 8 }),
        hito({ objetivo: "imparable", profileId: 7 }),
      ),
    ).toBeLessThan(0);
  });

  it("las dos filas de un cambio salen con la ganancia delante", () => {
    // Las dos comparten objetivo e instante y solo las separa el `lead`: es el desempate que
    // impide que una página repita una y pierda la otra.
    const ganancia = liderazgo({ objetivo: "rey-1v1", lead: "GAINED", profileId: 7 });
    const perdida = liderazgo({ objetivo: "rey-1v1", lead: "LOST", profileId: 8 });

    expect(comparePointHistory(ganancia, perdida)).toBeLessThan(0);
    expect(comparePointHistory(perdida, ganancia)).toBeGreaterThan(0);
  });

  it("el orden de las dos filas de un cambio no depende del jugador, sino del signo", () => {
    // Aunque el que gana tenga un `profileId` mayor que el que pierde, la ganancia va delante.
    const ganancia = liderazgo({ objetivo: "rey-1v1", lead: "GAINED", profileId: 9 });
    const perdida = liderazgo({ objetivo: "rey-1v1", lead: "LOST", profileId: 1 });

    expect(comparePointHistory(ganancia, perdida)).toBeLessThan(0);
  });

  it("es un orden total: ninguna pareja de filas distintas empata", () => {
    const filas = [
      victoria({ gameId: "9000001" }),
      victoria({ gameId: "9000001", profileId: 8 }),
      victoria({ gameId: "9000002" }),
      victoria({ gameId: "9000002", fecha: T2 }),
      hito({ objetivo: "imparable" }),
      hito({ objetivo: "imparable", profileId: 8 }),
      hito({ objetivo: "victorias", fecha: T2 }),
      liderazgo({ objetivo: "rey-1v1", lead: "GAINED", profileId: 7 }),
      liderazgo({ objetivo: "rey-1v1", lead: "LOST", profileId: 8 }),
      liderazgo({ objetivo: "rey-2v2", lead: "GAINED", fecha: T2 }),
    ];

    for (const a of filas) {
      for (const b of filas) {
        if (a.id === b.id) {
          continue;
        }

        expect(comparePointHistory(a, b)).not.toBe(0);
        expect(comparePointHistory(a, b)).toBe(-comparePointHistory(b, a));
      }
    }
  });

  it("la marca de revert no cambia el sitio de la fila: solo dice que no cuenta", () => {
    const revertida = victoria({ gameId: "9000002", points: 0, revertedAt: new Date(T2) });

    expect(comparePointHistory(revertida, victoria({ gameId: "9000001" }))).toBeLessThan(0);
  });
});

describe("readProfileIdFilter", () => {
  it("admite un `profileId` de AoE4World", () => {
    expect(readProfileIdFilter("21050396")).toBe(21050396);
    expect(readProfileIdFilter(" 21050396 ")).toBe(21050396);
    expect(readProfileIdFilter(["21050396", "7"])).toBe(21050396);
  });

  it("lo que no es un perfil es ausencia de filtro, no un filtro sin resultados", () => {
    expect(readProfileIdFilter("noSoyUnNumero")).toBeNull();
    expect(readProfileIdFilter("12.5")).toBeNull();
    expect(readProfileIdFilter("-5")).toBeNull();
    expect(readProfileIdFilter("0")).toBeNull();
    expect(readProfileIdFilter("021050396")).toBeNull();
    expect(readProfileIdFilter("")).toBeNull();
    expect(readProfileIdFilter(undefined)).toBeNull();
  });
});

describe("readPointHistoryFilters", () => {
  it("sin parámetros no hay ningún filtro", () => {
    expect(readPointHistoryFilters({})).toEqual({ profileId: null, rango: {} });
  });

  it("el jugador y las fechas se combinan, con los mismos bordes que el panel", () => {
    const filtros = readPointHistoryFilters({
      jugador: "21050396",
      from: "2026-09-01",
      to: "2026-09-30",
    });

    expect(filtros.profileId).toBe(21050396);
    expect(filtros.rango.gte?.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(filtros.rango.lt?.toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });

  it("un jugador que no se entiende se comporta como si no se hubiera filtrado", () => {
    const filtros = readPointHistoryFilters({ jugador: "inventado", from: "2026-09-01" });

    expect(filtros.profileId).toBeNull();
    expect(filtros.rango.gte?.toISOString()).toBe("2026-09-01T00:00:00.000Z");
  });
});
