import type { ReactNode } from "react";

export type CalloutTone = "info" | "warning" | "locked";

const TONE_CLASS: Record<CalloutTone, string> = {
  info: "border-line bg-surface-raised",
  warning: "border-danger/40 bg-danger/5",
  locked: "border-accent/30 bg-accent/5",
};

const TITLE_CLASS: Record<CalloutTone, string> = {
  info: "text-foreground",
  warning: "text-danger-soft",
  locked: "text-foreground",
};

type CalloutProps = {
  tone?: CalloutTone;
  /** Titular corto del aviso; el cuerpo ya explica el motivo y el siguiente paso. */
  title?: string;
  className?: string;
  children: ReactNode;
};

/**
 * Aviso dentro de una tarjeta: un estado que hay que leer antes de tocar nada.
 *
 * Tres tonos y no más, con los colores que el panel ya tenía: `info` para el
 * contexto, `warning` para lo que está mal —el rojo reservado a lo que hay que
 * corregir— y `locked` para lo que el sistema no deja cambiar, que es el oro con
 * el que el panel marca la edición en marcha. La caja es de 1px por los cuatro
 * lados: un filete de color en un borde suelto se lee como decoración.
 */
export function Callout({ tone = "info", title, className, children }: CalloutProps) {
  return (
    <div
      className={`rounded-lg border px-4 py-3 text-sm leading-relaxed text-muted ${TONE_CLASS[tone]} ${className ?? ""}`}
    >
      {title !== undefined ? (
        <p className={`font-semibold ${TITLE_CLASS[tone]}`}>{title}</p>
      ) : null}
      <div className={title !== undefined ? "mt-1" : undefined}>{children}</div>
    </div>
  );
}
