import "server-only";

import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { isRecord } from "@/lib/json";

/**
 * La configuración de la edición: nombre, premio, retransmisión y marca.
 *
 * ## Qué es y por qué vive en `Setting`
 *
 * Es lo que distingue una edición de la siguiente —el nombre que se enseña, el
 * premio base, si la retransmisión es obligatoria y el emblema y color de acento—
 * y **no** lo decide el código: vive en `Setting["edition.config"]`, un documento
 * JSON que la organización cambia desde el panel sin desplegar. Es el mismo patrón
 * que el ruleset de puntos (`scoring.ruleset`), el de alertas y la lista de países.
 *
 * No puede ser un enum del schema por la razón de siempre: añadir un campo
 * obligaría a un `db push` sobre la base de producción, y esto se cambia entre
 * ediciones, no entre versiones del software.
 *
 * ## La versión la fija el código
 *
 * Como en los rulesets: `EDITION_CONFIG_VERSION` la declara el código y el
 * documento guardado solo la copia. Si el documento guardado no coincide en versión,
 * **se descarta entero** con un aviso y se usa el valor por defecto: un documento que
 * describe otra estructura no se puede aplicar "a lo que se parezca". A diferencia
 * del ruleset de puntos, aquí no hay versión anterior que migrar (la 1 es la
 * primera).
 *
 * ## Nunca lanza al leer
 *
 * `mergeEditionConfig()` es pura y no lanza: un campo que no se entiende se avisa y
 * se queda en su valor por defecto, porque un documento a medias sigue describiendo
 * una edición publicable. Lo que **sí** se propaga es un fallo de la base de datos,
 * como en `readRegistrationOpen()`: "no hay nada configurado" tiene su valor por
 * defecto y "no se ha podido leer" no, y quien pinta el nombre o el premio tiene que
 * poder distinguir lo segundo para no publicar datos inventados.
 *
 * ## Quién lo escribe
 *
 * La Server Action `saveEditionConfig` (`src/app/admin/administracion/actions.ts`),
 * que es **solo del superadministrador**. El rastro del cambio va en `AdminAction`
 * (`CONFIG_CHANGED`), escrito por quien llama en la misma transacción que el
 * `upsert`.
 */

/** Clave de `Setting` donde vive la configuración de la edición. */
export const EDITION_CONFIG_KEY = "edition.config";

/**
 * Versión de la **forma** del documento. La fija el código: cambiar un valor no
 * requiere despliegue, cambiar la estructura sí.
 */
export const EDITION_CONFIG_VERSION = 1;

/**
 * Tope del nombre de la edición, en caracteres.
 *
 * Es un dato que se pinta en una cabecera y en un `title` de pestaña, no un texto
 * libre: 60 cabe en las dos sin que haya que decidir si se recorta.
 */
export const EDITION_NAME_MAX_LENGTH = 60;

/** Tope de la nota del premio, en caracteres. */
export const EDITION_PRIZE_NOTE_MAX_LENGTH = 120;

/** Forma exacta del color de acento: `#rrggbb`, en minúsculas. */
const ACCENT_COLOR_PATTERN = /^#[0-9a-f]{6}$/;

/**
 * Premio base de la edición.
 *
 * `amount` a `null` es **"no hay premio anunciado"**, que es distinto de un premio
 * de 0: lo primero no se pinta, lo segundo es un dato. La nota es opcional y solo
 * tiene sentido con importe (una nota sin premio describiría algo que no hay).
 */
export type EditionPrize = {
  /** Importe en euros, entero; `null` si no hay premio anunciado. */
  amount: number | null;
  /** Aclaración corta del premio (reparto, condiciones); `null` si no hay. */
  note: string | null;
};

/**
 * Marca de la edición.
 *
 * El layout **no** se toca desde aquí: el color de acento se publica para que la
 * interfaz lo aplique como variable CSS y el emblema sustituye al del sitio. Los dos
 * son opcionales (`null` = el sitio usa los suyos).
 */
