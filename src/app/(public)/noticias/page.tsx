import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight } from "@phosphor-icons/react/dist/ssr/ArrowUpRight";
import { WarningCircle } from "@phosphor-icons/react/dist/ssr/WarningCircle";
import { NewsDate } from "@/components/news-date";
import { newsExcerpt } from "@/lib/news";
import { listPublishedPosts, type NewsPost } from "@/lib/news-store";

export const metadata: Metadata = {
  title: "Noticias",
  description:
    "Las noticias de la Liga Hispana de Age of Empires IV: avisos de la organización sobre ediciones, calendario y normas.",
};

// Las noticias se publican sin desplegar, desde el panel: una página generada en el
// build seguiría enseñando la lista anterior. Se lee en cada petición, como las
// páginas que dependen de Setting.
export const dynamic = "force-dynamic";

/**
 * Listado público de noticias (issue 229), con la identidad de la portada.
 *
 * Solo salen las publicadas. La última se lee destacada —es la que la organización
 * acaba de anunciar— y las anteriores, en un archivo separado por filetes; no hay
 * imágenes ni datos inventados, porque la noticia es texto y fecha.
 *
 * Un fallo de la base no se pinta como "no hay noticias": se dice que no se han
 * podido leer, que es lo que la persona necesita saber para volver más tarde en vez
 * de marcharse creyendo que no hay nada.
 */
export default async function NewsPage() {
  const posts = await listPublishedPosts().catch(() => null);

  if (posts === null) {
    return (
      <div className="news-page">
        <NewsHeading />
        <section className="news-state" aria-labelledby="news-error-title">
          <WarningCircle size={28} aria-hidden="true" />
          <h2 id="news-error-title">No se han podido leer las noticias</h2>
          <p>La base de datos no ha respondido. Vuelve a intentarlo en unos minutos.</p>
        </section>
      </div>
    );
  }

  if (posts.length === 0) {
    return (
      <div className="news-page">
        <NewsHeading />
        <section className="news-state" aria-labelledby="news-empty-title">
          <h2 id="news-empty-title">Todavía no hay ninguna noticia publicada</h2>
          <p>Cuando la organización publique el primer aviso, aparecerá aquí.</p>
        </section>
      </div>
    );
  }

  const [lead, ...earlier] = posts;

  return (
    <div className="news-page">
      <NewsHeading />

      <article className="news-lead">
        <Link href={`/noticias/${lead.slug}`} aria-labelledby="news-lead-title">
          <NewsDate publishedAt={lead.publishedAt} />
          <h2 id="news-lead-title">{lead.title}</h2>
          <p>{newsExcerpt(lead.summary, lead.body)}</p>
          <span className="news-more">
            Leer la noticia
            <ArrowUpRight size={14} aria-hidden="true" />
          </span>
        </Link>
      </article>

      {earlier.length > 0 ? (
        <section className="news-archive" aria-labelledby="news-archive-title">
          <h2 id="news-archive-title">Noticias anteriores</h2>
          <ul className="news-list">
            {earlier.map((post) => (
              <li key={post.id}>
                <NewsItem post={post} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/** El título y la entradilla de la sección; común a la lista y a sus dos estados. */
function NewsHeading() {
  return (
    <header className="news-heading">
      <h1>Noticias</h1>
      <p>Los avisos de la organización sobre la liga: ediciones, calendario y normas.</p>
    </header>
  );
}

/**
 * Una noticia del archivo: fecha, titular y entradilla, todo enlazado.
 *
 * Sin «Leer la noticia»: en la lista se repite en cada fila y sobra, porque la
 * fila entera es el enlace. El enlace ocupa la fila completa —es un blanco cómodo
 * en móvil— pero su nombre accesible es solo el titular (`aria-labelledby`): sin
 * él, el lector de pantalla anunciaría la fecha y la entradilla como nombre.
 */
function NewsItem({ post }: { post: NewsPost }) {
  const titleId = `news-title-${post.id}`;

  return (
    <article className="news-item">
      <Link href={`/noticias/${post.slug}`} aria-labelledby={titleId}>
        <NewsDate publishedAt={post.publishedAt} />
        <h3 id={titleId}>{post.title}</h3>
        <p>{newsExcerpt(post.summary, post.body)}</p>
      </Link>
    </article>
  );
}
