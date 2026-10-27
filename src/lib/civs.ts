/**
 * Catálogo de civilizaciones del torneo.
 *
 * El `id` es el `id` de AoE4World (`civs-index.json`), que es exactamente lo
 * que guarda `Match.civ` y por tanto lo único con lo que se pueden cruzar los
 * datos. El `slug` del mismo índice es otra cosa (`delhi`, `hre`, `zhuxi`) y no
 * aparece por aquí: usarlo rompería la correspondencia con la base de datos.
 *
 * `name` es la traducción al español propuesta para la interfaz: es la única
 * parte discutible del catálogo y está pendiente de validación.
 *
 * El orden del array es el orden del grupo `civilizacion` en la vista de
 * objetivos: alfabético por `id`, estable y sin sorpresas.
 *
 * ## Los assets también viven aquí
 *
 * El fichero WebP de cada civilización y los prefijos de id de los objetivos que
 * la llevan pegada (`lider-japanese`) están en este módulo, que no importa React,
 * porque los usan las dos caras del proyecto: `civilization-icon.tsx` para pintar
 * el `<img>` y `src/lib/overlay-api.ts` para publicar `icono_url`. Si vivieran en
 * el componente, la API —que corre en el servidor y no puede importar componentes—
 * tendría que repetir el mapa y los dos se irían separando con cada civilización
 * nueva.
 */

export type Civilization = {
  id: string;
  name: string;
};

export const CIVILIZATIONS = [
  { id: "abbasid_dynasty", name: "Dinastía Abásida" },
  { id: "ayyubids", name: "Ayyubíes" },
  { id: "byzantines", name: "Bizantinos" },
  { id: "chinese", name: "Chinos" },
  { id: "delhi_sultanate", name: "Sultanato de Delhi" },
  { id: "english", name: "Ingleses" },
  { id: "french", name: "Franceses" },
  { id: "golden_horde", name: "Horda de Oro" },
  { id: "holy_roman_empire", name: "Sacro Imperio Romano" },
  { id: "house_of_lancaster", name: "Lancaster" },
  { id: "japanese", name: "Japoneses" },
  { id: "jeanne_darc", name: "Juana de Arco" },
  { id: "jin_dynasty", name: "Dinastía Jin" },
  { id: "knights_templar", name: "Caballeros Templarios" },
  { id: "macedonian_dynasty", name: "Dinastía Macedonia" },
  { id: "malians", name: "Malienses" },
  { id: "mongols", name: "Mongoles" },
  { id: "order_of_the_dragon", name: "Orden del Dragón" },
  { id: "ottomans", name: "Otomanos" },
  { id: "rus", name: "Rus" },
  { id: "sengoku_daimyo", name: "Daimyō del Sengoku" },
  { id: "tughlaq_dynasty", name: "Dinastía Tughlaq" },
  { id: "zhu_xis_legacy", name: "Legado de Zhu Xi" },
] as const satisfies readonly Civilization[];

export type CivilizationId = (typeof CIVILIZATIONS)[number]["id"];

const NAME_BY_ID = new Map<string, string>(CIVILIZATIONS.map((civ) => [civ.id, civ.name]));

export const CIVILIZATION_IDS: readonly string[] = CIVILIZATIONS.map((civ) => civ.id);

/**
 * Nombre en español de una civilización.
 *
 * Si aparece una que el catálogo no conoce (una civ nueva de un DLC, o un
 * valor raro guardado en la base), se devuelve el `id` tal cual: peor que una
 * traducción, mejor que no mostrar nada, y no rompe la tabla.
 */
export function civilizationName(id: string): string {
  return NAME_BY_ID.get(id) ?? id;
}

export function isKnownCivilization(id: string): boolean {
  return NAME_BY_ID.has(id);
}

/**
 * Directorio público de los iconos de civilización
 * (`public/imagenes/civilizaciones`).
 *
 * Se publica porque la API del overlay compone la URL absoluta del icono a partir
 * del origen de la petición y no puede saber dónde están los assets si no es por
 * aquí.
 */
export const CIVILIZATION_DIRECTORY = "/imagenes/civilizaciones";

/**
 * Fichero WebP de cada civilización en `public/imagenes/civilizaciones`.
 *
 * El nombre no se puede derivar del `id` de AoE4World (Sacro Imperio es `HRE`,
 * Juana de Arco es `Jeanne_d_Arc`, Legado de Zhu Xi es `Zhu_Xis_Legacy`), así
 * que el mapa es explícito. `satisfies` obliga a que esté completo: cuando
 * entre una civilización nueva, el compilador exige su icono.
 */
export const CIVILIZATION_FILES = {
  abbasid_dynasty: "Abbasid_Dynasty_AoE4.webp",
  ayyubids: "Ayyubids_AoE4.webp",
  byzantines: "Byzantines_AoE4.webp",
  chinese: "Chinese_AoE4.webp",
  delhi_sultanate: "Delhi_Sultanate_AoE4.webp",
  english: "English_AoE4.webp",
  french: "French_AoE4.webp",
  golden_horde: "Golden_Horde_AoE4.webp",
  holy_roman_empire: "HRE_AoE4.webp",
  house_of_lancaster: "House_of_Lancaster_AoE4.webp",
  japanese: "Japanese_AoE4.webp",
  jeanne_darc: "Jeanne_d_Arc_AoE4.webp",
  jin_dynasty: "Jin_Dynasty_AoE4.webp",
  knights_templar: "Knights_Templar_AoE4.webp",
  macedonian_dynasty: "Macedonian_Dynasty_AoE4.webp",
  malians: "Malians_AoE4.webp",
  mongols: "Mongols_AoE4.webp",
  order_of_the_dragon: "Order_of_the_Dragon_AoE4.webp",
  ottomans: "Ottomans_AoE4.webp",
  rus: "Rus_AoE4.webp",
  sengoku_daimyo: "Sengoku_Daimyo_AoE4.webp",
  tughlaq_dynasty: "Tughlaq_Dynasty_AoE4.webp",
  zhu_xis_legacy: "Zhu_Xis_Legacy_AoE4.webp",
} as const satisfies Record<CivilizationId, string>;

/**
 * Fichero del icono de una civilización, o `null` si no hay asset.
 *
 * Lo usa quien necesita distinguir "hay imagen" de "no la hay" para elegir su
 * propio recuadro de reserva, en vez de montar el componente entero.
 *
 * Se pregunta con `Object.hasOwn` y no con `in`: `in` mira la cadena de
 * prototipos, así que `"constructor"` respondería que sí y devolvería una función
 * en lugar de un fichero.
 */
export function civilizationFile(id: string): string | null {
  return Object.hasOwn(CIVILIZATION_FILES, id)
    ? CIVILIZATION_FILES[id as CivilizationId]
    : null;
}

/**
 * Prefijos de id de objetivo que llevan la civilización pegada detrás
 * (`lider-japanese` → `japanese`).
 */
export const CIV_OBJECTIVE_PREFIXES = ["masterizando-", "lider-", "acolito-"] as const;

/**
 * La civilización de un id de objetivo de civilización, o `null` si el id no es
 * de esa familia (`rey-1v1`, `loco-por-ganar`…).
 */
export function objectiveCivilization(id: string): string | null {
  for (const prefix of CIV_OBJECTIVE_PREFIXES) {
    if (id.startsWith(prefix)) {
      return id.slice(prefix.length);
    }
  }

  return null;
}
