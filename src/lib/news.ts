/**
 * Las **noticias** del torneo (issue 229): el catálogo de límites, la validación del
 * formulario y el **Markdown básico** con el que se pinta el cuerpo.
 *
 * Todo lo de aquí es puro: no lee la base, no mira el reloj y no depende de Next. La
 * lectura y la escritura viven en `news-store.ts`, y la pantalla de administración en
 * `src/app/admin/noticias/`.
 *
 * ## El formato enriquecido es una lista blanca
 *
 * El cuerpo lo escribe el superadministrador, pero la página pública lo pinta como
 * HTML: por eso el renderizador **escapa todo** y después solo reconoce un repertorio
 * corto de marcas. No hay HTML crudo, ni imágenes, ni scripts, y los enlaces solo
 * valen si son `http(s)://` o una ruta del propio sitio. Lo que no se entiende se pinta
 * como texto, que es lo único que no puede sorprender a quien lo lee.
 */

/** Tope del titular. */
export const NEWS_TITLE_MAX_LENGTH = 120;
/** Tope de la entradilla. */
export const NEWS_SUMMARY_MAX_LENGTH = 240;
/** Tope del cuerpo: una noticia del torneo no necesita más. */
export const NEWS_BODY_MAX_LENGTH = 20_000;
/** Tope del slug, que es la URL. */
export const NEWS_SLUG_MAX_LENGTH = 80;

/** Minúsculas, números y guiones simples: lo que cabe en una URL legible. */
const NEWS_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * El slug que se propone a partir del titular: minúsculas, sin acentos y con guiones.
 *
 * Se usa cuando el formulario deja el slug vacío. Un titular sin letras ni números
 * (solo emojis, por ejemplo) da cadena vacía, y la validación lo dirá: mejor pedir un
 * slug a inventarse una URL.
 */
export function slugifyNewsTitle(title: string): string {
  return title
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, NEWS_SLUG_MAX_LENGTH)
    .replace(/-+$/g, "");
}

/** Si el slug sirve como dirección: ya normalizado y dentro del tope. */
export function isNewsSlug(slug: string): boolean {
  return slug.length > 0 && slug.length <= NEWS_SLUG_MAX_LENGTH && NEWS_SLUG_PATTERN.test(slug);
}

/** Lo que llega del formulario, ya recortado. */
export type NewsPostInput = {
  title: string;
  slug: string;
  summary: string;
  body: string;
};

/** Los valores que se guardan, ya normalizados. */
export type NewsPostValues = {
  title: string;
  slug: string;
  /** Entradilla, o `null` si no se escribió. */
  summary: string | null;
  body: string;
};

/** El resultado de validar: los valores listos o el primer error, en español. */
export type NewsPostValidation =
  | { ok: true; values: NewsPostValues }
  | { ok: false; message: string };

/**
 * Valida lo que se ha escrito y devuelve lo que se guarda, o el primer error.
 *
 * El slug vacío se rellena a partir del titular y, si el titular no da slug, se pide a
 * mano. Los límites se comprueban aquí además de en el schema porque una Server Action
 * es un endpoint público: el navegador no es la defensa.
 */
export function validateNewsPost(input: NewsPostInput): NewsPostValidation {
  const title = input.title.trim();
  const summary = input.summary.trim();
  const body = input.body.trim();
  const slug = (input.slug.trim() === "" ? slugifyNewsTitle(title) : input.slug.trim()).toLowerCase();

  if (title === "") {
    return { ok: false, message: "El titular es obligatorio: es lo que se lee en el listado." };
  }

  if (title.length > NEWS_TITLE_MAX_LENGTH) {
    return {
      ok: false,
      message: `El titular no puede pasar de ${NEWS_TITLE_MAX_LENGTH} caracteres.`,
    };
  }

  if (!isNewsSlug(slug)) {
    return {
      ok: false,
      message: `La dirección tiene que ser minúsculas, números y guiones simples (por ejemplo "nueva-edicion"), sin pasar de ${NEWS_SLUG_MAX_LENGTH} caracteres.`,
    };
  }

  if (summary.length > NEWS_SUMMARY_MAX_LENGTH) {
    return {
      ok: false,
      message: `La entradilla no puede pasar de ${NEWS_SUMMARY_MAX_LENGTH} caracteres.`,
    };
  }

  if (body === "") {
    return { ok: false, message: "El cuerpo de la noticia no puede estar vacío." };
  }

  if (body.length > NEWS_BODY_MAX_LENGTH) {
    return {
      ok: false,
      message: `El cuerpo no puede pasar de ${NEWS_BODY_MAX_LENGTH} caracteres.`,
    };
  }

  return { ok: true, values: { title, slug, summary: summary === "" ? null : summary, body } };
}

