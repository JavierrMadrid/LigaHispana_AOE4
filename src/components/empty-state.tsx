import type { ReactNode } from "react";

type EmptyStateProps = {
  title: string;
  body: ReactNode;
  action?: ReactNode;
};

/**
 * Estado vacío de una pantalla.
 *
 * No es un texto suelto: es un bloque con la misma caja que el resto del sitio que
 * explica qué falta y por qué, y siempre ofrece el siguiente paso. En las páginas
 * de datos "no hay nada" suele ser la primera impresión, no un error.
 *
 * También cubre el caso en que la base de datos no responde: es la misma caja,
 * pero con un texto que distingue "no hay datos" de "no se han podido leer", que
 * para quien mira la página son cosas distintas.
 */
export function EmptyState({ title, body, action }: EmptyStateProps) {
  return (
    <div className="rounded-lg border border-line bg-surface p-8 sm:p-10">
      <h2 className="font-display text-lg font-semibold text-foreground">{title}</h2>
      <div className="mt-2 max-w-[58ch] text-sm leading-relaxed text-muted">{body}</div>
      {action ? <div className="mt-6">{action}</div> : null}
    </div>
  );
}