import type { ReactNode } from "react";

type PageHeadProps = {
  /**
   * Título de la página. No se pinta: es el `h1` semántico que necesitan los
   * lectores de pantalla y los buscadores. La navegación ya dice al visitante
   * en qué página está, así que el título visible sobraba.
   */
  title: string;
  /** Controles de la página: contador en juego, refresco, chips de estado. */
  aside?: ReactNode;
};

/**
 * Cabecera semántica de una página pública.
 *
 * Tras la limpieza visual las páginas no llevan titular a la vista y empiezan
 * directamente por su contenido. Aquí solo queda el `h1` oculto y, si la página
 * tiene controles propios, una fila para colocarlos encima de ese contenido.
 */
export function PageHead({ title, aside }: PageHeadProps) {
  return (
    <>
      <h1 className="sr-only">{title}</h1>
      {aside ? (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
          {aside}
        </div>
      ) : null}
    </>
  );
}