export type EditionBranding = {
  /**
   * URL del emblema: `http(s)` o una **ruta del propio sitio** que empiece por `/`.
   * Cualquier otra cosa (un `javascript:`, un texto suelto) se descarta.
   */
  emblemUrl: string | null;
  /** Color de acento en `#rrggbb` minúsculas, o `null` para el del sitio. */
  accentColor: string | null;
};

export type EditionConfig = {
  version: number;
  /** Nombre de la edición tal y como se enseña. Nunca vacío. */
  name: string;
  prize: EditionPrize;
  /**
   * ¿La retransmisión es obligatoria en esta edición?
   *
   * Cuando está activo, el motor de alertas evalúa `NO_STREAM_CHANNEL` sobre los
   * participantes aprobados sin ningún canal de directo. Apagarlo **no** borra las
   * alertas ya escritas: `Alert` es *append-only*.
   */
  streamingRequired: boolean;
  branding: EditionBranding;
};

/**
 * La configuración con la que arranca una edición mientras nadie publique nada.
 *
 * El nombre es el que ya enseña la web, y todo lo demás viene **vacío o apagado**:
 * sin premio anunciado, sin retransmisión obligatoria y sin emblema ni color
 * propios. Publicar un premio o exigir retransmisión es una decisión explícita de
 * la organización, no el estado en que queda el sistema si nadie dice nada.
 */
export const DEFAULT_EDITION_CONFIG: EditionConfig = {
  version: EDITION_CONFIG_VERSION,
  name: "Liga Hispana AoE IV",
  prize: { amount: null, note: null },
  streamingRequired: false,
  branding: { emblemUrl: null, accentColor: null },
};

/** Copia nueva del documento por defecto: quien la reciba puede escribir en ella. */
function defaultEditionConfig(): EditionConfig {
  return {
    ...DEFAULT_EDITION_CONFIG,
    prize: { ...DEFAULT_EDITION_CONFIG.prize },
    branding: { ...DEFAULT_EDITION_CONFIG.branding },
  };
}

/** Cliente con la única tabla que necesita este módulo (`db` o una `tx`). */
export type EditionConfigClient = Pick<Prisma.TransactionClient, "setting">;

export type EditionConfigMergeResult = {
  /** La configuración efectiva, ya validada y normalizada. */
  config: EditionConfig;
  /** Lo que no se ha podido aplicar; se avisa y se queda el valor por defecto. */
  warnings: string[];
};

/* -------------------------------------------------------------------------- */
/* Validación campo a campo                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Un texto guardado, ya recortado, o `null` si no hay nada que guardar.
 *
 * `null` cuando no es una cadena y cuando está vacío: un texto vacío y un campo
 * ausente significan lo mismo en este documento ("no se ha configurado"), y
 * distinguirlos solo daría dos formas de decir nada.
 */
function optionalText(value: unknown, max: number, field: string, warnings: string[]): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value !== "string") {
    warnings.push(`${field} no es un texto: ${JSON.stringify(value)}`);
    return null;
  }

  const text = value.trim();

  if (text === "") {
    return null;
  }

  if (text.length > max) {
    warnings.push(`${field} pasa de ${max} caracteres; se ignora`);
    return null;
  }

  return text;
}

/**
 * El nombre de la edición: obligatorio y con tope.
 *
 * Es el único campo de texto que **no** puede quedar vacío: la cabecera del sitio
 * no se puede quedar sin nombre. Un valor que no sirve cae al de por defecto, que es
 * lo que ya enseña la web.
 */
function parseName(value: unknown, warnings: string[]): string {
  if (value === undefined) {
    return DEFAULT_EDITION_CONFIG.name;
  }

  const name = optionalText(value, EDITION_NAME_MAX_LENGTH, "name", warnings);

  if (name === null) {
    warnings.push("name está vacío o no sirve; se usa el nombre por defecto");
    return DEFAULT_EDITION_CONFIG.name;
  }

  return name;
}

