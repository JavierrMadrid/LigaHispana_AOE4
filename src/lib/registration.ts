import "server-only";

import { createAoe4WorldClient, type Aoe4WorldClient } from "@/lib/aoe4world/client";
import { Aoe4WorldNotFoundError } from "@/lib/aoe4world/http";
import type { Aoe4WorldPlayer } from "@/lib/aoe4world/types";
import { readRuntimeEnv } from "@/lib/runtime-env";

/**
 * Comprobación de que un `profileId` existe de verdad en AoE4World, para la
 * inscripción pública de `/participar`.
 *
 * Vive fuera de la Server Action por la misma razón que el resto de la lógica
 * de datos en `src/lib/`: la acción es un endpoint público y lo que decide tiene
 * que estar en el servidor, y así además se puede verificar sin una petición.
 *
 * El criterio es **cerrar en vez de dejar pasar**. Solo hay dos salidas de la
 * comprobación: el perfil existe, o no se ha podido saber que exista. Un 404 es
 * la única señal fiable de "ese perfil no existe" y por eso se distingue del
 * resto; cualquier otro fallo (red, 429, timeout, payload raro) devuelve
 * `unavailable` y la inscripción **no** se crea. Aceptar el `profileId` declarado
 * sin comprobarlo dejaría pasar cualquier número inventado, y eso es justo lo que
 * este módulo evita.
 *
 * En el camino `ok` viaja también el **país del perfil**, porque es el dato con el
 * que la inscripción contrasta el que eligió la persona (ver
 * `findCountryIsoConflict()`). Aquí solo se traduce el JSON y se deja pasar el
 * valor tal cual: decidir si dos países se contradicen es de la lista admitida, y
 * esta comprobación no la conoce.
 */

const DEFAULT_PROFILE_TIMEOUT_MS = 8_000;

export type ProfileCheck =
  | {
      status: "ok";
      /** Nombre oficial de AoE4World, para `Player.aoe4WorldName`. */
      name: string;
      /** `avatars.full` o `null`; null = la tabla dibujará un monograma. */
      avatarUrl: string | null;
      /**
       * `country` del perfil: un **ISO 3166-1 alfa-2 en minúsculas** (la API lo
       * manda así: `"co"`, `"do"`, `"pr"`…) o `null` si el perfil no tiene país.
       *
       * Viene sin traducir a propósito: el rótulo canónico es cosa de la lista
       * admitida, que vive en `Setting`, y quien lo necesita
       * (`findCountryIsoConflict()`, en `src/lib/countries.ts`) lo resuelve contra
       * ella. Un `null` es un dato en sí mismo —el perfil no dice de dónde es— y no
       * un fallo de esta comprobación.
       */
      country: string | null;
    }
  /** La API respondió 404: el perfil no existe. */
  | { status: "not-found" }
  /**
   * No se ha podido comprobar. `reason` es solo para el log del servidor: al
   * formulario no vuelve nunca.
   */
  | { status: "unavailable"; reason: string };

export type ProfileCheckOptions = {
  /** Cliente alternativo, para verificar sin salir a la red. */
  client?: Aoe4WorldClient;
  /** Presupuesto total de la comprobación, en milisegundos. */
  timeoutMs?: number;
};

/**
 * Presupuesto de la comprobación.
 *
 * El cliente de la API reintenta hasta 3 veces con *backoff* y cada intento
 * espera su propio `AOE4WORLD_TIMEOUT_MS` (15 s por defecto): sin un tope aquí,
 * un formulario que una persona está mirando podría tardar un minuto en
 * responder, y durante ese minuto sigue gastando cuota. Con 8 s caben el intento
 * inicial y algún reintento, que es lo que hace falta cuando la API va lenta;
 * cuando va muy lenta, sale el mensaje de "inténtalo en unos minutos", que es la
 * respuesta correcta.
 */
function readProfileTimeoutMs(): number {
  const raw = readRuntimeEnv("REGISTRATION_PROFILE_TIMEOUT_MS")?.trim() ?? "";

  if (raw === "") {
    return DEFAULT_PROFILE_TIMEOUT_MS;
  }

  const value = Number(raw);

  if (!Number.isFinite(value) || value <= 0) {
    console.warn(
      `[registro] REGISTRATION_PROFILE_TIMEOUT_MS no es un número positivo (valor recibido: "${raw}"): ` +
        `se usa ${DEFAULT_PROFILE_TIMEOUT_MS}.`,
    );
    return DEFAULT_PROFILE_TIMEOUT_MS;
  }

  return Math.floor(value);
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export async function checkAoe4WorldProfile(
  profileId: number,
  options: ProfileCheckOptions = {},
): Promise<ProfileCheck> {
  const client = options.client ?? createAoe4WorldClient();
  const timeoutMs = options.timeoutMs ?? readProfileTimeoutMs();

  try {
    const profile: Aoe4WorldPlayer = await client.getPlayer(profileId, {
      // `AbortSignal.timeout` y no el timeout propio del cliente: este es el
      // presupuesto de **esta** petición interactiva, con la cancelación
      // incluida, y tiene que mandar sobre los reintentos que pueda querer hacer
      // la capa de HTTP.
      signal: AbortSignal.timeout(timeoutMs),
    });

    return {
      status: "ok",
      name: profile.name,
      avatarUrl: profile.avatars.full,
      country: profile.country,
    };
  } catch (error) {
    if (error instanceof Aoe4WorldNotFoundError) {
      return { status: "not-found" };
    }

    // Cualquier otra cosa (red, 429, timeout, respuesta que no se sabe leer) es
    // "no se ha podido comprobar", no "el perfil no existe". La razón se queda
    // aquí: al formulario solo le vuelve un mensaje sin detalles internos.
    return { status: "unavailable", reason: describe(error) };
  }
}
