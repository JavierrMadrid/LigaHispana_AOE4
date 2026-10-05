import { afterEach, describe, expect, it, vi } from "vitest";

import type { Aoe4WorldConfig } from "@/lib/aoe4world/env";
import {
  Aoe4WorldError,
  Aoe4WorldNotFoundError,
  Aoe4WorldRateLimitError,
  Aoe4WorldTimeoutError,
  createAoe4WorldHttpClient,
  runWithDeadline,
} from "@/lib/aoe4world/http";

/**
 * El plazo y la cancelación del cliente de AoE4World.
 *
 * Aquí vive la única parte de la política HTTP que no se puede comprobar con datos
 * reales ni contra la base: **qué se reporta cuando una petición termina en el mismo
 * instante en que vence el plazo**. El orden de esas comprobaciones importa más de lo
 * que parece —un `404` leído como "tardó demasiado" haría que el worker reintentara un
 * perfil que no existe y lo tratara como avería de la red—, y es justo el tipo de cosa
 * que se rompe en silencio: nada falla, solo deja de tratarse bien un caso.
 *
 * Los plazos se miden con **cronizadores falsos**: el test decide cuándo vence el plazo,
 * así que la carrera que reproduce el fallo es determinista y no hay esperas reales. Por
 * eso los dobles de `fetch` **escuchan la señal**: un `fetch` real se aborta, y si el
 * doble no lo hiciera la carrera no se parecería a la que importa.
 */

/** Un error del dominio de quien llama, para comprobar que el plazo no lo tapa. */
class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainError";
  }
}

const CONFIG: Aoe4WorldConfig = {
  apiBase: "https://aoe4world.example",
  timeoutMs: 100,
  userAgent: "LigaHispanaAOE4/0.1 (sync AoE4World)",
  apiKey: null,
  maxRetries: 0,
  retryBaseMs: 1,
  retryMaxMs: 10,
  minRequestIntervalMs: 0,
  syncConcurrency: 1,
  syncPageSize: 50,
  syncMaxPages: 1,
  syncDeadlineMs: 1_000,
  mock: false,
};

/**
 * Un `fetch` falso con `honraSignal` para reproducir las dos situaciones:
 *
 * - `true` (lo normal): se aborta si lo cancelan, como el `fetch` de verdad. Sirve para
 *   comprobar que el plazo **sí** se ve cuando la petición está en vuelo.
 * - `false`: ignora la señal y contesta cuando le toca. Es la carrera del docblock de
 *   `runWithDeadline()`: la respuesta **ya había llegado** cuando venció el plazo, así
 *   que el abort ya no puede deshacerla y la operación llega a lanzar su propio error
 *   con `timedOut === true`. Un `fetch` real con el cuerpo ya en memoria se parece a esto.
 */
function fetchQueResponde(
  status: number,
  delayMs: number,
  { honraSignal = true, headers = {} }: { honraSignal?: boolean; headers?: HeadersInit } = {},
) {
  const fake = vi.fn(
    (_url: unknown, init?: { signal?: AbortSignal }) =>
      new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(
          () => resolve(new Response(status === 429 ? null : "{}", { status, headers })),
          delayMs,
        );

        if (!honraSignal) {
          return;
        }

        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("petición abortada"));
        });
      }),
  );

  vi.stubGlobal("fetch", fake);

  return fake;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/* -------------------------------------------------------------------------- */

