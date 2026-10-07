import { describe, expect, it, vi } from "vitest";

import type { StreamsConfig } from "@/lib/streams/env";
import { createStreamsHttpClient, StreamsError } from "@/lib/streams/http";

/**
 * El detalle del error de una API externa, y por qué el `reason` importa.
 *
 * Aquí está lo que hacía que una credencial caducada pasara **tres días** sin que nadie
 * lo notara. El rastro de la pasada (`streamsError`) solo llevaba la prosa de Google —
 * "API key expired. Please renew the API key."—, que es texto pensado para leerse en un
 * `curl` donde se está mirando la clave, no para un log donde hay que averiguar qué
 * ha pasado con un canal que lleva días sin detectar el directo. El `reason` es lo que
 * lo hace accionable: `API_KEY_EXPIRED` no se confunde con `API_KEY_INVALID` ni con
 * `quotaExceeded`, y se lee sin traducir nada.
 *
 * Se comprueba contra un `fetch` falso, sin red, y sobre el mensaje que sale tal cual:
 * lo que importa es qué acaba leyendo alguien en el panel, no qué devuelve una función
 * interna. La clave se manda en la query —la Data API la espera ahí— y `redactUrl()`
 * la borra: que el mensaje del error no la contenga es parte de lo que se comprueba,
 * porque ese mensaje acaba en un log del Worker.
 */

const CONFIG: StreamsConfig = {
  youtubeApiKey: "clave-de-prueba",
  youtubeApiBase: "https://youtube.example/youtube/v3",
  kickApiBase: "https://kick.example",
  timeoutMs: 1_000,
  userAgent: "test",
  maxRetries: 0,
  retryBaseMs: 1,
  retryMaxMs: 10,
  minRequestIntervalMs: 0,
  maxChecksPerRun: 10,
};

type Respuesta = { status: number; body: unknown };

/** Un cliente con un `fetch` falso que conteste una respuesta preparada. */
function clienteCon(respuesta: Respuesta) {
  const fetchMock = vi.fn(async () => ({
    ok: respuesta.status >= 200 && respuesta.status < 300,
    status: respuesta.status,
    headers: new Headers(),
    json: async () => respuesta.body,
  }));

  vi.stubGlobal("fetch", fetchMock);

  return { cliente: createStreamsHttpClient(CONFIG), fetchMock };
}

async function pedir(cliente: ReturnType<typeof createStreamsHttpClient>): Promise<unknown> {
  const url = new URL(`${CONFIG.youtubeApiBase}/search`);

  url.searchParams.set("channelId", "UC123");

  return cliente.fetchJson(url);
}

describe("el detalle del error de la API de streams", () => {
  it("antepone el reason de Google al mensaje, que es lo accionable", async () => {
    const { cliente } = clienteCon({
      status: 400,
      body: {
        error: {
          code: 400,
          message: "API key expired. Please renew the API key.",
          errors: [{ reason: "API_KEY_EXPIRED", message: "API key expired." }],
        },
      },
    });

    const error = await pedir(cliente).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(StreamsError);
    expect((error as StreamsError).message).toContain("API_KEY_EXPIRED");
    expect((error as StreamsError).message).toContain("API key expired. Please renew the API key.");
  });

  it("deja el mensaje intacto cuando la API no envía reason", async () => {
    // Kick no tiene contrato de error: lo único que llega es el estado. El `reason` era
    // opcional desde el principio, así que su ausencia no puede cambiar el mensaje ni
    // hacer que se pierda información que antes estaba.
    const { cliente } = clienteCon({ status: 503, body: null });

    const error = await pedir(cliente).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(StreamsError);
    expect((error as StreamsError).message).not.toContain("null");
    expect((error as StreamsError).message).toContain("503");
  });

  it("no deja la clave en el mensaje, que acaba en un log", async () => {
    const { cliente } = clienteCon({
      status: 403,
      body: { error: { code: 403, message: "quota exceeded", errors: [{ reason: "quotaExceeded" }] } },
    });

    const error = await pedir(cliente).catch((caught: unknown) => caught);

    expect((error as StreamsError).message).not.toContain(CONFIG.youtubeApiKey ?? "");
    expect((error as StreamsError).message).toContain("quotaExceeded");
  });

  it("trata un 4xx como fatal y un 5xx como reintentable", async () => {
    // Lo decide `fatal`, y de eso depende que la pasada deje de preguntar a la
    // plataforma entera en vez de gastar el presupuesto del tope en llamadas que van a
    // fallar igual. Un error de clave caducada es de los primeros: reintentar no lo
    // arregla. Un 503 sí se reintenta, y por eso con `maxRetries: 0` sale igualmente.
    const caducada = clienteCon({ status: 400, body: { error: { errors: [{ reason: "API_KEY_EXPIRED" }] } } });
    const errorFatal = await pedir(caducada.cliente).catch((caught: unknown) => caught);

    expect((errorFatal as StreamsError).fatal).toBe(true);
    expect((errorFatal as StreamsError).retryable).toBe(false);

    const caido = clienteCon({ status: 500, body: null });
    const errorRetry = await pedir(caido.cliente).catch((caught: unknown) => caught);

    expect((errorRetry as StreamsError).fatal).toBe(false);
    expect((errorRetry as StreamsError).retryable).toBe(true);
  });
});