import { describe, expect, it } from "vitest";

import {
  resolvePlayerStreams,
  resolveStandingsVersion,
  splitStandingPoints,
  type ObjectiveKind,
  type PlayerStreamSource,
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
 * El reparto de `points` en las tres columnas de la clasificación.
 *
 * Las victorias no se multiplican por el precio del ruleset: salen **por resta**
 * contra el total de objetivos de la fila. De los dos tipos de objetivo, el que se
 * calcula en positivo es la **competición**, porque su precio es fijo en el
 * catálogo y el motor cobra exactamente ese precio; los **logros** son el resto,
 * porque `imparable` reparte puntos por día y su precio de catálogo es solo el
 * tope. El reparto se reconstruye desde el desglose guardado
 * (`breakdown.objectives`) y el catálogo activo, así que cualquiera de los dos
 * puede venir de otra versión de las reglas.
 *
 * Aquí se comprueba la parte pura —`splitStandingPoints`— sin base de datos. Lo
 * que **no** se puede probar aquí es de dónde salen esos datos (`PlayerScore`) ni
 * que `presentStandings` los use: eso es Prisma.
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
  };
}

/** Suma de las tres columnas: es la identidad que tiene que cumplirse siempre. */
function suma(reparto: StandingPoints): number {
  return reparto.pointsByWins + reparto.pointsByAchievements + reparto.pointsByCompetitions;
}

describe("splitStandingPoints", () => {
  /** Total 310: 250 de objetivos (200 de una competición y 50 de un logro) y 60 de victorias. */
  const catalogo = new Map<string, StandingObjective>([
    ["rey-1v1", objetivo("rey-1v1", "competition", 200)],
    ["loco-por-ganar", objetivo("loco-por-ganar", "achievement", 50)],
  ]);
  const TOTAL = 310;

  it("caso normal: reparte los objetivos por tipo y las tres columnas suman el total", () => {
    const reparto = splitStandingPoints(
      TOTAL,
      { objectives: { points: 250, earned: ["rey-1v1", "loco-por-ganar"] } },
      catalogo,
    );

    expect(reparto).toEqual({
      pointsByWins: 60,
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
      265,
      { objectives: { points: 205, earned: ["imparable", "rey-1v1"] } },
      conImparable,
    );

    expect(reparto.pointsByAchievements).toBe(5);
    expect(reparto.pointsByCompetitions).toBe(200);
    expect(reparto.pointsByWins).toBe(60);
    expect(suma(reparto)).toBe(265);
  });

  it("el sobrante del total de objetivos que no es de competiciones cae en logros", () => {
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
    expect(reparto.pointsByWins).toBe(60);
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

  it("desglose ausente o mal formado: los objetivos aportan 0 y todo el total cuenta como victorias", () => {
    const rotos = [undefined, null, {}, { objectives: null }, { objectives: "lo que sea" }];

    for (const breakdown of rotos) {
      const reparto = splitStandingPoints(TOTAL, breakdown, catalogo);

      expect(reparto).toEqual({
        pointsByWins: TOTAL,
        pointsByAchievements: 0,
        pointsByCompetitions: 0,
      });
      expect(suma(reparto)).toBe(TOTAL);
    }
  });

  it("puntos de objetivos legibles con el earned ilegible: no hay nada que atribuir y van a competiciones", () => {
    const reparto = splitStandingPoints(
      TOTAL,
      { objectives: { points: 250, earned: "rey-1v1" } },
      catalogo,
    );

    expect(reparto.pointsByAchievements).toBe(0);
    expect(reparto.pointsByCompetitions).toBe(250);
    expect(reparto.pointsByWins).toBe(60);
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
    expect(reparto.pointsByAchievements).toBe(0);
    expect(reparto.pointsByWins).toBe(100);
    expect(suma(reparto)).toBe(120);
  });

  it("ids desconocidos en el earned: no se atribuyen a competiciones y quedan del lado de los logros", () => {
    const reparto = splitStandingPoints(
      200,
      { objectives: { points: 150, earned: ["loco-por-ganar", "objetivo-que-ya-no-existe"] } },
      catalogo,
    );

    expect(reparto.pointsByCompetitions).toBe(0);
    expect(reparto.pointsByAchievements).toBe(150);
    expect(reparto.pointsByWins).toBe(50);
    expect(suma(reparto)).toBe(200);
  });

  it("sin objetivos poseídos: todo el total son victorias", () => {
    const reparto = splitStandingPoints(TOTAL, { objectives: { points: 0, earned: [] } }, catalogo);

    expect(reparto).toEqual({
      pointsByWins: TOTAL,
      pointsByAchievements: 0,
      pointsByCompetitions: 0,
    });
    expect(suma(reparto)).toBe(TOTAL);
  });
});
