export default function Loading() {
  return (
    <div className="home-skeleton" role="status" aria-live="polite">
      <span className="sr-only">Cargando la clasificación</span>
      <div className="home-skeleton-title" aria-hidden="true" />
      <div className="home-skeleton-status" aria-hidden="true" />
      <div className="home-skeleton-board" aria-hidden="true">
        {Array.from({ length: 8 }, (_, index) => (
          <div className="home-skeleton-row" key={index} />
        ))}
      </div>
    </div>
  );
}
