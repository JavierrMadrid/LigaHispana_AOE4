"use client";

import { useActionState } from "react";
import { login, type LoginState } from "./actions";

const initialState: LoginState = { error: null };

export function LoginForm() {
  const [state, formAction, pending] = useActionState(login, initialState);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted">Email</span>
        {/* `data-autofocus`: al abrirse como ventana, `Modal` lleva el foco aquí
            en lugar de al aspa de cierre. En la página propia no hace nada. */}
        <input
          name="email"
          type="email"
          autoComplete="email"
          required
          data-autofocus
          className="h-10 rounded-md border border-line bg-background px-3 text-foreground"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted">Contraseña</span>
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className="h-10 rounded-md border border-line bg-background px-3 text-foreground"
        />
      </label>

      {state.error ? (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="h-10 rounded-md bg-accent px-4 font-medium text-accent-ink transition-colors hover:bg-accent-strong active:translate-y-px disabled:opacity-60"
      >
        {pending ? "Entrando…" : "Entrar"}
      </button>
    </form>
  );
}