describe("runWithDeadline", () => {
  it("devuelve el valor si la operación acaba antes de que venza el plazo", async () => {
    vi.useFakeTimers();

    const outcome = await runWithDeadline(1_000, undefined, async () => "hecho");

    expect(outcome).toEqual({ kind: "value", value: "hecho" });
  });

  it("el plazo vence con la operación en vuelo y no se pierde su error", async () => {
    // **El caso que importa.** La operación lanza su propio error en el mismo tick en
    // que vence el plazo. El error tiene que seguir ahí, porque quien llama es el
    // único que sabe distinguir "su" error de un abort, así que el helper no puede
    // decidir y mucho menos taparlo.
    vi.useFakeTimers();

    const domain = new DomainError("el recurso no existe");
    const promise = runWithDeadline(100, undefined, async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));

      throw domain;
    });

    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);

    const outcome = await promise;

    expect(outcome).toEqual({ kind: "failed", error: domain, timedOut: true, cancelled: false });
  });

  it("un fallo de red sin plazo ni cancelación sale con los tres hechos a `false`", async () => {
    const red = new TypeError("fetch failed");
    const outcome = await runWithDeadline(1_000, undefined, async () => {
      throw red;
    });

    expect(outcome).toEqual({ kind: "failed", error: red, timedOut: false, cancelled: false });
  });

  it("la cancelación del llamante se distingue del plazo, y su error también se conserva", async () => {
    const motivo = new Error("el worker terminó su plazo global");
    const controller = new AbortController();

    const outcome = await runWithDeadline(10_000, controller.signal, async () => {
      controller.abort(motivo);

      throw motivo;
    });

    expect(outcome).toEqual({ kind: "failed", error: motivo, timedOut: false, cancelled: true });
  });

  it("el plazo sigue armado mientras la operación lee el cuerpo", async () => {
    // Es la razón de que el temporizador se limpie en el `finally` de la operación
    // completa y no al terminar la respuesta: una respuesta que llega y se queda
    // colgada al leer el cuerpo tiene que vencer igual.
    vi.useFakeTimers();

    const promise = runWithDeadline(100, undefined, (signal) => {
      const cuerpo = new Promise<string>((resolve) => setTimeout(() => resolve("cuerpo"), 500));

      // Dos temporizadores vivos: el del plazo y el de la lectura del cuerpo.
      expect(vi.getTimerCount()).toBe(2);

      return Promise.race([
        cuerpo,
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("abortada")));
        }),
      ]);
    });

    await vi.advanceTimersByTimeAsync(100);

    expect(await promise).toEqual({
      kind: "failed",
      timedOut: true,
      cancelled: false,
      error: expect.any(Error),
    });
  });

  it("limpia el temporizador al terminar: una operación larga no deja el plazo vivo", async () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");

    await runWithDeadline(1_000_000, undefined, async () => "hecho");

    expect(clearSpy).toHaveBeenCalled();
    // Si el temporizador siguiera vivo, quedaría pendiente para siempre.
    expect(vi.getTimerCount()).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */

describe("createAoe4WorldHttpClient", () => {
  it("un 404 sigue siendo `Aoe4WorldNotFoundError` aunque el plazo venza en ese instante", async () => {
    // **La regresión.** `performRequest()` recibe el error de la operación y los hechos
    // del plazo, y los mira en este orden: primero el error propio. Si el plazo ganara,
    // este 404 saldría como `Aoe4WorldTimeoutError` —reintentable— y el worker dejaría
    // de tratar al jugador como "AoE4World no conoce este perfil".
    vi.useFakeTimers();
    fetchQueResponde(404, 200, { honraSignal: false });

    const client = createAoe4WorldHttpClient(CONFIG);
    const assertion = expect(client.fetchJson("/players/1")).rejects.toBeInstanceOf(
      Aoe4WorldNotFoundError,
    );

    await vi.advanceTimersByTimeAsync(200);

    await assertion;
    expect(client.stats.retries).toBe(0);
  });

  it("un 429 se reconoce como tal aunque el plazo venza en ese instante", async () => {
    // Misma razón que el 404, y además un 429 trae información propia —cuánto esperar—
    // que un timeout no tiene: aquí se ve en que la pausa global sale de `Retry-After`.
    vi.useFakeTimers();
    fetchQueResponde(429, 200, { honraSignal: false, headers: { "retry-after": "7" } });

    const client = createAoe4WorldHttpClient(CONFIG);
    const assertion = expect(client.fetchJson("/leaderboards/rm_solo")).rejects.toBeInstanceOf(
      Aoe4WorldRateLimitError,
    );

    await vi.advanceTimersByTimeAsync(200);

    await assertion;
    expect(client.stats.rateLimitResponses).toBe(1);
    expect(client.stats.rateLimitPausesMs).toBe(7_000);
  });

  it("un fallo de red sin plazo ni cancelación sale como avería reintentable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );

    const client = createAoe4WorldHttpClient(CONFIG);

    await expect(client.fetchJson("/players/1")).rejects.toMatchObject({
      status: null,
      retryable: true,
    });
  });

  it("sin plazo ni cancelación, un error de AoE4World se propaga tal cual", async () => {
    // El caso trivial de la precedencia, para dejar escrito que `performRequest()` no
    // reescribe lo que la operación lanza.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Aoe4WorldError("prueba", { status: 403 });
      }),
    );

    const client = createAoe4WorldHttpClient(CONFIG);

    await expect(client.fetchJson("/players/1")).rejects.toMatchObject({ status: 403 });
  });

  it("la cancelación del llamante no se reporta como avería de la API", async () => {
    // `fetchJson()` propaga el error de la cancelación tal cual, para que el worker la
    // distinga de un fallo de la API (que sí se reintenta y se registra).
    vi.useFakeTimers();

    const motivo = new Error("fin de la pasada");
    const controller = new AbortController();
    fetchQueResponde(200, 500);

    const client = createAoe4WorldHttpClient(CONFIG);
    const assertion = expect(
      client.fetchJson("/players/1", undefined, { signal: controller.signal }),
    ).rejects.toBe(motivo);

    controller.abort(motivo);
    await vi.advanceTimersByTimeAsync(200);

    await assertion;
    expect(client.stats.retries).toBe(0);
  });

  it("el tiempo agotado sí se reporta como avería reintentable", async () => {
    // El contrapunto del anterior: aquí el plazo es el veredicto, y es reintentable
    // para que la siguiente pasada lo vuelva a intentar.
    vi.useFakeTimers();
    fetchQueResponde(200, 500);

    const client = createAoe4WorldHttpClient(CONFIG);
    const assertion = expect(client.fetchJson("/players/1")).rejects.toBeInstanceOf(
      Aoe4WorldTimeoutError,
    );

    await vi.advanceTimersByTimeAsync(200);

    await assertion;
  });
});
