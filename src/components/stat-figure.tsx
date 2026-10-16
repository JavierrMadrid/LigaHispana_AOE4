/**
 * Dato de una ficha: la cifra en la tipografía de display y su rótulo debajo.
 *
 * Lo montan la cabecera del participante y el resumen de objetivos de su ficha
 * —dos bloques de la misma pantalla—, así que vive una sola vez.
 *
 * El marcado va en el orden que pide una lista de descripción (`dt` y después
 * `dd`) y la cifra sube con `flex-col-reverse`: el vuelco es visual, no del
 * documento, así que un lector de pantalla lee "Puntos de objetivos: 42" en vez
 * de una cifra suelta antes de saber de qué es.
 */
export function StatFigure({
  label,
  value,
  accent = false,
}: {
  label: string;
  value: string;
  /** El oro para la cifra que es el titular del bloque; neutro en el resto. */
  accent?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col-reverse">
      <dt className="text-xs text-muted">{label}</dt>
      <dd
        className={`font-display text-lg font-semibold tabular-nums ${
          accent ? "text-accent" : "text-foreground"
        }`}
      >
        {value}
      </dd>
    </div>
  );
}
