import "server-only";

import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { foldCountryName } from "@/lib/player-input";

/**
 * La lista de países que admite el torneo, configurable sin desplegar.
 *
 * ## Dónde vive y por qué no en el código
 *
 * Vive en `Setting["registration.countries"]`, un documento JSON que es
 * **una lista de rótulos en el orden en que los ve la persona que se inscribe**.
 * Es el mismo patrón que el ruleset de puntos (`scoring.ruleset`) y el de alertas
 * (`alerts.ruleset`): la organización cambia la lista sin pasar por un despliegue.
 *
 * Y no puede ser un enum del schema por la razón de siempre: añadir un país
 * obligaría a un `db push` sobre la base de datos de producción, que no es una
 * operación que se haga para cambiar una lista. La lista se publica con
 * `npm run countries:seed`, que la siembra desde `paises.txt`.
 *
 * ## Por qué el rótulo canónico es el dato y no un código
 *
 * Lo que se guarda en `Player.country` es el rótulo tal cual está en la lista
 * ("República Dominicana"), no un código ISO ni una abreviatura. Es lo que hace
 * que la fila siga siendo legible para quien mire la tabla, y lo que evita que
 * haya que resolver el código a nombre en cada sitio que pinte. El coste es que
 * hay que resolver el texto escrito por una persona al rótulo de la lista, y eso
 * es lo que hace `parseCountry()` en `src/lib/player-input.ts` (insensible a
 * acentos y mayúsculas).
 *
 * ## El mismo criterio de "nunca lanzar" que los rulesets
 *
 * `mergeCountries()` **nunca lanza** y `readCountries()` hereda de ella: un
 * documento que no se entiende se **descarta entero**, se avisa y se usan los
 * países por defecto. No se "limpia" a medias, y esa es la decisión importante:
 * una lista a medias validaría países que la organización ya no admite y
 * rechazaría a los que sí, sin que nada fallara. Un array que no sea de textos no
 * vacíos, o que traiga un país repetido, es un documento que no describe lo que
 * cree describir, y se trata como si no hubiera lista publicada.
 *
 * Lo que **sí** se propaga es un fallo de la base de datos, igual que en
 * `readRuleset()`: quien llama lo necesita distinguir de "no hay lista publicada"
 * (que es un estado normal y tiene su lista por defecto) porque, si la base está
 * caída, validar contra `DEFAULT_COUNTRIES` en silencio escribiría el país de una
 * lista que ya no es la vigente.
 */

/** Clave de `Setting` donde vive la lista de países admitidos. */
export const REGISTRATION_COUNTRIES_KEY = "registration.countries";

/**
 * Los países con los que se publica la lista la primera vez.
 *
 * Es la misma lista, en el mismo orden, que `paises.txt` en la raíz del
 * repositorio —que es la fuente de verdad para sembrarla—, y vive aquí como
 * **respaldo** para cuando todavía no se ha publicado nada: leer no debería
 * modificar la base, así que `readCountries()` no escribe por su cuenta, igual que
 * `readRuleset()`.
 *
 * El orden es el que se le enseña a la persona que se inscribe y por eso se
 * respeta tal cual. Lo verifica `npm run verify:sync`, que además lo compara con
 * el fichero para que los dos no puedan divergir en silencio.
 */
export const DEFAULT_COUNTRIES: readonly string[] = [
  "Colombia",
  "España",
  "Venezuela",
  "Perú",
  "Ecuador",
  "Guatemala",
  "Bolivia",
  "Cuba",
  "República Dominicana",
  "Honduras",
  "Paraguay",
  "El Salvador",
  "Nicaragua",
  "Costa Rica",
  "Panamá",
  "Guinea Ecuatorial",
  "Antigua y Barbuda",
  "México",
  "Argentina",
  "Chile",
  "Uruguay",
  "Puerto Rico",
];

/** Copia nueva de la lista por defecto: quien la reciba puede recortarla. */
function defaultCountries(): string[] {
  return [...DEFAULT_COUNTRIES];
}

/** Cliente con la única tabla que necesita esta lectura (`db` o una `tx`). */
export type CountriesClient = Pick<Prisma.TransactionClient, "setting">;

export type CountriesMergeResult = {
  /** La lista efectiva, ya recortada y sin duplicados. */
  countries: string[];
  /** Lo que no se ha podido aplicar; se avisa y se queda la lista por defecto. */
  warnings: string[];
};

/**
 * Valida el documento guardado. **Nunca lanza.**
 *
 * Mismo contrato que `mergeRuleset()` y `mergeAlertsRuleset()` —el dato efectivo
 * más `warnings`—, con una diferencia que es la decisión de este documento y no
 * un descuido: aquí **no hay ajuste parcial**. Si algo no cuadra, la lista entera
 * se descarta. En un ruleset, un umbral suelto que cae al valor por defecto solo
 * cambia un número; en una lista de países, quedarse con las 20 entradas buenas
 * de 22 admitiría a alguien de un país que la organización ha retirado y
 * rechazaría a alguien de uno que ha añadido, y todo sin error ni aviso más allá
 * del log. Mejor no admitir a nadie que admitir a la persona equivocada.
 *
 * Los espacios de fuera se recortan en vez de invalidar el documento: es lo que
 * hace falta para tolerar que alguien edite el JSON a mano en el panel. Los
 * duplicados, en cambio, se detectan **con el mismo criterio que resuelve el
 * valor escrito** (`foldCountryName`), porque "Colombia" y " COLOMBIA " son dos
 * entradas que en un desplegable serían indistinguibles y en `parseCountry()`
 * resolverían a la misma, o sea: una de las dos nunca se podría elegir.
 */
