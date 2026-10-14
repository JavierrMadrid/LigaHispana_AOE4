import { describe, expect, it } from "vitest";

import { resolvePlayerStreams, resolveStandingsVersion, type PlayerStreamSource } from "@/lib/public";

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
