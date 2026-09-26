"use client";

import { useActionState } from "react";
import { createPlayer, type PlayerFormState } from "./actions";

const initialState: PlayerFormState = { error: null };

export function PlayerForm() {
  const [state, formAction, pending] = useActionState(createPlayer, initialState);

  return (
    <form
      action={formAction}
      className="grid gap-4 rounded-lg border border-neutral-800 bg-neutral-950 p-4 sm:grid-cols-2"
    >
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-neutral-400">Profile ID (AoE4World)</span>
        <input
          name="profileId"
          inputMode="numeric"
          required
          placeholder="1234567"
          className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-neutral-100 outline-none focus:border-amber-500"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-neutral-400">Nombre</span>
        <input
          name="name"
          required
          placeholder="Beastyqt"
          className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-neutral-100 outline-none focus:border-amber-500"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-neutral-400">Canal de Twitch (opcional)</span>
        <input
          name="twitchChannel"
          placeholder="beastyqt"
          className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-neutral-100 outline-none focus:border-amber-500"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-neutral-400">Estado</span>
        <select
          name="status"
          defaultValue="APPROVED"
          className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-neutral-100 outline-none focus:border-amber-500"
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
          className="rounded-md bg-amber-500 px-3 py-2 text-sm font-medium text-neutral-950 hover:bg-amber-400 disabled:opacity-60"
        >
          {pending ? "Guardando…" : "Añadir jugador"}
        </button>
      </div>
    </form>
  );
}