export function mergeCountries(stored: unknown): CountriesMergeResult {
  const descartado = (warning: string): CountriesMergeResult => ({
    countries: defaultCountries(),
    warnings: [warning],
  });

  if (!Array.isArray(stored)) {
    return descartado(
      `el valor no es una lista de países (${JSON.stringify(stored)}); se usan los países por defecto`,
    );
  }

  if (stored.length === 0) {
    return descartado("la lista de países está vacía; se usan los países por defecto");
  }

  const countries: string[] = [];
  // Rótulo plegado -> rótulo tal cual, para poder decir en el aviso cuál de los
  // dos es el que ya estaba.
  const vistos = new Map<string, string>();

  for (const [indice, bruto] of stored.entries()) {
    if (typeof bruto !== "string") {
      return descartado(
        `el país ${indice + 1} no es un texto (${JSON.stringify(bruto)}); se usan los países por defecto`,
      );
    }

    const country = bruto.trim();

    if (country === "") {
      return descartado(`el país ${indice + 1} está vacío; se usan los países por defecto`);
    }

    const plegado = foldCountryName(country);
    const anterior = vistos.get(plegado);

    if (anterior !== undefined) {
      return descartado(
        `"${country}" está repetido (ya estaba como "${anterior}"); se usan los países por defecto`,
      );
    }

    vistos.set(plegado, country);
    countries.push(country);
  }

  return { countries, warnings: [] };
}

/**
 * La lista de países que admite el torneo ahora mismo.
 *
 * Si nadie ha publicado `registration.countries`, devuelve `DEFAULT_COUNTRIES`
 * sin escribir nada: leer no debería modificar la base. Quien publica es
 * `npm run countries:seed`.
 *
 * Un documento que no se entiende se descarta con un aviso en el log y se usan
 * los países por defecto, igual que los rulesets. Un **fallo de la base de datos
 * sí se propaga**, como en `readRuleset()`: son dos cosas distintas —"no hay
 * lista publicada" tiene su lista por defecto y "no se ha podido leer" no la
 * tiene— y quien valida un formulario tiene que poder responder a la segunda.
 */
export async function readCountries(client: CountriesClient = db): Promise<string[]> {
  const setting = await client.setting.findUnique({ where: { key: REGISTRATION_COUNTRIES_KEY } });

  if (setting === null) {
    return defaultCountries();
  }

  const merged = mergeCountries(setting.value);

  for (const warning of merged.warnings) {
    console.warn(`[registration] ${REGISTRATION_COUNTRIES_KEY}: ${warning}`);
  }

  return merged.countries;
}

/**
 * Publica la lista. Solo la usa `npm run countries:seed`.
 *
 * **Válida antes de escribir**, y por el mismo motivo que el resto del módulo: si
 * la lista que se le pasa no llegara a `readCountries()`, quien la publicara
 * estaría escribiendo un documento que el sistema va a descartar con un aviso, y
 * el síntoma (unos países que no se pueden elegir) aparecería en el formulario, no
 * en el script. Aquí sale como un error del propio script.
 *
 * El `upsert` la hace idempotente: repetirla con la misma lista no cambia nada.
 */
export async function writeCountries(
  countries: readonly string[],
  client: CountriesClient = db,
): Promise<void> {
  const merged = mergeCountries(countries);

  if (merged.warnings.length > 0) {
    throw new Error(
      `${REGISTRATION_COUNTRIES_KEY}: lista no válida, no se publica (${merged.warnings.join("; ")})`,
    );
  }

  const value = toInputJsonArray(merged.countries);

  await client.setting.upsert({
    where: { key: REGISTRATION_COUNTRIES_KEY },
    create: { key: REGISTRATION_COUNTRIES_KEY, value },
    update: { value },
  });
}

/**
 * El documento a JSON de entrada, **sin castear a ciegas**.
 *
 * `JSON.parse(JSON.stringify(...))` en vez de un `as`, por lo mismo que
 * `toInputJson()` en `src/lib/alerts/settings.ts`: la lista la arma un script de
 * terminal leyendo un fichero de texto, así que pasa por el validador pero no por
 * un tipo de Prisma. El viaje por `JSON` falla ruidosamente si algún día se cuela
 * un `undefined` o una función, en vez de guardarlos como `null` sin que nadie se
 * entere.
 */
function toInputJsonArray(countries: readonly string[]): Prisma.InputJsonArray {
  return JSON.parse(JSON.stringify(countries)) as Prisma.InputJsonArray;
}
