import { describe, expect, it } from "vitest";

import { localDatabaseConfig, parsePublicHomepage, parsePublicMatches, validateSnapshot } from "../../../scripts/public-snapshot.mjs";

const objective = { id: "imparable", label: "Imparable", group: "actividad", metric: "dias", points: 14 };
const row = {
  rank: 1, profileId: 123, name: "Participante", aoe4WorldName: null, country: "España",
  points: 3, pointsByWins: 2, pointsByObjectives: 1, wins: 1, losses: 0, elo: null,
  division: null, rankLevel: null, streak: 1, twitchChannel: null, twitchIsLive: false,
  youtubeChannel: null, youtubeIsLive: false, kickChannel: null, kickIsLive: false,
  isPlaying: false, avatarUrl: null, profileUrl: "https://aoe4world.com/players/123",
  objectives: [objective],
};
const snapshot = {
  source: "https://laligahispana.es/",
  capturedAt: "2026-10-13T15:00:00.000Z",
  publicSyncFinishedAt: "2026-10-13T14:50:00.000Z",
  window: { from: "2026-10-12T22:00:00.000Z", to: "2026-10-29T22:59:59.000Z" },
  rows: [row],
  matches: [],
};

function flight(records: Record<string, unknown>) {
  const payload = Object.entries(records).map(([key, value]) => `${key}:${JSON.stringify(value)}\n`).join("");
  const cut = Math.floor(payload.length / 2);
  return [payload.slice(0, cut), payload.slice(cut)].map((chunk) =>
    `<script>self.__next_f.push(${JSON.stringify([1, chunk])})</script>`).join("");
}

describe("destino de la captura pública", () => {
  it("admite loopback y fija el host de conexión sin credenciales en errores", () => {
    expect(localDatabaseConfig("postgres://tester:example@localhost:51214/template1", "development"))
      .toMatchObject({ host: "127.0.0.1", port: 51214, database: "template1", ssl: false });
    expect(localDatabaseConfig("postgres://tester:example@[::1]:5432/local", "test").host).toBe("::1");
  });

  it.each([
    "postgres://tester:example@db.example.com/local",
    "postgres://tester:example@localhost.evil.test/local",
    "postgres://tester:example@localhost/local?host=db.example.com",
    "postgres://tester:example@127.0.0.1/local?hostaddr=192.0.2.5",
    "https://localhost/local",
    "no-es-una-url",
  ])("rechaza una conexión fuera del destino local: %s", (url) => {
    expect(() => localDatabaseConfig(url, "development")).toThrow(/local|loopback/);
    try { localDatabaseConfig(url, "development"); } catch (error) {
      expect(String(error)).not.toContain("example@");
    }
  });

  it("rechaza producción incluso con loopback", () => {
    expect(() => localDatabaseConfig("postgres://localhost/local", "production")).toThrow(/desarrollo local/);
  });
});

describe("lectura del HTML público", () => {
  it("resuelve objetivos compartidos entre trozos Flight y conserva el total real", () => {
    const html = flight({
      a: ["$", "section", null, { rows: [row, { ...row, rank: 2, profileId: 124, objectives: ["$a:props:rows:0:objectives:0"] }] }],
      b: { ...snapshot.window, serverNow: snapshot.capturedAt },
      c: { dataUpdatedAt: snapshot.publicSyncFinishedAt },
    });
    const parsed = parsePublicHomepage(html);
    expect(parsed.rows[1].objectives).toEqual([objective]);
    expect(parsed.rows[1].pointsByObjectives).toBe(1);
    expect(parsed.publicSyncFinishedAt).toBe(snapshot.publicSyncFinishedAt);
  });

  it("decodifica fechas de partidas sin ejecutar el HTML", () => {
    const html = `<script>throw new Error('no ejecutar');</script>${flight({ a: { matches: [{ startedAt: "$D2026-10-13T15:00:00.000Z" }] } })}`;
    expect(parsePublicMatches(html)).toEqual([{ startedAt: "2026-10-13T15:00:00.000Z" }]);
  });

  it("rechaza un payload roto, vacío o con referencias sin resolver", () => {
    expect(() => parsePublicHomepage("<html>Servicio no disponible</html>")).toThrow();
    expect(() => parsePublicHomepage(flight({ a: { rows: [] } }))).toThrow();
    expect(() => parsePublicHomepage(flight({
      a: { rows: [{ ...row, objectives: ["$f:missing"] }] },
      b: { ...snapshot.window, serverNow: snapshot.capturedAt },
    }))).toThrow(/sin resolver/);
  });
});

describe("coherencia de la captura", () => {
  it("conserva el reparto publicado aunque no sea la suma nominal de los objetivos", () => {
    expect(validateSnapshot(snapshot)).toBe(snapshot);
  });

  it("rechaza totales incorrectos, filas duplicadas y estados de juego sin partida pública", () => {
    expect(() => validateSnapshot({ ...snapshot, rows: [{ ...row, points: 99 }] })).toThrow();
    expect(() => validateSnapshot({ ...snapshot, rows: [row, row] })).toThrow();
    expect(() => validateSnapshot({ ...snapshot, rows: [{ ...row, isPlaying: true }] })).toThrow();
  });
});
