"use client";

import Image from "next/image";
import { useActionState } from "react";
import { setPassword, type SetPasswordState } from "./actions";

const initialState: SetPasswordState = { error: null };

/**
 * Tarjeta y formulario de la alta de contraseña, en la misma pieza que el
 * acceso: no hay variante de ventana que compartir, así que el panel vive aquí
 * y no en un Server Component aparte como en `/login`.
 */
export function SetPasswordForm() {
  const [state, formAction, pending] = useActionState(setPassword, initialState);

  return (
    <div className="w-full max-w-sm rounded-lg border border-line bg-surface p-6">
      <Image
        src="/imagenes/marca/emblema-256.png"
        alt="Emblema de la Liga Hispana de Age of Empires IV"
        width={56}
        height={56}
        className="mb-4 size-14"
      />
      <h1 className="mb-1 text-xl font-semibold text-foreground">Establece tu contraseña</h1>
      <p className="mb-6 text-sm text-muted">
        Último paso tras aceptar la invitación: eliges la contraseña con la que
        entrarás al panel.
      </p>

      <form action={formAction} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">Contraseña</span>
          {/* `data-autofocus`: al abrirse como ventana, `Modal` lleva el foco aquí
              en lugar de al aspa de cierre. En la página propia no hace nada. */}
          <input
            name="password"
            type="password"
            autoComplete="new-password"
            required
            data-autofocus
            className="h-10 rounded-md border border-line bg-background px-3 text-foreground"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">Repite la contraseña</span>
          <input
            name="confirm"
            type="password"
            autoComplete="new-password"
            required
            className="h-10 rounded-md border border-line bg-background px-3 text-foreground"
          />
        </label>

        {state.error ? (
          <p className="text-sm text-red-400">{state.error}</p>
        ) : null}

        <button
          type="submit"
          disabled={pending}
          className="h-10 rounded-md bg-accent px-4 font-medium text-accent-ink transition-colors hover:bg-accent-strong disabled:opacity-60"
        >
          {pending ? "Guardando…" : "Guardar contraseña"}
        </button>
      </form>
    </div>
  );
}
