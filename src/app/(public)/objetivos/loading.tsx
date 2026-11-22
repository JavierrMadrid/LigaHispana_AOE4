export default function Loading() {
  return (
    <div className="catalog-skeleton" role="status" aria-live="polite">
      <span className="sr-only">Cargando los objetivos</span>
      <div className="catalog-skeleton-title" aria-hidden="true" />
      <div aria-hidden="true">
        <div className="catalog-skeleton-toolbar" />
        <div className="catalog-grid">
          {[0, 1, 2, 3, 4, 5].map((index) => (
            <div key={index} className="catalog-skeleton-card" />
          ))}
        </div>
      </div>
    </div>
  );
}
