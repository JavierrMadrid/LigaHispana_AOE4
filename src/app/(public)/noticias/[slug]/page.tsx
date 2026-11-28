import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "@phosphor-icons/react/dist/ssr/ArrowLeft";
import { NewsDate } from "@/components/news-date";
import { renderNewsBody } from "@/lib/news";
import { getPublishedPost } from "@/lib/news-store";

export const dynamic = "force-dynamic";

type NewsPostPageProps = {
  params: Promise<{ slug: string }>;
};

/**
 * Una noticia publicada (issue 229), con la identidad de la portada.
 *
 * El cuerpo se pinta con renderNewsBody(), que escapa todo y solo reconoce un
 * repertorio corto de marcas: el HTML que llega a dangerouslySetInnerHTML lo ha
 * construido el propio proyecto, no el texto guardado. Los estilos de ese
 * repertorio viven en `news.css`, bajo `.news-body`.
 *
 * Un borrador o una dirección que no existe dan el mismo 404: la web pública no tiene
 * que revelar qué está a medio escribir.
 */
export default async function NewsPostPage({ params }: NewsPostPageProps) {
  const { slug } = await params;
  const post = await getPublishedPost(slug).catch(() => null);

  if (post === null) {
    notFound();
  }

  return (
    <article className="news-article">
      <Link href="/noticias" className="news-back">
        <ArrowLeft size={14} aria-hidden="true" />
        Noticias
      </Link>

      <header className="news-article-head">
        <NewsDate publishedAt={post.publishedAt} />
        <h1>{post.title}</h1>
        {post.summary !== null ? (
          <p className="news-article-summary">{post.summary}</p>
        ) : null}
      </header>

      <div
        className="news-body"
        dangerouslySetInnerHTML={{ __html: renderNewsBody(post.body) }}
      />

      <footer className="news-article-foot">
        <Link href="/noticias" className="news-back">
          <ArrowLeft size={14} aria-hidden="true" />
          Volver a Noticias
        </Link>
      </footer>
    </article>
  );
}

/** El título de la pestaña es el de la noticia; si no existe, el de la sección. */
export async function generateMetadata({ params }: NewsPostPageProps): Promise<Metadata> {
  const { slug } = await params;
  const post = await getPublishedPost(slug).catch(() => null);

  if (post === null) {
    return { title: "Noticias" };
  }

  return {
    title: post.title,
    description: post.summary ?? undefined,
  };
}
