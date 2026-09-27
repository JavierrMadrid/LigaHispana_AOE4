import type { ReactNode } from "react";

type PageHeadProps = {
  title: string;
  lead?: ReactNode;
  /** Contenido a la derecha del título: contador en directo, botón de refresco. */
  aside?: ReactNode;
};

/**
 * Cabecera de una página pública: filete de oro, titular en capital
 * inscripcional y entradilla. El filete es la firma de la casa y se repite en
 * todas las páginas para que la cara pública se lea como una sola web.
 */
export function PageHead({ title, lead, aside }: PageHeadProps) {
  return (
    <div className="flex flex-col gap-6 border-b border-line pb-8 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <span aria-hidden="true" className="block h-px w-10 bg-accent/70" />
        <h1 className="mt-4 font-display text-3xl font-semibold text-foreground sm:text-4xl">
          {title}
        </h1>
        {lead ? (
          <p className="mt-3 max-w-[62ch] leading-relaxed text-muted">{lead}</p>
        ) : null}
      </div>
      {aside ? <div className="flex shrink-0 items-center gap-4">{aside}</div> : null}
    </div>
  );
}