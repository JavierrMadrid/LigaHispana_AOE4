import type { Metadata } from "next";
import Link from "next/link";
import { NewsForm } from "@/app/admin/noticias/news-form";
import { AdminPageHeader } from "@/components/admin/page-header";
import { SectionCard } from "@/components/admin/section";
import { EmptyState } from "@/components/empty-state";
import { formatAbsoluteTime, formatMadridDateTime } from "@/lib/format";
import { getPostForAdmin, listPostsForAdmin } from "@/lib/news-store";
import { requireSuperadmin } from "@/lib/auth";

export const metadata: Metadata = {
  title: { absolute: "Noticias · Admin" },
};

export const dynamic = "force-dynamic";

type AdminNewsPageProps = {
  searchParams: Promise<{ editar?: string }>;
};

/**
 * Noticias del torneo (issue 229): listado y editor, solo para el superadministrador.
 *
 * La edición vive en la URL (editar=<id>), como en eventos: el formulario se rellena en
 * el servidor y recargar no pierde qué se estaba escribiendo. Con la dirección vacía se
 * crea una noticia nueva.
 *
 * La lista enseña también los borradores, con su estado, porque es lo que el editor
 * necesita para saber qué le queda por publicar. Un fallo de lectura no se pinta como
 * "no hay noticias": se dice que no se han podido leer.
 */
export default async function AdminNewsPage({ searchParams }: AdminNewsPageProps) {
  await requireSuperadmin();

  const { editar } = await searchParams;
  const [posts, editing] = await Promise.all([
    listPostsForAdmin().catch(() => null),
    editar === undefined ? Promise.resolve(null) : getPostForAdmin(editar).catch(() => null),
  ]);

  return (
    <div className="flex flex-col gap-8">
      <AdminPageHeader
        title="Noticias"
        description="Lo que se publica en /noticias. Se escribe en Markdown básico y se publica sin desplegar."
      />

      <SectionCard
        title={editing === null ? "Nueva noticia" : "Editar noticia"}
        description={
          editing === null
            ? "El titular y el cuerpo son obligatorios; la dirección se completa sola."
            : "Guardar no cambia la fecha de publicación original."
        }
      >
        <NewsForm key={editing?.id ?? "nueva"} post={editing} />
      </SectionCard>

      <section aria-labelledby="noticias-lista" className="flex flex-col gap-4">
        <h2 id="noticias-lista" className="text-lg font-semibold">
          Todas las noticias
        </h2>

        {posts === null ? (
          <EmptyState
            title="No se han podido leer las noticias"
            body="La base de datos no ha respondido. Vuelve a intentarlo en unos minutos."
          />
        ) : posts.length === 0 ? (
          <EmptyState
            title="Todavía no hay noticias"
            body="Escribe la primera arriba: se guarda como borrador hasta que marques Publicada."
          />
        ) : (
          <ul className="flex flex-col divide-y divide-line border-y border-line">
            {posts.map((post) => (
              <li key={post.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-3">
                <span className="text-sm text-foreground">{post.title}</span>
                <span className="font-mono text-xs text-muted">/{post.slug}</span>
                <span className="text-xs text-muted">
                  {post.publishedAt === null
                    ? "Borrador"
                    : "Publicada el " + formatMadridDateTime(post.publishedAt)}
                </span>
                <span className="text-xs text-muted" title={formatAbsoluteTime(post.updatedAt)}>
                  · última edición {formatAbsoluteTime(post.updatedAt)}
                </span>
                <Link
                  href={"/admin/noticias?editar=" + post.id}
                  className="ml-auto text-xs text-muted underline underline-offset-4 transition-colors hover:text-accent"
                >
                  Editar
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
