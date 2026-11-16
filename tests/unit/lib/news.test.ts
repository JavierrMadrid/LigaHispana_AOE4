import { describe, expect, it } from "vitest";

import {
  NEWS_BODY_MAX_LENGTH,
  NEWS_SUMMARY_MAX_LENGTH,
  NEWS_TITLE_MAX_LENGTH,
  isNewsSlug,
  newsExcerpt,
  newsPlainText,
  renderNewsBody,
  slugifyNewsTitle,
  validateNewsPost,
} from "@/lib/news";

/**
 * Las noticias de la issue 229: la dirección, la entradilla, la validación del
 * formulario y el Markdown básico.
 *
 * Lo importante de este módulo es que la página pública lo pinta como HTML, así que
 * los casos que más pesan son los de **seguridad**: lo que no es una marca conocida se
 * escapa, y un enlace que no sea http(s) o una ruta del sitio no se convierte en
 * enlace.
 */

describe("slugifyNewsTitle", () => {
  it("pasa el titular a minúsculas, sin acentos y con guiones", () => {
    expect(slugifyNewsTitle("Nueva edición: ¡arranca la liga!")).toBe(
      "nueva-edicion-arranca-la-liga",
    );
    expect(slugifyNewsTitle("  Cambios  en   el calendario  ")).toBe("cambios-en-el-calendario");
  });

  it("recorta a ochenta caracteres y quita el guion final que deja el corte", () => {
    const slug = slugifyNewsTitle("a".repeat(120));

    expect(slug.length).toBeLessThanOrEqual(80);
    expect(slug.endsWith("-")).toBe(false);
  });
});

describe("isNewsSlug", () => {
  it("acepta minúsculas, números y guiones simples", () => {
    expect(isNewsSlug("nueva-edicion")).toBe(true);
    expect(isNewsSlug("2026-11-04")).toBe(true);
  });

  it("rechaza lo que no cabe en una URL legible", () => {
    expect(isNewsSlug("")).toBe(false);
    expect(isNewsSlug("Con Mayúsculas")).toBe(false);
    expect(isNewsSlug("con_barra")).toBe(false);
    expect(isNewsSlug("con--doble")).toBe(false);
    expect(isNewsSlug("-empieza-por-guion")).toBe(false);
    expect(isNewsSlug("a".repeat(81))).toBe(false);
  });
});

describe("validateNewsPost", () => {
  const valido = {
    title: "Arranca la tercera edición",
    slug: "",
    summary: "La liga empieza el 15 de noviembre.",
    body: "Primer párrafo.",
  };

  it("rellena la dirección desde el titular cuando se deja vacía", () => {
    const result = validateNewsPost(valido);

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.values.slug).toBe("arranca-la-tercera-edicion");
      expect(result.values.summary).toBe("La liga empieza el 15 de noviembre.");
    }
  });

  it("recorta los espacios y deja la entradilla vacía como null", () => {
    const result = validateNewsPost({ ...valido, title: "  Hola  ", summary: "   " });

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.values.title).toBe("Hola");
      expect(result.values.summary).toBeNull();
    }
  });

  it("se niega con un mensaje en español cuando algo no vale", () => {
    const sinTitular = validateNewsPost({ ...valido, title: "   " });
    const titularLargo = validateNewsPost({ ...valido, title: "a".repeat(NEWS_TITLE_MAX_LENGTH + 1) });
    const slugMalo = validateNewsPost({ ...valido, slug: "Con Espacios" });
    const entradillaLarga = validateNewsPost({
      ...valido,
      summary: "a".repeat(NEWS_SUMMARY_MAX_LENGTH + 1),
    });
    const sinCuerpo = validateNewsPost({ ...valido, body: "  " });
    const cuerpoLargo = validateNewsPost({ ...valido, body: "a".repeat(NEWS_BODY_MAX_LENGTH + 1) });

    for (const result of [sinTitular, titularLargo, slugMalo, entradillaLarga, sinCuerpo, cuerpoLargo]) {
      expect(result.ok).toBe(false);
    }

    expect(sinTitular.ok === false && sinTitular.message).toContain("titular es obligatorio");
  });
});

describe("newsPlainText y newsExcerpt", () => {
  it("quita las marcas para usar el cuerpo como entradilla", () => {
    expect(newsPlainText("**Hola** [liga](https://laligahispana.es) <script>")).toBe(
      "Hola liga <script",
    );
  });

  it("prefiere la entradilla escrita y recorta por palabra", () => {
    expect(newsExcerpt("Corta", "Cuerpo larguísimo")).toBe("Corta");
    expect(newsExcerpt(null, "palabra ".repeat(60), 30)).toMatch(/…$/);
    expect(newsExcerpt("Cabe", "x", 40)).toBe("Cabe");
  });
});

describe("renderNewsBody", () => {
  it("escapa el HTML que venga en el texto", () => {
    expect(renderNewsBody("<script>alert(1)</script>")).toContain(
      "&lt;script&gt;alert(1)&lt;/script&gt;",
    );
    expect(renderNewsBody('<img src=x onerror="alert(1)">')).not.toContain("<img");
  });

  it("pinta párrafos separados por líneas en blanco y saltos dentro del párrafo", () => {
    expect(renderNewsBody("Uno\ndos\n\ntres")).toBe("<p>Uno<br />dos</p>\n<p>tres</p>");
  });

  it("reconoce títulos, listas, citas y las marcas de línea", () => {
    const html = renderNewsBody(
      "## Título\n\n- uno\n- dos\n\n1. primero\n\n> cita\n\n**fuerte** y *suave* y `código`",
    );

    expect(html).toContain("<h2>Título</h2>");
    expect(html).toContain("<ul><li>uno</li><li>dos</li></ul>");
    expect(html).toContain("<ol><li>primero</li></ol>");
    expect(html).toContain("<blockquote><p>cita</p></blockquote>");
    expect(html).toContain("<strong>fuerte</strong>");
    expect(html).toContain("<em>suave</em>");
    expect(html).toContain("<code>código</code>");
  });

  it("no convierte en enlace un destino que no sea http(s) o una ruta del sitio", () => {
    expect(renderNewsBody("[malo](javascript:alert(1))")).not.toContain("<a href");
    expect(renderNewsBody("[bien](https://laligahispana.es)")).toContain(
      '<a href="https://laligahispana.es" rel="noopener noreferrer">bien</a>',
    );
    expect(renderNewsBody("[interno](/reglas)")).toContain('<a href="/reglas"');
  });

  it("no interpreta el markdown que va dentro de un trozo de código", () => {
    expect(renderNewsBody("`**no** es negrita`")).toBe("<p><code>**no** es negrita</code></p>");
  });
});
