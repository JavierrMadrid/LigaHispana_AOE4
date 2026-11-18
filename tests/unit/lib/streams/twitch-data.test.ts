import { describe, expect, it } from "vitest";

import {
  createTwitchStreamReader,
  fallbackLeagueTwitchStreams,
  parseTwitchStreams,
  type TwitchLeagueParticipant,
} from "@/lib/streams/twitch-data";

const credentials = { clientId: "app-id", clientSecret: "test-secret" };
const tokenBody = { access_token: "app-token", expires_in: 7200, token_type: "bearer" };
const validationBody = { client_id: credentials.clientId, expires_in: 7200 };
const participant = (login: string, id = 1): TwitchLeagueParticipant => ({
  profileId: id, name: `Jugador ${id}`, twitchChannel: login, twitchIsLive: true,
});
const stream = (login: string, viewers: unknown = 17) => ({
  user_login: login, user_name: login.toUpperCase(), type: "live", viewer_count: viewers,
  thumbnail_url: `https://static-cdn.jtvnw.net/previews-ttv/live_user_${login}-{width}x{height}.jpg`,
});

function fixture(responses: { status: number; body: unknown }[]) {
  let time = 100_000;
  const calls: { url: string; init: RequestInit }[] = [];
  const read = createTwitchStreamReader({
    now: () => time,
    request: async (url, init) => {
      calls.push({ url, init });
      const response = responses.shift();
      if (!response) throw new Error("No quedan respuestas preparadas.");
      return response;
    },
  });
  return { read, calls, advance: (ms: number) => { time += ms; } };
}

const authorized = () => [
  { status: 200, body: tokenBody }, { status: 200, body: validationBody },
];

