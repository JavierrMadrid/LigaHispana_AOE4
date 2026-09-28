/**
 * Catálogo de civilizaciones del torneo.
 *
 * El `id` es el `id` de AoE4World (`civs-index.json`), que es exactamente lo
 * que guarda `Match.civ` y por tanto lo único con lo que se pueden cruzar los
 * datos. El `slug` del mismo índice es otra cosa (`delhi`, `hre`, `zhuxi`) y no
 * aparece por aquí: usarlo rompería la correspondencia con la base de datos.
 *
 * `name` es la traducción al español propuesta para la interfaz: es la única
 * parte discutible del catálogo y está pendiente de validación (§9 de
 * `docs/PUNTUACION.md`).
 *
 * El orden del array es el orden del grupo `civilizacion` en la vista de
 * objetivos: alfabético por `id`, estable y sin sorpresas.
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
  { id: "english", name: "Inglaterra" },
  { id: "french", name: "Francia" },
  { id: "golden_horde", name: "Horda de Oro" },
  { id: "holy_roman_empire", name: "Sacro Imperio Romano Germánico" },
  { id: "house_of_lancaster", name: "Casa de Lancaster" },
  { id: "japanese", name: "Japón" },
  { id: "jeanne_darc", name: "Juana de Arco" },
  { id: "jin_dynasty", name: "Dinastía Jin" },
  { id: "knights_templar", name: "Caballeros Templarios" },
  { id: "macedonian_dynasty", name: "Dinastía Macedonia" },
  { id: "malians", name: "Malíes" },
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
