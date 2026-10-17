import { describe, expect, it } from "vitest";
import { liveChannelValues, matchLiveChannels, participantIsLive } from "@/components/live-channels";

/**
 * Qué cuenta como "en directo" en una partida en juego.
 *
 * Lo que se comprueba aquí es la degradación, que es lo que no se ve a ojo: un
 * `…IsLive` llega a `false` tanto cuando la plataforma dice que no emite como
 * cuando no se ha podido comprobar, y solo el canal comprobado y emitiendo hace
 * que el participante salga con su icono y entre en el visor multi-stream.
 */

/** Los seis campos de canal que publica el DAL; `NADA` es "no hay nada vivo". */
type Canales = Parameters<typeof participantIsLive>[0];

const NADA: Canales = {
  twitchChannel: null,
  twitchIsLive: false,
  youtubeChannel: null,
  youtubeIsLive: false,
  kickChannel: null,
  kickIsLive: false,
};

function canales(overrides: Partial<Canales>): Canales {
  return { ...NADA, ...overrides };
}

describe("participantIsLive", () => {
  it("no es directo sin ningún canal", () => {
    expect(participantIsLive(canales({}))).toBe(false);
  });

  it("no es directo si la comprobación no ha visto emisión", () => {
    expect(participantIsLive(canales({ twitchChannel: "alguien" }))).toBe(false);
  });

  it("no es directo con la comprobación puesta pero sin canal", () => {
    expect(participantIsLive(canales({ twitchIsLive: true }))).toBe(false);
  });

  it("es directo con canal y emisión comprobada, en cualquiera de las tres", () => {
    expect(participantIsLive(canales({ twitchChannel: "alguien", twitchIsLive: true }))).toBe(true);
    expect(participantIsLive(canales({ youtubeChannel: "alguien", youtubeIsLive: true }))).toBe(true);
    expect(participantIsLive(canales({ kickChannel: "alguien", kickIsLive: true }))).toBe(true);
  });
});

describe("liveChannelValues", () => {
  it("deja fuera el canal apagado", () => {
    const values = liveChannelValues(
      canales({ twitchChannel: "apagado", kickChannel: "encendido", kickIsLive: true }),
    );

    expect(values.twitch).toBeNull();
    expect(values.kick).toEqual({ channel: "encendido", isLive: true });
  });
});

describe("matchLiveChannels", () => {
  it("ordena por participante y por plataforma, y solo con los que emiten", () => {
    const channels = matchLiveChannels([
      canales({ twitchChannel: "uno", twitchIsLive: true }),
      canales({ kickChannel: "dos", kickIsLive: true, youtubeChannel: "tres" }),
    ]);

    expect(channels).toEqual([
      { platform: "twitch", channel: "uno" },
      { platform: "kick", channel: "dos" },
    ]);
  });

  it("no incluye a nadie cuando no emite nadie", () => {
    expect(matchLiveChannels([canales({}), canales({ twitchChannel: "apagado" })])).toEqual([]);
  });
});
