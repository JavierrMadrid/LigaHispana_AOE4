import "server-only";

import { isRecord } from "@/lib/json";
import { IMPARABLE_ID, OBJECTIVE_DEFINITIONS } from "@/lib/objectives";

export type StandingPointsBreakdown = {
  pointsAccumulated: number | null;
  pointsByLeadership: number | null;
};

const DEFINITIONS = new Map(OBJECTIVE_DEFINITIONS.map((definition) => [definition.id, definition]));

/** Reparte el total guardado sin confundir el máximo de Imparable con lo cobrado. */
export function standingPointsBreakdown(
  total: number,
  breakdown: unknown,
  objectivePoints: Readonly<Record<string, number>> = {},
): StandingPointsBreakdown {
  const unavailable: StandingPointsBreakdown = { pointsAccumulated: null, pointsByLeadership: null };
  if (!Number.isSafeInteger(total) || total < 0) return unavailable;
  if (total === 0) return { pointsAccumulated: 0, pointsByLeadership: 0 };

  const section = isRecord(breakdown) && isRecord(breakdown.objectives) ? breakdown.objectives : null;
  if (section === null || !Array.isArray(section.earned)) return unavailable;
  const awarded = section.points;
  if (typeof awarded !== "number" || !Number.isSafeInteger(awarded) || awarded < 0 || awarded > total) {
    return unavailable;
  }

  let leadership = 0;
  let fixedAchievements = 0;
  let dailyMaximum = 0;
  for (const id of new Set(section.earned)) {
    if (typeof id !== "string") return unavailable;
    const definition = DEFINITIONS.get(id);
    // Un id desconocido puede aportar puntos de cualquiera de los dos grupos.
    if (!definition) return unavailable;
    const points = objectivePoints[id] ?? definition.points;
    if (!Number.isSafeInteger(points) || points <= 0) return unavailable;
    if (definition.kind === "competition") leadership += points;
    else if (id === IMPARABLE_ID) dailyMaximum = points;
    else fixedAchievements += points;
  }

  const dailyAward = awarded - leadership - fixedAchievements;
  // No reconstruimos un reparto si las reglas actuales contradicen la fila guardada.
  if (dailyMaximum === 0 ? dailyAward !== 0 : dailyAward < 1 || dailyAward > dailyMaximum) {
    return unavailable;
  }

  return { pointsAccumulated: total - leadership, pointsByLeadership: leadership };
}
