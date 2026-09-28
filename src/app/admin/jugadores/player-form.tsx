"use client";

import { useActionState } from "react";
import { createPlayer, type PlayerFormState } from "./actions";

const initialState: PlayerFormState = { error: null };

export function PlayerForm() {
  const [state, formAction, pending] = useActionState(createPlayer, initialState);

  return (
    <form
      action={formAction}
      className="grid gap-4 rounded-lg border border-line bg-surface p-4 sm:grid-cols-2"
    >
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted">Profile ID (AoE4World)</span>
        <input
          name="profileId"
          inputMode="numeric"
          required
          placeholder="1234567"
          className="h-10 rounded-md border border-line bg-background px-3 text-foreground placeholder:text-muted"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted">Nombre</span>
        <input
          name="name"
          required
          placeholder="Beastyqt"
          className="h-10 rounded-md border border-line bg-background px-3 text-foreground placeholder:text-muted"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted">Canal de Twitch (opcional)</span>
        <input
          name="twitchChannel"
          placeholder="beastyqt"
          className="h-10 rounded-md border border-line bg-background px-3 text-foreground placeholder:text-muted"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted">Estado</span>
        <select
          name="status"
          defaultValue="APPROVED"
          className="h-10 rounded-md border border-line bg-background px-3 text-foreground"
        >
          <option value="APPROVED">Aprobado</option>
          <option value="PENDING">Pendiente</option>
          <option value="REJECTED">Rechazado</option>
        </select>
      </label>

      {state.error ? (
        <p className="text-sm text-red-400 sm:col-span-2">{state.error}</p>
      ) : null}

      <div className="sm:col-span-2">
        <button
          type="submit"
          disabled={pending}
          className="h-10 rounded-md bg-accent px-4 text-sm font-medium text-accent-ink transition-colors hover:bg-accent-strong disabled:opacity-60"
        >
          {pending ? "Guardando…" : "Añadir jugador"}
        </button>
      </div>
    </form>
  );
}
