import "server-only";

import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { foldCountryName, parseCountry } from "@/lib/player-input";

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
 *
 * ## El ISO de AoE4World, y por qué este módulo no es solo de lectura
 *
 * `COUNTRY_LABEL_BY_ISO` traduce el `country` que trae el perfil de AoE4World (un
 * ISO-2 en minúsculas) al rótulo canónico, y `findCountryIsoConflict()` decide si
 * ese país y el que eligió la persona son el mismo. Las dos cosas son de este
 * módulo y no de otro porque las dos son sobre **la lista admitida**: el
 * diccionario es su mitad por código, y la comparación solo tiene sentido contra la
 * lista que se está aplicando, no contra la del código. Y porque el rótulo canónico
 * es el dato —ver arriba—: quien compara tiene que comparar rótulos, no códigos.
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

/**
 * Código ISO 3166-1 alfa-2 → rótulo canónico de la lista anterior.
 *
 * Vive aquí, junto a `DEFAULT_COUNTRIES`, porque es **la otra mitad de la misma
 * lista**: los rótulos son los que se ofrecen y los que se guardan, y este
 * diccionario es lo que permite traducir a ese rótulo el `country` que manda la
 * API de AoE4World (que es un ISO-2 en minúsculas, `"co"`, `"do"`, `"pr"`…).
 *
 * **Al añadir un país a la lista hay que añadir aquí su ISO.** Un país sin ISO no
 * rompe nada —la comparación simplemente no lo alcanza y se deja pasar—, pero
 * `npm run verify:sync` comprueba que las dos mitades tienen el mismo tamaño y
 * que ningún ISO apunta a un rótulo que no esté en `DEFAULT_COUNTRIES`.
 *
 * Los dos casos que confunden, y que son los que hacen que la tabla merezca un
 * comentario: **`pr` es Puerto Rico** y **`do` es República Dominicana**. Los dos
 * están porque son los que se parecen a un código de otro país (y porque son los dos
 * territories que la lista admite); el resto se resuelve solo con la tabla.
 *
 * Es un `Map` y no un objeto porque las claves vienen de fuera —el `country` de un
 * perfil de AoE4World lo escribe el jugador en su perfil, no la organización— y
 * en un objeto plano `"constructor"` o `"toString"` saldrían heredados del
 * prototipo en vez de salir `undefined`.
 */
const COUNTRY_LABEL_BY_ISO: ReadonlyMap<string, string> = new Map([
  ["co", "Colombia"],
  ["es", "España"],
  ["ve", "Venezuela"],
  ["pe", "Perú"],
  ["ec", "Ecuador"],
  ["gt", "Guatemala"],
  ["bo", "Bolivia"],
  ["cu", "Cuba"],
  ["do", "República Dominicana"],
  ["hn", "Honduras"],
  ["py", "Paraguay"],
  ["sv", "El Salvador"],
  ["ni", "Nicaragua"],
  ["cr", "Costa Rica"],
  ["pa", "Panamá"],
  ["gq", "Guinea Ecuatorial"],
  ["ag", "Antigua y Barbuda"],
  ["mx", "México"],
  ["ar", "Argentina"],
  ["cl", "Chile"],
  ["uy", "Uruguay"],
  ["pr", "Puerto Rico"],
]);

/**
 * Los dos países no coinciden. Lleva los dos rótulos porque el mensaje que redacta
 * quien llama los necesita: sin nombrarlos, la contradicción no se explica.
 */
export type CountryIsoConflict = {
  /** Rótulo canónico de la lista admitida al que apunta el ISO de AoE4World. */
  aoe4WorldCountry: string;
  /** Rótulo canónico de la lista admitida que eligió la persona. */
  selectedCountry: string;
};

/**
 * ¿El país que AoE4World tiene en el perfil contradice el que eligió la persona?
 *
 * Es una función ** pura**: no lee nada y no escribe nada, así que se puede comprobar
 * sin base de datos ni red, que es lo que hace `npm run verify:sync`. Devuelve
 * `null` cuando no hay contradicción, y los dos rótulos cuando la hay, para que quien
 * redacta el mensaje no tenga que volver a resolver nada.
 *
 * ## Por qué casi todo se deja pasar
 *
 * Solo hay un `null` de resultado en el que se bloquea, y es el de "los dos países
 * se han resuelto y son distintos". Los demás `null` son deliberados, y son el
 * mismo criterio de degradación que usa el resto del módulo —y que
 * `checkAoe4WorldProfile()` aplica a su lado—: **no se ha podido comprobar** no es
 * lo mismo que **está mal**.
 *
 * - `aoe4WorldCountry` a `null` (o vacío): el perfil no tiene país. No se afirma
 *   nada.
 * - El ISO no está en `COUNTRY_LABEL_BY_ISO` (por ejemplo `"gb"`, que no es uno de
 *   los países que admite el torneo): no se puede traducir, y no se puede afirmar
 *   una contradicción sobre un país que no se conoce. Cabría añadir su fila al
 *   diccionario, pero entonces el mensaje afirmaría "en tu perfil pone Reino
 *   Unido" a partir de una tabla escrita a mano, que es exactamente el tipo de dato
 *   que este módulo no quiere inventar.
 * - El ISO se traduce, pero ese rótulo **no está en la lista vigente**: la
 *   organización puede haber publicado una lista más corta que la del código, y el
 *   país elegido es de los que admite, así que solo se compara contra la lista que
 *   de verdad se está aplicando.
 *
 * La comparación de los dos rótulos es **plegada** (`foldCountryName`), igual que
 * en `parseCountry()`: una lista publicada editada a mano puede traer "españa" y no
 * por eso hay que decirle a alguien que se equivoca.
 */
export function findCountryIsoConflict(params: {
  /** `country` del perfil de AoE4World: ISO-2 en minúsculas, o `null`. */
  aoe4WorldCountry: string | null;
  /** Rótulo canónico ya resuelto por `parseCountry()`. */
  selectedCountry: string;
  /** La lista admitida vigente, la misma que se pasó a `parseCountry()`. */
  allowed: readonly string[];
}): CountryIsoConflict | null {
  const iso = foldCountryName(params.aoe4WorldCountry ?? "");

  if (iso === "") {
    return null;
  }

  const etiqueta = COUNTRY_LABEL_BY_ISO.get(iso);

  if (etiqueta === undefined) {
    return null;
  }

  // Se resuelve **contra la lista vigente**, no contra `DEFAULT_COUNTRIES`: el
  // rótulo que se guarda y el que se enseña son los de la lista publicada.
  const canonico = parseCountry(etiqueta, params.allowed);

  if (canonico === null) {
    return null;
  }

  if (foldCountryName(canonico) === foldCountryName(params.selectedCountry)) {
    return null;
  }

  return { aoe4WorldCountry: canonico, selectedCountry: params.selectedCountry };
}

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
