/**
 * Esqueleto de una noticia.
 *
 * Misma forma que el artículo —vuelta a Noticias, fecha, titular, entradilla y
 * cuerpo— con la caja de la casa, para que la lectura no dé un salto al llegar el
 * texto.
 */
export default function Loading() {
  return (
    <div className="news-skeleton news-skeleton-article" role="status" aria-live="polite">
      <span className="sr-only">Cargando la noticia</span>

      <span aria-hidden="true" className="news-skeleton-back" />

      <div aria-hidden="true" className="news-skeleton-article-head">
        <span className="news-skeleton-date" />
        <span className="news-skeleton-line news-skeleton-article-title" />
        <span className="news-skeleton-line news-skeleton-article-title news-skeleton-line-short" />
        <span className="news-skeleton-line" />
      </div>

      <div aria-hidden="true" className="news-skeleton-body">
        {[0, 1, 2, 3, 4, 5].map((line) => (
          <span key={line} className="news-skeleton-line" />
        ))}
      </div>
    </div>
  );
}
