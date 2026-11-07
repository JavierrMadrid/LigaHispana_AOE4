import type { ReactNode } from "react";

type AdminPageHeaderProps = {
  title: string;
  /** Una frase: qué se configura aquí. No repite lo que ya dice el titular. */
  description?: ReactNode;
  /** `1` en una pestaña del panel; `2` bajo el `h1` de Administración. */
  level?: 1 | 2;
  /** Acciones de la pantalla, alineadas con el titular. */
  actions?: ReactNode;
};

/**
 * Cabecera de una pantalla del panel.
 *
 * El titular y su frase van siempre con la misma escala y la misma separación.
 * Antes cada pestaña los escribía a mano y el panel acabó con dos tamaños de
 * titular y cinco anchos de párrafo para lo mismo; la frase es una sola línea de
 * intención, y lo que hay que saber para operar vive en las tarjetas.
 */
export function AdminPageHeader({
  title,
  description,
  level = 1,
  actions,
}: AdminPageHeaderProps) {
  const Heading = level === 1 ? "h1" : "h2";

  return (
    <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
      <div className="min-w-0">
        <Heading
          className={
            level === 1
              ? "text-2xl font-semibold text-foreground"
              : "text-lg font-medium text-foreground"
          }
        >
          {title}
        </Heading>
        {description !== undefined ? (
          <p className="mt-1 max-w-[70ch] text-sm text-muted">{description}</p>
        ) : null}
      </div>

      {actions !== undefined ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
      ) : null}
    </header>
  );
}
