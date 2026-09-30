/**
 * Divisiones de la ladder.
 *
 * Estaban en `src/lib/public.ts`, que es la capa de lectura de las páginas
 * públicas; ahora las necesita también el motor de objetivos (`sensei-*`) y
 * `public.ts` solo las reexporta, para no romper a la UI que ya las importa de
 * ahí.
 *
 * `rankLevel` llega de AoE4World como string libre (`"gold_2"`, `"bronze_1"`),
 * así que la correspondencia vive **aquí**, en datos: la UI y el motor solo
 * reciben el `DivisionId` ya resuelto y esta lista para pintar los botones de
 * filtro. Los prefijos son los que usa la API y se comparan antes del guion, de
 * forma que cualquier tier (`gold_1`, `gold_2`, `gold_3`) cae en la misma
 * división.
 */

export type DivisionId = "bronce" | "plata" | "oro" | "platino" | "diamante" | "conquistador";

export type Division = {
  id: DivisionId;
  /** Etiqueta tal y como se escribe en español. */
  label: string;
  /** Prefijo de `rank_level` en AoE4World (`"gold_2"` → `"gold"`). */
  rankLevelPrefix: string;
};

/** En el orden en que las pinta la interfaz y en el del grupo `division`. */
export const DIVISIONS: Division[] = [
  { id: "bronce", label: "Bronce", rankLevelPrefix: "bronze" },
  { id: "plata", label: "Plata", rankLevelPrefix: "silver" },
  { id: "oro", label: "Oro", rankLevelPrefix: "gold" },
  { id: "platino", label: "Platino", rankLevelPrefix: "platinum" },
  { id: "diamante", label: "Diamante", rankLevelPrefix: "diamond" },
  { id: "conquistador", label: "Conquistador", rankLevelPrefix: "conqueror" },
];

/**
 * División de una ladder, o `null` si no está clasificado (`rankLevel` vacío)
 * o si el string no corresponde a ninguna división conocida.
 */
export function divisionFromRankLevel(rankLevel: string | null): DivisionId | null {
  if (rankLevel === null) {
    return null;
  }

  const normalized = rankLevel.trim().toLowerCase();

  if (normalized === "") {
    return null;
  }

  for (const division of DIVISIONS) {
    const prefix = division.rankLevelPrefix;

    if (normalized === prefix || normalized.startsWith(`${prefix}_`)) {
      return division.id;
    }
  }

  return null;
}

/**
 * Las 18 subdivisiones, **de la más fuerte a la más débil**.
 *
 * El orden real de AoE4World va del 3 al 1 dentro de cada división y de
 * conquistador a bronce entre divisiones, y es el que hace falta para contar
 * "escalones": desde `gold_3`, tres escalones abajo es `silver_3` o inferior;
 * desde `gold_1`, tres escalones abajo es `silver_1` o inferior (los dos
 * ejemplos están verificados con el cliente).
 *
 * Se escribe **entero y a mano**, y no se deduce de `DIVISIONS`, porque el paso
 * interno de cada división (3 → 2 → 1) es del `rank_level` de AoE4World y no
 * está en ningún otro sitio del proyecto: `DIVISIONS` solo sabe los seis
 * prefijos. Derivar el orden de una lista de prefijos sería inventar el dato.
 *
 * Comparar Escalones entre ladders es legítimo porque las subdivisiones son
 * globales: el motor de alertas compara el `rank_level` 1v1 de un jugador con
 * el que corresponde a la media de elo de una partida de equipos, y lo único
 * que cambia entre ladders es **dónde cae el corte de rating** de cada
 * subdivisión, que es lo que guarda `Setting["alerts.divisionCutoffs"]`.
 */
export const SUBDIVISION_RANK_LEVELS = [
  "conqueror_3",
  "conqueror_2",
  "conqueror_1",
  "diamond_3",
  "diamond_2",
  "diamond_1",
  "platinum_3",
  "platinum_2",
  "platinum_1",
  "gold_3",
  "gold_2",
  "gold_1",
  "silver_3",
  "silver_2",
  "silver_1",
  "bronze_3",
  "bronze_2",
  "bronze_1",
] as const;

export type SubdivisionRankLevel = (typeof SUBDIVISION_RANK_LEVELS)[number];

/** Posición de una subdivisión en el orden fuerte → débil, o `null` si no se reconoce. */
export function subdivisionIndex(rankLevel: string | null): number | null {
  if (rankLevel === null) {
    return null;
  }

  const normalized = rankLevel.trim().toLowerCase();
  const found = (SUBDIVISION_RANK_LEVELS as readonly string[]).indexOf(normalized);

  return found === -1 ? null : found;
}
