export default function Loading() {
  return (
    <div
      className="matches-layout matches-skeleton"
      role="status"
      aria-live="polite"
    >
      <span className="sr-only">Cargando las partidas en juego</span>
      <aside className="matches-context" aria-hidden="true">
        <div className="matches-skeleton-band" />
      </aside>
      <div aria-hidden="true">
        <div className="matches-skeleton-band" />
        <div className="matches-grid">
          {[0, 1, 2, 3].map((index) => (
            <div key={index} className="matches-skeleton-card" />
          ))}
        </div>
      </div>
    </div>
  );
}
