import { describe, expect, it } from "vitest";

import { StreamsError } from "@/lib/streams/http";
import {
  anyVideoIsLive,
  readChannelIds,
  readUploadedVideoIds,
} from "@/lib/streams/youtube";

/**
 * La lectura de las respuestas de YouTube que decide si alguien está en directo.
 *
 * Este módulo dejó de preguntarlo con `search.list` (cuota propia de 100 al día, que
 * se agotaba todos los días y congelaba el estado del directo hasta la medianoche del
 * Pacífico) y ahora lo deduce de la playlist de subidas del canal y de los detalles de
 * emisión de sus últimos vídeos. Lo que se comprueba aquí es **esa deducción**, que es
 * lo que no se puede ver de otra manera: los tres payloads son documentos de una API
 * que no controlamos, y leerlos de más —dar por muerto un directo que sí lo está, o al
 * revés— publica una afirmación que nadie ha hecho.
 *
 * Todo es puro y sin red: los payloads son objetos escritos a mano y no se construye
 * ningún cliente HTTP. Por eso vive aquí y no en `scripts/verify-sync.ts`, que se
 * queda con lo que necesita la red o la base de datos.
 *
 * Nota sobre el diseño de la comprobación, que es lo que fijan los casos:
 *
 * - `channels.list` con `items: []` **no es un error**: YouTube responde así cuando no
 *   conoce el handle, y un canal inexistente no está en directo.
 * - Un payload sin `items` sí es un error, y se avisa en lugar de leerse como un
 *   "no hay directo": no se puede distinguir "no hay vídeos" de "esto no es la
 *   respuesta que esperaba".
 * - En `videos.list` hacen falta las dos señales: el `snippet` diciendo `live` (un
 *   directo terminado pasa a `none` y uno programado es `upcoming`) **y** la ausencia de
 *   `actualEndTime` (recién terminado, el `snippet` puede seguir diciendo `live` un rato).
 *   Mirar solo los tiempos da falsos positivos: hay emisiones viejas con
 *   `actualStartTime` sin `actualEndTime` que YouTube sigue marcando como `upcoming`.
 */

describe("readChannelIds: channels.list", () => {
  it("saca el channelId y la playlist de subidas del primer canal", () => {
    const payload = {
      items: [
        {
          id: "UC123",
          contentDetails: { relatedPlaylists: { uploads: "UU123", likes: "LL123" } },
        },
      ],
    };

    expect(readChannelIds(payload)).toEqual({
      channelId: "UC123",
      uploadsPlaylistId: "UU123",
    });
  });

  it("sin canales no hay error: el handle no existe y eso es un no-directo", () => {
    // La API contesta `200 { items: [] }` a un handle que no conoce, no un 404.
    expect(readChannelIds({ items: [] })).toEqual({
      channelId: null,
      uploadsPlaylistId: null,
    });
  });

  it("un canal sin la playlist de subidas deja el campo en null", () => {
    // El canal existe, pero sin playlist no hay nada que preguntar: quien llama lo
    // trata como "no se sabe", nunca como "no está".
    expect(readChannelIds({ items: [{ id: "UC123" }] })).toEqual({
      channelId: "UC123",
      uploadsPlaylistId: null,
    });
    expect(
      readChannelIds({ items: [{ id: "UC123", contentDetails: { relatedPlaylists: {} } }] }),
    ).toEqual({ channelId: "UC123", uploadsPlaylistId: null });
  });

  it("los campos que no son cadenas con contenido se leen como ausencia", () => {
    const payload = {
      items: [{ id: 123, contentDetails: { relatedPlaylists: { uploads: ["UU123"] } } }],
    };

    expect(readChannelIds(payload)).toEqual({ channelId: null, uploadsPlaylistId: null });
  });

  it("un payload sin `items` se avisa, no se lee como que no hay canal", () => {
    for (const roto of [{ error: "nada" }, {}, null, "texto", { items: "una" }]) {
      expect(() => readChannelIds(roto)).toThrow(StreamsError);
    }
  });
});

describe("readUploadedVideoIds: playlistItems.list", () => {
  it("saca los ids de las subidas en el orden en que llegan", () => {
    const payload = {
      items: [
        { contentDetails: { videoId: "v1" } },
        { contentDetails: { videoId: "v2" } },
        { contentDetails: { videoId: "v3" } },
      ],
    };

    expect(readUploadedVideoIds(payload)).toEqual(["v1", "v2", "v3"]);
  });

  it("un item que no se entiende se salta y no invalida la lista", () => {
    const payload = {
      items: [
        { contentDetails: { videoId: "v1" } },
        { contentDetails: {} },
        {},
        "texto",
        { contentDetails: { videoId: 42 } },
        { contentDetails: { videoId: "v2" } },
      ],
    };

    expect(readUploadedVideoIds(payload)).toEqual(["v1", "v2"]);
  });

  it("una playlist sin subidas es una lista vacía, no un fallo", () => {
    expect(readUploadedVideoIds({ items: [] })).toEqual([]);
  });

  it("un payload sin `items` se avisa", () => {
    for (const roto of [{ error: "nada" }, {}, null, { items: {} }]) {
      expect(() => readUploadedVideoIds(roto)).toThrow(StreamsError);
    }
  });
});

