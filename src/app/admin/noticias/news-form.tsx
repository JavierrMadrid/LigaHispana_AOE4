"use client";

import { useActionState, useEffect, useState } from "react";
import type { AdminActionResult } from "@/app/admin/actions";
import { NEWS_BODY_MAX_LENGTH, NEWS_MARKDOWN_HELP, NEWS_SUMMARY_MAX_LENGTH, NEWS_TITLE_MAX_LENGTH } from "@/lib/news";
import type { NewsPost } from "@/lib/news-store";
import { saveNewsPost } from "./actions";

const initialState: AdminActionResult = { status: "idle", message: null };

type NewsFormProps = {
  /** La noticia que se edita, o null para escribir una nueva. */
  post: NewsPost | null;
};

/**
 * El formulario de una noticia: titular, dirección, entradilla, cuerpo y publicación.
 *
 * Los campos son controlados porque un error de guardado no puede borrar lo escrito, y
 * el formulario es una foto completa: se envía siempre todo. La dirección vacía se
 * rellena en el servidor a partir del titular, así que aquí no se calcula nada.
 *
 * El cuerpo es un textarea y no un editor: el formato es Markdown básico y el panel no
 * mete dependencias de terceros. La ayuda bajo el campo es la única lista de marcas.
 */
export function NewsForm({ post }: NewsFormProps) {
  const [state, formAction, pending] = useActionState(saveNewsPost, initialState);

  const [title, setTitle] = useState(post?.title ?? "");
  const [slug, setSlug] = useState(post?.slug ?? "");
  const [summary, setSummary] = useState(post?.summary ?? "");
  const [body, setBody] = useState(post?.body ?? "");
  const [published, setPublished] = useState(post?.publishedAt !== null && post !== null);

  // React resetea los campos al terminar una acción: los controlados vuelven al valor
  // con el que se montaron. Se reaplican desde la noticia que acaba de guardarse.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reaplica al DOM la noticia que el servidor acaba de guardar
    setTitle(post?.title ?? "");
    setSlug(post?.slug ?? "");
    setSummary(post?.summary ?? "");
    setBody(post?.body ?? "");
    setPublished(post !== null && post.publishedAt !== null);
  }, [post, state.status]);

  return (
    <form action={formAction} className="flex flex-col gap-5">
      <input type="hidden" name="id" value={post?.id ?? ""} />

      <div className="flex flex-col gap-1.5">
        <label htmlFor="noticia-titular" className="text-sm text-muted">
          Titular
        </label>
        <input
          id="noticia-titular"
          name="title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={NEWS_TITLE_MAX_LENGTH}
          required
          className="rounded-md border border-line bg-background px-3 py-2 text-sm text-foreground"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="noticia-direccion" className="text-sm text-muted">
          Dirección
        </label>
        <input
          id="noticia-direccion"
          name="slug"
          value={slug}
          onChange={(event) => setSlug(event.target.value)}
          placeholder="nueva-edicion"
          className="rounded-md border border-line bg-background px-3 py-2 font-mono text-sm text-foreground"
        />
        <p className="text-xs text-muted">
          Minúsculas, números y guiones. Se completa sola con el titular si la dejas
          vacía. La noticia se lee en /noticias/&lt;dirección&gt;.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="noticia-entradilla" className="text-sm text-muted">
          Entradilla
        </label>
        <textarea
          id="noticia-entradilla"
          name="summary"
          value={summary}
          onChange={(event) => setSummary(event.target.value)}
          maxLength={NEWS_SUMMARY_MAX_LENGTH}
          rows={2}
          className="rounded-md border border-line bg-background px-3 py-2 text-sm text-foreground"
        />
        <p className="text-xs text-muted">
          Lo que se lee en el listado. Si la dejas vacía se recorta del cuerpo.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="noticia-cuerpo" className="text-sm text-muted">
          Cuerpo
        </label>
        <textarea
          id="noticia-cuerpo"
          name="body"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          maxLength={NEWS_BODY_MAX_LENGTH}
          rows={18}
          required
          className="rounded-md border border-line bg-background px-3 py-2 font-mono text-sm leading-relaxed text-foreground"
        />
        <p className="text-xs leading-relaxed text-muted">{NEWS_MARKDOWN_HELP}</p>
      </div>

      <label className="flex items-start gap-3 rounded-md border border-line bg-background px-3 py-3">
        <input
          type="checkbox"
          name="published"
          value="true"
          checked={published}
          onChange={(event) => setPublished(event.target.checked)}
          className="mt-0.5"
        />
        <span className="flex flex-col gap-0.5">
          <span className="text-sm text-foreground">Publicada</span>
          <span className="text-xs leading-relaxed text-muted">
            Sin marcar queda como borrador: se guarda, pero no sale en la web ni por URL
            directa.
          </span>
        </span>
      </label>

      <div className="flex flex-wrap items-center gap-4 border-t border-line pt-4">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md border border-accent/60 bg-accent/15 px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent/25 disabled:opacity-60"
        >
          {pending ? "Guardando…" : post === null ? "Crear noticia" : "Guardar cambios"}
        </button>

        {state.message !== null ? (
          <p
            role="status"
            className={
              state.status === "error"
                ? "text-sm text-red-400"
                : "text-sm text-muted"
            }
          >
            {state.message}
          </p>
        ) : null}
      </div>
    </form>
  );
}
