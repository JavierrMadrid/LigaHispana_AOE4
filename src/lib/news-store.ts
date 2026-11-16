import "server-only";

import { db } from "@/lib/db";

/**
 * La lectura de las **noticias** (issue 229).
 *
 * Cuatro consultas y ningún criterio: lo publicado lo decide `publishedAt` y el orden
 * es el de la fecha. La validación y el Markdown viven en `news.ts`, y las pantallas
 * (pública y de administración) solo pintan lo que sale de aquí. Se separa de
 * `news.ts` para que aquel siga siendo puro y se pueda probar sin base.
 */

/** Una noticia tal y como la consumen las páginas. */
export type NewsPost = {
  id: string;
  slug: string;
  title: string;
  summary: string | null;
  body: string;
  /** `null` = borrador: no sale en la web. */
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

const POST_FIELDS = {
  id: true,
  slug: true,
  title: true,
  summary: true,
  body: true,
  publishedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** Las publicadas, de la más nueva a la más vieja: lo que se ve en `/noticias`. */
export async function listPublishedPosts(): Promise<NewsPost[]> {
  return db.post.findMany({
    where: { publishedAt: { not: null } },
    orderBy: [{ publishedAt: "desc" }, { createdAt: "desc" }],
    select: POST_FIELDS,
  });
}

/**
 * Una noticia publicada por su dirección.
 *
 * Un borrador devuelve `null` como si no existiera: la web pública no tiene que
 * distinguir "no existe" de "todavía no está publicada".
 */
export async function getPublishedPost(slug: string): Promise<NewsPost | null> {
  return db.post.findFirst({
    where: { slug, publishedAt: { not: null } },
    select: POST_FIELDS,
  });
}

/** Todas, publicadas o no, para el panel: las últimas que se han tocado primero. */
export async function listPostsForAdmin(): Promise<NewsPost[]> {
  return db.post.findMany({
    orderBy: [{ updatedAt: "desc" }],
    select: POST_FIELDS,
  });
}

/** Una noticia por id, para editarla en el panel. */
export async function getPostForAdmin(id: string): Promise<NewsPost | null> {
  return db.post.findUnique({ where: { id }, select: POST_FIELDS });
}