/** Un importe en euros: entero, no negativo. `null` = sin premio anunciado. */
function parseAmount(value: unknown, warnings: string[]): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    warnings.push(`prize.amount no es un importe entero en euros: ${JSON.stringify(value)}`);
    return null;
  }

  return value;
}

function parsePrize(value: unknown, warnings: string[]): EditionPrize {
  if (value === undefined) {
    return { ...DEFAULT_EDITION_CONFIG.prize };
  }

  if (!isRecord(value)) {
    warnings.push("prize no es un objeto");
    return { ...DEFAULT_EDITION_CONFIG.prize };
  }

  const amount = parseAmount(value.amount, warnings);
  const note = optionalText(value.note, EDITION_PRIZE_NOTE_MAX_LENGTH, "prize.note", warnings);

  return { amount, note };
}

/**
 * ¿El texto es un emblema admisible: `http(s)` o una ruta del propio sitio?
 *
 * Se exige `http` o `https` porque el valor acaba en el `src` de una imagen: un
 * `javascript:` o un `data:` serían una vía de inyección. La ruta que empieza por
 * `/` se admite porque el emblema de una edición es un fichero del propio
 * repositorio (`/ediciones/2026/emblema.png`), que es el caso normal; `//` no, que
 * es una URL sin esquema y por tanto un tercero. `new URL` es puro —no hace red—,
 * así que la comprobación se puede testear como cualquier otra regla.
 *
 * Se exporta para que el panel pueda decir el motivo antes de guardar con sus
 * propias palabras, sin tener que llevar una segunda copia del criterio.
 */
