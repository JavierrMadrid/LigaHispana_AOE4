/**
 * Campaña de donaciones del torneo (Matcherino).
 *
 * Es un **contrato puro**: no importa `db` ni `server-only`, así que se puede
 * comprobar con Vitest sin base de datos ni red. Vive aparte de quien la lee y la
 * escribe porque el mismo valor lo consumen el servidor (el banner del layout
 * público), el panel (`/admin`) y este parser: un único módulo normal, con lo
 * justo para que las tres partes lean la misma cosa. Es el mismo patrón del plazo
 * de inscripción (`src/lib/registration-open.ts`) y del catálogo de países.
 *
 * ## La fuente de verdad es `Setting`
 *
 * Ni la activación ni la URL las decide el código: viven en
 * `Setting["donations.matcherino"]`, que la organización cambia desde el panel
 * sin desplegar, igual que el plazo de inscripción o el ruleset. No va en
 * variables de entorno a propósito: es un dato editorial del torneo —qué campaña
 * se apoya y dónde—, no configuración de despliegue. Quien lo lee y lo escribe es
 * `src/lib/settings.ts` (`readMatcherinoDonations` / `writeMatcherinoDonations`);
 * el banner público solo pinta su cara visible.
 *
 * ## Por qué el valor por defecto es "desactivada"
 *
 * `DEFAULT_MATCHERINO_DONATIONS` viene apagado y sin URL: mientras nadie haya
 * publicado la clave, no hay banner. Activar la campaña es una decisión explícita
 * de la organización y no el estado en que queda el sistema si nadie dice nada.
 * Es también lo que pide la issue: dejar la función lista pero sin activar (o con
 * una cuenta de prueba) hasta que la organización quiera publicarla.
 *
 * ## Por qué el banner necesita las dos cosas
 *
 * `enabled` sin una URL utilizable sería un enlace vacío, así que el parser no
 * deja un valor activo sin dirección: si `enabled` es `true` pero la URL no vale,
 * la campaña sale apagada. De ese modo quien pinte puede mirar solo `enabled` y no
 * puede acabar renderizando un `href` basura, y el panel no puede publicar un
 * banner que no lleva a ningún sitio.
 */

import { isRecord } from "@/lib/json";

/** Clave de `Setting` donde vive la campaña de donaciones. */
export const MATCHERINO_DONATIONS_KEY = "donations.matcherino";

/** La campaña de donaciones guardada. */
export type MatcherinoDonations = {
  /** Si la organización ha activado el banner **y** hay una URL utilizable. */
  enabled: boolean;
  /** Dirección de la campaña. `""` significa "sin URL". */
  url: string;
};

/** ¿Hay campaña publicada si `Setting` no tiene la clave? No. */
export const DEFAULT_MATCHERINO_DONATIONS: MatcherinoDonations = {
  enabled: false,
  url: "",
};

/**
 * La URL de la campaña, o `""` si lo guardado no es una dirección utilizable.
 *
 * Se exige `http` o `https` porque este valor acaba en el `href` de un enlace: un
 * `javascript:` o un `data:` serían una vía de ejecución en la página, y un texto
 * suelto sin esquema sería un enlace roto. `new URL` es puro —no hace red—, así
 * que la comprobación se puede testear como cualquier otra regla. La dirección se
 * guarda tal cual (solo recortada) para no reescribir lo que pegó la organización.
 */
function parseUrl(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }

  const candidate = value.trim();

  if (candidate === "") {
    return "";
  }

  try {
    const { protocol } = new URL(candidate);

    return protocol === "http:" || protocol === "https:" ? candidate : "";
  } catch {
    return "";
  }
}

/**
 * Lee la campaña guardada. Devuelve el valor por defecto si no es legible.
 *
 * Acepta `unknown` porque lo que llega es la columna `Setting.value`, que es
 * `Json`: cualquier cosa pudo escribirse a mano en el panel. Un valor que no sea
 * un objeto, o cuyos campos no tengan el tipo esperado, cae al default con el
 * mismo criterio de degradación que `parseRegistrationOpen()` y `mergeCountries()`:
 * un dato guardado inútil no puede dejar la web con un banner roto.
 *
 * Un `enabled` que no sea `true` cuenta como apagado (el estado seguro), y una
 * `url` vacía, que no sea cadena o que no sea `http`/`https` cuenta como "sin
 * URL". Las dos condiciones juntas: sin URL utilizable la campaña sale apagada
 * (ver el docblock del módulo).
 */
export function parseMatcherinoDonations(value: unknown): MatcherinoDonations {
  if (!isRecord(value)) {
    return { ...DEFAULT_MATCHERINO_DONATIONS };
  }

  const url = parseUrl(value["url"]);

  return {
    enabled: value["enabled"] === true && url !== "",
    url,
  };
}
