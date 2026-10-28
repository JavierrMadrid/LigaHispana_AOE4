"use client";

import { useActionState } from "react";
import Link from "next/link";
import { CONTACT_EMAIL_MAX_LENGTH, DISCORD_USERNAME_FIELD_MAX_LENGTH } from "@/lib/player-input";
import { createPlayer, type PlayerFormState } from "./actions";

const initialState: PlayerFormState = { error: null, message: null };

/**
 * Alta de jugador desde el panel.
 *
 * Conserva el comportamiento y el copy de siempre: los mismos campos, misma
 * validación en servidor y un único mensaje de error que sustituye al formulario
 * sin decir nada del fallo real, que se queda en el log.
 *
 * Desde la issue 119 el alta **no** trae partidas ni recalcula: escribe la fila y,
 * cuando la verificación por Discord está configurada, manda el privado. El estado
 * que se elija manda: «Aprobado» no aprueba, deja el alta pendiente hasta que la
 * persona confirme, y por eso la pista del campo de estado lo dice en vez de dejar
 * que se descubra después. Con la verificación caída la pista dice lo contrario,
 * porque entonces «Aprobado» aprueba de verdad y no hay privado.
 *
 * Con el plazo cerrado (`disabled`) el formulario entero se apaga y una nota
 * explica por qué, en vez de desaparecer: el panel es una herramienta y un bloque
 * que se esfuma deja a quien lo usaba sin saber si se ha roto. El apagado se hace
 * con un `<fieldset disabled>`, que desactiva de una vez todos los controles y sus
 * etiquetas, sin repetir `disabled` campo a campo. El servidor lo rechaza igual:
 * esto es la cara visible de `Setting["registration.open"]`, no la defensa.
 */
export function PlayerForm({
  countries,
  disabled = false,
  discordVerificationEnabled = false,
}: {
  countries: string[];
  /** El plazo cerrado bloquea el alta; el servidor lo rechaza igualmente. */
  disabled?: boolean;
  /**
   * Si la verificación del alta por privado está configurada, leído en el servidor
   * (`missingDiscordVerificationEnv()`). Decide **qué** dice la pista del campo de
   * estado, no si se pinta: con la verificación puesta, «Aprobado» deja el alta
   * pendiente de confirmación; sin ella, la aprueba de verdad y no manda privado.
   * Anunciar una confirmación que no va a llegar sería mentir, y callar que el alta
   * entra sola también.
   */
  discordVerificationEnabled?: boolean;
}) {
  const [state, formAction, pending] = useActionState(createPlayer, initialState);

  return (
    <form action={formAction} className="rounded-lg border border-line bg-surface p-4">
      {disabled ? (
        <p className="mb-4 rounded-md border border-line-strong bg-surface-raised px-3 py-2 text-sm leading-relaxed text-muted">
          El alta está bloqueada porque las inscripciones están cerradas.{" "}
          <Link
            href="/admin/administracion/inscripciones"
            className="text-accent underline underline-offset-4 hover:text-accent-strong"
          >
            Ábrelas en Inscripciones
          </Link>{" "}
          para poder añadir jugadores.
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
          Opcional, y con el mismo criterio que el país: vacío es `null` ("no lo
          sabemos") y un valor escrito que no es una dirección es un error, no un `null`
          silencioso. Va detrás del nombre porque es un dato de la persona y no un canal.
          `autoComplete="off"` a propósito, como los demás campos: quien escribe es un
          admin rellenando datos de otro, y aquí autocompletar su propia dirección
          acabaría con el correo del admin en la ficha del jugador.
        */}
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">Correo de contacto (opcional)</span>
          <input
            name="email"
            type="email"
            placeholder="nombre@correo.com"
            maxLength={CONTACT_EMAIL_MAX_LENGTH}
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

        <div className="flex flex-col gap-1 text-sm">
          <label htmlFor="alta-estado" className="text-muted">
            Estado
          </label>
          <select
            id="alta-estado"
            name="status"
            defaultValue="APPROVED"
            aria-describedby="alta-estado-hint"
            className="h-10 rounded-md border border-line bg-background px-3 text-foreground"
          >
            <option value="APPROVED">Aprobado</option>
            <option value="PENDING">Pendiente</option>
            <option value="REJECTED">Rechazado</option>
          </select>
          {/* Fuera del `<label>` y enlazada con `aria-describedby`, como la pista
              del usuario de Discord: así no forma parte del nombre accesible del
              campo. Se pinta siempre: el mismo valor del campo significa una cosa con
              la verificación puesta y otra sin ella, así que las dos se dicen. La
              lista de variables que faltan no se repite aquí: eso es el aviso de
              arriba, y esta pista es una línea. */}
          <span id="alta-estado-hint" className="text-xs leading-relaxed text-muted">
            {discordVerificationEnabled
              ? "Si eliges Aprobado, el alta quedará pendiente hasta que la persona confirme por privado de Discord. Si eliges Pendiente, el privado se enviará al aprobarla."
              : "La verificación por privado está desactivada: si eliges Aprobado, el alta se aprueba directamente y no se envía ningún privado."}
          </span>
        </div>

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
            {pending ? "Dando de alta…" : "Añadir jugador"}
          </button>
        </div>
      </fieldset>
    </form>
  );
}