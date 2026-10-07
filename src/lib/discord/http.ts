import "server-only";

import { isRecord } from "@/lib/json";
import { getDiscordConfig, type DiscordConfig } from "./env";

/**
 * Único punto de salida HTTP hacia Discord.
 *
 * Es un módulo aparte del cliente de AoE4World y del de los directos por lo que
 * dicen los docblocks de `env.ts`: es otro servicio, con otra autenticación (aquí
 * conviven dos, `Bot <token>` y `Bearer <access_token>`) y otros límites, y
 * mezclarlos haría que el ritmo de uno gobernara al del otro.
 *
 * ## Lo que este módulo NO hace
 *
 * **No reintenta.** Es lo primero que parece faltar al leerlo, y es deliberado: las
 * tres llamadas de este módulo ocurren **dentro de una inscripción interactiva**,
 * una detrás de otra, mientras alguien mira la pantalla. Un *backoff* con reintentos
 * convertiría un fallo de Discord en varios segundos de espera antes de devolverle
 * el formulario a quien está esperando, y el plan de CPU del Worker paga igual por
 * reintentar que por no hacerlo. Quien llama decide: el callback del OAuth
 * redirige a `/participar?discord=error` y la persona vuelve a pulsar el botón.
 *
 * ## El parseo es defensivo y vive en `oauth.ts`
 *
 * Aquí solo se trae el JSON sin leer; el paso de `unknown` a tipos lo hace
 * `parseDiscordUser()` y compañía, en la frontera. La regla es la de siempre en este
 * repositorio: **nunca un `as` sobre la respuesta de la red**, y un payload raro se
 * descarta en vez de guardarse.
 *
 * ## El secreto no aparece en ningún mensaje
 *
 * El canje de token manda el `client_secret` en el cuerpo y el token del bot en una
 * cabecera, así que ningún mensaje de este módulo puede incluir la URL con la que
 * se llama ni el cuerpo de la petición: lo único que sale en el `DiscordError` es
 * el host, la ruta y el estado. Un `console.error` con el secreto dentro acabaría en
 * el log del Worker, que es un sitio de acceso público (ver `redactUrl()` en el
 * cliente de AoE4World, que resuelve el mismo problema).
 */

/** Fallo de una petición a Discord. `status` es `null` cuando no hubo respuesta. */
export class DiscordError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.name = "DiscordError";
    this.status = status;
  }
}

export type DiscordRequestOptions = {
  /** `Authorization` ya montado, si la llamada lo necesita. */
  authorization?: string;
  /** Cuerpo `application/x-www-form-urlencoded` (el canje de token). */
  form?: URLSearchParams;
  /** Cuerpo JSON (el auto-unión). */
  json?: unknown;
};

export type DiscordHttpClient = {
  /**
   * Hace la petición y devuelve el cuerpo ya leído, **sin validar**.
   *
   * Devuelve `null` cuando la respuesta no trae JSON (Discord contesta `204` sin
   * cuerpo al auto-unión cuando la persona ya era miembro) y **lanza**
   * `DiscordError` si la respuesta no es `2xx` o si la petición falla.
   */
  request(
    method: "GET" | "POST" | "PUT",
    path: string,
    options?: DiscordRequestOptions,
  ): Promise<unknown>;
};

/**
 * Descripción del error cuando el propio Discord la da.
 *
 * Discord responde `{"error": "…", "error_description": "…"}` en el canje de token y
 * `{"message": "…", "code": …}` en el resto. Se lee defensivamente y se recorta: el
 * texto va a un log, no a la interfaz, y un mensaje de la API puede ser largo.
 */
function readApiErrorDetail(value: unknown): string {
  if (!isRecord(value)) {
    return "";
  }

  const code = typeof value.error === "string" ? value.error : "";
  const description =
    typeof value.error_description === "string"
      ? value.error_description
      : typeof value.message === "string"
        ? value.message
        : "";

  const detail = [code, description].filter((part) => part !== "").join(": ");

  return detail === "" ? "" : `: ${detail.slice(0, 200)}`;
}

export function createDiscordHttpClient(
  config: DiscordConfig = getDiscordConfig(),
): DiscordHttpClient {
  async function request(
    method: "GET" | "POST" | "PUT",
    path: string,
    options: DiscordRequestOptions = {},
  ): Promise<unknown> {
    const url = `${config.apiBase}${path}`;
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": config.userAgent,
    };

    if (options.authorization !== undefined) {
      headers.Authorization = options.authorization;
    }

    let body: string | undefined;

    if (options.form !== undefined) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      body = options.form.toString();
    } else if (options.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.json);
    }

    let response: Response;

    try {
      response = await fetch(url, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(config.timeoutMs),
        // El token canjeado es de un solo uso y el estado de un miembro cambia:
        // una respuesta cacheada por el runtime sería un token gastado o una
        // pertenencia vieja, que es justo lo que este módulo existe por no leer.
        cache: "no-store",
      });
    } catch (error) {
      const causa = error instanceof Error ? error.message : "causa desconocida";

      throw new DiscordError(
        `No se ha podido llamar a ${path} en Discord: ${causa}`,
        null,
      );
    }

    const payload: unknown = await response.json().catch(() => null);

    if (!response.ok) {
      throw new DiscordError(
        `Discord respondió ${response.status} a ${path}${readApiErrorDetail(payload)}`,
        response.status,
      );
    }

    return payload;
  }

  return { request };
}
