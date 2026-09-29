"use client";

import type { ComponentPropsWithoutRef } from "react";
import { useActionState, useEffect } from "react";
import Link from "next/link";
import { CONTACT_EMAIL_MAX_LENGTH } from "@/lib/player-input";
import { REGISTRATION_IS_CLOSED } from "@/lib/registration-open";
import { registerPlayer, type RegistrationFormState } from "./actions";
import { TurnstileWidget, resetTurnstileWidget } from "./turnstile-widget";

const initialState: RegistrationFormState = {
  status: "idle",
  message: null,
  fieldErrors: {},
};

/**
 * Site key pública del captcha. Se lee con el nombre literal y no con la
 * constante del contrato porque Next solo sustituye `process.env.NEXT_PUBLIC_*`
 * cuando el acceso es estático; con una clave calculada llegaría vacío al
 * navegador. Sin valor el formulario es el de siempre: no se pinta el widget y
 * el servidor tampoco comprueba nada.
 */
const turnstileSiteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim() ?? "";

/**
 * Formulario público de inscripción.
 *
 * Es cliente porque `useActionState` lleva el estado de la Server Action (error
 * general, error por campo y envío pendiente). Importar `registerPlayer` aquí es
 * lo que mantiene la acción viva en el build: sin esta referencia, Next la
 * eliminaría por no tener consumidores.
 *
 * Los tres momentos de la UI se cubren en el mismo componente: `idle` pinta el
 * formulario, `error` añade el bloque general y los avisos por campo, y `success`
 * sustituye el formulario entero por la confirmación, para no dejar a nadie con
 * los datos rellenos y sin respuesta. El contexto sobre qué se pide vive en las
 * pistas de cada campo, no en un bloque aparte que se quedaría colgando tras
 * enviar.
 *
 * Con el plazo cerrado (`REGISTRATION_IS_CLOSED`) el botón se desactiva y el
 * motivo se lee a su lado, enlazado con `aria-describedby`. El servidor lo
 * rechaza igualmente: esto es la cara visible del mismo flag, no la defensa.
 */
export function RegistrationForm() {
  const [state, formAction, pending] = useActionState(registerPlayer, initialState);

  // El token de Turnstile es de un solo uso: la Server Action lo canjea contra
  // Cloudflare antes de validar los campos, así que cualquier respuesta de error
  // lo deja gastado. Sin resetear aquí, el segundo intento fallaría siempre y el
  // formulario quedaría inservible hasta recargar.
  useEffect(() => {
    if (turnstileSiteKey !== "" && state.status === "error") {
      resetTurnstileWidget();
    }
  }, [state]);

  if (state.status === "success") {
    return <RegistrationConfirmation message={state.message} />;
  }

  const { fieldErrors } = state;

  return (
    <section className="mx-auto w-full max-w-2xl rounded-lg border border-line bg-surface p-6 sm:p-8">
      <h2 className="border-b border-line pb-3 font-display text-xl font-semibold text-foreground">
        Inscripción
      </h2>
      <p className="mt-4 max-w-[58ch] text-sm leading-relaxed text-muted">
        Necesitas el identificador de tu perfil de AoE4World. El canal de Twitch
        es opcional y solo sirve para señalar tu directo cuando emites partidas de
        la liga.
      </p>

      <form action={formAction} className="mt-6 flex flex-col gap-5">
        {state.status === "error" && state.message ? (
          <p
            role="alert"
            className="rounded-md border border-red-500/40 bg-red-500/5 px-4 py-3 text-sm leading-relaxed text-red-300"
          >
            {state.message}
          </p>
        ) : null}

        <TextField
          id="profileId"
          name="profileId"
          label="Profile ID de AoE4World"
          hint="El número de tu perfil, visible en la URL de aoe4world.com/players."
          placeholder="1234567"
          inputMode="numeric"
          autoComplete="off"
          required
          error={fieldErrors.profileId}
        />

        <TextField
          id="name"
          name="name"
          label="Nombre de jugador"
          hint="El nombre con el que aparecerás en la clasificación. Hasta 64 caracteres."
          maxLength={64}
          autoComplete="off"
          required
          error={fieldErrors.name}
        />

        <TextField
          id="email"
          name="email"
          label="Correo de contacto"
          hint="Solo para avisarte si hay dudas con tu inscripción."
          placeholder="tu@correo.com"
          type="email"
          inputMode="email"
          autoComplete="email"
          maxLength={CONTACT_EMAIL_MAX_LENGTH}
          required
          error={fieldErrors.email}
        />

        <TextField
          id="twitchChannel"
          name="twitchChannel"
          label="Canal de Twitch (opcional)"
          hint="Solo el nombre del canal, sin la arroba."
          placeholder="tu_canal"
          maxLength={25}
          autoComplete="off"
          error={fieldErrors.twitchChannel}
        />

        <div className="flex flex-col gap-1.5">
          <label htmlFor="terms" className="flex items-start gap-3 text-sm text-foreground">
            <input
              id="terms"
              name="terms"
              type="checkbox"
              required
              aria-invalid={fieldErrors.terms ? true : undefined}
              aria-describedby={fieldErrors.terms ? "terms-error" : undefined}
              className="mt-0.5 size-4 shrink-0"
            />
            <span>He leído y acepto las bases del torneo.</span>
          </label>
          {fieldErrors.terms ? (
            <p id="terms-error" className="text-sm text-red-400">
              {fieldErrors.terms}
            </p>
          ) : null}
        </div>

        {/* Campo trampa: fuera de pantalla pero sin `display: none`, que algunos
            bots detectan. No es tabulable ni lo anuncia el lector de pantalla, y
            una persona nunca lo rellena. */}
        <div className="absolute left-[-9999px]" aria-hidden="true">
          <label htmlFor="website">No rellenes este campo</label>
          <input
            id="website"
            name="website"
            type="text"
            tabIndex={-1}
            autoComplete="off"
          />
        </div>

        {turnstileSiteKey !== "" ? <TurnstileWidget siteKey={turnstileSiteKey} /> : null}

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={pending || REGISTRATION_IS_CLOSED}
            aria-describedby={REGISTRATION_IS_CLOSED ? "registration-closed-note" : undefined}
            className="inline-flex h-10 items-center justify-center rounded-md border border-accent-strong/70 bg-linear-to-b from-accent-strong to-accent px-5 text-sm font-semibold text-accent-ink transition-colors hover:border-accent-strong hover:to-accent-strong disabled:cursor-not-allowed disabled:opacity-60"
          >
            {pending ? "Enviando…" : "Enviar solicitud"}
          </button>
          {REGISTRATION_IS_CLOSED ? (
            // Aviso, no error: se queda en `muted` para no competir con el rojo
            // que este formulario reserva a los fallos.
            <p id="registration-closed-note" className="max-w-[42ch] text-sm leading-relaxed text-muted">
              La organización abrirá las inscripciones más adelante, una vez que se acerquen las fechas del torneo.
            </p>
          ) : null}
        </div>
      </form>
    </section>
  );
}

