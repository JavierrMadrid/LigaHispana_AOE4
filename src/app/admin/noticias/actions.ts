"use server";

import { revalidatePath } from "next/cache";
import type { AdminActionResult } from "@/app/admin/actions";
import { requireSuperadmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { logDatabaseFailure, uniqueViolationOn } from "@/lib/db-errors";
import { validateNewsPost } from "@/lib/news";

/** Campo de texto de un formulario, ya recortado. */
function readField(formData: FormData, name: string): string {
  const value = formData.get(name);

  return typeof value === "string" ? value.trim() : "";
}

const SAVE_FAILED_MESSAGE =
  "No se ha podido guardar la noticia. Inténtalo de nuevo en unos minutos.";

const SLUG_TAKEN_MESSAGE =
  "Ya hay otra noticia con esa dirección. Cambia el titular o escribe otra dirección.";

const POST_GONE_MESSAGE =
  "Esa noticia ya no existe. Recarga la página y vuelve a intentarlo.";

/**
 * Alta y edición de una noticia (issue 229).
 *
 * Solo el **superadministrador**: la acción llama a requireSuperadmin(), no basta con
 * que la pantalla esté detrás del panel, porque una Server Action es un endpoint
 * público.
 *
 * El formulario es una foto completa: se envian siempre titular, dirección, entradilla
 * y cuerpo, y una publicacion sin fecha conserva la que ya tenia (reeditar no cambia
 * cuando se publico). La validacion vive en lib/news.ts para poder probarla sin base.
 */
export async function saveNewsPost(
  _prevState: AdminActionResult,
  formData: FormData,
): Promise<AdminActionResult> {
  const admin = await requireSuperadmin();

  const id = readField(formData, "id");
  const published = readField(formData, "published") === "true";
  const validation = validateNewsPost({
    title: readField(formData, "title"),
    slug: readField(formData, "slug"),
    summary: readField(formData, "summary"),
    body: readField(formData, "body"),
  });

  if (!validation.ok) {
    return { status: "error", message: validation.message };
  }

  const values = validation.values;

  try {
    if (id === "") {
      await db.post.create({
        data: {
          ...values,
          authorEmail: admin.email ?? null,
          publishedAt: published ? new Date() : null,
        },
      });
    } else {
      const current = await db.post.findUnique({ where: { id }, select: { publishedAt: true } });

      if (current === null) {
        return { status: "error", message: POST_GONE_MESSAGE };
      }

      await db.post.update({
        where: { id },
        data: {
          ...values,
          publishedAt: published ? current.publishedAt ?? new Date() : null,
        },
      });
    }
  } catch (error) {
    if (uniqueViolationOn(error, "slug")) {
      return { status: "error", message: SLUG_TAKEN_MESSAGE };
    }

    logDatabaseFailure("admin/saveNewsPost", error);

    return { status: "error", message: SAVE_FAILED_MESSAGE };
  }

  revalidatePath("/admin/noticias");
  revalidatePath("/noticias");
  revalidatePath("/noticias/" + values.slug);

  return {
    status: "success",
    message: published
      ? "Noticia guardada y publicada en /noticias/" + values.slug + "."
      : "Noticia guardada como borrador: todavía no se ve en la web.",
  };
}
