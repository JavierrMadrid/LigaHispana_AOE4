/**
 * Modos de juego y si puntúan en la liga. Lo comparten `/reglas` y
 * `/puntuacion`: es el mismo hecho visto desde dos sitios, así que se escribe
 * una sola vez. Sin la columna de identificadores de AoE4World: al
 * participante le basta con el nombre del modo que ve en el juego.
 */
const MODES = [
  { mode: "Ranked 1vs1", counts: true },
  { mode: "Ranked por equipos 2v2", counts: true },
  { mode: "Ranked por equipos 3v3", counts: true },
  { mode: "Ranked por equipos 4v4", counts: true },
  { mode: "Quick match", counts: false },
  { mode: "Partidas personalizadas", counts: false },
] as const;

export function RankedModesTable() {
  // Sin ancho mínimo: con el relleno compacto de móvil las dos columnas caben
  // por sí solas en un teléfono. El `overflow-x-auto` queda como red de
  // seguridad.
  return (
    <div className="overflow-x-auto overscroll-x-contain rounded-lg border border-line">
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">
          Modos de juego de Age of Empires IV y si puntúan en la liga.
        </caption>
        <thead className="bg-surface">
          <tr className="text-left text-xs font-medium text-muted">
            <th scope="col" className="px-3 py-3 sm:px-4">
              Modo
            </th>
            <th scope="col" className="px-3 py-3 text-right sm:px-4">
              Puntúa
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {MODES.map((row) => (
            <tr key={row.mode}>
              <td className="px-3 py-3 text-foreground sm:px-4">{row.mode}</td>
              <td
                className={`px-3 py-3 text-right font-medium sm:px-4 ${
                  row.counts ? "text-accent" : "text-muted"
                }`}
              >
                {row.counts ? "Sí" : "No"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