describe("anyVideoIsLive: videos.list", () => {
  it("con el snippet en `live` y sin `actualEndTime` está emitiendo", () => {
    // Es la forma que devuelve la API para un canal que está emitiendo ahora mismo.
    const payload = {
      items: [
        {
          id: "v1",
          snippet: { liveBroadcastContent: "live" },
          liveStreamingDetails: { actualStartTime: "2026-10-12T20:59:26Z" },
        },
      ],
    };

    expect(anyVideoIsLive(payload)).toBe(true);
  });

  it("una emisión terminada no se cuenta como directo", () => {
    // Al terminar, el `snippet` pasa a `none` y aparece `actualEndTime`.
    const payload = {
      items: [
        {
          id: "v1",
          snippet: { liveBroadcastContent: "none" },
          liveStreamingDetails: {
            actualStartTime: "2026-10-12T18:00:00Z",
            actualEndTime: "2026-10-12T19:30:00Z",
          },
        },
      ],
    };

    expect(anyVideoIsLive(payload)).toBe(false);
  });

  it("recién terminado: el snippet todavía dice `live` pero con `actualEndTime` no cuela", () => {
    // Pasa de verdad: durante unos minutos después del final el `snippet` sigue
    // diciendo `live`. Sin mirar el `actualEndTime`, el icono se quedaría encendido de
    // más, que es justo el síntoma que esto arregla.
    const payload = {
      items: [
        {
          id: "v1",
          snippet: { liveBroadcastContent: "live" },
          liveStreamingDetails: {
            actualStartTime: "2026-10-12T18:00:00Z",
            actualEndTime: "2026-10-12T19:30:00Z",
          },
        },
      ],
    };

    expect(anyVideoIsLive(payload)).toBe(false);
  });

  it("una emisión de 2016 marcada como `upcoming` no es un directo eterno", () => {
    // El caso real que se encontró al verificar: un vídeo con `actualStartTime` y sin
    // `actualEndTime` que YouTube sigue marcando como `upcoming`. Con los tiempos
    // solos, ese canal saldría en directo todos los días.
    const payload = {
      items: [
        {
          id: "FxaSwC9MLJ0",
          snippet: { liveBroadcastContent: "upcoming" },
          liveStreamingDetails: { actualStartTime: "2016-05-27T23:09:47Z" },
        },
      ],
    };

    expect(anyVideoIsLive(payload)).toBe(false);
  });

  it("una subida normal no trae `liveStreamingDetails` y no es un directo", () => {
    expect(anyVideoIsLive({ items: [{ id: "v1", snippet: { liveBroadcastContent: "none" } }] })).toBe(
      false,
    );
    expect(anyVideoIsLive({ items: [{ id: "v1", snippet: { title: "un vídeo" } }] })).toBe(false);
  });

  it("una emisión programada tampoco: hay `scheduledStartTime`, no `actualStartTime`", () => {
    const payload = {
      items: [
        {
          id: "v1",
          snippet: { liveBroadcastContent: "upcoming" },
          liveStreamingDetails: { scheduledStartTime: "2026-10-13T18:00:00Z" },
        },
      ],
    };

    expect(anyVideoIsLive(payload)).toBe(false);
  });

  it("sin el campo del snippet se cae a los tiempos, no a un `false`", () => {
    // Una versión de la API anterior a `liveBroadcastContent`: empezó y no ha
    // terminado es lo único que se puede afirmar, y afirmar "no está" sería peor.
    expect(
      anyVideoIsLive({
        items: [{ id: "v1", liveStreamingDetails: { actualStartTime: "2026-10-12T20:59:26Z" } }],
      }),
    ).toBe(true);
    expect(
      anyVideoIsLive({
        items: [{ id: "v1", liveStreamingDetails: { actualEndTime: "2026-10-12T20:59:26Z" } }],
      }),
    ).toBe(false);
    expect(anyVideoIsLive({ items: [{ id: "v1", liveStreamingDetails: {} }] })).toBe(false);
  });

  it("basta con que uno de los items esté en directo", () => {
    // Es el caso que justifica pedir cinco subidas y no una: el directo puede no ser
    // el primero de la lista.
    const payload = {
      items: [
        { id: "v1", snippet: { liveBroadcastContent: "none" } },
        {
          id: "v2",
          snippet: { liveBroadcastContent: "none" },
          liveStreamingDetails: { actualEndTime: "2026-10-12T19:30:00Z" },
        },
        {
          id: "v3",
          snippet: { liveBroadcastContent: "live" },
          liveStreamingDetails: { actualStartTime: "2026-10-12T20:00:00Z" },
        },
      ],
    };

    expect(anyVideoIsLive(payload)).toBe(true);
  });

  it("sin items no hay directo, y los items raros no lo inventan", () => {
    expect(anyVideoIsLive({ items: [] })).toBe(false);
    expect(anyVideoIsLive({ items: [null, "texto", { liveStreamingDetails: "sí" }] })).toBe(
      false,
    );
  });

  it("un payload sin `items` se avisa", () => {
    for (const roto of [{ error: "nada" }, {}, null, { items: 0 }]) {
      expect(() => anyVideoIsLive(roto)).toThrow(StreamsError);
    }
  });
});
