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
