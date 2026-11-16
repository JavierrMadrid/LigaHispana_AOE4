import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { formatMadridDateTime } from "@/lib/format";
import { renderNewsBody } from "@/lib/news";
import { getPublishedPost } from "@/lib/news-store";

export const dynamic = "force-dynamic";

type NewsPostPageProps = {
  params: Promise<{ slug: string }>;
};

/**
 * Una noticia publicada (issue 229).
 *
 * El cuerpo se pinta con renderNewsBody(), que escapa todo y solo reconoce un
 * repertorio corto de marcas: el HTML que llega a dangerouslySetInnerHTML lo ha
 * construido el propio proyecto, no el texto guardado.
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

  const published = post.publishedAt !== null ? formatMadridDateTime(post.publishedAt) : null;

  return (
    <article className="flex flex-col gap-6">
      <header className="flex flex-col gap-2 border-b border-line pb-5">
        <Link
          href="/noticias"
          className="text-xs uppercase tracking-wide text-muted transition-colors hover:text-accent"
        >
          Noticias
        </Link>
        <h1 className="font-display text-2xl font-semibold text-foreground sm:text-3xl">
          {post.title}
        </h1>
        {published !== null ? (
          <time
            dateTime={post.publishedAt?.toISOString()}
            className="text-xs uppercase tracking-wide text-muted"
          >
            {published}
          </time>
        ) : null}
      </header>

      {post.summary !== null ? (
        <p className="max-w-[75ch] text-base leading-relaxed text-muted">{post.summary}</p>
      ) : null}

      <div
        className="news-body flex max-w-[75ch] flex-col gap-4 text-sm leading-relaxed text-foreground"
        dangerouslySetInnerHTML={{ __html: renderNewsBody(post.body) }}
      />
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
