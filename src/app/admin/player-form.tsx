"use client";

import { useActionState } from "react";
import { DISCORD_USERNAME_FIELD_MAX_LENGTH } from "@/lib/player-input";
import { createPlayer, type PlayerFormState } from "./actions";

const initialState: PlayerFormState = { error: null, message: null };

/**
 * Alta de jugador desde el panel.
 *
 * Conserva el comportamiento y el copy de siempre: los mismos campos, misma
 * validación en servidor y un único mensaje de error que sustituye al formulario
 * sin decir nada del fallo real, que se queda en el log.
 *
 * El botón dice lo que está pasando de verdad, que ya no es solo guardar: si el
 * jugador queda aprobado, la acción le trae las partidas de AoE4World y recalcula
 * la clasificación. Son varios segundos contra una API externa, y un "Guardando…"
 * sin más invites a pensar que se ha colgado.
 */
export function PlayerForm({
  countries,
  disabled = false,
}: {
  countries: string[];
  /** El plazo cerrado bloquea el alta; el servidor lo rechaza igualmente. */
  disabled?: boolean;
}) {
  const [state, formAction, pending] = useActionState(createPlayer, initialState);

  return (
    <form action={formAction} className="rounded-lg border border-line bg-surface p-4">
      {disabled ? (
        <p className="mb-4 rounded-md border border-line-strong bg-surface-raised px-3 py-2 text-sm leading-relaxed text-muted">
          El alta está bloqueada porque las inscripciones están cerradas. Ábrelas en el
          control de arriba para poder añadir jugadores.
        </p>
      ) : null}

      <fieldset disabled={disabled} className="grid min-w-0 gap-4 sm:grid-cols-2">
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted">Profile ID (AoE4World)</span>
        <input
          name="profileId"
          inputMode="numeric"
          required
          placeholder="1234567"
          autoComplete="off"
          className="h-10 rounded-md border border-line bg-background px-3 text-foreground placeholder:text-muted"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted">Nombre</span>
        <input
          name="name"
          required
          placeholder="Beastyqt"
          maxLength={64}
          autoComplete="off"
          className="h-10 rounded-md border border-line bg-background px-3 text-foreground placeholder:text-muted"
        />
      </label>

      {/*
        Obligatorio, y con la arroba **dentro** del valor: es lo que exige el parser
        del servidor (`parseDiscordUsername`), que rechaza un nombre sin ella. Se pide
        el nombre global —el único que identifica una cuenta en todo Discord— y no el
        que la persona tenga puesto dentro del servidor. La pista va fuera del
        `<label>` y enlazada con `aria-describedby` para que no forme parte del nombre
        accesible del campo.
      */}
      <div className="flex flex-col gap-1 text-sm">
        <label htmlFor="discord-username" className="text-muted">
          Usuario de Discord
        </label>
        <input
          id="discord-username"
          name="discordUsername"
          required
          placeholder="@pepito"
          maxLength={DISCORD_USERNAME_FIELD_MAX_LENGTH}
          autoComplete="off"
          aria-describedby="discord-username-hint"
          className="h-10 rounded-md border border-line bg-background px-3 text-foreground placeholder:text-muted"
        />
        <span id="discord-username-hint" className="text-xs leading-relaxed text-muted">
          El usuario global de Discord, con la arroba delante (@pepito): el que la
          persona usa en todo Discord, no el nombre que tenga puesto dentro del servidor.
        </span>
      </div>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted">País (opcional)</span>
        <select
          name="country"
          defaultValue=""
          className="h-10 rounded-md border border-line bg-background px-3 text-foreground"
        >
          <option value="">Sin especificar</option>
          {countries.map((country) => (
            <option key={country} value={country}>
              {country}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted">Canal de Twitch (opcional)</span>
        <input
          name="twitchChannel"
          placeholder="beastyqt"
          maxLength={25}
          autoComplete="off"
          className="h-10 rounded-md border border-line bg-background px-3 text-foreground placeholder:text-muted"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted">Canal de YouTube (opcional)</span>
        <input
          name="youtubeChannel"
          placeholder="@canal"
          maxLength={100}
          autoComplete="off"
          className="h-10 rounded-md border border-line bg-background px-3 text-foreground placeholder:text-muted"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted">Canal de Kick (opcional)</span>
        <input
          name="kickChannel"
          placeholder="canal"
          maxLength={100}
          autoComplete="off"
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

      {state.error !== null ? (
        <p role="alert" className="text-sm text-loss sm:col-span-2">
          {state.error}
        </p>
      ) : null}

      {/*
        `status` en vez de `alert`: el alta sí se hizo, así que esto informa y no
        avisa de un fallo. Va en `text-muted` y no en el dorado porque el oro es
        para liga y estructura, no para estados.
      */}
      {state.message !== null ? (
        <p role="status" className="text-sm text-muted sm:col-span-2">
          {state.message}
        </p>
      ) : null}

      <div className="sm:col-span-2">
        <button
          type="submit"
          disabled={pending}
          className="h-10 rounded-md bg-accent px-4 text-sm font-semibold text-accent-ink transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? "Guardando y trayendo sus partidas…" : "Añadir jugador"}
        </button>
      </div>
      </fieldset>
    </form>
  );
}
