import type { Metadata } from "next";
import Link from "next/link";
import { PageHead } from "@/components/page-head";
import { formatMadridDateTime } from "@/lib/format";
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
 * Listado público de noticias (issue 229).
 *
 * Solo salen las publicadas. Un fallo de la base no se pinta como "no hay noticias":
 * se dice que no se han podido leer, que es lo que la persona necesita saber para
 * volver más tarde en vez de marcharse creyendo que no hay nada.
 */
export default async function NewsPage() {
  const posts = await listPublishedPosts().catch(() => null);

  return (
    <div className="flex flex-col gap-8">
      <PageHead title="Noticias" />

      {posts === null ? (
        <p className="max-w-[70ch] text-sm leading-relaxed text-muted">
          No se han podido leer las noticias: la base de datos no ha respondido. Vuelve
          a intentarlo en unos minutos.
        </p>
      ) : posts.length === 0 ? (
        <p className="max-w-[70ch] text-sm leading-relaxed text-muted">
          Todavía no hay ninguna noticia publicada.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-line border-y border-line">
          {posts.map((post) => (
            <NewsRow key={post.id} post={post} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** Una noticia del listado: fecha, titular y entradilla, todo enlazado. */
function NewsRow({ post }: { post: NewsPost }) {
  const published = post.publishedAt !== null ? formatMadridDateTime(post.publishedAt) : null;

  return (
    <li>
      <article>
        <Link
          href={"/noticias/" + post.slug}
          className="group flex flex-col gap-2 px-1 py-5 transition-colors hover:bg-surface/60"
        >
          {published !== null ? (
            <time
              dateTime={post.publishedAt?.toISOString()}
              className="text-xs uppercase tracking-wide text-muted"
            >
              {published}
            </time>
          ) : null}
          <h2 className="text-lg font-semibold text-foreground transition-colors group-hover:text-accent">
            {post.title}
          </h2>
          <p className="max-w-[80ch] text-sm leading-relaxed text-muted">
            {newsExcerpt(post.summary, post.body)}
          </p>
        </Link>
      </article>
    </li>
  );
}
