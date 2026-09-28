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
        <input
          name="email"
          type="email"
          autoComplete="email"
          required
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
        <p className="text-sm text-red-400">{state.error}</p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="h-10 rounded-md bg-accent px-4 font-medium text-accent-ink transition-colors hover:bg-accent-strong disabled:opacity-60"
      >
        {pending ? "Entrando…" : "Entrar"}
      </button>
    </form>
  );
}