type TextFieldProps = {
  id: string;
  name: string;
  label: string;
  hint?: string;
  error?: string;
} & Omit<ComponentPropsWithoutRef<"input">, "id" | "name" | "className">;

/**
 * Campo de texto del formulario. La pista y el error comparten línea bajo el
 * control: cuando hay error, el aviso lo sustituye y se enlaza con
 * `aria-describedby`, de modo que el mensaje nunca se pinta dos veces.
 */
function TextField({ id, name, label, hint, error, ...inputProps }: TextFieldProps) {
  const messageId = `${id}-message`;
  const message = error ?? hint;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {label}
      </label>
      <input
        id={id}
        name={name}
        aria-invalid={error ? true : undefined}
        aria-describedby={message ? messageId : undefined}
        className={`h-10 rounded-md border bg-background px-3 text-foreground placeholder:text-muted ${
          error ? "border-red-500/60" : "border-line"
        }`}
        {...inputProps}
      />
      {message ? (
        <p
          id={messageId}
          className={
            error ? "text-sm leading-relaxed text-red-400" : "text-xs leading-relaxed text-muted"
          }
        >
          {message}
        </p>
      ) : null}
    </div>
  );
}

/** Confirmación: ocupa el lugar del formulario cuando la solicitud ya está registrada. */
function RegistrationConfirmation({ message }: { message: string | null }) {
  return (
    <section className="thread-top relative mx-auto w-full max-w-2xl overflow-hidden rounded-lg border border-accent/30 bg-surface p-6 sm:p-8">
      <div className="flex items-center gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full border border-accent/40 text-accent">
          <CheckIcon className="size-5" />
        </span>
        <h2 className="font-display text-xl font-semibold text-foreground">
          Solicitud recibida
        </h2>
      </div>

      <p className="mt-4 max-w-[58ch] text-[15px] leading-relaxed text-muted">
        {message ??
          "La organización la revisa antes de que entres en la clasificación."}
      </p>

      <p className="mt-4 max-w-[58ch] text-sm leading-relaxed text-muted/85">
        Mientras tanto, puedes consultar las{" "}
        <Link
          href="/reglas"
          className="text-accent underline underline-offset-4 hover:text-accent-strong"
        >
          reglas del torneo
        </Link>
        .
      </p>
    </section>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="m5 12.5 4.5 4.5L19 6.5" />
    </svg>
  );
}
