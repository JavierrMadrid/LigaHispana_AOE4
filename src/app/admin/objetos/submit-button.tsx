"use client";

import { useFormStatus } from "react-dom";

/**
 * Botón de envío de los formularios de objetos.
 *
 * Vive aparte porque `useFormStatus` solo lee el estado del `<form>` desde un
 * componente que esté **dentro** de él: el mismo botón lo comparten el
 * lanzamiento y el cumplimiento, y así los dos se deshabilitan y cambian de
 * texto igual mientras la Server Action viaja.
 */
export function SubmitButton({
  idleLabel,
  pendingLabel,
}: {
  idleLabel: string;
  pendingLabel: string;
}) {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex h-10 shrink-0 items-center justify-center rounded-md bg-accent px-4 text-sm font-semibold text-accent-ink transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending ? pendingLabel : idleLabel}
    </button>
  );
}