describe("tarjetas Twitch de participantes en directo", () => {
  it("normaliza, deduplica, limita a cinco y conserva desconocido el contador sin Helix", () => {
    const rows = [participant("https://www.twitch.tv/CanalUno?ref=liga"), participant("canaluno", 2),
      { ...participant("apagado", 3), twitchIsLive: false }, participant("javascript:alert(1)", 4),
      ...Array.from({ length: 8 }, (_, index) => participant(`canal_${index}`, index + 5))];
    const result = fallbackLeagueTwitchStreams(rows);
    expect(result.status).toBe("unavailable");
    expect(result.streams).toHaveLength(5);
    expect(result.streams[0]).toMatchObject({ profileId: 1, login: "canaluno", displayName: "canaluno", viewerCount: null });
    expect(new Set(result.streams.map((item) => item.login)).size).toBe(5);
    expect(result.streams.every((item) => item.viewerCount === null)).toBe(true);
    expect(result.streams[0].thumbnailUrl).toBe("https://static-cdn.jtvnw.net/previews-ttv/live_user_canaluno-640x360.jpg");
    expect(fallbackLeagueTwitchStreams([])).toEqual({ status: "ok", streams: [] });
  });

  it("un envelope inválido es desconocido; una lista vacía y los no-directos no son un fallo", () => {
    for (const payload of [null, {}, { data: {} }, { data: [null] }, { data: [{ type: "live", user_login: "../otro" }] }]) {
      expect(parseTwitchStreams(payload)).toBeNull();
    }
    expect(parseTwitchStreams({ data: [] })).toEqual([]);
    expect(parseTwitchStreams({ data: [{ ...stream("canal"), type: "" }] })).toEqual([]);
  });

  it("conserva un cero real y no convierte campos ausentes, negativos o cadenas en espectadores", () => {
    expect(parseTwitchStreams({ data: [stream("canal", 0)] })![0].viewerCount).toBe(0);
    for (const viewers of [undefined, null, "80", -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const entry = { ...stream("canal"), viewer_count: viewers };
      expect(parseTwitchStreams({ data: [entry] })![0].viewerCount).toBeNull();
    }
    const parsed = parseTwitchStreams({ data: [stream("canal", 35), stream("canal", 40)] })!;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ displayName: "CANAL", viewerCount: 35 });
  });

  it("solo acepta miniaturas HTTPS del CDN de Twitch y sustituye sus dimensiones", () => {
    const expected = "https://static-cdn.jtvnw.net/previews-ttv/live_user_canal-640x360.jpg";
    expect(parseTwitchStreams({ data: [stream("canal")] })![0].thumbnailUrl).toBe(expected);
    for (const url of ["javascript:alert(1)", "https://evil.example/frame.jpg", "http://static-cdn.jtvnw.net/previews-ttv/a.jpg",
      "https://user:pass@static-cdn.jtvnw.net/previews-ttv/a.jpg", "https://static-cdn.jtvnw.net:444/previews-ttv/a.jpg"]) {
      expect(parseTwitchStreams({ data: [{ ...stream("canal"), thumbnail_url: url }] })![0].thumbnailUrl).toBe(expected);
    }
  });

  it("no llama a la red sin credenciales ni canales confirmados", async () => {
    const { read, calls } = fixture([]);
    expect((await read([participant("canal")], null)).streams[0].viewerCount).toBeNull();
    expect(await read([{ ...participant("canal"), twitchIsLive: false }], credentials)).toEqual({ status: "ok", streams: [] });
    expect(calls).toHaveLength(0);
  });

  it("consulta canales canónicos y devuelve solo miembros, ordenados por audiencia hasta cinco", async () => {
    const rows = Array.from({ length: 8 }, (_, index) => participant(`canal_${index}`, index + 1));
    const { read, calls } = fixture([...authorized(), { status: 200, body: {
      data: [stream("ajeno", 99999), ...rows.map((row, index) => stream(row.twitchChannel!, index * 10))],
    } }]);
    const result = await read(rows, credentials);
    expect(result.status).toBe("ok");
    expect(result.streams.map((item) => item.login)).toEqual(["canal_7", "canal_6", "canal_5", "canal_4", "canal_3"]);
    expect(result.streams.map((item) => item.viewerCount)).toEqual([70, 60, 50, 40, 30]);
    expect(calls).toHaveLength(3);
    expect(calls[0].url).toBe("https://id.twitch.tv/oauth2/token");
    expect(calls[0].url).not.toContain(credentials.clientSecret);
    expect(new URLSearchParams(String(calls[0].init.body)).get("client_secret")).toBe(credentials.clientSecret);
    expect(calls[1].url).toBe("https://id.twitch.tv/oauth2/validate");
    expect(new URL(calls[2].url).searchParams.getAll("user_login")).toEqual(rows.map((row) => row.twitchChannel));
  });

  it("una consulta correcta vacía retira la señal de directo antigua de la base", async () => {
    const { read } = fixture([...authorized(), { status: 200, body: { data: [] } }]);
    expect(await read([participant("canal")], credentials)).toEqual({ status: "ok", streams: [] });
  });

  it("cachea el dato remoto 60 segundos y proyecta de nuevo el nombre actual de la liga", async () => {
    const { read, calls, advance } = fixture([...authorized(),
      { status: 200, body: { data: [stream("canal", 21)] } },
      { status: 200, body: { data: [stream("canal", 42)] } }]);
    await read([participant("canal")], credentials);
    advance(59_000);
    const cached = await read([{ ...participant("canal"), name: "Nombre actualizado" }], credentials);
    expect(cached.streams[0]).toMatchObject({ playerName: "Nombre actualizado", viewerCount: 21 });
    expect(calls).toHaveLength(3);
    advance(1001);
    expect((await read([participant("canal")], credentials)).streams[0].viewerCount).toBe(42);
    expect(calls).toHaveLength(4);
  });

  it("degrada y frena fallos de cuota o respuestas rotas sin publicar ceros", async () => {
    for (const response of [{ status: 429, body: null }, { status: 503, body: null }, { status: 200, body: {} }]) {
      const { read, calls } = fixture([...authorized(), response]);
      const result = await read([participant("canal")], credentials);
      expect(result.status).toBe("unavailable");
      expect(result.streams[0].viewerCount).toBeNull();
      await read([participant("canal")], credentials);
      expect(calls).toHaveLength(3);
    }
  });

  it("limita un token revocado a una renovación y un reintento", async () => {
    const { read, calls } = fixture([...authorized(), { status: 401, body: null }, ...authorized(),
      { status: 401, body: null }]);
    expect((await read([participant("canal")], credentials)).status).toBe("unavailable");
    expect(calls).toHaveLength(6);
  });

  it("vuelve a validar el token al usarlo tras 55 minutos", async () => {
    const { read, calls, advance } = fixture([...authorized(), { status: 200, body: { data: [stream("canal")] } },
      { status: 200, body: validationBody }, { status: 200, body: { data: [stream("canal")] } }]);
    await read([participant("canal")], credentials);
    advance(55 * 60_000 + 1);
    await read([participant("canal")], credentials);
    expect(calls).toHaveLength(5);
    expect(calls[3].url).toBe("https://id.twitch.tv/oauth2/validate");
  });

  it("no reutiliza tokens ni resultados entre credenciales distintas", async () => {
    const { read, calls } = fixture([...authorized(), { status: 200, body: { data: [stream("canal", 55)] } },
      { status: 401, body: null }]);
    await read([participant("canal")], credentials);
    const result = await read([participant("canal")], { ...credentials, clientSecret: "secret-rotated" });
    expect(result.streams[0].viewerCount).toBeNull();
    expect(result.status).toBe("unavailable");
    expect(calls).toHaveLength(4);
  });

  it("acota el lote a cien canales y trata los errores de transporte como dato no disponible", async () => {
    const { read, calls } = fixture([...authorized()]);
    const rows = Array.from({ length: 120 }, (_, index) => participant(`canal_${index}`, index + 1));
    const result = await read(rows, credentials);
    expect(result.status).toBe("unavailable");
    expect(result.streams).toHaveLength(5);
    expect(new URL(calls[2].url).searchParams.getAll("user_login")).toHaveLength(100);
  });
});
