/**
 * Esqueleto de carga de la página de objetos.
 *
 * La página es `force-dynamic` y relee la base en cada petición, así que entre la
 * navegación y los datos hay un hueco. Se reserva la forma real —titular,
 * entradilla, barra de filtros, feed y pie— con las mismas cajas de la casa, para
 * que el historial no salte al llegar los datos.
 */
export default function Loading() {
  return (
    <div className="objects-skeleton" role="status" aria-live="polite">
      <span className="sr-only">Cargando los objetos</span>

      <div aria-hidden="true" className="objects-skeleton-heading">
        <span />
        <span />
        <span />
      </div>

      <div aria-hidden="true" className="objects-skeleton-layout">
        <div className="objects-skeleton-main">
          <div className="objects-skeleton-toolbar" />

          <div className="objects-skeleton-list">
            {[0, 1, 2, 3, 4, 5, 6].map((row) => (
              <div key={row} className="objects-skeleton-row" />
            ))}
          </div>

          <div className="objects-skeleton-footer">
            <span />
            <span />
          </div>
        </div>

        <div className="objects-skeleton-aside">
          <span />
          <span />
        </div>
      </div>
    </div>
  );
}
