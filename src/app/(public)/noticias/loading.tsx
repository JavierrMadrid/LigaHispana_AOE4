/**
 * Esqueleto del listado de noticias.
 *
 * La página es `force-dynamic` y relee la base en cada petición, así que entre pulsar
 * «Noticias» y ver la gaceta hay un hueco. Se reserva la forma real —cabecera de
 * sección, destacada y archivo— con las cajas de la casa, para que nada salte al
 * llegar los datos. El aviso de estado lo da el `role="status"`; el bloque no repite
 * mensajes.
 */
export default function Loading() {
  return (
    <div className="news-skeleton" role="status" aria-live="polite">
      <span className="sr-only">Cargando las noticias</span>

      <div aria-hidden="true" className="news-skeleton-head">
        <span className="news-skeleton-title" />
        <span className="news-skeleton-line" />
        <span className="news-skeleton-line news-skeleton-line-short" />
      </div>

      <div aria-hidden="true" className="news-skeleton-lead">
        <span className="news-skeleton-date" />
        <span className="news-skeleton-line" />
        <span className="news-skeleton-line" />
        <span className="news-skeleton-line news-skeleton-line-short" />
      </div>

      <div aria-hidden="true" className="news-skeleton-list">
        {[0, 1, 2].map((row) => (
          <div key={row} className="news-skeleton-row">
            <span className="news-skeleton-date" />
            <span className="news-skeleton-line news-skeleton-line-short" />
            <span className="news-skeleton-line" />
          </div>
        ))}
      </div>
    </div>
  );
}