/** Un texto sin marcas de Markdown, para usarlo como entradilla. */
export function newsPlainText(body: string): string {
  return body
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_>#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * La entradilla de una noticia: la suya o, si no tiene, el principio del cuerpo.
 *
 * Recorta por palabra para no cortar a media palabra y añade puntos suspensivos solo
 * cuando de verdad se ha recortado.
 */
export function newsExcerpt(summary: string | null, body: string, max = NEWS_SUMMARY_MAX_LENGTH): string {
  const source = summary !== null && summary.trim() !== "" ? summary.trim() : newsPlainText(body);
  const text = source.replace(/\s+/g, " ").trim();

  if (text.length <= max) {
    return text;
  }

  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");

  return `${(lastSpace > max / 2 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:.]+$/, "")}…`;
}

/* -------------------------------------------------------------------------- */
/* Markdown básico                                                             */
/* -------------------------------------------------------------------------- */

/** El repertorio de marcas, para la ayuda del formulario y la documentación. */
export const NEWS_MARKDOWN_HELP =
  "Párrafos separados por una línea en blanco; ## y ### para títulos; - para listas; 1. para listas numeradas; > para citas; **negrita**, *cursiva*, `código` y [texto](https://enlace).";

/** Escapa lo que el navegador interpretaría como HTML. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Carácter de uso privado con el que se protegen los trozos ya formateados. */
const TOKEN = "\u0001";

/**
 * Las marcas de línea: negrita, cursiva, código y enlaces.
 *
 * El texto llega ya escapado. El código se aparta antes de todo lo demás para que un
 * `*` dentro de un trozo de código no se interprete como cursiva; después se devuelve
 * tal cual. Los enlaces solo se pintan si el destino es `http(s)://` o una ruta del
 * sitio: un `javascript:` se queda como texto.
 */
function renderInline(escaped: string): string {
  const code: string[] = [];
  let html = escaped.replace(/`([^`]+)`/g, (_match, inner: string) => {
    code.push(`<code>${inner}</code>`);

    return `${TOKEN}${code.length - 1}${TOKEN}`;
  });

  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  html = html.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label: string, url: string) => {
    const safe = /^(https?:\/\/|\/)/i.test(url);

    return safe ? `<a href="${url}" rel="noopener noreferrer">${label}</a>` : match;
  });

  return html.replace(new RegExp(`${TOKEN}(\\d+)${TOKEN}`, "g"), (_match, index: string) => {
    return code[Number(index)] ?? "";
  });
}

/**
 * El cuerpo en HTML, con una lista blanca de bloques: párrafos, `h2`, `h3`, listas,
 * citas y saltos de línea dentro del párrafo.
 *
 * El resultado es **seguro por construcción**: lo que no es una marca conocida se
 * escapa, y no hay ni un atributo que venga del texto salvo el `href` de un enlace, que
 * ya se ha filtrado.
 */
export function renderNewsBody(body: string): string {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const blocks: string[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushParagraph = (): void => {
    if (paragraph.length === 0) {
      return;
    }

    blocks.push(`<p>${paragraph.map((line) => renderInline(escapeHtml(line))).join("<br />")}</p>`);
    paragraph = [];
  };

  const flushList = (): void => {
    if (list === null) {
      return;
    }

    const tag = list.ordered ? "ol" : "ul";
    const items = list.items
      .map((item) => `<li>${renderInline(escapeHtml(item))}</li>`)
      .join("");

    blocks.push(`<${tag}>${items}</${tag}>`);
    list = null;
  };

  const flushAll = (): void => {
    flushParagraph();
    flushList();
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (line.trim() === "") {
      flushAll();
      continue;
    }

    const heading = /^(#{2,3})\s+(.*)$/.exec(line);

    if (heading !== null) {
      flushAll();
      const tag = heading[1].length === 2 ? "h2" : "h3";
      blocks.push(`<${tag}>${renderInline(escapeHtml(heading[2]))}</${tag}>`);
      continue;
    }

    const quote = /^>\s+(.*)$/.exec(line);

    if (quote !== null) {
      flushAll();
      blocks.push(`<blockquote><p>${renderInline(escapeHtml(quote[1]))}</p></blockquote>`);
      continue;
    }

    const bullet = /^[-*]\s+(.*)$/.exec(line);
    const numbered = /^\d+\.\s+(.*)$/.exec(line);

    if (bullet !== null || numbered !== null) {
      flushParagraph();

      const ordered = numbered !== null;
      const item = (bullet ?? numbered)?.[1] ?? "";

      if (list !== null && list.ordered === ordered) {
        list.items.push(item);
      } else {
        flushList();
        list = { ordered, items: [item] };
      }

      continue;
    }

    flushList();
    paragraph.push(line);
  }

  flushAll();

  return blocks.join("\n");
}
