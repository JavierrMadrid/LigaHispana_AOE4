import "server-only";

import { isRecord } from "@/lib/json";
import { getStreamsConfig, type StreamsConfig } from "./env";
import { StreamsError, type StreamsHttpClient, type StreamsRequestOptions } from "./http";

/**
 * Detección de directo en Kick.
 *
 * ## El endpoint es **no documentado**
 *
 * `GET https://kick.com/api/v2/channels/<slug>` es un endpoint privado del sitio, no
 * una API pública: no hay developer portal, ni documentación, ni registro, ni cuota
 * declarada. Se usa porque es **lo único que hay sin clave ni registro** —Kick no
 * ofrece nada comparable, y la alternativa sería no detectar nada en Kick o meter
 * un scraping del HTML de la web, que es frágil y bastante menos honesto— y porque
 * responde el mismo dato que buscamos: si el canal está emitiendo.
 *
 * ## Qué implica que no esté documentado
 *
 * Tres cosas concretas, y las tres son la razón de que este módulo sea degradable:
 *
 * 1. **Puede dejar de funcionar o cambiar de forma.** Si algún día el endpoint
 *    desaparece, pasa a pedir credenciales, cambia el nombre del campo o responde
 *    otra cosa, este módulo **no lo nota y no rompe nada**: la respuesta que no se
 *    entiende se convierte en `null`, el canal se queda en su estado anterior y el
 *    motivo va al rastro de la pasada (`streamsError`) con un aviso. Nunca es un
 *    error que tumbe la sincronización.
 * 2. **Puede devolver un `4xx` que no significa lo que parece.** Un `403` aquí no
 *    es "no autorizado" sino, casi siempre, "te ha detectado"; el cliente HTTP lo
 *   trata como no reintentable y lo registra, no lo reintenta en bucle.
 * 3. **No se puede prometer nada de su formato más allá de lo que se ve hoy.** Por eso
 *    la lectura es defensiva (`isRecord` y comprobaciones de tipo en cada salto) y no
 *    un `as` sobre el JSON: un payload raro se descarta, no se interpreta a medias.
 *
 * **Si algún día deja de servir**, el sustituto no es tocar este archivo: es que el
 * estado de Kick se quede en `false` y con un aviso que lo diga, y que la
 * organización decida si merece la pena otra vía. Es exactamente el mismo criterio
 * degradante que el captcha sin secret key.
 */

/**
 * Campo que trae el estado de emisión. Kick lo llama `livestream` y dentro va
 * `is_live`.
 *
 * Se acepta además `is_live` en la raíz porque el endpoint ha movido el campo entre
 * versiones y no cuesta nada leer los dos: la alternativa es dejar de detectar
 * directos sin que nadie entienda por qué.
 */
function readIsLive(payload: unknown): boolean | null {
  if (!isRecord(payload)) {
    return null;
  }

  const livestream = payload.livestream;

  if (isRecord(livestream) && typeof livestream.is_live === "boolean") {
    return livestream.is_live;
  }

  return typeof payload.is_live === "boolean" ? payload.is_live : null;
}

/**
 * ¿Está este canal de Kick emitiendo ahora mismo?
 *
 * `null` cuando no se ha podido saber, y el llamante **no** escribe nada en ese
 * caso: un `false` escrito por un fallo publicaría "no está en directo" cuando lo
 * cierto es "no lo sabemos". Un canal que Kick no conoce **sí** devuelve `false` —
 * un `404` aquí significa que el slug no existe, no que el servicio esté roto—, y
 * ese caso no es un fallo sino una respuesta.
 */
export async function isKickChannelLive(
  slug: string,
  http: StreamsHttpClient,
  config: StreamsConfig = getStreamsConfig(),
  options: StreamsRequestOptions = {},
): Promise<boolean | null> {
  const url = new URL(`${config.kickApiBase}/api/v2/channels/${slug}`);

  let payload: unknown;

  try {
    payload = await http.fetchJson(url, options);
  } catch (error) {
    // Un 404 es "este canal no existe", que es una respuesta y no un fallo: el
    // llamante escribe `false` y deja de preguntar cada cinco minutos. El resto se
    // propaga para que el resumen registre el motivo literal.
    if (error instanceof StreamsError && error.status === 404) {
      return false;
    }

    throw error;
  }

  return readIsLive(payload);
}