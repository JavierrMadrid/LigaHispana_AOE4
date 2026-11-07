import type { ReactNode } from "react";

type SectionCardProps = {
  title: string;
  /** Una frase corta; nunca repite la frase de la cabecera de la página. */
  description?: ReactNode;
  /** `2` en una página con `h1` propio; `3` bajo un titular de subpestaña. */
  level?: 2 | 3;
  /** Dato o control alineado con el titular: una píldora de estado, un recuento. */
  actions?: ReactNode;
  /** Fila al pie, separada por filete: normalmente el guardado del formulario. */
  footer?: ReactNode;
  /** Ancla de la tarjeta; también nombra su titular para lectores de pantalla. */
  id?: string;
  className?: string;
  /** Clase del cuerpo; `p-0` cuando lo que va dentro es una tabla a sangre. */
  bodyClassName?: string;
  children: ReactNode;
};

/**
 * Id estable para el titular. El llamador puede fijarlo con `id` cuando la
 * tarjeta es un destino de enlace; si no, se deriva del título, que en una misma
 * pantalla no se repite.
 */
function titleId(title: string, id: string | undefined): string {
  if (id !== undefined) {
    return `${id}-titulo`;
  }

  const slug = title
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return `seccion-${slug}`;
}

/**
 * Bloque de una pantalla del panel: una caja con su titular, su frase opcional,
 * su cuerpo separado por filete y un hueco de acciones o pie.
 *
 * Existe porque las secciones se separaban solo con un `h3` y un párrafo, y no
 * se veía dónde empezaba ni acababa cada bloque. La caja es la unidad, no el
 * `h3`: dentro de una tarjeta no se mete otra tarjeta, se usan filetes.
 */
export function SectionCard({
  title,
  description,
  level = 3,
  actions,
  footer,
  id,
  className,
  bodyClassName = "px-5 py-4",
  children,
}: SectionCardProps) {
  const Heading = level === 2 ? "h2" : "h3";
  const headingId = titleId(title, id);

  return (
    <section
      id={id}
      aria-labelledby={headingId}
      className={`rounded-lg border border-line bg-surface ${className ?? ""}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2 px-5 py-4">
        <div className="min-w-0">
          <Heading
            id={headingId}
            className={
              level === 2
                ? "text-lg font-medium text-foreground"
                : "text-base font-medium text-foreground"
            }
          >
            {title}
          </Heading>
          {description !== undefined ? (
            <p className="mt-1 max-w-[70ch] text-sm text-muted">{description}</p>
          ) : null}
        </div>

        {actions !== undefined ? (
          <div className="flex shrink-0 items-center gap-2">{actions}</div>
        ) : null}
      </div>

      <div className={`border-t border-line ${bodyClassName}`}>{children}</div>

      {footer !== undefined ? (
        <div className="border-t border-line px-5 py-4">{footer}</div>
      ) : null}
    </section>
  );
}