export function isEmblemUrl(value: string): boolean {
  const text = value.trim();

  if (text.startsWith("/") && !text.startsWith("//")) {
    return true;
  }

  try {
    const { protocol } = new URL(text);

    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** ¿El texto es un color de acento `#rrggbb`? (la comparación no distingue la caja) */
export function isAccentColor(value: string): boolean {
  return ACCENT_COLOR_PATTERN.test(value.trim().toLowerCase());
}

function parseEmblemUrl(value: unknown, warnings: string[]): string | null {
  const text = optionalText(value, 2_048, "branding.emblemUrl", warnings);

  if (text === null) {
    return null;
  }

  if (!isEmblemUrl(text)) {
    warnings.push("branding.emblemUrl no es una dirección http(s) ni una ruta del sitio; se ignora");
    return null;
  }

  return text;
}

/** El color de acento, en `#rrggbb`. Se normaliza a minúsculas. */
function parseAccentColor(value: unknown, warnings: string[]): string | null {
  const text = optionalText(value, 32, "branding.accentColor", warnings);

  if (text === null) {
    return null;
  }

  if (!isAccentColor(text)) {
    warnings.push(`branding.accentColor no es un color #rrggbb: ${JSON.stringify(value)}`);
    return null;
  }

  return text.toLowerCase();
}

function parseBranding(value: unknown, warnings: string[]): EditionBranding {
  if (value === undefined) {
    return { ...DEFAULT_EDITION_CONFIG.branding };
  }

  if (!isRecord(value)) {
    warnings.push("branding no es un objeto");
    return { ...DEFAULT_EDITION_CONFIG.branding };
  }

  return {
    emblemUrl: parseEmblemUrl(value.emblemUrl, warnings),
    accentColor: parseAccentColor(value.accentColor, warnings),
  };
}

/* -------------------------------------------------------------------------- */
/* Fusión                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Combina el documento guardado con los valores por defecto. **Nunca lanza.**
 *
 * Mismo contrato que `mergeRuleset()` y `mergeCountries()` —el dato efectivo más
 * `warnings`— con dos diferencias deliberadas:
 *
 * - **Campo a campo, no todo o nada.** Un premio mal escrito no tiene por qué tirar
 *   el nombre de la edición: cada campo que no se entiende se avisa y se queda en su
 *   valor por defecto, como en el ruleset de puntos.
 * - **La versión sí invalida el documento entero**, como en los rulesets: un
 *   documento de otra versión puede describir otra estructura, y aplicar "lo que se
 *   parezca" sería peor que usar los valores por defecto y decirlo.
 */
export function mergeEditionConfig(stored: unknown): EditionConfigMergeResult {
  const warnings: string[] = [];
  const config = defaultEditionConfig();

  if (!isRecord(stored)) {
    warnings.push("el valor no es un objeto; se usa la configuración por defecto");
    return { config, warnings };
  }

  if (stored.version !== EDITION_CONFIG_VERSION) {
    warnings.push(
      `la versión guardada (${String(stored.version)}) no es ${EDITION_CONFIG_VERSION}; se usa la configuración por defecto`,
    );
    return { config, warnings };
  }

  config.name = parseName(stored.name, warnings);
  config.prize = parsePrize(stored.prize, warnings);
  config.branding = parseBranding(stored.branding, warnings);

  if (stored.streamingRequired !== undefined) {
    if (typeof stored.streamingRequired === "boolean") {
      config.streamingRequired = stored.streamingRequired;
    } else {
      warnings.push("streamingRequired no es un booleano");
    }
  }

  return { config, warnings };
}

function reportWarnings(warnings: readonly string[]): void {
  for (const warning of warnings) {
    console.warn(`[edition] ${EDITION_CONFIG_KEY}: ${warning}`);
  }
}

/**
 * La configuración de la edición activa.
 *
 * Si nadie ha publicado `edition.config`, devuelve el documento por defecto **sin
 * escribir nada**: leer no debería modificar la base. Un documento que no se entiende
 * se descarta con un aviso en el log y se usan los valores por defecto, igual que los
 * rulesets. Un **fallo de la base de datos sí se propaga** (ver el docblock del
 * módulo).
 */
export async function readEditionConfig(client: EditionConfigClient = db): Promise<EditionConfig> {
  const setting = await client.setting.findUnique({ where: { key: EDITION_CONFIG_KEY } });

  if (setting === null) {
    return defaultEditionConfig();
  }

  const merged = mergeEditionConfig(setting.value);
  reportWarnings(merged.warnings);

  return merged.config;
}

/**
 * Publica la configuración de la edición.
 *
 * **Valida antes de escribir**, como `writeCountries()`: si el documento que se le
 * pasa no volviera a salir de `readEditionConfig()`, quien lo publicara estaría
 * dejando un documento que el sistema va a descartar con un aviso, y el síntoma
 * (un nombre de edición que no cambia) aparecería en la web, no en el panel. Aquí
 * sale como un error de quien llama, que es quien puede explicarlo.
 *
 * Acepta el cliente para poder participar en la transacción del panel: el `upsert` y
 * el rastro de `AdminAction` van juntos, o no va ninguno.
 */
export async function writeEditionConfig(
  config: EditionConfig,
  client: EditionConfigClient = db,
): Promise<void> {
  const merged = mergeEditionConfig(config);

  if (merged.warnings.length > 0) {
    throw new Error(
      `${EDITION_CONFIG_KEY}: documento no válido, no se publica (${merged.warnings.join("; ")})`,
    );
  }

  const value = toInputJson(merged.config);

  await client.setting.upsert({
    where: { key: EDITION_CONFIG_KEY },
    create: { key: EDITION_CONFIG_KEY, value },
    update: { value },
  });
}

/**
 * El documento a JSON de entrada, **sin castear a ciegas**.
 *
 * `JSON.parse(JSON.stringify(...))` en vez de un `as`, por lo mismo que
 * `toInputJson()` en `src/lib/alerts/settings.ts`: el documento lo arma un
 * formulario del panel, así que pasa por el validador pero no por un tipo de Prisma.
 * El viaje por `JSON` falla ruidosamente si algún día se cuela un `undefined` o una
 * función, en vez de guardarlos como `null` sin que nadie se entere.
 */
function toInputJson(config: EditionConfig): Prisma.InputJsonObject {
  return JSON.parse(JSON.stringify(config)) as Prisma.InputJsonObject;
}
