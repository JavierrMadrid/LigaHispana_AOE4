/** Utilidades de JSON compartidas por la frontera con APIs externas y la BBDD. */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
