import { formatMadridDateTime } from "@/lib/format";

/**
 * La fecha de publicación de una noticia, en el huso de Madrid y con el formato
 * de la casa («28 de noviembre de 2026 a las 18:30»).
 *
 * Se calla cuando no hay fecha o no se puede leer: el listado solo trae
 * publicadas y el detalle ya exige fecha, así que no hay nada que inventar.
 */
export function NewsDate({ publishedAt }: { publishedAt: Date | null }) {
  if (publishedAt === null) {
    return null;
  }

  const label = formatMadridDateTime(publishedAt);

  if (label === null) {
    return null;
  }

  return (
    <time dateTime={publishedAt.toISOString()} className="news-date">
      {label}
    </time>
  );
}
